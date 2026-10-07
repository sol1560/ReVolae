import { describe, expect, test } from "bun:test";
import { describe as describeAction, PolicyEngine, staticLevel } from "@cuaremote/brain";
import { CLOUD_TOOLS, CloudComputers, E2bHost, E2bPty, fillCard, MemoryCloudStore, QUICK_CARDS, resolvePath, WORK_DIR } from "../src/index.js";
import { FakeProvider, FakeSandbox } from "./fake.js";

const enc = (s: string) => new TextEncoder().encode(s);

function setup(now = { t: 1000 }) {
  const provider = new FakeProvider();
  const store = new MemoryCloudStore();
  const cc = new CloudComputers({ provider, store, template: "cuaremote-cloud", idleMs: 600_000, now: () => now.t });
  return { provider, store, cc, now };
}

describe("路径", () => {
  test("相对路径以工作目录为根，~ 是 /home/user", () => {
    expect(resolvePath(undefined)).toBe(WORK_DIR);
    expect(resolvePath("a/b.txt")).toBe(`${WORK_DIR}/a/b.txt`);
    expect(resolvePath("~/x")).toBe("/home/user/x");
    expect(resolvePath("/tmp/y")).toBe("/tmp/y");
  });
});

describe("E2bHost 工具", () => {
  test("工具表全部标记为沙箱工具", async () => {
    const h = new E2bHost({ sandbox: async () => new FakeSandbox("s") });
    const { tools } = await h.listTools();
    expect(tools.map((t) => t.name)).toEqual(CLOUD_TOOLS.map((t) => t.name));
    expect(tools.every((t) => t.sandboxed && t.staticLevel === 0)).toBe(true);
  });

  test("shell.run 默认在工作目录，非 0 退出码返回失败但带输出", async () => {
    const sb = new FakeSandbox("s");
    sb.responders.push([/false/, () => ({ exitCode: 1, stdout: "out", stderr: "boom" })]);
    const h = new E2bHost({ sandbox: async () => sb });
    const ok = await h.call("shell.run", { cmd: "ls" });
    expect(ok.ok).toBe(true);
    expect(sb.commands[0]).toMatchObject({ cmd: "ls", cwd: WORK_DIR });
    const bad = await h.call("shell.run", { cmd: "false" });
    expect(bad).toMatchObject({ ok: false, output: "out\nboom", error: "退出码 1" });
  });

  test("fs.write 先建目录再写，fs.read 截断", async () => {
    const sb = new FakeSandbox("s");
    const h = new E2bHost({ sandbox: async () => sb });
    await h.call("fs.write", { path: "notes/a.md", content: "x".repeat(20) });
    expect(sb.commands[0]!.cmd).toBe(`mkdir -p '${WORK_DIR}/notes'`);
    const r = await h.call("fs.read", { path: "notes/a.md", maxBytes: 5 });
    expect(r.output).toStartWith("xxxxx\n…(截断，共 20 字节)");
  });

  test("cloud.preview 等端口起来再给链接并通知", async () => {
    const sb = new FakeSandbox("s");
    let probes = 0;
    sb.responders.push([/ss -ltnH/, () => ({ exitCode: ++probes >= 3 ? 0 : 1, stdout: "", stderr: "" })]);
    const previews: unknown[] = [];
    const h = new E2bHost({ sandbox: async () => sb, onPreview: (e) => previews.push(e), pollMs: 1 });
    const r = await h.call("cloud.preview", { port: 8080 });
    expect(r.ok).toBe(true);
    expect(probes).toBe(3);
    expect(previews).toEqual([{ port: 8080, url: "https://8080-s.e2b.test/" }]);
  });

  test("cloud.preview 端口一直不起来就报错", async () => {
    const sb = new FakeSandbox("s");
    sb.responders.push([/ss -ltnH/, () => ({ exitCode: 1, stdout: "", stderr: "" })]);
    const h = new E2bHost({ sandbox: async () => sb, pollMs: 1 });
    const r = await h.call("cloud.preview", { port: 3000, waitMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没有开始监听");
  });

  test("cloud.download 给签名链接并推给手机；文件不存在报错", async () => {
    const sb = new FakeSandbox("s");
    await sb.write(`${WORK_DIR}/out.docx`, enc("docx!"));
    const downloads: unknown[] = [];
    const h = new E2bHost({ sandbox: async () => sb, onDownload: (e) => downloads.push(e) });
    const r = await h.call("cloud.download", { path: "out.docx" });
    expect(r.ok).toBe(true);
    expect(downloads).toEqual([{ path: `${WORK_DIR}/out.docx`, name: "out.docx", size: 5, url: `https://down.e2b.test/s${WORK_DIR}/out.docx?ttl=3600` }]);
    expect((await h.call("cloud.download", { path: "nope.pdf" })).ok).toBe(false);
  });

  test("browser.screenshot 返回 PNG 附件", async () => {
    const sb = new FakeSandbox("s");
    sb.responders.push([/chromium/, (cmd) => {
      const file = /--screenshot=(\S+)/.exec(cmd)![1]!;
      void sb.write(file, enc("PNGDATA"));
      return { exitCode: 0, stdout: "", stderr: "" };
    }]);
    const h = new E2bHost({ sandbox: async () => sb });
    const r = await h.call("browser.screenshot", { url: "http://localhost:8080" });
    expect(r.ok).toBe(true);
    expect(r.attachments[0]).toEqual({ kind: "image/png", inline: Buffer.from("PNGDATA").toString("base64") });
    expect((await h.call("browser.screenshot", { url: "file:///etc/passwd" })).ok).toBe(false);
  });

  test("沙箱拿不到时返回失败而不是抛出", async () => {
    const h = new E2bHost({ sandbox: async () => { throw new Error("E2B 503"); } });
    expect(await h.call("shell.run", { cmd: "ls" })).toMatchObject({ ok: false, error: "E2B 503" });
  });
});

describe("云电脑策略", () => {
  const shell = CLOUD_TOOLS.find((t) => t.name === "shell.run")!;
  test("沙箱里删除和装软件直接放行，推代码要确认", async () => {
    const p = new PolicyEngine({ jevEnabled: false, autonomy: "balanced" });
    const scope = { allowedDirs: ["/"], allowedApps: [], deniedCommands: [] };
    const run = (cmd: string) => p.decide({ intent: "t", tool: shell, args: { cmd }, action: describeAction(shell, { cmd }), scope, recent: [] });
    expect((await run("rm -rf build && pip install -r requirements.txt")).verdict).toBe("allow");
    expect((await run("git push origin main")).verdict).toBe("confirm");
    expect(staticLevel(shell, { cmd: "git push" }, describeAction(shell, { cmd: "git push" }))).toBe(2);
  });
});

describe("E2bPty", () => {
  test("建好之前的输入和 resize 排队，之后按顺序送达；输出和退出都转出去", async () => {
    const sb = new FakeSandbox("s");
    const pty = new E2bPty(async () => sb, { cols: 80, rows: 24 });
    const out: string[] = [];
    let exit = null as number | undefined | null;
    pty.onData((c) => out.push(new TextDecoder().decode(c)));
    pty.onExit((c) => (exit = c));
    pty.write("ls\n");
    pty.resize(100, 30);
    await pty.ready;
    const fake = sb.ptys[0]!;
    expect(fake.opts).toMatchObject({ cols: 80, rows: 24, cwd: WORK_DIR });
    expect(fake.sizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(new TextDecoder().decode(fake.input[0])).toBe("ls\n");
    fake.emit("a.txt\r\n");
    expect(out).toEqual(["a.txt\r\n"]);
    fake.quit(0);
    await Bun.sleep(1);
    expect(exit).toBe(0);
  });

  test("输入严格按顺序送达：上一块没发完时后来的按键合并排队", async () => {
    const sb = new FakeSandbox("s");
    const pty = new E2bPty(async () => sb, { cols: 80, rows: 24 });
    await pty.ready;
    const fake = sb.ptys[0]!;
    // 让每次发送都慢一点、而且越早的越慢：没排队的话一定会乱序
    let delay = 30;
    const orig = fake.write.bind(fake);
    fake.write = async (d) => {
      const wait = (delay = Math.max(1, delay - 10));
      await Bun.sleep(wait);
      await orig(d);
    };
    for (const ch of "ls -la") pty.write(ch);
    await Bun.sleep(120);
    expect(fake.input.map((b) => new TextDecoder().decode(b)).join("")).toBe("ls -la");
    expect(fake.input.length).toBeLessThan(6);
  });

  test("启动失败时打印原因并触发退出", async () => {
    const pty = new E2bPty(async () => { throw new Error("no capacity"); }, { cols: 80, rows: 24 });
    const out: string[] = [];
    let exited = false;
    pty.onData((c) => out.push(new TextDecoder().decode(c)));
    pty.onExit(() => (exited = true));
    await pty.ready;
    expect(out.join("")).toContain("no capacity");
    expect(exited).toBe(true);
  });

  test("close 杀掉 PTY", async () => {
    const sb = new FakeSandbox("s");
    const pty = new E2bPty(async () => sb, { cols: 80, rows: 24 });
    await pty.ready;
    pty.close();
    await Bun.sleep(1);
    expect(sb.ptys[0]!.killed).toBe(true);
  });
});

describe("CloudComputers", () => {
  test("第一次用时创建，之后复用同一台并续时", async () => {
    const { provider, cc, now } = setup();
    expect(cc.status("acct").state).toBe("none");
    const [a, b] = await Promise.all([cc.handle("acct"), cc.handle("acct")]);
    expect(a.id).toBe(b.id);
    expect(provider.created).toEqual([{ template: "cuaremote-cloud", metadata: { accountId: "acct" } }]);
    now.t += 30;
    await cc.handle("acct");
    expect((a as FakeSandbox).keepAlives).toEqual([]); // 一分钟内不重复续时
    now.t += 60;
    const c = await cc.handle("acct");
    expect(c.id).toBe(a.id);
    expect((c as FakeSandbox).keepAlives).toEqual([600_000]);
    expect(cc.status("acct")).toMatchObject({ state: "running", sandboxId: a.id, lastActiveAt: 1090 });
  });

  test("空闲超过时长显示已暂停；hub 重启后用 connect 找回同一台", async () => {
    const { provider, store, cc, now } = setup();
    const a = await cc.handle("acct");
    now.t += 601;
    expect(cc.status("acct").state).toBe("paused");
    const cc2 = new CloudComputers({ provider, store, template: "cuaremote-cloud", now: () => now.t });
    const b = await cc2.handle("acct");
    expect(b.id).toBe(a.id);
    expect(provider.connects).toEqual([a.id]);
  });

  test("缓存连接失效时重新 connect", async () => {
    const { provider, cc, now } = setup();
    const a = (await cc.handle("acct")) as FakeSandbox;
    now.t += 120;
    a.keepAlive = async () => { throw new Error("stale"); };
    const b = await cc.handle("acct");
    expect(b.id).toBe(a.id);
    expect(provider.connects).toEqual([a.id]);
  });

  test("快照只留最近 N 个；整机撤销用快照新建并删掉旧机器", async () => {
    const provider = new FakeProvider();
    const store = new MemoryCloudStore();
    const now = { t: 1000 };
    const cc = new CloudComputers({ provider, store, template: "t", keepSnapshots: 2, now: () => now.t });
    const main = (await cc.handle("acct")) as FakeSandbox;
    await main.write("/home/user/work/a.txt", "v1");
    await cc.snapshot("acct", "run1");
    now.t += 1;
    await main.write("/home/user/work/a.txt", "v2");
    await cc.snapshot("acct", "run2");
    now.t += 1;
    await cc.snapshot("acct", "run3");
    expect(store.listSnapshots("acct").map((s) => s.runId)).toEqual(["run3", "run2"]);
    await expect(cc.undo("acct", "run1")).rejects.toThrow("没有快照");

    const restored = (await cc.undo("acct", "run2")) as FakeSandbox;
    expect(new TextDecoder().decode(await restored.read("/home/user/work/a.txt"))).toBe("v2");
    expect(provider.killed).toEqual([main.id]);
    expect(store.getComputer("acct")!.sandboxId).toBe(restored.id);
    // run2 及之后的快照作废
    expect(store.listSnapshots("acct")).toEqual([]);
    expect((await cc.handle("acct")).id).toBe(restored.id);
  });

  test("分叉：选中一份成为主机器，其余和旧主机器都删掉；单份失败不影响其他", async () => {
    const { provider, store, cc } = setup();
    const main = (await cc.handle("acct")) as FakeSandbox;
    await main.write("/home/user/work/x", "base");
    provider.failForkIndex = 1;
    const forks = await cc.fork("acct", 3);
    expect(forks[1]).toBeInstanceOf(Error);
    const ok = forks.filter((f): f is FakeSandbox => f instanceof FakeSandbox);
    expect(ok).toHaveLength(2);
    await ok[0]!.write("/home/user/work/x", "variant A");
    await ok[1]!.write("/home/user/work/x", "variant B");
    expect(new TextDecoder().decode(await main.read("/home/user/work/x"))).toBe("base");

    cc.adopt("acct", ok[1]!, [ok[0]!]);
    expect(store.getComputer("acct")!.sandboxId).toBe(ok[1]!.id);
    expect(provider.killed.sort()).toEqual([main.id, ok[0]!.id].sort());
    const now = await cc.handle("acct");
    expect(new TextDecoder().decode(await now.read("/home/user/work/x"))).toBe("variant B");
  });

  test("destroy 删机器和记录", async () => {
    const { provider, store, cc } = setup();
    const a = await cc.handle("acct");
    await cc.snapshot("acct", "r");
    await cc.destroy("acct");
    expect(provider.killed).toEqual([a.id]);
    expect(store.getComputer("acct")).toBeUndefined();
    expect(store.listSnapshots("acct")).toEqual([]);
  });
});

describe("快捷命令卡", () => {
  test("填字段生成意图；缺字段报出字段名", () => {
    const pdf = QUICK_CARDS.find((c) => c.id === "pdf-to-word")!;
    expect(fillCard(pdf, { file: "/home/user/work/inbox/a.pdf" })).toContain("/home/user/work/inbox/a.pdf");
    expect(() => fillCard(pdf, {})).toThrow("PDF 文件");
  });
  test("每张卡的占位符都有对应字段", () => {
    for (const c of QUICK_CARDS) {
      const keys = [...c.intent.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const k of keys) expect(c.fields.map((f) => f.key)).toContain(k!);
    }
  });
});
