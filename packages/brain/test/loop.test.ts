import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnyMessage, approvalChallenge, mkMsg, type MsgBody } from "@cuaremote/protocol";
import { describe as describeAction, runIntent, type ApprovalGate, type BrainEvent } from "../src/agent/loop.js";
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
  test("脚本和快捷指令审批详情绑定全部调用参数", () => {
    const appleTool = { name: "applescript.run", description: "", channel: "applescript" as const, staticLevel: 1 as const, costClass: 0 as const, dataLeavesDevice: true, inputSchema: {} };
    const scriptArgs = { script: 'tell application "Notes" to return "a\\nb"', timeoutMs: 12_000 };
    const scriptAction = describeAction(appleTool, scriptArgs);
    expect(scriptAction.detail).toBe(`applescript.run\n${JSON.stringify(scriptArgs, null, 2)}`);
    expect(scriptAction.targetApp).toBe("Notes");

    const shortcutTool = { name: "shortcuts.run", description: "", channel: "shortcuts" as const, staticLevel: 1 as const, costClass: 0 as const, dataLeavesDevice: true, inputSchema: {} };
    const shortcutArgs = { name: "写日记☃", input: "带引号：\"\n第二行" };
    expect(describeAction(shortcutTool, shortcutArgs).detail).toBe(`shortcuts.run\n${JSON.stringify(shortcutArgs, null, 2)}`);
  });

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
    const { deps, events, asked, dir } = setup("balanced");
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo need-ok", mode: "agent" });
    expect(out.ok).toBe(true);
    expect(asked).toEqual([{ level: 1, detail: `shell.run\n${JSON.stringify({ cmd: "echo need-ok", cwd: realpathSync(dir), timeoutMs: 60_000 }, null, 2)}` }]);
    expect(types(events)).toContain("step.approval_required");
    const req = events.find((e) => e.type === "step.approval_required") as Extract<BrainEvent, { type: "step.approval_required" }>;
    expect(req.challenge.split("\n")[0]).toBe("cuaremote-approval-v1");
    expect(req.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(req.action.summary).toContain("echo need-ok");
    expect(req.action.targetPath).toBe(realpathSync(dir));
  });

  test("审批和策略绑定同一组规范化 shell 参数（cwd、stdin、默认 timeout）", async () => {
    const { deps, events, dir } = setup("balanced");
    mkdirSync(join(dir, "nested"));
    const providerChat = deps.provider.chat.bind(deps.provider);
    deps.provider.chat = async (request) => {
      const result = await providerChat(request);
      const shell = result.toolCalls.find((item) => item.name === "shell.run");
      if (shell) shell.args = { cmd: "cat", cwd: "nested", stdin: "审批☃\nstdin" };
      return result;
    };
    let policyArgs: Record<string, unknown> | undefined;
    const decide = deps.policy.decide.bind(deps.policy);
    deps.policy.decide = async (input) => {
      if (input.tool.name === "shell.run") policyArgs = input.args;
      return decide(input);
    };
    let hostArgs: Record<string, unknown> | undefined;
    const call = deps.host.call.bind(deps.host);
    deps.host.call = async (name, args, timeoutMs, signal) => {
      if (name === "shell.run") hostArgs = args;
      return call(name, args, timeoutMs, signal);
    };

    const out = await runIntent(deps, { runId: "normalized-shell", deviceId: "d", intent: "shell: cat", mode: "agent" });
    const approval = events.find((event) => event.type === "step.approval_required") as Extract<BrainEvent, { type: "step.approval_required" }>;
    const normalized = { cmd: "cat", cwd: join(realpathSync(dir), "nested"), timeoutMs: 60_000, stdin: "审批☃\nstdin" };
    const detail = `shell.run\n${JSON.stringify(normalized, null, 2)}`;
    expect(out.ok).toBe(true);
    expect(approval.action.detail).toBe(detail);
    expect(approval.action.targetPath).toBe(normalized.cwd);
    expect(policyArgs).toEqual(normalized);
    expect(hostArgs).toEqual(normalized);
    expect(hostArgs).toBe(policyArgs);
    expect((events.find((event) => event.type === "step.finished") as Extract<BrainEvent, { type: "step.finished" }>).output).toBe("审批☃\nstdin");

    const challengeArgs = { runId: approval.runId, stepId: approval.stepId, nonce: "fixed-nonce", expiresAt: approval.expiresAt };
    const baseChallenge = approvalChallenge({ ...challengeArgs, actionDetail: detail });
    const cwdChallenge = approvalChallenge({ ...challengeArgs, actionDetail: `shell.run\n${JSON.stringify({ ...normalized, cwd: `${normalized.cwd}-other` }, null, 2)}` });
    const stdinChallenge = approvalChallenge({ ...challengeArgs, actionDetail: `shell.run\n${JSON.stringify({ ...normalized, stdin: "different input" }, null, 2)}` });
    expect(cwdChallenge).not.toBe(baseChallenge);
    expect(stdinChallenge).not.toBe(baseChallenge);
  });

  test("用户拒绝：立即结束，不让模型换一种办法继续执行", async () => {
    const { deps, events } = setup("balanced", { request: async () => ({ allow: false, remember: "once" }) });
    let calls = 0;
    deps.host.call = async () => { calls++; throw new Error("不应执行"); };
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo nope", mode: "agent" });
    const fin = events.find((e) => e.type === "step.finished") as Extract<BrainEvent, { type: "step.finished" }>;
    expect(fin.ok).toBe(false);
    expect(fin.error).toContain("拒绝");
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("未执行");
    expect(out.stepCount).toBe(1);
    expect(events.at(-1)).toMatchObject({ status: "denied", cancelled: false });
    expect(calls).toBe(0);
  });

  test("确认过期属于失败，不假称用户拒绝；不执行工具", async () => {
    const { deps, events } = setup("balanced", { request: async () => ({ allow: false, remember: "once", failure: "确认请求已过期" }) });
    let calls = 0;
    deps.host.call = async () => { calls++; throw new Error("不应执行"); };
    await runIntent(deps, { deviceId: "d", intent: "shell: echo expired", mode: "agent" });
    expect(calls).toBe(0);
    expect(events.at(-1)).toMatchObject({ status: "failed", cancelled: false, summary: "确认请求已过期" });
  });

  test("允许返回时确认已过期：不调用工具", async () => {
    const { deps, events } = setup("balanced", { request: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { allow: true, remember: "once" };
    } });
    let calls = 0;
    deps.host.call = async () => { calls++; throw new Error("不应执行"); };
    const out = await runIntent({ ...deps, limits: { approvalTtlSec: 1 } }, { deviceId: "d", intent: "shell: echo expired-allow", mode: "agent" });
    expect(out).toMatchObject({ ok: false, status: "failed" });
    expect(calls).toBe(0);
    expect(events.find((event) => event.type === "step.finished")).toMatchObject({ ok: false, error: "确认已过期，未执行" });
  });

  test("参数准备失败：产生失败步骤且不调用宿主", async () => {
    const { deps, events } = setup("handsoff");
    let calls = 0;
    deps.host.prepareCall = async () => { throw new Error("cwd 已离开允许范围"); };
    deps.host.call = async () => { calls++; throw new Error("不应执行"); };
    const out = await runIntent(deps, { deviceId: "d", intent: "shell: echo blocked", mode: "agent" });
    expect(out).toMatchObject({ ok: false, status: "failed" });
    expect(calls).toBe(0);
    expect(events.find((event) => event.type === "step.finished")).toMatchObject({ ok: false, error: "cwd 已离开允许范围" });
  });

  test.each(["before", "response", "approval"] as const)("取消时机%s：不再执行，不误报成功或拒绝", async (when) => {
    const ctrl = new AbortController();
    const { deps, events } = setup("balanced", { request: async () => {
      ctrl.abort();
      return { allow: false, remember: "once" };
    } });
    let modelCalls = 0, toolCalls = 0;
    const chat = deps.provider.chat.bind(deps.provider);
    deps.provider.chat = async (request) => {
      modelCalls++;
      const result = await chat(request);
      if (when === "response" && !request.forceTool) ctrl.abort();
      return result;
    };
    deps.host.call = async () => { toolCalls++; throw new Error("不应执行"); };
    if (when === "before") ctrl.abort();
    await runIntent({ ...deps, signal: ctrl.signal }, { deviceId: "d", intent: when === "response" ? "只回答" : "shell: echo cancelled", mode: "agent" });
    expect(toolCalls).toBe(0);
    if (when === "before") expect(modelCalls).toBe(0);
    expect(events.at(-1)).toMatchObject({ ok: false, status: "cancelled", cancelled: true });
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
    const r = await deps.host.call("fs.read", { path: "/etc/passwd" });
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

  test("终端模式：宿主有 terminal.blocks 时，最近命令块先进上下文；没有会话 id 或没有这个工具时不调", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const seen: string[] = [];
    let passedSignal: AbortSignal | undefined;
    const blocksTool = { name: "terminal.blocks", description: "最近命令块", channel: "terminal" as const, staticLevel: 0 as const, costClass: 0 as const, dataLeavesDevice: true, inputSchema: {} };
    const fakeHost = {
      listTools: async () => ({ tools: [blocksTool], scope: { allowedDirs: [], allowedApps: [], deniedCommands: [] } }),
      call: async (tool: string, args: Record<string, unknown>, _timeoutMs?: number, signal?: AbortSignal) => {
        passedSignal = signal;
        calls.push({ tool, args });
        return { ok: true, ms: 1, attachments: [], output: JSON.stringify({ blocks: [
          { blockId: 1, state: "done", command: "git status", cwd: "/w", exitCode: 0, output: "On branch main" },
          { blockId: 2, state: "done", command: "bun test", cwd: "/w", exitCode: 1, output: "x".repeat(2000) + "\n1 fail" },
          { blockId: 3, state: "prompt" },
        ] }) };
      },
    };
    const spy = new MockProvider();
    const orig = spy.chat.bind(spy);
    spy.chat = async (req) => { seen.push(...req.messages.filter((m) => m.role === "user").map((m) => (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join(""))); return orig(req); };
    const deps = { host: fakeHost, provider: spy, policy: new PolicyEngine({ jevEnabled: false, autonomy: "balanced" as const }), approvals: { request: async () => ({ allow: true, remember: "once" as const }) }, emit: () => {} };
    const ctrl = new AbortController();
    await runIntent({ ...deps, signal: ctrl.signal }, { deviceId: "d", intent: "为什么测试挂了", mode: "terminal", terminalSessionId: "t9" });
    expect(calls[0]).toEqual({ tool: "terminal.blocks", args: { sessionId: "t9", limit: 5 } });
    expect(passedSignal).toBe(ctrl.signal);
    const ctx = seen[0]!;
    expect(ctx).toContain("$ git status");
    expect(ctx).toContain("[退出码 1]");
    expect(ctx).toContain("1 fail");
    expect(ctx).not.toContain("x".repeat(1600)); // 长输出只留尾部
    expect(ctx.indexOf("git status")).toBeLessThan(ctx.indexOf("bun test")); // 从旧到新
    expect(seen[1]).toBe("意图：为什么测试挂了"); // 意图在命令块之后

    calls.length = 0;
    await runIntent(deps, { deviceId: "d", intent: "x", mode: "terminal" });
    expect(calls).toHaveLength(0);
    await runIntent(deps, { deviceId: "d", intent: "x", mode: "agent", terminalSessionId: "t9" });
    expect(calls).toHaveLength(0);
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
