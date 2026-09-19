import { describe, expect, test } from "bun:test";
import { MAX_STREAM_ID, decodeFrame, generateSigningKeyPair, signTerminalOpen, type DeviceToPhone, type Frame, type MsgBody, type PhoneToDevice } from "@cuaremote/protocol";
import { LocalBunHost } from "../src/host/local-bun-host.js";
import { TerminalManager } from "../src/terminal/manager.js";
import { BunPty, type Pty, type PtySpawnOptions } from "../src/terminal/pty.js";
import { TerminalSession } from "../src/terminal/session.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 假 PTY：记录写入 / resize / close，测试用 emit / exit 手动推输出 */
class FakePty implements Pty {
  pid = 4242;
  written: Uint8Array[] = [];
  sizes: [number, number][] = [];
  closed = 0;
  private dataCb?: (c: Uint8Array) => void;
  private exitCb?: (code: number | undefined) => void;
  constructor(public readonly opts?: PtySpawnOptions) {}
  write(d: Uint8Array | string) {
    this.written.push(typeof d === "string" ? enc.encode(d) : d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  close() {
    this.closed++;
  }
  onData(cb: (c: Uint8Array) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (code: number | undefined) => void) {
    this.exitCb = cb;
  }
  emit(s: string | Uint8Array) {
    this.dataCb?.(typeof s === "string" ? enc.encode(s) : s);
  }
  exit(code: number | undefined) {
    this.exitCb?.(code);
  }
}

function sink() {
  const frames: Frame[] = [];
  const msgs: MsgBody<DeviceToPhone>[] = [];
  return {
    frames,
    msgs,
    sendFrame: (b: Uint8Array) => frames.push(decodeFrame(b)),
    sendMsg: (m: MsgBody<DeviceToPhone>) => msgs.push(m),
    text: () => dec.decode(concat(frames.map((f) => f.payload))),
    types: () => msgs.map((m) => m.type),
  };
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

describe("TerminalSession：分块与窗口背压", () => {
  const mk = (o: { windowBytes?: number; chunkBytes?: number; maxQueuedBytes?: number } = {}) => {
    const pty = new FakePty();
    const s = sink();
    const sess = new TerminalSession({ sessionId: "t1", streamId: 7, pty, sendFrame: s.sendFrame, sendMsg: s.sendMsg, ...o });
    return { pty, s, sess };
  };

  test("构造即发 terminal.opened（带 streamId 和 pid）；输出按 chunkBytes 切帧，帧用同一个 streamId", () => {
    const { pty, s } = mk({ chunkBytes: 4 });
    expect(s.msgs[0]).toEqual({ type: "terminal.opened", sessionId: "t1", streamId: 7, pid: 4242 });
    pty.emit("0123456789");
    expect(s.frames.map((f) => f.payload.length)).toEqual([4, 4, 2]);
    expect(s.frames.every((f) => f.kind === 1 && f.streamId === 7)).toBe(true);
    expect(s.text()).toBe("0123456789");
  });

  test("窗口满后攒队列；ack 到了才继续放；迟到 / 超 sent 的 ack 忽略", () => {
    const { pty, s, sess } = mk({ windowBytes: 10, chunkBytes: 4 });
    pty.emit("aaaabbbbccccdddd"); // 16 字节：4+4 = 8 ≤ 10；再放 4 会到 12 > 10，停
    expect(s.text()).toBe("aaaabbbb");
    expect(sess.stats).toMatchObject({ sent: 8, acked: 0, queued: 8 });

    sess.ack(20); // 超过 sent：忽略
    expect(sess.stats.acked).toBe(0);
    sess.ack(4); // 未确认 4，再放 4 → 8 ≤ 10，放一块；再放一块到 12 停
    expect(s.text()).toBe("aaaabbbbcccc");
    sess.ack(2); // 迟到的 ack：忽略
    expect(sess.stats.acked).toBe(4);
    sess.ack(12);
    expect(s.text()).toBe("aaaabbbbccccdddd");
    expect(sess.stats).toMatchObject({ sent: 16, acked: 12, queued: 0, frames: 4 });
  });

  test("单块比窗口还大时也至少发一块（窗口空着就不会死锁）", () => {
    const { pty, s } = mk({ windowBytes: 3, chunkBytes: 8 });
    pty.emit("12345678abc");
    expect(s.text()).toBe("12345678");
  });

  test("PTY 退出：忽略窗口把剩余全冲完，然后才发 terminal.exit（带退出码）", () => {
    const { pty, s, sess } = mk({ windowBytes: 4, chunkBytes: 4 });
    pty.emit("aaaabbbbcccc");
    expect(s.text()).toBe("aaaa");
    pty.exit(3);
    expect(s.text()).toBe("aaaabbbbcccc");
    expect(s.msgs.at(-1)).toEqual({ type: "terminal.exit", sessionId: "t1", code: 3 });
    expect(sess.closed).toBe(true);
    // 退出后再来的数据 / 输入 / 第二次退出都不再产生任何东西
    const n = s.frames.length;
    pty.emit("late");
    sess.input(enc.encode("x"));
    pty.exit(0);
    expect(s.frames.length).toBe(n);
    expect(s.types().filter((t) => t === "terminal.exit")).toHaveLength(1);
    expect(pty.written).toHaveLength(0);
  });

  test("被信号杀掉（code undefined）时 terminal.exit 不带 code", () => {
    const { pty, s } = mk();
    pty.exit(undefined);
    expect(s.msgs.at(-1)).toEqual({ type: "terminal.exit", sessionId: "t1" });
  });

  test("对端一直不 ack、攒过 maxQueuedBytes：关 PTY，发 terminal.exit + error terminal_closed", () => {
    const { pty, s, sess } = mk({ windowBytes: 4, chunkBytes: 4, maxQueuedBytes: 10 });
    pty.emit("aaaabbbbcccc"); // 发 4，攒 8：没超
    expect(pty.closed).toBe(0);
    pty.emit("dddd"); // 攒 12 > 10
    expect(pty.closed).toBe(1);
    expect(sess.closed).toBe(true);
    expect(s.types().slice(-2)).toEqual(["terminal.exit", "error"]);
    expect(s.msgs.at(-1)).toMatchObject({ type: "error", code: "terminal_closed", ref: "t1" });
    expect(sess.stats.queued).toBe(0);
  });

  test("input 写进 PTY，resize 转给 PTY；主动 close 只关一次", () => {
    const { pty, s, sess } = mk();
    sess.input(enc.encode("ls\r"));
    sess.resize(100, 30);
    expect(dec.decode(pty.written[0])).toBe("ls\r");
    expect(pty.sizes).toEqual([[100, 30]]);
    sess.close();
    sess.close();
    expect(pty.closed).toBe(1);
    expect(s.types()).toEqual(["terminal.opened", "terminal.exit"]);
    sess.resize(1, 1);
    expect(pty.sizes).toHaveLength(1);
  });

  test("OSC 133 输出产生 terminal.block 事件；blocks() 给出命令、退出码和纯文本输出", () => {
    const { pty, s, sess } = mk();
    pty.emit("\x1b]133;A\x07$ \x1b]133;B\x07echo hi\r\n\x1b]133;C;cmd=echo%20hi\x07\x1b[32mhi\x1b[0m\r\n\x1b]133;D;0\x07");
    const blocks = s.msgs.filter((m) => m.type === "terminal.block");
    expect(blocks.length).toBeGreaterThan(0);
    const b = sess.blocks(5);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ blockId: expect.any(Number), state: "done", command: "echo hi", exitCode: 0 });
    expect(b[0]!.output).toContain("hi");
    expect(b[0]!.output).not.toContain("\x1b");
  });
});

describe("TerminalManager：路由、验签、上限", () => {
  const now = 1_800_000_000;
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

  // cwd 现在要真实存在（不存在的目录在验签前就被拒），所以用 /tmp 和 /usr
  const DEFAULT_CWD = "/tmp";
  const OTHER_CWD = "/usr";

  function mkManager(o: { phoneKeys?: { sig: string; sigAlg: "ES256" | "Ed25519" }; maxSessions?: number; spawnFail?: boolean; nonces?: Map<string, number>; sendFrame?: (b: Uint8Array) => void; deviceId?: string } = {}) {
    const ptys: FakePty[] = [];
    const s = sink();
    const mgr = new TerminalManager({
      deviceId: o.deviceId ?? "mac-1",
      spawn: (opts) => {
        if (o.spawnFail) throw new Error("no pty");
        const p = new FakePty(opts);
        ptys.push(p);
        return p;
      },
      sendFrame: o.sendFrame ?? s.sendFrame,
      sendMsg: s.sendMsg,
      phoneKeys: o.phoneKeys,
      unsafeUnsigned: o.phoneKeys ? undefined : true,
      nonces: o.nonces,
      firstStreamId: 1,
      maxSessions: o.maxSessions,
      now: () => now,
      defaultCwd: DEFAULT_CWD,
      shell: "/bin/sh",
    });
    return { mgr, ptys, s };
  }
  const open = (sessionId: string, extra: Partial<Extract<PhoneToDevice, { type: "terminal.open" }>> = {}): PhoneToDevice =>
    ({ v: 1, id: `m-${sessionId}`, type: "terminal.open", sessionId, cols: 80, rows: 24, ...extra }) as PhoneToDevice;
  const ctl = (m: Record<string, unknown>) => ({ v: 1, id: "m", ...m }) as PhoneToDevice;
  const opened = (s: ReturnType<typeof sink>, sessionId: string) => s.msgs.find((m) => m.type === "terminal.opened" && m.sessionId === sessionId) as Extract<DeviceToPhone, { type: "terminal.opened" }> | undefined;
  const errors = (s: ReturnType<typeof sink>) => s.msgs.filter((m) => m.type === "error").map((m) => (m as { code: string }).code);

  test("unsafeUnsigned 时直接开；streamId 从 firstStreamId 递增；spawn 带 CUAREMOTE_SESSION、cwd/shell 默认值；非终端消息返回 false", () => {
    const { mgr, ptys, s } = mkManager();
    expect(mgr.handle(open("a"))).toBe(true);
    expect(mgr.handle(open("b", { cwd: OTHER_CWD }))).toBe(true);
    expect(opened(s, "a")?.streamId).toBe(1);
    expect(opened(s, "b")?.streamId).toBe(2);
    expect(ptys[0]!.opts).toMatchObject({ cols: 80, rows: 24, cwd: DEFAULT_CWD, shell: "/bin/sh", env: { CUAREMOTE_SESSION: "a" } });
    expect(ptys[1]!.opts?.cwd).toBe(OTHER_CWD);
    expect(mgr.size).toBe(2);
    expect(mgr.handle(ctl({ type: "run.cancel", runId: "r" }))).toBe(false);
  });

  test("既没 phoneKeys 也没 unsafeUnsigned：构造直接抛错（不能静默变成不验签）", () => {
    const s = sink();
    expect(() => new TerminalManager({ deviceId: "mac-1", spawn: () => new FakePty(), sendFrame: s.sendFrame, sendMsg: s.sendMsg })).toThrow(/phoneKeys|unsafeUnsigned/);
  });

  test("不传 firstStreamId 时按时间取种子：重启后的新管理器不会重用上一轮的 streamId 1", () => {
    const s = sink();
    const mgr = new TerminalManager({ deviceId: "mac-1", unsafeUnsigned: true, spawn: () => new FakePty(), sendFrame: s.sendFrame, sendMsg: s.sendMsg, now: () => now });
    mgr.handle(open("a"));
    const id = opened(s, "a")!.streamId;
    expect(id).toBe((now % 0x1000_0000) * 16 + 1);
    expect(id).toBeLessThanOrEqual(MAX_STREAM_ID);
    // 一秒后启动的另一台：种子严格更大
    const s2 = sink();
    const mgr2 = new TerminalManager({ deviceId: "mac-1", unsafeUnsigned: true, spawn: () => new FakePty(), sendFrame: s2.sendFrame, sendMsg: s2.sendMsg, now: () => now + 1 });
    mgr2.handle(open("a"));
    expect(opened(s2, "a")!.streamId).toBeGreaterThan(id);
  });

  test("非法 sessionId → terminal_bad_session_id；不存在的 cwd → terminal_bad_cwd（都在 spawn 之前）", () => {
    const { mgr, ptys, s } = mkManager();
    mgr.handle(open("has space"));
    mgr.handle(open("a".repeat(65)));
    mgr.handle(open("../etc"));
    mgr.handle(open("ok", { cwd: "/definitely/not/here" }));
    mgr.handle(open("ok2", { cwd: "/etc/hostname" })); // 存在但是文件不是目录
    expect(errors(s)).toEqual(["terminal_bad_session_id", "terminal_bad_session_id", "terminal_bad_session_id", "terminal_bad_cwd", "terminal_bad_cwd"]);
    expect(ptys).toHaveLength(0);
    expect(mgr.size).toBe(0);
  });

  test("kind=1 帧按 streamId 路由到对应 PTY；kind≠1 / 未知 streamId 返回 false", () => {
    const { mgr, ptys } = mkManager();
    mgr.handle(open("a"));
    mgr.handle(open("b"));
    expect(mgr.input({ kind: 1, streamId: 2, payload: enc.encode("pwd\r") })).toBe(true);
    expect(dec.decode(ptys[1]!.written[0])).toBe("pwd\r");
    expect(ptys[0]!.written).toHaveLength(0);
    expect(mgr.input({ kind: 0, streamId: 1, payload: enc.encode("x") })).toBe(false);
    expect(mgr.input({ kind: 1, streamId: 99, payload: enc.encode("x") })).toBe(false);
    expect(ptys[0]!.written).toHaveLength(0);
  });

  test("resize / ack / close 按 sessionId 转发；close 后会话被移除，同名可重开且拿新 streamId", () => {
    const { mgr, ptys, s } = mkManager();
    mgr.handle(open("a"));
    mgr.handle(ctl({ type: "terminal.resize", sessionId: "a", cols: 120, rows: 40 }));
    expect(ptys[0]!.sizes).toEqual([[120, 40]]);
    mgr.handle(ctl({ type: "terminal.resize", sessionId: "nope", cols: 1, rows: 1 })); // 不存在：静默
    mgr.handle(ctl({ type: "terminal.close", sessionId: "a" }));
    expect(ptys[0]!.closed).toBe(1);
    expect(mgr.size).toBe(0);
    expect(mgr.input({ kind: 1, streamId: 1, payload: enc.encode("x") })).toBe(false);
    mgr.handle(open("a"));
    expect(opened(s, "a")).toBeDefined();
    expect(s.msgs.filter((m) => m.type === "terminal.opened").map((m) => (m as { streamId: number }).streamId)).toEqual([1, 2]);
    expect(errors(s)).toEqual([]);
  });

  test("重复 sessionId → terminal_exists；超过 maxSessions → terminal_limit；spawn 抛错 → terminal_spawn_failed", () => {
    const { mgr, s } = mkManager({ maxSessions: 1 });
    mgr.handle(open("a"));
    mgr.handle(open("a"));
    mgr.handle(open("b"));
    expect(errors(s)).toEqual(["terminal_exists", "terminal_limit"]);
    expect(mgr.size).toBe(1);
    const bad = mkManager({ spawnFail: true });
    bad.mgr.handle(open("z"));
    expect(errors(bad.s)).toEqual(["terminal_spawn_failed"]);
    expect(bad.mgr.size).toBe(0);
  });

  test("PTY 退出后会话自动移除，同 streamId 的输入不再送达", () => {
    const { mgr, ptys } = mkManager();
    mgr.handle(open("a"));
    ptys[0]!.exit(0);
    expect(mgr.size).toBe(0);
    expect(mgr.input({ kind: 1, streamId: 1, payload: enc.encode("x") })).toBe(false);
  });

  for (const alg of ["ES256", "Ed25519"] as const) {
    test(`${alg}：有 phoneKeys 时无签名 / 过期 / TTL 过长 / 错钥 / 重放都拒绝（approval_invalid），signTerminalOpen 正确通过`, () => {
      const keys = generateSigningKeyPair(alg);
      const other = generateSigningKeyPair(alg);
      const { mgr, s } = mkManager({ phoneKeys: { sig: b64(keys.publicKey), sigAlg: alg } });
      const sig = (sessionId: string, o: { key?: Uint8Array; expiresAt?: number; nonce?: string; deviceId?: string } = {}) =>
        signTerminalOpen({ sessionId, deviceId: o.deviceId ?? "mac-1", privateKey: o.key ?? keys.privateKey, alg, keyId: "k1", nonce: o.nonce ?? `n-${sessionId}`, expiresAt: o.expiresAt ?? now + 60 });

      mgr.handle(open("nosig"));
      mgr.handle(open("expired", { signature: sig("expired", { expiresAt: now }) }));
      mgr.handle(open("longttl", { signature: sig("longttl", { expiresAt: now + 301 }) }));
      mgr.handle(open("wrongkey", { signature: sig("wrongkey", { key: other.privateKey }) }));
      // 签名是给另一个 sessionId 的：challenge 不一致，等于错签名
      mgr.handle(open("swapped", { signature: sig("someone-else") }));
      // 签名是给另一台设备（deviceId 不同）的：不能拿到这台上开终端
      mgr.handle(open("xdev", { signature: sig("xdev", { deviceId: "mac-2" }) }));
      expect(errors(s)).toEqual(Array(6).fill("approval_invalid"));
      expect(mgr.size).toBe(0);

      // 非法 sessionId / 坏 cwd 带着合法签名来：在验签前被拒，nonce 不该被记下，同一个签名换成合法请求后仍能用
      const nonceKept = sig("keep");
      mgr.handle(open("keep", { cwd: "/definitely/not/here", signature: nonceKept }));
      expect(errors(s).at(-1)).toBe("terminal_bad_cwd");
      mgr.handle(open("keep", { signature: nonceKept }));
      expect(opened(s, "keep")).toBeDefined();
      mgr.handle(ctl({ type: "terminal.close", sessionId: "keep" }));
      expect(mgr.size).toBe(0);

      mgr.handle(open("ok", { signature: sig("ok", { expiresAt: now + 300 }) })); // TTL 正好 300 秒：允许
      expect(mgr.size).toBe(1);
      expect(opened(s, "ok")).toBeDefined();

      // 同一个 nonce 再用一次（换 sessionId 重新签）：重放拒绝
      mgr.handle(open("replay", { signature: sig("replay", { nonce: "n-ok" }) }));
      expect(errors(s).at(-1)).toBe("approval_invalid");
      expect(mgr.size).toBe(1);
      // 新 nonce 正常
      mgr.handle(open("ok2", { signature: sig("ok2") }));
      expect(mgr.size).toBe(2);

      // 真实重放：关掉 "ok" 之后，把同一条 terminal.open 原样再发一次（sessionId 也没变）→ 还是拒
      const okMsg = open("ok", { signature: sig("ok", { expiresAt: now + 300 }) });
      mgr.handle(ctl({ type: "terminal.close", sessionId: "ok" }));
      expect(mgr.size).toBe(1);
      mgr.handle(okMsg);
      expect(errors(s).at(-1)).toBe("approval_invalid");
      expect(mgr.size).toBe(1);
    });

    test(`${alg}：nonce 表可由宿主持久化——重启后的新管理器同一个 Map，旧 nonce 仍拒；过期的会被清掉`, () => {
      const keys = generateSigningKeyPair(alg);
      const nonces = new Map<string, number>();
      const phoneKeys = { sig: b64(keys.publicKey), sigAlg: alg };
      const a = mkManager({ phoneKeys, nonces });
      const sigA = signTerminalOpen({ sessionId: "x", deviceId: "mac-1", privateKey: keys.privateKey, alg, keyId: "k1", nonce: "n-once", expiresAt: now + 200 });
      a.mgr.handle(open("x", { signature: sigA }));
      expect(a.mgr.size).toBe(1);
      expect(nonces.get("n-once")).toBe(now + 200);

      const b = mkManager({ phoneKeys, nonces }); // 模拟 daemon 重启
      b.mgr.handle(open("x", { signature: sigA }));
      expect(errors(b.s)).toEqual(["approval_invalid"]);
      expect(b.mgr.size).toBe(0);

      // 时间走到 nonce 过期以后：下一次验签前会把它清掉（那时候这条签名本身也过期了，拒的原因换成过期）
      const late = new TerminalManager({ deviceId: "mac-1", phoneKeys, nonces, firstStreamId: 1, spawn: () => new FakePty(), sendFrame: b.s.sendFrame, sendMsg: b.s.sendMsg, now: () => now + 201 });
      late.handle(open("y", { signature: signTerminalOpen({ sessionId: "y", deviceId: "mac-1", privateKey: keys.privateKey, alg, keyId: "k1", nonce: "n-y", expiresAt: now + 260 }) }));
      expect(late.size).toBe(1);
      expect(nonces.has("n-once")).toBe(false);
      expect(nonces.has("n-y")).toBe(true);
    });
  }

  test("terminal.ack 经管理器按 sessionId 路由到会话（窗口打开后继续发）", () => {
    const s = sink();
    const ptys: FakePty[] = [];
    const mgr = new TerminalManager({ deviceId: "mac-1", unsafeUnsigned: true, firstStreamId: 1, spawn: (o) => { const p = new FakePty(o); ptys.push(p); return p; }, sendFrame: s.sendFrame, sendMsg: s.sendMsg, session: { windowBytes: 4, chunkBytes: 4 } });
    mgr.handle(open("a"));
    ptys[0]!.emit("aaaabbbb");
    expect(s.frames).toHaveLength(1);
    mgr.handle(ctl({ type: "terminal.ack", sessionId: "zzz", bytes: 4 })); // 不存在：静默
    expect(s.frames).toHaveLength(1);
    mgr.handle(ctl({ type: "terminal.ack", sessionId: "a", bytes: 4 }));
    expect(s.frames).toHaveLength(2);
  });

  test("sendFrame 抛错：会话关闭（terminal.exit + terminal_closed），sent 不把没发出去的算进去", () => {
    let fail = false;
    const { mgr, ptys, s } = mkManager({ sendFrame: (b) => { if (fail) throw new Error("socket closed"); s.sendFrame(b); } });
    mgr.handle(open("a"));
    const sess = mgr.get("a")!;
    ptys[0]!.emit("abcd");
    expect(sess.stats.sent).toBe(4);
    fail = true;
    ptys[0]!.emit("efgh");
    expect(sess.stats.sent).toBe(4);
    expect(sess.stats.closed).toBe(true);
    expect(ptys[0]!.closed).toBe(1);
    expect(mgr.size).toBe(0);
    expect(errors(s).at(-1)).toBe("terminal_closed");
  });

  test("callBlocks：找不到会话 ok=false；找到返回 blocks；limit 夹在 1–20", async () => {
    const { mgr, ptys } = mkManager();
    mgr.handle(open("a"));
    const miss = await mgr.callBlocks({ sessionId: "zzz" });
    expect(miss.ok).toBe(false);
    ptys[0]!.emit("\x1b]133;A\x07$ \x1b]133;B\x07one\r\n\x1b]133;C;cmd=one\x07x\r\n\x1b]133;D;1\x07\x1b]133;A\x07$ \x1b]133;B\x07two\r\n\x1b]133;C;cmd=two\x07y\r\n\x1b]133;D;0\x07");
    const r = await mgr.callBlocks({ sessionId: "a", limit: 1 });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.output!) as { blocks: { command?: string; exitCode?: number }[] };
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]).toMatchObject({ command: "two", exitCode: 0 });
    const all = JSON.parse((await mgr.callBlocks({ sessionId: "a", limit: 999 })).output!) as { blocks: unknown[] };
    expect(all.blocks).toHaveLength(2);
    // limit 0 → 1；再灌 25 个块后 999 → 20；非数字 → 默认 5
    const zero = JSON.parse((await mgr.callBlocks({ sessionId: "a", limit: 0 })).output!) as { blocks: unknown[] };
    expect(zero.blocks).toHaveLength(1);
    for (let i = 0; i < 25; i++) ptys[0]!.emit(`\x1b]133;A\x07$ \x1b]133;B\x07c${i}\r\n\x1b]133;C;cmd=c${i}\x07\x1b]133;D;0\x07`);
    const capped = JSON.parse((await mgr.callBlocks({ sessionId: "a", limit: 999 })).output!) as { blocks: unknown[] };
    expect(capped.blocks).toHaveLength(20);
    const dflt = JSON.parse((await mgr.callBlocks({ sessionId: "a", limit: "abc" })).output!) as { blocks: unknown[] };
    expect(dflt.blocks).toHaveLength(5);
  });

  test("closeAll 关掉所有 PTY 并清空", () => {
    const { mgr, ptys } = mkManager();
    mgr.handle(open("a"));
    mgr.handle(open("b"));
    mgr.closeAll();
    expect(ptys.map((p) => p.closed)).toEqual([1, 1]);
    expect(mgr.size).toBe(0);
  });
});

describe("LocalBunHost 挂 terminal.blocks", () => {
  test("有 terminals 才出现在工具表里，并转给管理器", async () => {
    const s = sink();
    const mgr = new TerminalManager({ deviceId: "mac-1", unsafeUnsigned: true, spawn: () => new FakePty(), sendFrame: s.sendFrame, sendMsg: s.sendMsg });
    const withT = new LocalBunHost({ scope: { allowedDirs: ["/tmp"], deniedCommands: [] }, shell: "/bin/sh", loginShell: false, terminals: mgr });
    const without = new LocalBunHost({ scope: { allowedDirs: ["/tmp"], deniedCommands: [] }, shell: "/bin/sh", loginShell: false });
    expect((await withT.listTools()).tools.some((t) => t.name === "terminal.blocks")).toBe(true);
    expect((await without.listTools()).tools.some((t) => t.name === "terminal.blocks")).toBe(false);
    mgr.handle({ v: 1, id: "m", type: "terminal.open", sessionId: "s1", cols: 80, rows: 24 });
    const r = await withT.call("terminal.blocks", { sessionId: "s1" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.output!)).toEqual({ blocks: [] });
    const r2 = await without.call("terminal.blocks", { sessionId: "s1" });
    expect(r2.ok).toBe(false);
  });
});

describe("BunPty 真 PTY（Linux orb 上跑 bash）", () => {
  test("echo hi; exit 3 → 收到 hi 与退出码 3", async () => {
    const chunks: Uint8Array[] = [];
    let exitCode: number | undefined | null = null as number | undefined | null;
    const pty = new BunPty({ cols: 80, rows: 24, shell: "/bin/bash", env: { CUAREMOTE_SESSION: "real" } });
    pty.onData((c) => chunks.push(c));
    const exited = new Promise<void>((resolve) => pty.onExit((c) => { exitCode = c; resolve(); }));
    pty.write("echo hi-$CUAREMOTE_SESSION; exit 3\n");
    await Promise.race([exited, Bun.sleep(8000)]);
    expect(exitCode).toBe(3);
    expect(dec.decode(concat(chunks))).toContain("hi-real");
  }, 10_000);

  test("resize 后 stty size 反映新尺寸", async () => {
    const chunks: Uint8Array[] = [];
    const pty = new BunPty({ cols: 80, rows: 24, shell: "/bin/bash" });
    pty.onData((c) => chunks.push(c));
    const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
    await Bun.sleep(300);
    pty.resize(133, 47);
    await Bun.sleep(100);
    pty.write("stty size; exit 0\n");
    await Promise.race([exited, Bun.sleep(8000)]);
    expect(dec.decode(concat(chunks))).toContain("47 133");
  }, 10_000);

  test("close 结束子进程（onExit 触发）", async () => {
    const pty = new BunPty({ cols: 80, rows: 24, shell: "/bin/bash" });
    const exited = new Promise<boolean>((resolve) => pty.onExit(() => resolve(true)));
    await Bun.sleep(200);
    pty.close();
    expect(await Promise.race([exited, Bun.sleep(5000).then(() => false)])).toBe(true);
  }, 8_000);

  test("shell 忽略 SIGHUP（trap '' HUP）时，close 后 killAfterMs 内改用 SIGKILL，不留孤儿", async () => {
    const pty = new BunPty({ cols: 80, rows: 24, shell: "/bin/bash", killAfterMs: 300 });
    let code: number | undefined = 0;
    const exited = new Promise<boolean>((resolve) => pty.onExit((c) => { code = c; resolve(true); }));
    pty.write(new TextEncoder().encode("trap '' HUP; sleep 30\n"));
    await Bun.sleep(300);
    const t0 = Date.now();
    pty.close();
    expect(await Promise.race([exited, Bun.sleep(5000).then(() => false)])).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(code).toBeUndefined(); // 被信号杀掉：没有退出码
  }, 8_000);
});
