import { z } from "zod";
import {
  ApprovalSignature,
  BrainLocation,
  CapabilityCard,
  Channel,
  ConcreteAction,
  Cost,
  DevicePlatform,
  DeviceStats,
  HistoryItem,
  Level,
  ModelEntry,
  PlanStep,
  PrecheckSource,
  PrivacySettings,
  PublicKeys,
  Scope,
  Shortcut,
  SyncBlob,
  SyncKind,
  TerminalBlock,
  ToolDescriptor,
  Verdict,
} from "./common.js";
import { TERMINAL_SESSION_ID_RE } from "./frame.js";

const base = { v: z.literal(1), id: z.string() };
const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ ...base, type: z.literal(type), ...shape });

// ─────────────────────────── 手机 → 设备 ───────────────────────────

export const IntentSubmit = msg("intent.submit", {
  text: z.string().min(1),
  deviceId: z.string(),
  mode: z.enum(["agent", "terminal"]),
  /** 覆盖默认 provider，如 anthropic:claude-fable-5.1 / ollama:muse-glimmer:30b-mlx */
  provider: z.string().optional(),
  /** terminal 模式：把建议命令填进哪个会话 */
  terminalSessionId: z.string().optional(),
});
export const RunCancel = msg("run.cancel", { runId: z.string() });
export const ApprovalDecision = msg("approval.decision", {
  runId: z.string(),
  stepId: z.string(),
  allow: z.boolean(),
  remember: z.enum(["once", "always"]).default("once"),
  signature: ApprovalSignature.optional(),
});
export const TerminalOpen = msg("terminal.open", {
  sessionId: z.string().regex(TERMINAL_SESSION_ID_RE),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cwd: z.string().optional(),
  signature: ApprovalSignature.optional(),
});
export const TerminalResize = msg("terminal.resize", {
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const TerminalClose = msg("terminal.close", { sessionId: z.string() });
/** 窗口式背压：告诉对端已消费多少字节 */
export const TerminalAck = msg("terminal.ack", { sessionId: z.string(), bytes: z.number().int().nonnegative() });
export const MediaSubscribe = msg("media.subscribe", {
  fps: z.number().positive().max(30),
  maxWidth: z.number().int().positive(),
  codec: z.enum(["jpeg", "h264"]).default("jpeg"),
});
export const MediaUnsubscribe = msg("media.unsubscribe", {});
export const StatsGet = msg("stats.get", {});
export const ShortcutRun = msg("shortcut.run", { shortcutId: z.string(), params: z.record(z.string(), z.string()).default({}) });
export const HistoryList = msg("history.list", { cursor: z.string().optional(), limit: z.number().int().positive().max(200).default(50) });
export const PrivacySet = msg("privacy.set", { settings: PrivacySettings });
export const PrivacyGet = msg("privacy.get", {});
/** 问大脑（本地或云端）有哪些模型可选；本地大脑会顺带探测 Ollama / LM Studio 是否在跑 */
export const ModelsList = msg("models.list", {});
export const ScopeSet = msg("scope.set", { scope: Scope });
/** deviceId：直接发给设备时可省；发给云端大脑时必填（大脑得知道去哪台设备扒 / 跑） */
export const AppLearnStart = msg("app.learn.start", { bundleId: z.string(), explore: z.boolean().default(false), deviceId: z.string().optional() });
export const AppLearnStop = msg("app.learn.stop", { bundleId: z.string() });
export const AppCardRun = msg("app.card.run", { cardId: z.string(), params: z.record(z.string(), z.string()).default({}), deviceId: z.string().optional() });
export const AppCardsGet = msg("app.cards.get", { bundleId: z.string().optional() });
export const CapabilitiesGet = msg("capabilities.get", {});

// ─────────────────────────── 设备 → 手机 ───────────────────────────

export const RunCreated = msg("run.created", {
  runId: z.string(),
  deviceId: z.string(),
  intent: z.string(),
  provider: z.string(),
  plan: z.array(PlanStep),
});
export const PlanUpdated = msg("plan.updated", { runId: z.string(), plan: z.array(PlanStep) });
export const StepStarted = msg("step.started", { runId: z.string(), stepId: z.string(), title: z.string(), channel: Channel.optional() });
export const StepPrecheck = msg("step.precheck", {
  runId: z.string(),
  stepId: z.string(),
  staticLevel: Level,
  level: Level,
  intentMatch: z.boolean().optional(),
  risk: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  jevMs: z.number().nonnegative().optional(),
  verdict: Verdict,
  source: PrecheckSource,
});
export const StepApprovalRequired = msg("step.approval_required", {
  runId: z.string(),
  stepId: z.string(),
  level: Level,
  action: ConcreteAction,
  reason: z.string(),
  /** 秒级 unix */
  expiresAt: z.number().int(),
  /** 手机签名时要签的 canonical 串 */
  challenge: z.string(),
});
export const StepFinished = msg("step.finished", {
  runId: z.string(),
  stepId: z.string(),
  ok: z.boolean(),
  ms: z.number().nonnegative(),
  channel: Channel.optional(),
  cost: Cost.optional(),
  dataLeftDevice: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
});
export const RunFinished = msg("run.finished", {
  runId: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  cost: Cost,
  stepCount: z.number().int(),
  cancelled: z.boolean().default(false),
});
/** terminal 模式下大脑给出的建议命令，不执行 */
export const TerminalSuggestion = msg("terminal.suggestion", {
  runId: z.string(),
  sessionId: z.string().optional(),
  command: z.string(),
  explanation: z.string(),
  level: Level,
});
/** streamId：这条会话的 PTY 字节走 Frame(kind=1) 时用的流号，由设备分配，两个方向共用 */
export const TerminalOpened = msg("terminal.opened", { sessionId: z.string(), streamId: z.number().int().nonnegative(), pid: z.number().int().optional() });
export const TerminalExit = msg("terminal.exit", { sessionId: z.string(), code: z.number().int().optional() });
/** 命令块状态变化（prompt → running → done），daemon 解析 OSC 133 后发；每次变化发整块 */
export const TerminalBlockMsg = msg("terminal.block", { block: TerminalBlock });
/** 订阅成功：设备分配 streamId，之后 kind=2 帧都用它（payload 格式见 media.ts） */
export const MediaInfo = msg("media.info", {
  streamId: z.number().int().nonnegative(),
  width: z.number().int(),
  height: z.number().int(),
  codec: z.enum(["jpeg", "h264"]),
  fps: z.number(),
});
export const Stats = msg("stats", { deviceId: z.string(), stats: DeviceStats });
export const Capabilities = msg("capabilities", {
  deviceId: z.string(),
  platform: DevicePlatform,
  name: z.string(),
  tools: z.array(ToolDescriptor),
  scope: Scope,
  brainAvailable: z.boolean(),
  brainUnavailableReason: z.string().optional(),
  daemonVersion: z.string(),
});
export const PrivacyState = msg("privacy.state", {
  deviceId: z.string(),
  settings: PrivacySettings,
  /** 「数据去哪了」：每类数据当前去向 */
  dataFlow: z.array(z.object({ data: z.string(), destination: z.string(), reason: z.string() })),
});
export const HistoryPage = msg("history.page", { items: z.array(HistoryItem), nextCursor: z.string().optional() });
export const AppLearnProgress = msg("app.learn.progress", {
  bundleId: z.string(),
  phase: z.enum(["sdef", "menu", "window", "shortcuts", "explore", "summarize", "done", "failed"]),
  found: z.number().int(),
  message: z.string().optional(),
});
export const AppCards = msg("app.cards", { cards: z.array(CapabilityCard) });
export const ModelsCatalog = msg("models.catalog", {
  models: z.array(ModelEntry),
  /** 大脑当前默认模型 id */
  defaultModel: z.string(),
  /** 这台大脑在哪跑：本地设备 / 云端 */
  brainLocation: BrainLocation,
});
export const ShortcutsList = msg("shortcuts.list", { shortcuts: z.array(Shortcut) });
export const ErrorMsg = msg("error", { code: z.string(), message: z.string(), ref: z.string().optional() });
export const Ack = msg("ack", { ref: z.string() });

// ─────────────────────────── 端 ↔ hub（明文）───────────────────────────

export const Hello = msg("hello", {
  role: z.enum(["device", "phone", "brain"]),
  deviceId: z.string(),
  platform: DevicePlatform,
  name: z.string(),
  pubKeys: PublicKeys,
  protocolVersion: z.literal(1),
  /** 手机带 JOC JWT */
  token: z.string().optional(),
});
export const AuthChallenge = msg("auth.challenge", { nonce: z.string() });
export const AuthResponse = msg("auth.response", { nonce: z.string(), signature: z.string() });
export const AuthOk = msg("auth.ok", { sessionToken: z.string(), expiresAt: z.number().int() });
export const Presence = msg("presence", { deviceId: z.string(), online: z.boolean(), lastSeen: z.number().int() });
export const PeerKeys = msg("peer.keys", { deviceId: z.string(), pubKeys: PublicKeys });
export const PushRegister = msg("push.register", { platform: z.enum(["apns", "fcm"]), token: z.string(), /** HPKE 公钥，推送内容用它封装 */ pushKem: z.string() });
export const PushSend = msg("push.send", { to: z.string(), sealed: z.string(), category: z.string() });
export const UsageReport = msg("usage.report", { runId: z.string(), cost: Cost, steps: z.number().int(), jevCalls: z.number().int() });

// 云同步（端 ↔ hub，密文块；hub 不解密）
/** 上传/覆盖若干块，同 (kind,id) 以 ts 新的为准 */
export const SyncPut = msg("sync.put", { items: z.array(SyncBlob).min(1).max(100) });
/** 按 kind 增量拉取，cursor 是上一页 sync.page 的 cursor（hub 内部序号），从头拉不填 */
export const SyncPull = msg("sync.pull", { kind: SyncKind, cursor: z.string().optional(), limit: z.number().int().positive().max(200).default(100) });
/** cursor = 这一页最后一条的序号，下次从这里接着拉（这页没条目时不带）；more = 后面还有 */
export const SyncPage = msg("sync.page", { kind: SyncKind, items: z.array(SyncBlob), cursor: z.string().optional(), more: z.boolean() });
/** 删指定 id；不带 ids = 把这个账号这一类全部抹掉（关掉同步开关时用） */
export const SyncDelete = msg("sync.delete", { kind: SyncKind, ids: z.array(z.string()).max(500).optional() });
/** 手机问 hub 自己的套餐和余额 */
export const BillingGet = msg("billing.get", {});
/**
 * plan：free = 只用每月免费次数；paid = 有 credit 余额。
 * 只有云端大脑跑的 run 计费；本地大脑（用户自己的 key）不计。
 */
export const BillingStatus = msg("billing.status", {
  plan: z.enum(["free", "paid"]),
  freeRunsTotal: z.number().int().nonnegative(),
  freeRunsUsed: z.number().int().nonnegative(),
  /** 本月免费额度重置时间（Unix 秒） */
  periodEndsAt: z.number().int(),
  /** credit 余额；没接计费系统时为 0 */
  credits: z.number(),
  /** 1 美元模型成本（含加成）折多少 credit */
  creditsPerUsd: z.number().positive(),
  /** 免费层最多绑几台被控设备 */
  freeDeviceLimit: z.number().int().positive(),
  /** 充值页（手机用系统浏览器打开） */
  topUpURL: z.string().optional(),
});
/** 端到端分发同步密钥（手机 ↔ 设备，走加密链路；hub 永远见不到） */
export const SyncKey = msg("sync.key", { keyId: z.string().min(1).max(64), /** base64 32 字节 */ key: z.string() });

// 配对
export const PairOffer = z.object({
  hubURL: z.string().url(),
  deviceId: z.string(),
  name: z.string(),
  pubKeys: PublicKeys,
  /** base64 16 字节一次性 secret */
  secret: z.string(),
  expiresAt: z.number().int(),
});
export type PairOffer = z.infer<typeof PairOffer>;
export const PairRequest = msg("pair.request", {
  deviceId: z.string(),
  phoneId: z.string(),
  phoneName: z.string(),
  phonePubKeys: PublicKeys,
  /** HMAC-SHA256(secret, deviceKem || phoneKem) base64 */
  hmac: z.string(),
});
export const PairConfirm = msg("pair.confirm", { deviceId: z.string(), phoneId: z.string(), accept: z.boolean() });
export const PairResult = msg("pair.result", { deviceId: z.string(), phoneId: z.string(), ok: z.boolean(), reason: z.string().optional() });
/** 无摄像头时的 6 位码撮合：手机拿 code 换 PairOffer，之后照常走 pair.request */
export const PairCodeClaim = msg("pair.code.claim", { code: z.string().length(6), phoneId: z.string(), phonePubKeys: PublicKeys });
export const PairOfferMsg = msg("pair.offer", PairOffer.shape);
/** 任一方解绑（device.unpair 或 DELETE /api/pairings）后 hub 通知双方 */
export const PairRemoved = msg("pair.removed", { deviceId: z.string(), phoneId: z.string(), by: z.string() });

// 多设备管理（端 ↔ hub）
/** 一条设备记录：我配过对的对端 + 同账号下其它端（paired=false 时可以发起配对） */
export const DeviceSummary = z.object({
  deviceId: z.string(),
  role: z.enum(["device", "phone"]),
  platform: DevicePlatform,
  /** 显示名：账号内起过别名就是别名，否则是设备自报的名字 */
  name: z.string(),
  online: z.boolean(),
  lastSeen: z.number().int(),
  paired: z.boolean(),
  pairedAt: z.number().int().optional(),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;
export const DevicesList = msg("devices.list", {});
export const DevicesPage = msg("devices.page", { devices: z.array(DeviceSummary) });
/** 给自己或配过对的对端起别名（只在本账号内可见，不影响设备自报的名字） */
export const DeviceRename = msg("device.rename", { deviceId: z.string(), name: z.string().trim().min(1).max(64) });
/** 和某个对端解绑；双方都会收到 pair.removed */
export const DeviceUnpair = msg("device.unpair", { deviceId: z.string() });

// ─────────────────────────── 大脑 ↔ 宿主 ───────────────────────────

export const ToolsList = msg("tools.list", {});
export const ToolsListResult = msg("tools.list.result", { tools: z.array(ToolDescriptor), scope: Scope });
export const ToolsCall = msg("tools.call", { callId: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()), timeoutMs: z.number().int().positive().default(60_000) });
export const ToolsResult = msg("tools.result", {
  callId: z.string(),
  ok: z.boolean(),
  output: z.string().optional(),
  /** 截图等二进制走 media 流，这里放引用 */
  attachments: z.array(z.object({ kind: z.enum(["image/jpeg", "image/png", "text/plain"]), streamId: z.number().int().optional(), inline: z.string().optional() })).default([]),
  error: z.string().optional(),
  ms: z.number().nonnegative(),
});
export const EventEmit = msg("event.emit", { event: z.record(z.string(), z.unknown()) });
export const ApprovalRequest = msg("approval.request", { runId: z.string(), stepId: z.string(), level: Level, action: ConcreteAction, reason: z.string(), challenge: z.string(), expiresAt: z.number().int() });
export const ApprovalResponse = msg("approval.response", { runId: z.string(), stepId: z.string(), allow: z.boolean(), remember: z.enum(["once", "always"]).default("once"), signature: ApprovalSignature.optional() });

// ─────────────────────────── 联合 ───────────────────────────

export const PhoneToDevice = z.discriminatedUnion("type", [
  IntentSubmit, RunCancel, ApprovalDecision, TerminalOpen, TerminalResize, TerminalClose, TerminalAck,
  MediaSubscribe, MediaUnsubscribe, StatsGet, ShortcutRun, HistoryList, PrivacySet, PrivacyGet, ScopeSet,
  AppLearnStart, AppLearnStop, AppCardRun, AppCardsGet, CapabilitiesGet, ModelsList, SyncKey,
]);
export type PhoneToDevice = z.infer<typeof PhoneToDevice>;

export const DeviceToPhone = z.discriminatedUnion("type", [
  RunCreated, PlanUpdated, StepStarted, StepPrecheck, StepApprovalRequired, StepFinished, RunFinished,
  TerminalSuggestion, TerminalOpened, TerminalExit, TerminalAck, TerminalBlockMsg, MediaInfo, Stats, Capabilities, PrivacyState,
  HistoryPage, AppLearnProgress, AppCards, ModelsCatalog, ShortcutsList, SyncKey, ErrorMsg, Ack,
]);
export type DeviceToPhone = z.infer<typeof DeviceToPhone>;

export const HubMessage = z.discriminatedUnion("type", [
  Hello, AuthChallenge, AuthResponse, AuthOk, Presence, PeerKeys, PushRegister, PushSend, UsageReport,
  PairRequest, PairConfirm, PairResult, PairCodeClaim, PairOfferMsg, PairRemoved, DevicesList, DevicesPage, DeviceRename, DeviceUnpair,
  SyncPut, SyncPull, SyncPage, SyncDelete, BillingGet, BillingStatus, ErrorMsg, Ack,
]);
export type HubMessage = z.infer<typeof HubMessage>;

export const BrainHostMessage = z.discriminatedUnion("type", [
  ToolsList, ToolsListResult, ToolsCall, ToolsResult, EventEmit, ApprovalRequest, ApprovalResponse, ErrorMsg,
]);
export type BrainHostMessage = z.infer<typeof BrainHostMessage>;

/** 端到端（解密后）帧里 kind=0 的所有控制消息 */
const peerList = [
  ...PhoneToDevice.options,
  // 两个方向都有的（sync.key、error、ack、terminal.ack）只留一份
  ...DeviceToPhone.options.filter((o) => !["terminal.ack", "error", "ack", "sync.key"].includes(o.shape.type.value)),
];
export const PeerMessage = z.discriminatedUnion("type", [peerList[0]!, ...peerList.slice(1)] as [(typeof peerList)[number], ...(typeof peerList)[number][]]);
export type PeerMessage = z.infer<typeof PeerMessage>;

/** 所有消息，按 type 索引，供生成器使用 */
export const AllMessages = {
  IntentSubmit, RunCancel, ApprovalDecision, TerminalOpen, TerminalResize, TerminalClose, TerminalAck,
  MediaSubscribe, MediaUnsubscribe, StatsGet, ShortcutRun, HistoryList, PrivacySet, PrivacyGet, ScopeSet,
  AppLearnStart, AppLearnStop, AppCardRun, AppCardsGet, CapabilitiesGet, ModelsList, SyncKey,
  RunCreated, PlanUpdated, StepStarted, StepPrecheck, StepApprovalRequired, StepFinished, RunFinished,
  TerminalSuggestion, TerminalOpened, TerminalExit, TerminalBlockMsg, MediaInfo, Stats, Capabilities, PrivacyState,
  HistoryPage, AppLearnProgress, AppCards, ModelsCatalog, ShortcutsList, ErrorMsg, Ack,
  Hello, AuthChallenge, AuthResponse, AuthOk, Presence, PeerKeys, PushRegister, PushSend, UsageReport,
  PairRequest, PairConfirm, PairResult, PairCodeClaim, PairOfferMsg, PairRemoved, DevicesList, DevicesPage, DeviceRename, DeviceUnpair,
  SyncPut, SyncPull, SyncPage, SyncDelete, BillingGet, BillingStatus,
  ToolsList, ToolsListResult, ToolsCall, ToolsResult, EventEmit, ApprovalRequest, ApprovalResponse,
} as const;

const allList = Object.values(AllMessages);
export const AnyMessage = z.discriminatedUnion("type", [allList[0]!, ...allList.slice(1)] as [(typeof allList)[number], ...(typeof allList)[number][]]);
export type AnyMessage = z.infer<typeof AnyMessage>;

// ─────────────────────────── 构造辅助 ───────────────────────────

/** 去掉信封字段后的消息体（分配到每个成员） */
export type MsgBody<M = AnyMessage> = M extends { type: string } ? Omit<M, "v" | "id"> : never;

/** 给消息体补上信封字段 v/id，并做一次校验。所有发送方都应该用它。 */
export function mkMsg<B extends MsgBody>(body: B, id: string = crypto.randomUUID()): Extract<AnyMessage, { type: B["type"] }> {
  return AnyMessage.parse({ v: 1, id, ...body }) as Extract<AnyMessage, { type: B["type"] }>;
}
