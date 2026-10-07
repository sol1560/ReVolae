import { afterAll, describe, expect, test } from "bun:test";
import { CloudComputers } from "@cuaremote/cloud-computer";
import { signTerminalOpen } from "@cuaremote/protocol";
import { FakeProvider, FakeSandbox } from "../../../packages/cloud-computer/test/fake.js";
import { brainIdOf } from "../src/cloud-brain.js";
import { CloudComputerService, cloudDeviceIdOf, safeFileName, uniqueName } from "../src/cloud-computer.js";
import { HubStore } from "../src/db.js";
import { createHubServer } from "../src/server.js";
import { Endpoint } from "./helpers.js";
import { PhoneLink } from "./phone-link.js";

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
}

describe("hub 小工具", () => {
  test("上传文件名去掉路径、重名加序号", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a\\b\\c.pdf")).toBe("c.pdf");
    expect(safeFileName("..")).toBe("upload");
    expect(uniqueName("a.pdf", new Set(["a.pdf", "a (2).pdf"]))).toBe("a (3).pdf");
    expect(uniqueName("b.pdf", new Set(["a.pdf"]))).toBe("b.pdf");
  });
});

describe("云电脑（hub + 云端大脑 + 假沙箱）", () => {
  const provider = new FakeProvider();
  const store = new HubStore(":memory:");
  const computers = new CloudComputers({ provider, store, template: "cuaremote-cloud" });
  const cloud = new CloudComputerService({ computers, variantsAllowed: async () => 3 });
  const srv = createHubServer({ port: 0, store, publicURL: "ws://hub.test/ws", cloudBrain: { defaultProvider: "mock", cloud } });
  const url = () => `ws://127.0.0.1:${srv.server.port}/ws`;
  const brainId = brainIdOf("local");
  const deviceId = cloudDeviceIdOf("local");
  afterAll(() => {
    srv.cloudBrain?.stopAll();
    void srv.server.stop(true);
  });

  test("设备列表、状态、跑任务、上传、文件、下载、撤销、终端", async () => {
    const phone = await Endpoint.make("phone-cc", "phone", "Ed25519");
    await phone.login(url(), { platform: "ios" });

    // 设备列表第一项就是云电脑，不用配对
    phone.send({ type: "devices.list" });
    const page = await phone.expect("devices.page");
    expect(page.devices[0]).toMatchObject({ deviceId, platform: "cloud", name: "云电脑", online: true, paired: true });

    const link = await new PhoneLink(phone, brainId).open();

    // 还没建机器
    await link.send({ type: "cloud.status.get" });
    const st0 = await link.expect("cloud.status");
    expect(st0).toMatchObject({ deviceId, state: "none", variantsAllowed: 3, snapshots: [] });
    expect(st0.cards.length).toBeGreaterThanOrEqual(5);

    // 在云电脑上跑任务：沙箱工具 L0，不用确认；跑之前存了快照
    await link.send({ type: "intent.submit", text: "shell: echo hello-cloud", deviceId, mode: "agent" });
    const created = await link.expect("run.created");
    expect(created.deviceId).toBe(deviceId);
    const step = await link.expect("step.finished", (m) => m.runId === created.runId);
    expect(step.ok).toBe(true);
    const fin = await link.expect("run.finished", (m) => m.runId === created.runId);
    expect(fin.ok).toBe(true);
    const box = provider.boxes.get(store.getComputer("local")!.sandboxId)!;
    const ran = box.commands.find((c) => c.cmd === "echo hello-cloud");
    expect(ran?.cwd).toBe("/home/user/work");

    await link.send({ type: "cloud.status.get" });
    const st1 = await link.expect("cloud.status");
    expect(st1.state).toBe("running");
    expect(st1.snapshots).toEqual([{ runId: created.runId, createdAt: expect.any(Number), title: "shell: echo hello-cloud" }]);

    // 上传：拿直传地址，放进 inbox，文件名去掉路径，重名自动改名
    await box.write("/home/user/work/inbox/合同.pdf", "old");
    await link.send({ type: "cloud.upload.begin", name: "../合同.pdf" });
    const up = await link.expect("cloud.upload.url");
    expect(up.path).toBe("/home/user/work/inbox/合同 (2).pdf");
    expect(up.url).toContain("/home/user/work/inbox/合同 (2).pdf");

    // 文件列表（顺带建好 inbox / out）
    await box.write("/home/user/work/out.docx", "docx");
    await link.send({ type: "cloud.files.list" });
    const files = await link.expect("cloud.files");
    expect(files.path).toBe("/home/user/work");
    expect(files.entries.map((e) => e.name)).toContain("out.docx");

    // 下载
    await link.send({ type: "cloud.download.get", path: "out.docx" });
    expect(await link.expect("cloud.download")).toMatchObject({ name: "out.docx", size: 4 });
    await link.send({ type: "cloud.download.get", path: "nope.docx" });
    expect((await link.expect("error", (m) => m.code === "not_found")).message).toContain("nope.docx");

    // 整机撤销：用快照新建一台，旧的删掉
    const before = store.getComputer("local")!.sandboxId;
    await link.send({ type: "cloud.undo", runId: created.runId });
    const st2 = await link.expect("cloud.status");
    expect(st2.snapshots).toEqual([]);
    expect(store.getComputer("local")!.sandboxId).not.toBe(before);
    expect(provider.killed).toContain(before);

    // 终端：签名打开 → 输入到假 PTY → 输出回到手机
    const sessionId = "sess-cloud-1";
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const signature = signTerminalOpen({ sessionId, deviceId, privateKey: phone.sig.privateKey, alg: phone.alg, keyId: "k", nonce: "n-cloud-1", expiresAt });
    await link.send({ type: "terminal.open", sessionId, cols: 80, rows: 24, signature });
    const opened = await link.expect("terminal.opened").catch((e) => { throw new Error(`${e.message} \n${JSON.stringify(link.inbox.filter((m) => m.type === "error"))}`); });
    const nowBox = provider.boxes.get(store.getComputer("local")!.sandboxId) as FakeSandbox;
    await until(() => nowBox.ptys.length > 0);
    const fakePty = nowBox.ptys[0]!;
    expect(fakePty.opts).toMatchObject({ cols: 80, rows: 24 });
    await link.sendFrame({ kind: 1, streamId: opened.streamId, payload: new TextEncoder().encode("ls\n") });
    await until(() => fakePty.input.length > 0);
    expect(new TextDecoder().decode(fakePty.input[0])).toBe("ls\n");
    fakePty.emit("out.docx\r\n");
    await until(() => link.pty.length > 0);
    expect(new TextDecoder().decode(link.pty[0]!.payload)).toBe("out.docx\r\n");

    // 没签名的 terminal.open 被拒
    await link.send({ type: "terminal.open", sessionId: "sess-cloud-2", cols: 80, rows: 24 });
    expect((await link.expect("error", (m) => m.code === "approval_invalid")).code).toBe("approval_invalid");

    link.stop();
    phone.close();
  }, 30_000);
});

describe("分叉挑选", () => {
  test("试 3 种：每份各跑一遍，结果推给手机；挑中的成为主机器，其余删掉；没有权益时只跑一份", async () => {
    const provider = new FakeProvider();
    const store = new HubStore(":memory:");
    let allowed = 3;
    const computers = new CloudComputers({ provider, store, template: "t" });
    const cloud = new CloudComputerService({ computers, variantsAllowed: async () => allowed });
    const srv = createHubServer({ port: 0, store, cloudBrain: { defaultProvider: "mock", cloud } });
    try {
      const phone = await Endpoint.make("phone-var", "phone", "Ed25519");
      await phone.login(srv.url);
      const link = await new PhoneLink(phone, brainIdOf("local")).open();
      const deviceId = cloudDeviceIdOf("local");

      await link.send({ type: "intent.submit", text: "shell: echo variant", deviceId, mode: "agent", variants: 3 });
      const parent = await link.expect("run.created", (m) => !m.parentRunId);
      const kids = await Promise.all([1, 2, 3].map(() => link.expect("run.created", (m) => m.parentRunId === parent.runId)));
      expect(kids.map((k) => k.runId).sort()).toEqual([1, 2, 3].map((i) => `${parent.runId}.${i}`));
      expect(new Set(kids.map((k) => k.approach)).size).toBe(3);

      const v = await link.expect("cloud.variants", (m) => m.runId === parent.runId);
      expect(v.items).toHaveLength(3);
      expect(v.items.every((it) => it.ok)).toBe(true);
      const fin = await link.expect("run.finished", (m) => m.runId === parent.runId);
      expect(fin.summary).toContain("3 种做法");

      // 三份都真的在各自的沙箱里跑了，主机器没动
      const main = store.getComputer("local")!.sandboxId;
      for (const it of v.items) expect(provider.boxes.get(it.forkId)!.commands.some((c) => c.cmd === "echo variant")).toBe(true);
      expect(provider.boxes.get(main)!.commands.some((c) => c.cmd === "echo variant")).toBe(false);

      await link.send({ type: "cloud.pick", runId: parent.runId, forkId: v.items[1]!.forkId });
      await link.expect("cloud.status");
      expect(store.getComputer("local")!.sandboxId).toBe(v.items[1]!.forkId);
      await until(() => provider.killed.length >= 3);
      expect(provider.killed.sort()).toEqual([main, v.items[0]!.forkId, v.items[2]!.forkId].sort());

      // 挑过了再挑：报错
      await link.send({ type: "cloud.pick", runId: parent.runId, forkId: v.items[0]!.forkId });
      expect((await link.expect("error", (m) => m.code === "no_variants")).message).toContain("没有待挑选");

      // 没有 pro 权益：要 3 份也只跑一份，不分叉
      allowed = 1;
      const forksBefore = provider.boxes.size;
      await link.send({ type: "intent.submit", text: "shell: echo single", deviceId, mode: "agent", variants: 3 });
      const single = await link.expect("run.created", (m) => m.intent === "shell: echo single");
      expect(single.parentRunId).toBeUndefined();
      await link.expect("run.finished", (m) => m.runId === single.runId);
      expect(provider.boxes.size).toBe(forksBefore);
      link.stop();
      phone.close();
    } finally {
      srv.cloudBrain?.stopAll();
      void srv.server.stop(true);
    }
  }, 30_000);
});

