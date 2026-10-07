import { afterAll, describe, expect, test } from "bun:test";
import { CloudComputers } from "@cuaremote/cloud-computer";
import { CloudComputerService, HubStore, createHubServer } from "@cuaremote/hub";
import type { AnyMessage } from "@cuaremote/protocol";
import { FakeProvider, FakeSandbox } from "../../cloud-computer/test/fake.js";
import { CuaClient, newIdentity, parseIdentity, serializeIdentity, type ClientEvent } from "../src/index.js";

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  if (!cond()) throw new Error("等待超时");
}

function collect(c: CuaClient) {
  const msgs: AnyMessage[] = [];
  c.subscribe((e: ClientEvent) => e.kind === "message" && msgs.push(e.message));
  return msgs;
}

describe("CuaClient（真 hub + 云端大脑 + 假沙箱，多账号 + 自助账号）", () => {
  const provider = new FakeProvider();
  const store = new HubStore(":memory:");
  const computers = new CloudComputers({ provider, store, template: "t" });
  const cloud = new CloudComputerService({ computers, variantsAllowed: async () => 3 });
  const srv = createHubServer({ port: 0, store, jwtSecret: "s", selfAccounts: true, cloudBrain: { defaultProvider: "mock", cloud } });
  afterAll(() => {
    srv.cloudBrain?.stopAll();
    void srv.server.stop(true);
  });

  test("身份可序列化", async () => {
    const id = await newIdentity();
    const back = parseIdentity(serializeIdentity(id));
    expect(back.deviceId).toBe(id.deviceId);
    expect(back.sig.privateKey).toEqual(id.sig.privateKey);
    expect(back.kem.publicKey).toEqual(id.kem.publicKey);
  });

  test("登录 → 自己的账号和云电脑 → 状态 → 跑任务 → 要确认的步骤签名放行 → 终端来回 → 断线重连", async () => {
    const identity = await newIdentity();
    const c = new CuaClient({ url: srv.url, identity, name: "Sol 的 iPhone" });
    const msgs = collect(c);
    c.start();
    await until(() => c.state === "online");
    expect(c.accountId).toMatch(/^u_/);
    expect(c.cloudDeviceId).toBe(`cloud:${c.accountId}`);

    const st = await c.request({ type: "cloud.status.get" }, "cloud.status");
    expect(st).toMatchObject({ state: "none", variantsAllowed: 3 });

    await c.submit("shell: echo from-phone");
    await until(() => msgs.some((m) => m.type === "run.finished"));
    const fin = msgs.find((m) => m.type === "run.finished") as Extract<AnyMessage, { type: "run.finished" }>;
    expect(fin.ok).toBe(true);

    // 往外推代码：L2，要手机签名
    await c.submit("shell: git push origin main");
    await until(() => msgs.some((m) => m.type === "step.approval_required"));
    const ask = msgs.find((m) => m.type === "step.approval_required") as Extract<AnyMessage, { type: "step.approval_required" }>;
    expect(ask.level).toBe(2);
    await c.approve(ask, true);
    const mine = (m: AnyMessage) => m.type === "step.finished" && m.runId === ask.runId && m.stepId === ask.stepId;
    await until(() => msgs.some(mine));
    expect((msgs.find(mine) as { ok: boolean }).ok).toBe(true);
    const box = provider.boxes.get(store.getComputer(c.accountId!)!.sandboxId) as FakeSandbox;
    expect(box.commands.some((x) => x.cmd === "git push origin main")).toBe(true);

    // 终端
    const term = await c.openTerminal(80, 24);
    const got: string[] = [];
    term.onData((b) => got.push(new TextDecoder().decode(b)));
    await until(() => box.ptys.length > 0);
    term.write("echo hi\n");
    await until(() => box.ptys[0]!.input.length > 0);
    expect(new TextDecoder().decode(box.ptys[0]!.input[0])).toBe("echo hi\n");
    box.ptys[0]!.emit("hi\r\n");
    await until(() => got.length > 0);
    expect(got[0]).toBe("hi\r\n");
    term.close();

    // hub 重启连接（模拟网络断开）：自动重连并重新握手，还能用
    (c as unknown as { ws: WebSocket }).ws.close();
    await until(() => c.state !== "online");
    await until(() => c.state === "online", 5000);
    const st2 = await c.request({ type: "cloud.status.get" }, "cloud.status");
    expect(st2.state).toBe("running");
    c.stop();
  }, 30_000);

  test("两台手机是两个账号、两台云电脑", async () => {
    const a = new CuaClient({ url: srv.url, identity: await newIdentity(), name: "A" });
    const b = new CuaClient({ url: srv.url, identity: await newIdentity(), name: "B" });
    a.start();
    b.start();
    await until(() => a.state === "online" && b.state === "online");
    expect(a.accountId).not.toBe(b.accountId);
    a.stop();
    b.stop();
  });
});
