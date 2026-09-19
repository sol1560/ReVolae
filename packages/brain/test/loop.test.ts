import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnyMessage, mkMsg, type MsgBody } from "@cuaremote/protocol";
import { runIntent, type ApprovalGate, type BrainEvent } from "../src/agent/loop.js";
import { LocalBunHost } from "../src/host/local-bun-host.js";
import { PolicyEngine } from "../src/jev/policy.js";
import { MockProvider } from "../src/llm/mock.js";

function setup(autonomy: "cautious" | "balanced" | "handsoff", gate?: ApprovalGate) {
  const dir = mkdtempSync(join(tmpdir(), "cuaremote-"));
  const host = new LocalBunHost({ scope: { allowedDirs: [dir], deniedCommands: ["sudo"] }, shell: "/bin/sh", loginShell: false });
  const events: BrainEvent[] = [];
  const asked: { level: number; detail: string }[] = [];
  const approvals: ApprovalGate = gate ?? { request: async (r) => { asked.push({ level: r.level, detail: r.action.detail }); return { allow: true, remember: "once" }; } };
  const deps = { host, provider: new MockProvider(), policy: new PolicyEngine({ jevEnabled: false, autonomy }), approvals, emit: (e: BrainEvent) => events.push(e) };
  return { dir, deps, events, asked };
}
const types = (events: BrainEvent[]) => events.map((e) => e.type);

describe("agent loop（mock 模型 + 本地宿主）", () => {
  test("放手档：一步 shell 直接执行并回传输出", async () => {
    const { deps, events } = setup("handsoff");
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo hello-loop", mode: "agent" });
    expect(out.ok).toBe(true);
    expect(out.stepCount).toBe(1);
    expect(out.summary).toContain("hello-loop");
    expect(types(events)).toEqual(["run.created", "step.started", "step.precheck", "step.finished", "plan.updated", "run.finished"]);
    const fin = events.find((e) => e.type === "step.finished") as Extract<BrainEvent, { type: "step.finished" }>;
    expect(fin.ok).toBe(true);
    expect(fin.output?.trim()).toBe("hello-loop");
    expect(fin.dataLeftDevice).toBe(false); // mock 是本地档位
    const created = events[0] as Extract<BrainEvent, { type: "run.created" }>;
    expect(created.plan).toHaveLength(1);
    expect(created.plan[0]!.channel).toBe("shell");
  });

  test("平衡档：L1 要先确认，审批卡片带完整命令，允许后执行", async () => {
    const { deps, events, asked } = setup("balanced");
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo need-ok", mode: "agent" });
    expect(out.ok).toBe(true);
    expect(asked).toEqual([{ level: 1, detail: "echo need-ok" }]);
    expect(types(events)).toContain("step.approval_required");
    const req = events.find((e) => e.type === "step.approval_required") as Extract<BrainEvent, { type: "step.approval_required" }>;
    expect(req.challenge.split("\n")[0]).toBe("cuaremote-approval-v1");
    expect(req.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(req.action.summary).toContain("echo need-ok");
  });

  test("用户拒绝：这一步失败，模型收到拒绝提示后结束，run 不算成功执行", async () => {
    const { deps, events } = setup("balanced", { request: async () => ({ allow: false, remember: "once" }) });
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo nope", mode: "agent" });
    const fin = events.find((e) => e.type === "step.finished") as Extract<BrainEvent, { type: "step.finished" }>;
    expect(fin.ok).toBe(false);
    expect(fin.error).toContain("拒绝");
    // mock 收到拒绝后不再有 tool 输出，会直接给一句话收尾
    expect(out.stepCount).toBe(1);
  });

  test("deniedCommands：策略直接拒绝，不问用户", async () => {
    const { deps, events, asked } = setup("handsoff");
    await runIntent(deps, { deviceId: "d", intent: "shell: sudo id", mode: "agent" });
    expect(asked).toHaveLength(0);
    const pre = events.find((e) => e.type === "step.precheck") as Extract<BrainEvent, { type: "step.precheck" }>;
    expect(pre.verdict).toBe("deny");
    const fin = events.find((e) => e.type === "step.finished") as Extract<BrainEvent, { type: "step.finished" }>;
    expect(fin.ok).toBe(false);
  });

  test("两步意图：第二步复用计划里的 s2，不额外追加", async () => {
    const { deps, events } = setup("handsoff");
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo a && then: echo b", mode: "agent" });
    expect(out.stepCount).toBe(2);
    const started = events.filter((e) => e.type === "step.started") as Extract<BrainEvent, { type: "step.started" }>[];
    expect(started.map((s) => s.stepId)).toEqual(["s1", "s2"]);
    expect(types(events).filter((t) => t === "plan.updated")).toHaveLength(1);
  });

  test("作用域：fs 路径越界由宿主拒绝，步骤失败", async () => {
    const { deps, events, dir } = setup("handsoff");
    writeFileSync(join(dir, "ok.txt"), "inside");
    // 直接调宿主验证边界
    expect((await deps.host.call("fs.read", { path: join(dir, "ok.txt") })).output).toBe("inside");
    const r = await deps.host.call("fs.read", { path: "/etc/hostname" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不在允许的目录");
    expect(events).toHaveLength(0);
  });

  test("终端模式：只给建议，不执行", async () => {
    const { deps, events } = setup("balanced");
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo term", mode: "terminal", terminalSessionId: "t1" });
    expect(out.ok).toBe(true);
    // mock 在终端模式没有 propose_command 意识，会直接调 shell.run，但 shell.run 在 terminal 模式不在工具表里 → 被视为没有工具
    expect(types(events)).not.toContain("step.finished");
  });

  test("取消：signal abort 后下一轮结束，cancelled=true", async () => {
    const { deps } = setup("handsoff");
    const ctrl = new AbortController();
    const p = runIntent({ ...deps, signal: ctrl.signal }, { deviceId: "d", intent: "shell: sleep 0.2 && then: echo second", mode: "agent" });
    setTimeout(() => ctrl.abort(), 50);
    const out = await p;
    expect(out.cancelled).toBe(true);
    expect(out.ok).toBe(false);
  });
});

describe("host 模式（brain 被 spawn，stdio 协议）", () => {
  test("intent.submit → tools.list → tools.call → approval → run.finished", async () => {
    const proc = spawn("bun", ["run", join(import.meta.dir, "..", "src", "cli.ts"), "--mode", "host", "--provider", "mock", "--cua", "definitely-not-a-binary", "--log", join(tmpdir(), "cuaremote-test.jsonl")], { stdio: ["pipe", "pipe", "pipe"] });
    const seen: AnyMessage[] = [];
    const write = (m: MsgBody) => proc.stdin.write(JSON.stringify(mkMsg(m)) + "\n");
    const result = await new Promise<AnyMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("超时 " + seen.map((s) => s.type).join(","))), 20_000);
      let buf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const m = AnyMessage.parse(JSON.parse(line));
          seen.push(m);
          if (m.type === "tools.list") write({ type: "tools.list.result", tools: [{ name: "shell.run", description: "", channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: true, inputSchema: {} }], scope: { allowedDirs: [], allowedApps: [], deniedCommands: [] } });
          if (m.type === "tools.call") write({ type: "tools.result", callId: m.callId, ok: true, output: `宿主执行了 ${m.args.cmd}`, attachments: [], ms: 3 });
          if (m.type === "step.approval_required") write({ type: "approval.decision", runId: m.runId, stepId: m.stepId, allow: true, remember: "once" });
          if (m.type === "run.finished") { clearTimeout(timer); resolve(m); }
        }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", () => {});
      write({ type: "intent.submit", text: "shell: echo via-host", deviceId: "dev", mode: "agent" });
    });
    proc.kill();
    expect(result.type).toBe("run.finished");
    expect((result as Extract<AnyMessage, { type: "run.finished" }>).ok).toBe(true);
    const order = seen.map((s) => s.type);
    expect(order.indexOf("tools.list")).toBeLessThan(order.indexOf("run.created"));
    expect(order).toContain("step.approval_required");
    expect(order.indexOf("step.approval_required")).toBeLessThan(order.indexOf("tools.call"));
    const fin = seen.find((s) => s.type === "step.finished") as Extract<AnyMessage, { type: "step.finished" }>;
    expect(fin.output).toContain("宿主执行了 echo via-host");
    expect(fin.dataLeftDevice).toBe(false);
  }, 30_000);
});
