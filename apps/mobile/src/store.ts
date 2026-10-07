import type { AnyMessage, CloudEntry, CloudVariant, PlanStep, QuickCard } from "@cuaremote/protocol";

type Message = AnyMessage;
export type Approval = Extract<Message, { type: "step.approval_required" }>;
export interface RunState {
  runId: string;
  intent: string;
  approach?: string;
  parentRunId?: string;
  createdAt: number;
  plan: PlanStep[];
  approvals: Record<string, Approval>;
  outputs: Record<string, string>;
  summary?: string;
  ok?: boolean;
  downloads: Extract<Message, { type: "cloud.download" }>[];
  previews: Extract<Message, { type: "cloud.preview" }>[];
  variants?: CloudVariant[];
}
export interface CloudView {
  state: "none" | "running" | "paused";
  cards: QuickCard[];
  snapshots: { runId: string; createdAt: number; title?: string }[];
  variantsAllowed: number;
  idleSeconds: number;
}
export interface BillingView {
  plan: "free" | "paid";
  freeRunsTotal: number;
  freeRunsUsed: number;
  credits: number;
  periodEndsAt: number;
  creditsPerUsd: number;
  freeDeviceLimit: number;
  topUpURL?: string;
}
export interface AppState {
  /** 手机自己记的任务标题（快捷卡发出去的是填好的长指令，列表里显示用户写的那句） */
  labels: Record<string, string>;
  runs: Record<string, RunState>;
  order: string[];
  cloud?: CloudView;
  billing?: BillingView;
  files?: { path: string; entries: CloudEntry[] };
  lastError?: string;
}
export const initialState: AppState = { labels: {}, runs: {}, order: [] };

/** 本地动作：给即将发出的意图记一个显示标题 */
export type LocalAction = { type: "local.label"; intent: string; label: string };

export function reduce(state: AppState, a: AnyMessage | LocalAction): AppState {
  if (a.type === "local.label") return { ...state, labels: { ...state.labels, [a.intent]: a.label } };
  return foldMessage(state, a);
}

/** 任务显示标题：手机记过的优先，其次原意图 */
export const runTitle = (s: AppState, r: RunState) => s.labels[r.intent] ?? r.intent;

const run = (s: AppState, id: string): RunState =>
  s.runs[id] ?? { runId: id, intent: "任务", createdAt: Date.now(), plan: [], approvals: {}, outputs: {}, downloads: [], previews: [] };
export function foldMessage(state: AppState, m: Message): AppState {
  if (m.type === "cloud.status")
    return { ...state, cloud: { state: m.state, cards: m.cards, snapshots: m.snapshots, variantsAllowed: m.variantsAllowed, idleSeconds: m.idleSeconds } };
  if (m.type === "billing.status") return { ...state, billing: m };
  if (m.type === "cloud.files")
    return {
      ...state,
      files: { path: m.path, entries: [...m.entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)) },
    };
  if (m.type === "error") return { ...state, lastError: m.message };
  if (m.type === "run.created") {
    const r: RunState = {
      runId: m.runId,
      intent: m.intent,
      approach: m.approach,
      parentRunId: m.parentRunId,
      createdAt: Date.now(),
      plan: m.plan,
      approvals: {},
      outputs: {},
      downloads: [],
      previews: [],
    };
    return { ...state, runs: { ...state.runs, [m.runId]: r }, order: state.order.includes(m.runId) ? state.order : [m.runId, ...state.order] };
  }
  if (!("runId" in m) || !m.runId) return state;
  const current = run(state, m.runId);
  let next = current;
  if (m.type === "plan.updated") next = { ...current, plan: m.plan };
  if (m.type === "step.started") next = { ...current, plan: current.plan.map((x) => (x.id === m.stepId ? { ...x, status: "running" } : x)) };
  if (m.type === "step.approval_required")
    next = {
      ...current,
      approvals: { ...current.approvals, [m.stepId]: m },
      plan: current.plan.map((x) => (x.id === m.stepId ? { ...x, status: "awaiting_approval" } : x)),
    };
  if (m.type === "step.finished") {
    const approvals = { ...current.approvals };
    delete approvals[m.stepId];
    next = {
      ...current,
      approvals,
      outputs: { ...current.outputs, [m.stepId]: m.output ?? m.error ?? "" },
      plan: current.plan.map((x) => (x.id === m.stepId ? { ...x, status: m.ok ? "done" : "failed" } : x)),
    };
  }
  if (m.type === "run.finished") next = { ...current, summary: m.summary, ok: m.ok };
  if (m.type === "cloud.download") next = { ...current, downloads: [...current.downloads, m] };
  if (m.type === "cloud.preview") next = { ...current, previews: [...current.previews, m] };
  if (m.type === "cloud.variants") next = { ...current, variants: m.items };
  if (next === current) return state;
  return { ...state, runs: { ...state.runs, [m.runId]: next }, order: state.order.includes(m.runId) ? state.order : [m.runId, ...state.order] };
}
