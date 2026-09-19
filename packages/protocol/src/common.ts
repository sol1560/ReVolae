import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

/** 操作分级：0 只读 / 1 写入 / 2 系统级 */
export const Level = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type Level = z.infer<typeof Level>;

/** 执行通道 */
export const Channel = z.enum([
  "shell",
  "applescript",
  "jxa",
  "shortcuts",
  "fs",
  "gui",
  "app",
  "ipad",
  "android",
  "terminal",
]);
export type Channel = z.infer<typeof Channel>;

export const Verdict = z.enum(["allow", "confirm", "deny"]);
export type Verdict = z.infer<typeof Verdict>;

export const PrecheckSource = z.enum(["jev", "static", "cache", "fallback"]);
export type PrecheckSource = z.infer<typeof PrecheckSource>;

export const ModelTier = z.enum(["standard", "zdr", "byok", "local"]);
export type ModelTier = z.infer<typeof ModelTier>;

export const BrainLocation = z.enum(["local", "cloud", "lan"]);
export type BrainLocation = z.infer<typeof BrainLocation>;

export const PrivacyPreset = z.enum(["all_local", "balanced", "all_cloud"]);
export type PrivacyPreset = z.infer<typeof PrivacyPreset>;

export const SyncSettings = z.object({
  history: z.boolean(),
  screenshots: z.boolean(),
  logs: z.boolean(),
  shortcuts: z.boolean(),
});
export type SyncSettings = z.infer<typeof SyncSettings>;

export const PrivacySettings = z.object({
  brainLocation: BrainLocation,
  /** brainLocation = lan 时借用哪台设备的大脑 */
  brainDeviceId: z.string().optional(),
  sync: SyncSettings,
  modelTier: ModelTier,
  /** 本地档位下的大脑模型 id（provider:model） */
  localBrainModel: z.string().optional(),
  /** 可选专用 GUI 模型 */
  localGuiModel: z.string().optional(),
  jevEnabled: z.boolean(),
  /** 谨慎 / 平衡 / 放手 */
  autonomy: z.enum(["cautious", "balanced", "handsoff"]),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;

export const Cost = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  jevTokens: z.number().int().nonnegative().default(0),
  usd: z.number().nonnegative(),
});
export type Cost = z.infer<typeof Cost>;

export const PlanStepStatus = z.enum([
  "pending",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "skipped",
  "cancelled",
]);

export const PlanStep = z.object({
  id: z.string(),
  title: z.string(),
  channel: Channel.optional(),
  staticLevel: Level.optional(),
  status: PlanStepStatus,
});
export type PlanStep = z.infer<typeof PlanStep>;

/** 审批卡片上必须展示的「具体将执行什么」 */
export const ConcreteAction = z.object({
  channel: Channel,
  /** 一句话 */
  summary: z.string(),
  /** 完整命令 / 脚本 / {app, window, element, action} 文本 */
  detail: z.string(),
  targetApp: z.string().optional(),
  targetPath: z.string().optional(),
});
export type ConcreteAction = z.infer<typeof ConcreteAction>;

/** 手机审批签名：Secure Enclave P-256 对 canonical 串签名 */
export const ApprovalSignature = z.object({
  alg: z.literal("ES256"),
  keyId: z.string(),
  /** base64 DER 或 raw r||s（Swift 用 rawRepresentation） */
  sig: z.string(),
  /** 秒级 unix 时间，≤ 2 分钟 */
  expiresAt: z.number().int(),
  nonce: z.string(),
});
export type ApprovalSignature = z.infer<typeof ApprovalSignature>;

export const DevicePlatform = z.enum(["macos", "ios", "ipados", "android", "cloud"]);

export const PublicKeys = z.object({
  /** X25519，base64 */
  kem: z.string(),
  /** P-256 或 Ed25519 签名公钥，base64 */
  sig: z.string(),
  sigAlg: z.enum(["ES256", "Ed25519"]),
});
export type PublicKeys = z.infer<typeof PublicKeys>;

export const ToolDescriptor = z.object({
  name: z.string(),
  description: z.string(),
  channel: Channel,
  staticLevel: Level,
  /** 0 免费 / 1 便宜 / 2 贵（截图推理） */
  costClass: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  /** 调用结果会进入模型上下文并可能离开设备 */
  dataLeavesDevice: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const Scope = z.object({
  allowedDirs: z.array(z.string()),
  allowedApps: z.array(z.string()),
  deniedCommands: z.array(z.string()),
});
export type Scope = z.infer<typeof Scope>;

/** 学习应用生成的能力卡片 */
export const CardControl = z.enum(["button", "input_button", "list", "toggle", "picker", "form"]);
export const CardField = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["text", "number", "bool", "choice", "date"]),
  choices: z.array(z.string()).optional(),
  required: z.boolean().default(true),
});
export const CardAction = z.object({
  kind: z.enum(["applescript", "jxa", "shortcut", "gui", "shell"]),
  /** 模板，占位 {{key}} */
  template: z.string(),
});
export const CapabilityCard = z.object({
  id: z.string(),
  appBundleId: z.string(),
  appName: z.string(),
  name: z.string(),
  description: z.string(),
  control: CardControl,
  fields: z.array(CardField).default([]),
  action: CardAction,
  /** list 控件的数据源脚本 */
  dataSource: CardAction.optional(),
  staticLevel: Level,
  /** 只读层 / 探索层 */
  source: z.enum(["sdef", "menu", "window", "shortcuts", "explored", "adapter"]),
  hidden: z.boolean().default(false),
});
export type CapabilityCard = z.infer<typeof CapabilityCard>;

export const Shortcut = z.object({
  id: z.string(),
  name: z.string(),
  /** 一段意图或一条命令 */
  body: z.string(),
  runIn: z.enum(["agent", "terminal", "ssh"]),
  sshHostId: z.string().optional(),
  level: Level,
});
export type Shortcut = z.infer<typeof Shortcut>;

export const HistoryItem = z.object({
  runId: z.string(),
  deviceId: z.string(),
  intent: z.string(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
  ok: z.boolean().optional(),
  summary: z.string().optional(),
  cost: Cost.optional(),
  stepCount: z.number().int().optional(),
});
export type HistoryItem = z.infer<typeof HistoryItem>;

export const DeviceStats = z.object({
  batteryPercent: z.number().optional(),
  charging: z.boolean().optional(),
  network: z.string().optional(),
  runningApps: z.array(z.string()),
  cpuPercent: z.number().optional(),
  memUsedMB: z.number().optional(),
  uptimeSec: z.number().optional(),
});
export type DeviceStats = z.infer<typeof DeviceStats>;
