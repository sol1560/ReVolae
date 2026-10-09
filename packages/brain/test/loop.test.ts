import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AnyMessage, mkMsg, shellApprovalDetail, type MsgBody } from "@cuaremote/protocol";
import { runIntent, type ApprovalGate, type ApprovalRequest, type BrainEvent } from "../src/agent/loop.js";
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
  test("取消等待审批的任务后，即使批准也不能调用工具", async () => {
    const ctrl = new AbortController();
    const { deps } = setup("balanced", { request: async () => {
      ctrl.abort();
      return { allow: true, remember: "once" };
    } });
    let calls = 0;
    deps.host.call = async () => { calls++; throw new Error("不应执行"); };
    const out = await runIntent({ ...deps, signal: ctrl.signal }, { deviceId: "d", intent: "shell: echo cancelled", mode: "agent" });
    expect(calls).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.cancelled).toBe(true);
  });

  test("原生模式拒绝后结束任务，不能由模型把失败改写为成功", async () => {
    const { deps } = setup("balanced", { request: async () => ({ allow: false, remember: "once" }) });
    let calls = 0;
    deps.host.call = async () => { calls++; throw new Error("不应执行"); };
    const out = await runIntent({ ...deps, stopOnFailure: true }, { deviceId: "d", intent: "shell: echo denied", mode: "agent" });
    expect(calls).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("拒绝");
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

  test("shell cwd 默认和相对路径在审批与工具调用前规范化", async () => {
    const command = "echo cwd-bound";
    const runShell = async (modelCwd?: string | null) => {
      const requests: ApprovalRequest[] = [];
      const { deps } = setup("balanced", {
        request: async (request) => {
          requests.push(request);
          return { allow: true, remember: "once" };
        },
      });
      const root = deps.host.scope.allowedDirs[0]!;
      const listed = await deps.host.listTools();
      const tools = listed.tools.map((tool) => tool.name === "shell.run"
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...(tool.inputSchema.properties as Record<string, unknown>),
                cwd: { type: "string", default: root },
              },
            },
          }
        : tool);
      deps.host.listTools = async () => ({ tools, scope: listed.scope });

      const policyArgs: Record<string, unknown>[] = [];
      const decide = deps.policy.decide.bind(deps.policy);
      deps.policy.decide = async (request) => {
        if (request.tool.name === "shell.run") policyArgs.push(request.args);
        return decide(request);
      };
      const calls: { tool: string; args: Record<string, unknown> }[] = [];
      deps.host.call = async (tool, args) => {
        calls.push({ tool, args });
        return { ok: true, output: "done", attachments: [], ms: 1 };
      };

      const provider = deps.provider;
      const chat = provider.chat.bind(provider);
      provider.chat = async (request) => {
        const response = await chat(request);
        const shellCall = response.toolCalls.find((toolCall) => toolCall.name === "shell.run");
        if (shellCall && modelCwd !== undefined) shellCall.args.cwd = modelCwd;
        return response;
      };
      await runIntent(deps, { deviceId: "phone", intent: `shell: ${command}`, mode: "agent" });
      return { root, requests, policyArgs, calls };
    };

    const omitted = await runShell();
    const defaultAction = shellApprovalDetail(command, omitted.root);
    expect(omitted.requests[0]?.action.detail).toBe(defaultAction);
    expect(omitted.requests[0]?.action.targetPath).toBe(omitted.root);
    expect(omitted.calls[0]).toEqual({ tool: "shell.run", args: { cmd: command, cwd: omitted.root } });
    expect(omitted.policyArgs[0]).toBe(omitted.calls[0]?.args);

    const relative = await runShell("nested/../inside");
    const resolvedCwd = resolve(relative.root, "nested/../inside");
    const relativeAction = shellApprovalDetail(command, resolvedCwd);
    expect(relative.requests[0]?.action.detail).toBe(relativeAction);
    expect(relative.requests[0]?.action.targetPath).toBe(resolvedCwd);
    expect(relative.calls[0]).toEqual({ tool: "shell.run", args: { cmd: command, cwd: resolvedCwd } });
    expect(relative.policyArgs[0]).toBe(relative.calls[0]?.args);
    expect(relativeAction).not.toBe(defaultAction);

    const invalid = await runShell(null);
    expect(invalid.requests[0]?.action.detail).toBe(command);
    expect(invalid.calls[0]?.args.cwd).toBeNull();
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

  test("终端模式：宿主有 terminal.blocks 时，最近命令块先进上下文；没有会话 id 或没有这个工具时不调", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const seen: string[] = [];
    const blocksTool = { name: "terminal.blocks", description: "最近命令块", channel: "terminal" as const, staticLevel: 0 as const, costClass: 0 as const, dataLeavesDevice: true, inputSchema: {} };
    const fakeHost = {
      listTools: async () => ({ tools: [blocksTool], scope: { allowedDirs: [], allowedApps: [], deniedCommands: [] } }),
      call: async (tool: string, args: Record<string, unknown>) => {
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
    await runIntent(deps, { deviceId: "d", intent: "为什么测试挂了", mode: "terminal", terminalSessionId: "t9" });
    expect(calls[0]).toEqual({ tool: "terminal.blocks", args: { sessionId: "t9", limit: 5 } });
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
