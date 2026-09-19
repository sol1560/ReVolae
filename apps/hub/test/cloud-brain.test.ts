import { afterAll, describe, expect, test } from "bun:test";
import { AnyMessage, E2ELink, controlFrame, decodeFrame, decodeRelay, mkMsg, parseControl, signApproval, type MsgBody } from "@cuaremote/protocol";
import { brainIdOf } from "../src/cloud-brain.js";
import { createHubServer } from "../src/server.js";
import { Endpoint, b64, pair } from "./helpers.js";

/**
 * 端到端：手机 → hub → 云端大脑（进程内）→ hub → 设备，全程密文。
 * 手机和设备都是假的 ws 端；大脑是真的 CloudBrain + MockProvider。
 */

/** 一个端到大脑的加密链路 + 收到的明文消息队列 */
class BrainLink {
  link!: E2ELink;
  inbox: AnyMessage[] = [];
  private waiters: { pred: (m: AnyMessage) => boolean; resolve: (m: AnyMessage) => void }[] = [];
  private pump?: Promise<void>;

  constructor(
    readonly ep: Endpoint,
    readonly brainId: string,
  ) {}

  async open() {
    const keys = await this.ep.expect("peer.keys", (m) => m.deviceId === this.brainId);
    this.link = await E2ELink.create({ selfId: this.ep.id, self: this.ep.kem, peerId: this.brainId, peerPublicKey: new Uint8Array(Buffer.from(keys.pubKeys.kem, "base64")) });
    this.ep.sendBin(this.link.handshake());
    this.pump = this.run();
    return this;
  }

  private async run() {
    for (;;) {
      const bin = await this.ep.expectBin(10_000).catch(() => null);
      if (!bin) return;
      const env = decodeRelay(bin);
      if (env.from !== this.brainId) continue;
      const frame = await this.link.openRelay(bin);
      if (!frame) continue;
      const m = AnyMessage.parse(parseControl(decodeFrame(frame)));
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    }
  }

  async send(body: MsgBody) {
    this.ep.sendBin(await this.link.sealFrame(controlFrame(mkMsg(body), 0)));
  }

  expect<T extends AnyMessage["type"]>(type: T, extra?: (m: Extract<AnyMessage, { type: T }>) => boolean, timeoutMs = 8000): Promise<Extract<AnyMessage, { type: T }>> {
    return this.next((m): m is Extract<AnyMessage, { type: T }> => m.type === type && (extra ? extra(m as any) : true), timeoutMs);
  }

  next<T extends AnyMessage>(pred: (m: AnyMessage) => m is T, timeoutMs = 8000): Promise<T> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as T);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等消息超时；收件箱 ${JSON.stringify(this.inbox.map((m) => m.type))}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as any);
        },
      });
    });
  }
}

/** 假设备：像 daemon 一样响应大脑的 tools.list / tools.call */
function serveDevice(dev: BrainLink, onCall: (m: Extract<AnyMessage, { type: "tools.call" }>) => Promise<MsgBody>) {
  const calls: string[] = [];
  (async () => {
    for (;;) {
      const m = await dev.next((x): x is Extract<AnyMessage, { type: "tools.list" | "tools.call" }> => x.type === "tools.list" || x.type === "tools.call", 60_000).catch(() => null);
      if (!m) return;
      if (m.type === "tools.list") {
        await dev.send({
          type: "tools.list.result",
          tools: [{ name: "shell.run", description: "跑命令", channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: true, inputSchema: {} }],
          scope: { allowedDirs: ["/tmp"], allowedApps: [], deniedCommands: [] },
        });
      } else {
        calls.push(String(m.args.cmd));
        await dev.send(await onCall(m));
      }
    }
  })();
  return calls;
}

describe("云端大脑（hub 进程内）", () => {
  const logs: Record<string, unknown>[] = [];
  const srv = createHubServer({ port: 0, publicURL: "ws://hub.test/ws", cloudBrain: { defaultProvider: "mock", log: (r) => logs.push(r) } });
  const brainId = brainIdOf("local");
  afterAll(() => {
    srv.cloudBrain?.stopAll();
    void srv.server.stop(true);
  });

  test("手机 intent.submit → 大脑 → 设备 tools.call；L1 步骤要手机签名确认；结果全程密文回到手机", async () => {
    const mac = await Endpoint.make("mac-cloud", "device");
    const phone = await Endpoint.make("phone-cloud", "phone", "Ed25519");
    await mac.login(url(), { name: "Mac" });
    await phone.login(url(), { platform: "ios" });
    const secret = b64(crypto.getRandomValues(new Uint8Array(16)));
    expect((await pair(phone, mac, secret)).rp.ok).toBe(true);

    // hub 把大脑的公钥推给了账号里的两端
    const macLink = await new BrainLink(mac, brainId).open();
    const phoneLink = await new BrainLink(phone, brainId).open();
    expect(srv.hub.isOnline(brainId)).toBe(true);
    expect(srv.hub.store.getDevice(brainId)?.role).toBe("brain");

    const calls = serveDevice(macLink, async (m) => ({ type: "tools.result", callId: m.callId, ok: true, output: `设备跑了 ${m.args.cmd}`, attachments: [], ms: 2 }));

    await phoneLink.send({ type: "intent.submit", text: "shell: echo via-cloud", deviceId: mac.id, mode: "agent" });
    const created = await phoneLink.expect("run.created");
    const ask = await phoneLink.expect("step.approval_required", (m) => m.runId === created.runId);
    expect(ask.challenge.split("\n")[0]).toBe("cuaremote-approval-v1");
    expect(calls).toEqual([]); // 没确认前设备什么都没跑

    // 先发一个没签名的决定：大脑拒收，这一步失败
    await phoneLink.send({ type: "approval.decision", runId: ask.runId, stepId: ask.stepId, allow: true, remember: "once" });
    const err = await phoneLink.expect("error", (m) => m.code.startsWith("approval_"));
    expect(err.code).toBe("approval_bad_signature");
    const denied = await phoneLink.expect("step.finished", (m) => m.stepId === ask.stepId);
    expect(denied.ok).toBe(false);
    expect(calls).toEqual([]);
    // mock 模型被拒后会直接收尾，所以这里只看 run 结束了、且没有一步真的执行
    const fin1 = await phoneLink.expect("run.finished", (m) => m.runId === created.runId);
    expect(fin1.stepCount).toBe(1);

    // 再来一次，这回正经签名
    await phoneLink.send({ type: "intent.submit", text: "shell: echo via-cloud-2", deviceId: mac.id, mode: "agent" });
    const created2 = await phoneLink.expect("run.created");
    const ask2 = await phoneLink.expect("step.approval_required", (m) => m.runId === created2.runId);
    const parts = ask2.challenge.split("\n");
    const sig = signApproval({ challenge: ask2.challenge, allow: true, privateKey: phone.sig.privateKey, alg: phone.alg, keyId: "phone-key", nonce: parts[4]!, expiresAt: Number(parts[5]) });
    await phoneLink.send({ type: "approval.decision", runId: ask2.runId, stepId: ask2.stepId, allow: true, remember: "once", signature: sig });
    const done = await phoneLink.expect("step.finished", (m) => m.stepId === ask2.stepId);
    expect(done.ok).toBe(true);
    expect(done.output).toContain("设备跑了 echo via-cloud-2");
    const fin2 = await phoneLink.expect("run.finished", (m) => m.runId === created2.runId);
    expect(fin2.ok).toBe(true);
    expect(calls).toEqual(["echo via-cloud-2"]);

    // 重放同一个签名：nonce 已用过，必须被拒
    await phoneLink.send({ type: "intent.submit", text: "shell: echo replay", deviceId: mac.id, mode: "agent" });
    const created3 = await phoneLink.expect("run.created");
    const ask3 = await phoneLink.expect("step.approval_required", (m) => m.runId === created3.runId);
    await phoneLink.send({ type: "approval.decision", runId: ask3.runId, stepId: ask3.stepId, allow: true, remember: "once", signature: sig });
    const err3 = await phoneLink.expect("error", (m) => m.code.startsWith("approval_"));
    expect(err3.code).toBe("approval_nonce_reused");
    expect((await phoneLink.expect("step.finished", (m) => m.stepId === ask3.stepId)).ok).toBe(false);
    await phoneLink.expect("run.finished", (m) => m.runId === created3.runId);
    expect(calls).toEqual(["echo via-cloud-2"]);

    // 设备掉线：大脑里等它的调用全部失败，手机看到 presence
    mac.close();
    const off = await phone.expect("presence", (m) => m.deviceId === mac.id && !m.online);
    expect(off.online).toBe(false);
    phone.close();
  }, 30_000);

  test("大脑密钥落库：重启 hub 后 brain:<account> 的公钥不变", async () => {
    const before = srv.hub.store.getDevice(brainId)!;
    const row = srv.hub.store.getBrainKeys("local")!;
    expect(row.kemSeed.length).toBeGreaterThan(20);
    // 用同一个 store 再起一个 hub：应该复用密钥而不是新生成
    const srv2 = createHubServer({ port: 0, store: srv.hub.store, cloudBrain: { defaultProvider: "mock" } });
    try {
      const d = await Endpoint.make("mac-again", "device");
      await d.login(srv2.url);
      const keys = await d.expect("peer.keys", (m) => m.deviceId === brainId);
      expect(keys.pubKeys.kem).toBe(before.kem);
      expect(keys.pubKeys.sig).toBe(before.sig);
      d.close();
    } finally {
      srv2.cloudBrain?.stopAll();
      void srv2.server.stop(true);
    }
  });

  function url() {
    return srv.url;
  }
});
