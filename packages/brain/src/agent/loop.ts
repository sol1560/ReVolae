import { randomUUID } from "node:crypto";
import { approvalChallenge, type Channel, type ConcreteAction, type Cost, type DeviceToPhone, type Level, type MsgBody, type PlanStep, type ToolDescriptor } from "@cuaremote/protocol";
import { CuaDriver } from "../gui/cua-driver.js";
import { jevAxDecide, toCuaCall } from "../gui/jev-ax.js";
import type { Host, ToolResult } from "../host/types.js";
import type { JevClient } from "../jev/client.js";
import { PolicyEngine } from "../jev/policy.js";
import type { ChatMessage, ContentPart, Provider, ToolCall, ToolSpec } from "../llm/types.js";
import { systemPrompt } from "./prompt.js";

/** 大脑对外发出的消息（DeviceToPhone 子集） */
export type BrainEvent = Extract<MsgBody<DeviceToPhone>, { type: `run.${string}` | `step.${string}` | `plan.${string}` | "terminal.suggestion" | "error" }>;

export interface ApprovalRequest {
  runId: string;
  stepId: string;
  level: Level;
  action: ConcreteAction;
  reason: string;
  challenge: string;
  expiresAt: number;
}
export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<{ allow: boolean; remember: "once" | "always" }>;
}

export interface AgentDeps {
  host: Host;
  provider: Provider;
  policy: PolicyEngine;
  approvals: ApprovalGate;
  emit: (e: BrainEvent) => void;
  gui?: CuaDriver;
  jev?: JevClient;
  log?: (rec: Record<string, unknown>) => void;
  limits?: { maxSteps?: number; maxUsd?: number; approvalTtlSec?: number };
  platform?: string;
  signal?: AbortSignal;
}

export interface RunInput {
  runId?: string;
  deviceId: string;
  intent: string;
  mode: "agent" | "terminal";
  terminalSessionId?: string;
}

export interface RunOutcome {
  runId: string;
  ok: boolean;
  summary: string;
  cost: Cost;
  stepCount: number;
  cancelled: boolean;
}

const PLAN_TOOL: ToolSpec = {
  name: "propose_plan",
  description: "给出执行计划。每步一句话，标注打算走的通道。",
  inputSchema: {
    type: "object",
    properties: { steps: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", properties: { title: { type: "string" }, channel: { type: "string", enum: ["shell", "applescript", "jxa", "shortcuts", "fs", "gui", "app", "ipad", "android"] } }, required: ["title", "channel"] } } },
    required: ["steps"],
  },
};
/** daemon 侧实现的 L0 工具：返回终端会话最近的命令块（见 docs/protocol.md「终端命令块」） */
export const TERMINAL_BLOCKS_TOOL = "terminal.blocks";
const RECENT_BLOCKS = 5;
const BLOCK_OUTPUT_CHARS = 1500;

interface BlockSummary { blockId?: number; state?: string; command?: string; cwd?: string; exitCode?: number; output?: string }

/** 把 terminal.blocks 的结果整理成一段给模型看的文字；宿主没返回有效内容时给 undefined */
export async function recentBlocksContext(host: Host, sessionId: string): Promise<string | undefined> {
  let res: ToolResult;
  try {
    res = await host.call(TERMINAL_BLOCKS_TOOL, { sessionId, limit: RECENT_BLOCKS }, 3000);
  } catch {
    return undefined;
  }
  if (!res.ok || !res.output) return undefined;
  let blocks: BlockSummary[];
  try {
    const parsed = JSON.parse(res.output) as unknown;
    blocks = Array.isArray(parsed) ? (parsed as BlockSummary[]) : ((parsed as { blocks?: BlockSummary[] }).blocks ?? []);
  } catch {
    return undefined;
  }
  const done = blocks.filter((b) => b.command && b.state !== "prompt").slice(-RECENT_BLOCKS);
  if (done.length === 0) return undefined;
  const lines = done.map((b) => {
    const head = `$ ${b.command}` + (b.cwd ? `   (目录 ${b.cwd})` : "") + (b.state === "running" ? "   [还在运行]" : b.exitCode !== undefined ? `   [退出码 ${b.exitCode}]` : "");
    const out = (b.output ?? "").trim();
    const tail = out.length > BLOCK_OUTPUT_CHARS ? "…" + out.slice(-BLOCK_OUTPUT_CHARS) : out;
    return tail ? `${head}\n${tail}` : head;
  });
  return `用户终端里最近执行的命令和输出（从旧到新）：\n\n${lines.join("\n\n")}`;
}

const TERMINAL_TOOL: ToolSpec = {
  name: "propose_command",
  description: "终端模式：建议一条命令给用户，不执行。",
  inputSchema: { type: "object", properties: { command: { type: "string" }, explanation: { type: "string" } }, required: ["command", "explanation"] },
};
const GUI_ACT_TOOL: ToolDescriptor = {
  name: "gui.act",
  description: "在某个应用里完成一个小目标的一步：系统从无障碍元素中选目标并执行（click/set_value/type_text/press_key/scroll）。文本和按键由你给。返回执行后的元素概况。",
  channel: "gui", staticLevel: 1, costClass: 1, dataLeavesDevice: true,
  inputSchema: { type: "object", properties: { goal: { type: "string" }, app: { type: "string" }, text: { type: "string" }, key: { type: "string" }, scrollDirection: { type: "string", enum: ["up", "down", "left", "right"] } }, required: ["goal", "app"] },
};

export async function runIntent(deps: AgentDeps, input: RunInput): Promise<RunOutcome> {
  const runId = input.runId ?? randomUUID();
  const maxSteps = deps.limits?.maxSteps ?? 25;
  const maxUsd = deps.limits?.maxUsd ?? 2;
  const ttl = deps.limits?.approvalTtlSec ?? 300;
  const cost: Cost = { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 };
  const recent: string[] = [];
  const plan: PlanStep[] = [];
  let stepCount = 0;
  let cancelled = false;
  deps.signal?.addEventListener("abort", () => (cancelled = true));

  const { tools: hostTools, scope } = await deps.host.listTools();
  const guiTools = deps.gui?.running ? deps.gui.descriptors() : [];
  const hasJevAx = Boolean(deps.gui?.running && deps.jev?.enabled);
  const allTools: ToolDescriptor[] = [...hostTools, ...guiTools, ...(hasJevAx ? [GUI_ACT_TOOL] : [])];
  // 终端模式只允许只读工具 + 建议命令；模型看不到的工具也不能被调用
  const usableTools = input.mode === "terminal" ? hostTools.filter((t) => t.staticLevel === 0) : allTools;
  const byName = new Map(usableTools.map((t) => [t.name, t]));
  const modelTools: ToolSpec[] = input.mode === "terminal" ? [PLAN_TOOL, TERMINAL_TOOL, ...usableTools.map(spec)] : [PLAN_TOOL, ...usableTools.map(spec)];

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt({ platform: deps.platform ?? process.platform, tools: allTools, scope, mode: input.mode, hasGui: guiTools.length > 0, hasJevAx }) },
  ];
  // 终端模式：宿主如果会分块（shell 集成 + terminal.blocks 工具），先把最近几条命令和输出喂给模型
  if (input.mode === "terminal" && input.terminalSessionId && byName.has(TERMINAL_BLOCKS_TOOL)) {
    const ctx = await recentBlocksContext(deps.host, input.terminalSessionId);
    if (ctx) messages.push({ role: "user", content: [{ type: "text", text: ctx }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: `意图：${input.intent}` }] });

  const addUsage = (u: { inputTokens: number; outputTokens: number }) => {
    cost.inputTokens += u.inputTokens;
    cost.outputTokens += u.outputTokens;
    cost.usd += (u.inputTokens * deps.provider.info.priceIn + u.outputTokens * deps.provider.info.priceOut) / 1e6;
  };
  const finish = (ok: boolean, summary: string): RunOutcome => {
    const out = { runId, ok, summary, cost: { ...cost }, stepCount, cancelled };
    deps.emit({ type: "run.finished", ...out });
    deps.log?.({ t: "run.finished", ...out });
    return out;
  };

  // 1. 计划
  try {
    const r = await deps.provider.chat({ messages, tools: modelTools, forceTool: "propose_plan", signal: deps.signal });
    addUsage(r.usage);
    const call = r.toolCalls.find((c) => c.name === "propose_plan");
    const steps = ((call?.args.steps as { title: string; channel?: string }[] | undefined) ?? [{ title: input.intent, channel: "shell" }]).slice(0, 8);
    steps.forEach((s, i) => plan.push({ id: `s${i + 1}`, title: String(s.title), channel: asChannel(s.channel), status: "pending" }));
    if (call) {
      messages.push({ role: "assistant", content: r.text, toolCalls: [call] });
      messages.push({ role: "tool", toolCallId: call.id, content: [{ type: "text", text: "计划已记录，开始执行第一步。" }] });
    }
  } catch (e) {
    deps.emit({ type: "error", code: "plan_failed", message: String(e instanceof Error ? e.message : e), ref: runId });
    return finish(false, `做计划失败：${e instanceof Error ? e.message : e}`);
  }
  deps.emit({ type: "run.created", runId, deviceId: input.deviceId, intent: input.intent, provider: deps.provider.info.id, plan: [...plan] });
  deps.log?.({ t: "run.created", runId, intent: input.intent, provider: deps.provider.info.id, plan });

  // 2. 逐步执行
  let planCursor = 0;
  while (true) {
    if (cancelled) return finish(false, "用户取消");
    if (stepCount >= maxSteps) return finish(false, `超过 ${maxSteps} 步上限`);
    if (cost.usd > maxUsd) return finish(false, `超过本次预算 $${maxUsd}`);

    let resp;
    try {
      resp = await deps.provider.chat({ messages, tools: modelTools, signal: deps.signal });
    } catch (e) {
      return finish(false, `模型调用失败：${e instanceof Error ? e.message : e}`);
    }
    addUsage(resp.usage);
    const call: ToolCall | undefined = resp.toolCalls[0];
    if (!call) {
      plan.forEach((s) => { if (s.status === "pending" || s.status === "running") s.status = "done"; });
      deps.emit({ type: "plan.updated", runId, plan: [...plan] });
      return finish(true, resp.text.trim() || "完成");
    }
    messages.push({ role: "assistant", content: resp.text, toolCalls: [call] });

    if (call.name === "propose_plan") {
      messages.push({ role: "tool", toolCallId: call.id, content: [{ type: "text", text: "计划已更新。" }] });
      const steps = (call.args.steps as { title: string; channel?: string }[] | undefined) ?? [];
      const doneSteps = plan.filter((s) => s.status !== "pending");
      plan.splice(0, plan.length, ...doneSteps, ...steps.map((s, i) => ({ id: `s${doneSteps.length + i + 1}`, title: String(s.title), channel: asChannel(s.channel), status: "pending" as const })));
      planCursor = doneSteps.length;
      deps.emit({ type: "plan.updated", runId, plan: [...plan] });
      continue;
    }

    if (call.name === "propose_command") {
      const command = String(call.args.command ?? "");
      const action: ConcreteAction = { channel: "terminal", summary: String(call.args.explanation ?? ""), detail: command };
      const lvl = (await deps.policy.decide({ intent: input.intent, tool: { name: "shell.run", description: "", channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: true, inputSchema: {} }, args: { cmd: command }, action, scope, recent })).level;
      deps.emit({ type: "terminal.suggestion", runId, sessionId: input.terminalSessionId, command, explanation: action.summary, level: lvl });
      stepCount++;
      return finish(true, `建议命令：${command}`);
    }

    // 普通工具调用 = 一步
    const tool = byName.get(call.name);
    if (!tool) {
      messages.push({ role: "tool", toolCallId: call.id, content: [{ type: "text", text: `没有工具 ${call.name}` }] });
      continue;
    }
    const step = plan[planCursor] && plan[planCursor]!.status === "pending" ? plan[planCursor]! : appendStep(plan, tool.channel, describe(tool, call.args).summary);
    const stepIdx = plan.indexOf(step);
    step.status = "running";
    stepCount++;
    const t0 = Date.now();
    const action = describe(tool, call.args);
    deps.emit({ type: "step.started", runId, stepId: step.id, title: step.title, channel: tool.channel });

    const decision = await deps.policy.decide({ intent: input.intent, tool, args: call.args, action, scope, recent });
    cost.jevTokens += decision.jevTokens;
    cost.usd += decision.jevUsd;
    deps.emit({ type: "step.precheck", runId, stepId: step.id, staticLevel: decision.staticLevel, level: decision.level, intentMatch: decision.intentMatch, risk: decision.risk, confidence: decision.confidence, jevMs: decision.jevMs, verdict: decision.verdict, source: decision.source });
    deps.log?.({ t: "step.precheck", runId, stepId: step.id, tool: tool.name, ...decision });

    let verdict = decision.verdict;
    if (verdict === "confirm") {
      step.status = "awaiting_approval";
      const nonce = randomUUID();
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      const challenge = approvalChallenge({ runId, stepId: step.id, actionDetail: action.detail, nonce, expiresAt });
      deps.emit({ type: "step.approval_required", runId, stepId: step.id, level: decision.level, action, reason: decision.reason, expiresAt, challenge });
      const a = await deps.approvals.request({ runId, stepId: step.id, level: decision.level, action, reason: decision.reason, challenge, expiresAt });
      if (a.allow && a.remember === "always" && decision.level < 2) deps.policy.remember(action);
      verdict = a.allow ? "allow" : "deny";
      if (!a.allow) {
        step.status = "failed";
        deps.emit({ type: "step.finished", runId, stepId: step.id, ok: false, ms: Date.now() - t0, channel: tool.channel, dataLeftDevice: false, error: "用户拒绝了这一步" });
        messages.push({ role: "tool", toolCallId: call.id, content: [{ type: "text", text: "用户拒绝了这个操作。请换一种不需要这个操作的办法，或者停止并说明。" }] });
        recent.push(`拒绝: ${action.summary}`);
        planCursor = stepIdx + 1;
        continue;
      }
    }
    if (verdict === "deny") {
      step.status = "failed";
      deps.emit({ type: "step.finished", runId, stepId: step.id, ok: false, ms: Date.now() - t0, channel: tool.channel, dataLeftDevice: false, error: decision.reason });
      messages.push({ role: "tool", toolCallId: call.id, content: [{ type: "text", text: `系统策略拒绝：${decision.reason}` }] });
      recent.push(`策略拒绝: ${action.summary}`);
      planCursor = stepIdx + 1;
      continue;
    }

    // 执行
    let result: ToolResult;
    if (tool.name === "gui.act") result = await guiAct(deps, input.intent, call.args, recent, cost);
    else if (tool.name.startsWith("gui.") && deps.gui) result = await deps.gui.call(tool.name, call.args);
    else result = await deps.host.call(tool.name, call.args);

    step.status = result.ok ? "done" : "failed";
    const dataLeft = tool.dataLeavesDevice && deps.provider.info.tier !== "local";
    deps.emit({ type: "step.finished", runId, stepId: step.id, ok: result.ok, ms: Date.now() - t0, channel: tool.channel, cost: { ...cost }, dataLeftDevice: dataLeft, output: result.output?.slice(0, 4000), error: result.error });
    deps.log?.({ t: "step.finished", runId, stepId: step.id, tool: tool.name, ok: result.ok, ms: Date.now() - t0, output: result.output?.slice(0, 2000), error: result.error });
    recent.push(`${result.ok ? "成功" : "失败"}: ${action.summary}`);
    planCursor = stepIdx + 1;

    const parts: ContentPart[] = [{ type: "text", text: result.ok ? (result.output || "(无输出)") : `失败：${result.error ?? ""}\n${result.output ?? ""}` }];
    for (const a of result.attachments) if (a.inline && (a.kind === "image/jpeg" || a.kind === "image/png") && deps.provider.info.vision) parts.push({ type: "image", mime: a.kind, base64: a.inline });
    messages.push({ role: "tool", toolCallId: call.id, content: parts });
  }
}

/** gui.act：jev-ax 一步 */
async function guiAct(deps: AgentDeps, intent: string, args: Record<string, unknown>, recent: string[], cost: Cost): Promise<ToolResult> {
  const t0 = Date.now();
  const gui = deps.gui!;
  const jev = deps.jev!;
  const app = String(args.app ?? "");
  const goal = String(args.goal ?? intent);
  try {
    const wins = await gui.call("gui.list_windows", { on_screen_only: true });
    const list = safeParse<{ windows?: { pid: number; window_id: number; app?: string; title?: string; owner?: string }[] } | { pid: number; window_id: number; app?: string; owner?: string }[]>(wins.output ?? "");
    const arr = Array.isArray(list) ? list : (list?.windows ?? []);
    const win = arr.find((w) => `${w.app ?? ""} ${(w as { owner?: string }).owner ?? ""} ${(w as { title?: string }).title ?? ""}`.toLowerCase().includes(app.toLowerCase()));
    if (!win) return { ok: false, error: `没找到 ${app} 的窗口。先 gui.launch_app 或用 gui.list_windows 看看。`, attachments: [], ms: Date.now() - t0 };

    const { elements } = await gui.windowElements(win.pid, win.window_id);
    const d = await jevAxDecide(jev, { goal, app, elements, planner: { text: args.text as string | undefined, key: args.key as string | undefined, scrollDirection: args.scrollDirection as "up" | "down" | "left" | "right" | undefined }, recent });
    cost.jevTokens += d.tokens;
    cost.usd += d.usd;
    if (d.done > 0.8) return { ok: true, output: `快速模型判断目标已达成（${d.done.toFixed(2)}），无需操作。`, attachments: [], ms: Date.now() - t0 };
    if (d.askUser) return { ok: false, error: "快速模型建议停下来问用户。请用文字向用户说明情况。", attachments: [], ms: Date.now() - t0 };
    if (d.escalate) {
      const shot = await gui.call("gui.get_window_state", { pid: win.pid, window_id: win.window_id, include_screenshot: true, include_accessibility_tree: true, max_elements: 60, max_dimension: 1024 });
      return { ok: false, error: `需要视觉：元素候选里选不出目标（置信 ${d.targetConfidence.toFixed(2)}）。附上窗口状态和截图，请你自己用 gui.click 等工具操作。`, output: shot.output, attachments: shot.attachments, ms: Date.now() - t0 };
    }
    const c = toCuaCall(d, { text: args.text as string | undefined, key: args.key as string | undefined, scrollDirection: args.scrollDirection as "up" | "down" | "left" | "right" | undefined }, { pid: win.pid, windowId: win.window_id });
    if (!c) return { ok: false, error: `动作 ${d.action} 缺少参数（text/key）或目标`, attachments: [], ms: Date.now() - t0 };
    const r = await gui.call(`gui.${c.name}`, c.args);
    if (!r.ok) return { ...r, ms: Date.now() - t0 };
    await new Promise((res) => setTimeout(res, 300));
    const after = await gui.windowElements(win.pid, win.window_id, 30);
    const summary = after.elements.map((e) => `[${e.role}] ${e.label}${e.value ? `=${e.value}` : ""}`).join("\n");
    return { ok: true, output: `已执行 ${d.action}${d.target ? ` → ${d.target.label}` : ""}（Jev ${d.latencyMs}ms）。当前窗口元素：\n${summary}`, attachments: [], ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), attachments: [], ms: Date.now() - t0 };
  }
}

function spec(t: ToolDescriptor): ToolSpec {
  return { name: t.name, description: `${t.description}（等级 L${t.staticLevel}${t.costClass === 2 ? "，很贵" : ""}）`, inputSchema: t.inputSchema };
}

function asChannel(c: unknown): Channel {
  const ok = ["shell", "applescript", "jxa", "shortcuts", "fs", "gui", "app", "ipad", "android", "terminal"];
  return (ok.includes(String(c)) ? String(c) : "shell") as Channel;
}

function appendStep(plan: PlanStep[], channel: Channel, title: string): PlanStep {
  const s: PlanStep = { id: `s${plan.length + 1}`, title, channel, status: "pending" };
  plan.push(s);
  return s;
}

/** 审批卡片上要显示的「具体会执行什么」 */
export function describe(tool: ToolDescriptor, args: Record<string, unknown>): ConcreteAction {
  const s = (v: unknown) => (v === undefined ? "" : String(v));
  switch (tool.name) {
    case "shell.run":
      return { channel: "shell", summary: `运行命令 ${s(args.cmd).slice(0, 60)}`, detail: s(args.cmd), targetPath: args.cwd ? s(args.cwd) : undefined };
    case "applescript.run":
    case "jxa.run":
      return { channel: tool.channel, summary: `运行脚本（${tool.name === "jxa.run" ? "JXA" : "AppleScript"}）`, detail: s(args.script), targetApp: /tell application "([^"]+)"/.exec(s(args.script))?.[1] };
    case "shortcuts.run":
      return { channel: "shortcuts", summary: `运行快捷指令「${s(args.name)}」`, detail: `shortcuts run ${s(args.name)}` };
    case "fs.list":
    case "fs.read":
      return { channel: "fs", summary: `${tool.name === "fs.list" ? "列目录" : "读文件"} ${s(args.path)}`, detail: `${tool.name} ${s(args.path)}`, targetPath: s(args.path) };
    case "screenshot":
      return { channel: "gui", summary: "截屏", detail: `screenshot ${JSON.stringify(args)}` };
    case "gui.act":
      return { channel: "gui", summary: `在 ${s(args.app)} 里：${s(args.goal)}`, detail: JSON.stringify(args), targetApp: s(args.app) };
    case "ipad.tap":
      return { channel: "ipad", summary: `点 iPad 屏幕 (${s(args.x)}, ${s(args.y)})${Number(args.count) > 1 ? ` ×${s(args.count)}` : ""}`, detail: `${tool.name} ${JSON.stringify(args)}` };
    case "ipad.type":
      return { channel: "ipad", summary: `在 iPad 输入「${s(args.text).slice(0, 40)}」`, detail: s(args.text) };
    case "ipad.key":
      return { channel: "ipad", summary: `iPad 按键 ${[...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key].join("+")}`, detail: `${tool.name} ${JSON.stringify(args)}` };
    case "ipad.screenshot":
      return { channel: "ipad", summary: "截 iPad 屏幕", detail: tool.name };
    default:
      if (tool.name.startsWith("gui."))
        return { channel: "gui", summary: `界面操作 ${tool.name.slice(4)}`, detail: `${tool.name} ${JSON.stringify(args)}`, targetApp: args.bundle_id ? s(args.bundle_id) : args.name ? s(args.name) : undefined };
      return { channel: tool.channel, summary: `${tool.name}`, detail: `${tool.name} ${JSON.stringify(args)}` };
  }
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
