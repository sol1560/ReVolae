import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceToPhone } from "@cuaremote/protocol";
import { JevClient, LocalBunHost, MockProvider } from "@cuaremote/brain";
import { PocSession } from "../src/session.js";
import { createPocServer, providerOptions } from "../src/server.js";

const noJev = new JevClient({ apiKey: "" });

function makeSession(autonomy: "cautious" | "balanced" | "handsoff") {
  const out: DeviceToPhone[] = [];
  const waiters: { pred: (m: DeviceToPhone) => boolean; resolve: (m: DeviceToPhone) => void }[] = [];
  const dir = mkdtempSync(join(tmpdir(), "poc-"));
  const s = new PocSession({
    send: (m) => {
      out.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    },
    host: new LocalBunHost({ scope: { allowedDirs: [dir] }, loginShell: false }),
    providerFactory: (id) => { if (id.startsWith("mock")) return new MockProvider(id); throw new Error(`没有 ${id} 的 key`); },
    jev: noJev,
    autonomy,
    approvalTtlSec: 2,
  });
  const until = (pred: (m: DeviceToPhone) => boolean, ms = 5000) =>
    new Promise<DeviceToPhone>((resolve, reject) => {
      const hit = out.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`等消息超时。已收到：${out.map((m) => m.type).join(",")}`)), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  const submit = (text: string, mode: "agent" | "terminal" = "agent", provider = "mock") =>
    s.handle({ v: 1, id: `i-${Math.random()}`, type: "intent.submit", text, deviceId: "local", mode, provider });
  return { s, out, until, submit, dir };
}

const ofType = <T extends DeviceToPhone["type"]>(t: T) => (m: DeviceToPhone): m is Extract<DeviceToPhone, { type: T }> => m.type === t;

describe("PocSession", () => {
  test("放手档：shell 步骤自动放行，输出回传，成本为 0", async () => {
    const { s, out, until, submit } = makeSession("handsoff");
    await s.hello();
    const cap = await until(ofType("capabilities"));
    expect(cap.type === "capabilities" && cap.brainAvailable).toBe(true);
    expect(cap.type === "capabilities" && cap.tools.some((t) => t.name === "shell.run")).toBe(true);

    await submit("shell: echo poc-hello");
    const fin = await until(ofType("run.finished"));
    if (fin.type !== "run.finished") throw new Error();
    expect(fin.ok).toBe(true);
    const types = out.map((m) => m.type);
    // 顺序：ack → run.created → step.started → step.precheck → step.finished → plan.updated → run.finished
    expect(types.indexOf("run.created")).toBeLessThan(types.indexOf("step.started"));
    expect(types.indexOf("step.precheck")).toBeLessThan(types.indexOf("step.finished"));
    expect(types).not.toContain("step.approval_required");
    const pc = out.find(ofType("step.precheck"));
    expect(pc && pc.type === "step.precheck" && pc.verdict).toBe("allow");
    expect(pc && pc.type === "step.precheck" && pc.source).toBe("static");
    const sf = out.find(ofType("step.finished"));
    expect(sf && sf.type === "step.finished" && sf.output?.trim()).toBe("poc-hello");
    // mock 模型是 local 档，数据没出设备
    expect(sf && sf.type === "step.finished" && sf.dataLeftDevice).toBe(false);
    expect(fin.cost.usd).toBe(0);
  });

  test("平衡档无 Jev：写入步骤要确认；同意后执行；错的 stepId 报错", async () => {
    const { s, out, until, submit } = makeSession("balanced");
    await submit("shell: echo needs-ok");
    const req = await until(ofType("step.approval_required"));
    if (req.type !== "step.approval_required") throw new Error();
    expect(req.level).toBe(1);
    expect(req.action.detail).toContain("echo needs-ok");
    expect(req.challenge.length).toBeGreaterThan(10);

    await s.handle({ v: 1, id: "bad", type: "approval.decision", runId: req.runId, stepId: "nope", allow: true });
    const err = await until((m) => m.type === "error" && m.ref === "bad");
    expect(err.type === "error" && err.code).toBe("no_pending_approval");

    await s.handle({ v: 1, id: "ok1", type: "approval.decision", runId: req.runId, stepId: req.stepId, allow: true, remember: "once" });
    const sf = await until(ofType("step.finished"));
    expect(sf.type === "step.finished" && sf.ok).toBe(true);
    expect(sf.type === "step.finished" && sf.output?.trim()).toBe("needs-ok");
    const fin = await until(ofType("run.finished"));
    expect(fin.type === "run.finished" && fin.ok).toBe(true);
    expect(out.filter(ofType("step.approval_required")).length).toBe(1);
  });

  test("拒绝：步骤标失败，不执行命令", async () => {
    const { s, until, submit, dir } = makeSession("balanced");
    const marker = join(dir, "should-not-exist");
    await submit(`shell: touch ${marker}`);
    const req = await until(ofType("step.approval_required"));
    if (req.type !== "step.approval_required") throw new Error();
    await s.handle({ v: 1, id: "d", type: "approval.decision", runId: req.runId, stepId: req.stepId, allow: false });
    const sf = await until(ofType("step.finished"));
    expect(sf.type === "step.finished" && sf.ok).toBe(false);
    expect(sf.type === "step.finished" && sf.error).toContain("拒绝");
    await until(ofType("run.finished"));
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("「以后自动」：同一命令第二次不再问", async () => {
    const { s, out, until, submit } = makeSession("balanced");
    await submit("shell: echo twice");
    const req = await until(ofType("step.approval_required"));
    if (req.type !== "step.approval_required") throw new Error();
    await s.handle({ v: 1, id: "a", type: "approval.decision", runId: req.runId, stepId: req.stepId, allow: true, remember: "always" });
    await until(ofType("run.finished"));
    out.length = 0;
    await submit("shell: echo twice");
    const fin = await until(ofType("run.finished"));
    expect(fin.type === "run.finished" && fin.ok).toBe(true);
    expect(out.some(ofType("step.approval_required"))).toBe(false);
    const pc = out.find(ofType("step.precheck"));
    expect(pc && pc.type === "step.precheck" && pc.verdict).toBe("allow");
  });

  test("确认超时 → 视为拒绝", async () => {
    const { s, until, submit } = makeSession("balanced");
    await submit("shell: echo late");
    await until(ofType("step.approval_required"));
    const sf = await until(ofType("step.finished"), 4000);
    expect(sf.type === "step.finished" && sf.ok).toBe(false);
    s.close();
  });

  test("取消：跑到一半 run.finished cancelled=true，等待中的确认被回收", async () => {
    const { s, until, submit } = makeSession("balanced");
    await submit("shell: echo a && then: echo b");
    const req = await until(ofType("step.approval_required"));
    if (req.type !== "step.approval_required") throw new Error();
    await s.handle({ v: 1, id: "c", type: "run.cancel", runId: req.runId });
    const fin = await until(ofType("run.finished"));
    expect(fin.type === "run.finished" && fin.cancelled).toBe(true);
    expect(s.busy).toBe(false);
  });

  test("忙的时候再发意图 → busy；模型没 key → provider_unavailable；坏消息 → bad_message", async () => {
    const { s, until, submit } = makeSession("balanced");
    await submit("shell: echo first");
    await until(ofType("step.approval_required"));
    await submit("shell: echo second");
    const busy = await until((m) => m.type === "error" && m.code === "busy");
    expect(busy.type).toBe("error");
    s.close();
    await until(ofType("run.finished"));

    await submit("shell: echo x", "agent", "anthropic:claude-fable-5.1");
    const pe = await until((m) => m.type === "error" && m.code === "provider_unavailable");
    expect(pe.type === "error" && pe.message).toContain("anthropic");

    await s.handle({ v: 1, id: "z", type: "intent.submit", text: "" });
    const bad = await until((m) => m.type === "error" && m.code === "bad_message");
    expect(bad.type === "error" && bad.ref).toBe("z");
  });

  test("终端模式：只给命令不执行", async () => {
    const { s, out, until, submit } = makeSession("cautious");
    // mock 在 terminal 模式下没有 propose_command 逻辑，会直接回答文本；这里验证不会执行任何 shell 步骤
    await submit("shell: echo should-not-run", "terminal");
    const fin = await until(ofType("run.finished"));
    expect(fin.type).toBe("run.finished");
    expect(out.some((m) => m.type === "step.finished" && m.ok && m.output?.includes("should-not-run"))).toBe(false);
  });

  test("历史：跑完的任务能翻出来", async () => {
    const { s, until, submit } = makeSession("handsoff");
    await submit("shell: echo h1");
    await until(ofType("run.finished"));
    await s.handle({ v: 1, id: "h", type: "history.list" });
    const page = await until(ofType("history.page"));
    if (page.type !== "history.page") throw new Error();
    expect(page.items.length).toBe(1);
    expect(page.items[0]!.intent).toBe("shell: echo h1");
    expect(page.items[0]!.ok).toBe(true);
  });
});

describe("createPocServer", () => {
  test("首页 / providers 接口 / WS 一连上就收到 capabilities", async () => {
    const { server, close } = createPocServer({ port: 0, hostname: "127.0.0.1", env: { ANTHROPIC_API_KEY: "x" } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const html = await (await fetch(base + "/")).text();
      expect(html).toContain("CuaRemote");
      expect(html).toContain('id="sheet"');
      const p = (await (await fetch(base + "/api/providers")).json()) as { default: string; options: { id: string; available: boolean }[] };
      expect(p.default).toBe("mock");
      expect(p.options.find((o) => o.id.startsWith("anthropic:"))!.available).toBe(true);
      expect(p.options.find((o) => o.id.startsWith("openai:"))!.available).toBe(false);

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const first = await new Promise<DeviceToPhone>((resolve, reject) => {
        ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
        ws.onerror = () => reject(new Error("ws error"));
      });
      expect(first.type).toBe("capabilities");
      ws.close();
    } finally {
      close();
    }
  });

  test("providerOptions：没有任何 key 时只有 mock 和本地模型可用", () => {
    const opts = providerOptions({});
    expect(opts.filter((o) => o.available).map((o) => o.id.split(":")[0])).toEqual(["mock", "ollama", "lmstudio"]);
  });
});
