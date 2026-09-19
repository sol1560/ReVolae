import { randomUUID } from "node:crypto";
import { AppInventory, CapabilityCard as CapabilityCardSchema, approvalChallenge, type CapabilityCard, type Cost, type InventoryItem, type ToolDescriptor } from "@cuaremote/protocol";
import { describe, type ApprovalGate, type BrainEvent } from "../agent/loop.js";
import type { CuaDriver } from "../gui/cua-driver.js";
import type { Host } from "../host/types.js";
import type { PolicyEngine } from "../jev/policy.js";
import type { Provider } from "../llm/types.js";
import { CARD_TOOL, PROPOSE_CARDS_TOOL, renderTemplate, toolArgs, validateCards } from "./cards.js";

/**
 * 学习应用（brain 侧）。
 *
 * 原料由设备扒：daemon 提供工具 `app.inventory {bundleId, phase}`，每个阶段返回一份 AppInventory JSON
 *（sdef 命令 / 菜单项 / 主窗口元素 / 快捷指令）。这里只负责：按阶段要原料 → 汇报进度 →
 * 让模型总结成卡片 → 校验 → 交给设备存（emit app.cards）。
 * 卡片执行（runCard）每次都过策略引擎：静态分级 → 作用域 → Jev → 自治档位，和 agent loop 同一套。
 */

export type LearnPhase = "sdef" | "menu" | "window" | "shortcuts" | "explore" | "summarize" | "done" | "failed";
export type LearnEvent =
  | Extract<BrainEvent, { type: "run.created" | "run.finished" | "step.started" | "step.precheck" | "step.approval_required" | "step.finished" | "error" }>
  | { type: "app.learn.progress"; bundleId: string; phase: LearnPhase; found: number; message?: string }
  | { type: "app.cards"; cards: CapabilityCard[] };

export interface LearnDeps {
  host: Host;
  provider: Provider;
  emit: (e: LearnEvent) => void;
  gui?: CuaDriver;
  log?: (rec: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export interface LearnInput {
  bundleId: string;
  /** 只读层之外再用 GUI 探索一轮（贵，且会真的点界面） */
  explore: boolean;
}

export interface LearnOutcome {
  cards: CapabilityCard[];
  rejected: { name: string; reason: string }[];
  inventory: InventoryItem[];
  cost: Cost;
}

export const INVENTORY_TOOL = "app.inventory";
/** daemon 提供：按 id 取一张已存的卡片（JSON） */
export const CARD_GET_TOOL = "app.card.get";

/** 从设备取卡片；取不到返回 null 并说明原因 */
export async function fetchCard(host: Host, cardId: string): Promise<{ card: CapabilityCard } | { error: string }> {
  const { tools } = await host.listTools();
  if (!tools.some((t) => t.name === CARD_GET_TOOL)) return { error: `这台设备没有 ${CARD_GET_TOOL} 工具` };
  const r = await host.call(CARD_GET_TOOL, { cardId }, 15_000);
  if (!r.ok) return { error: r.error ?? `取卡片 ${cardId} 失败` };
  const parsed = CapabilityCardSchema.safeParse(tryJson(r.output ?? ""));
  return parsed.success ? { card: parsed.data } : { error: `卡片 ${cardId} 的内容不合法` };
}
const PHASES = ["sdef", "menu", "window", "shortcuts"] as const;

export async function learnApp(deps: LearnDeps, input: LearnInput): Promise<LearnOutcome> {
  const { tools } = await deps.host.listTools();
  const cost: Cost = { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 };
  const inventory: InventoryItem[] = [];
  let appName = input.bundleId;
  const progress = (phase: LearnPhase, message?: string) => deps.emit({ type: "app.learn.progress", bundleId: input.bundleId, phase, found: inventory.length, message });

  if (!tools.some((t) => t.name === INVENTORY_TOOL)) {
    progress("failed", `这台设备没有 ${INVENTORY_TOOL} 工具，学不了应用`);
    return { cards: [], rejected: [], inventory, cost };
  }

  for (const phase of PHASES) {
    if (deps.signal?.aborted) break;
    progress(phase);
    const r = await deps.host.call(INVENTORY_TOOL, { bundleId: input.bundleId, phase }, 120_000);
    if (!r.ok) {
      deps.log?.({ t: "learn.phase_failed", bundleId: input.bundleId, phase, error: r.error });
      progress(phase, `${phase} 阶段失败：${r.error ?? "未知错误"}`);
      continue;
    }
    const parsed = AppInventory.safeParse(tryJson(r.output ?? ""));
    if (!parsed.success) {
      progress(phase, `${phase} 阶段返回的不是 AppInventory`);
      continue;
    }
    appName = parsed.data.appName || appName;
    inventory.push(...parsed.data.items.filter((i) => !inventory.some((x) => x.id === i.id)));
    progress(phase, parsed.data.truncated ? "条目太多，已截断" : undefined);
  }

  if (input.explore) {
    // GUI 探索（真的去点界面）留给 F3 阶段；先明确告诉用户跳过了
    progress("explore", deps.gui ? "GUI 探索还没接上，先跳过" : "没有 GUI 通道，跳过探索");
  }

  if (!inventory.length) {
    progress("failed", "什么能力都没扒到");
    return { cards: [], rejected: [], inventory, cost };
  }

  progress("summarize");
  const res = await deps.provider.chat({
    messages: [
      { role: "system", content: cardPrompt(appName, input.bundleId) },
      { role: "user", content: [{ type: "text", text: `能力清单（${inventory.length} 条）：\n${JSON.stringify(inventory, null, 0)}` }] },
    ],
    tools: [PROPOSE_CARDS_TOOL],
    forceTool: PROPOSE_CARDS_TOOL.name,
  });
  cost.inputTokens += res.usage.inputTokens;
  cost.outputTokens += res.usage.outputTokens;
  cost.usd += (res.usage.inputTokens * deps.provider.info.priceIn + res.usage.outputTokens * deps.provider.info.priceOut) / 1_000_000;
  const call = res.toolCalls.find((c) => c.name === PROPOSE_CARDS_TOOL.name);
  const proposed = Array.isArray(call?.args.cards) ? (call!.args.cards as unknown[]) : [];
  const v = validateCards({ bundleId: input.bundleId, appName, proposed, inventory, tools });
  deps.log?.({ t: "learn.summarized", bundleId: input.bundleId, proposed: proposed.length, accepted: v.cards.length, rejected: v.rejected });
  deps.emit({ type: "app.cards", cards: v.cards });
  progress("done", v.rejected.length ? `${v.cards.length} 张可用，${v.rejected.length} 张不合规被丢弃` : `${v.cards.length} 张可用`);
  return { cards: v.cards, rejected: v.rejected, inventory, cost };
}

function cardPrompt(appName: string, bundleId: string) {
  return [
    `你在为 macOS 应用「${appName}」（${bundleId}）总结"能力卡片"。用户会在 iPhone 上一键点这些卡片让 Mac 干活，所以每张卡要是一个普通人会想用的完整动作，不是 API 罗列。`,
    "控件只有 6 种：button（无参数）、input_button（填一两个值再按）、list（先跑 dataSource 拿列表，用户选一项）、toggle（一个 bool）、picker（一个 choice）、form（多个字段）。",
    "动作模板用 {{key}} 占位，每个占位都必须在 fields 里声明。文本参数会被按通道自动转义并在 applescript/jxa 里放进双引号字符串，所以模板里要写 \"{{key}}\"；shell 模板里不要给 {{key}} 加引号（会自动加单引号）。",
    "来源规则：sdef → applescript/jxa；menu → applescript（System Events 点菜单）或 gui；window → gui/applescript；shortcuts → shortcut（模板就是快捷指令名字）。",
    "staticLevel：只读查询 0；改文件 / 发消息 / 改应用状态 1；删除、清空、涉及支付账号系统设置 2。拿不准往高了标。",
    "只输出真的能跑的卡；不确定参数怎么传的宁可不出。最多 24 张，重要的放前面。",
  ].join("\n");
}

// ───────────────────────── 执行卡片 ─────────────────────────

export interface RunCardDeps {
  host: Host;
  policy: PolicyEngine;
  approvals: ApprovalGate;
  emit: (e: LearnEvent) => void;
  log?: (rec: Record<string, unknown>) => void;
  limits?: { approvalTtlSec?: number };
  /** 给策略引擎「意图」和事件里的 deviceId */
  deviceId: string;
  providerId?: string;
}

export interface RunCardOutcome {
  runId: string;
  ok: boolean;
  output?: string;
  error?: string;
  cost: Cost;
}

/** 跑一张卡：渲染 → 策略 → （确认）→ 执行。事件和 agent loop 一致，手机上复用同一条时间线。 */
export async function runCard(deps: RunCardDeps, card: CapabilityCard, params: Record<string, string>): Promise<RunCardOutcome> {
  const runId = randomUUID();
  const stepId = "s1";
  const cost: Cost = { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 };
  const intent = `卡片「${card.name}」（${card.appName}）`;
  const finish = (ok: boolean, summary: string, extra: { output?: string; error?: string } = {}): RunCardOutcome => {
    deps.emit({ type: "run.finished", runId, ok, summary, cost, stepCount: 1, cancelled: false });
    return { runId, ok, cost, ...extra };
  };

  const { tools, scope } = await deps.host.listTools();
  const toolName = CARD_TOOL[card.action.kind];
  const tool: ToolDescriptor | undefined = tools.find((t) => t.name === toolName);
  deps.emit({ type: "run.created", runId, deviceId: deps.deviceId, intent, provider: deps.providerId ?? "card", plan: [{ id: stepId, title: card.name, channel: tool?.channel, staticLevel: card.staticLevel, status: "pending" }] });
  if (!tool) return finish(false, `这台设备没有 ${toolName}，跑不了这张卡`, { error: `缺工具 ${toolName}` });

  const rendered = renderTemplate(card, params);
  if (rendered.missing.length || rendered.invalid.length) {
    const msg = [rendered.missing.length ? `缺必填：${rendered.missing.join(", ")}` : "", rendered.invalid.length ? `值不合法：${rendered.invalid.join(", ")}` : ""].filter(Boolean).join("；");
    deps.emit({ type: "error", code: "card_params", message: msg, ref: runId });
    return finish(false, msg, { error: msg });
  }
  const args = toolArgs(card.action.kind, rendered.text, card);
  const action = describe(tool, args);
  const t0 = Date.now();
  deps.emit({ type: "step.started", runId, stepId, title: card.name, channel: tool.channel });

  // 卡片自带的等级是下限：模型说 L2 的卡，静态分级再低也按 L2 走
  const decision = await deps.policy.decide({ intent, tool, args, action, scope, recent: [] });
  const level = Math.max(decision.level, card.staticLevel) as 0 | 1 | 2;
  let verdict = decision.verdict;
  if (level === 2 && verdict === "allow") verdict = "confirm";
  cost.jevTokens += decision.jevTokens;
  cost.usd += decision.jevUsd;
  deps.emit({ type: "step.precheck", runId, stepId, staticLevel: decision.staticLevel, level, intentMatch: decision.intentMatch, risk: decision.risk, confidence: decision.confidence, jevMs: decision.jevMs, verdict, source: decision.source });
  deps.log?.({ t: "card.precheck", runId, cardId: card.id, tool: tool.name, ...decision, level, verdict });

  if (verdict === "confirm") {
    const nonce = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + (deps.limits?.approvalTtlSec ?? 300);
    const challenge = approvalChallenge({ runId, stepId, actionDetail: action.detail, nonce, expiresAt });
    deps.emit({ type: "step.approval_required", runId, stepId, level, action, reason: decision.reason, expiresAt, challenge });
    const a = await deps.approvals.request({ runId, stepId, level, action, reason: decision.reason, challenge, expiresAt });
    if (a.allow && a.remember === "always" && level < 2) deps.policy.remember(action);
    verdict = a.allow ? "allow" : "deny";
    if (!a.allow) {
      deps.emit({ type: "step.finished", runId, stepId, ok: false, ms: Date.now() - t0, channel: tool.channel, dataLeftDevice: false, error: "用户拒绝了这一步" });
      return finish(false, "用户拒绝了", { error: "用户拒绝了这一步" });
    }
  }
  if (verdict === "deny") {
    deps.emit({ type: "step.finished", runId, stepId, ok: false, ms: Date.now() - t0, channel: tool.channel, dataLeftDevice: false, error: decision.reason });
    return finish(false, `策略拒绝：${decision.reason}`, { error: decision.reason });
  }

  const result = await deps.host.call(tool.name, args);
  deps.emit({ type: "step.finished", runId, stepId, ok: result.ok, ms: Date.now() - t0, channel: tool.channel, cost: { ...cost }, dataLeftDevice: false, output: result.output?.slice(0, 4000), error: result.error });
  deps.log?.({ t: "card.finished", runId, cardId: card.id, ok: result.ok, ms: Date.now() - t0, error: result.error });
  return finish(result.ok, result.ok ? `「${card.name}」完成` : `「${card.name}」失败：${result.error ?? ""}`, { output: result.output, error: result.error });
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
