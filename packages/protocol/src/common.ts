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
  /** standard / zdr / byok 档位下的大脑模型 id；不填用大脑默认。选了 zdr 档位但这个模型不支持 ZDR 时大脑会拒绝而不是降级 */
  cloudModel: z.string().optional(),
  /** 可选专用 GUI 模型 */
  localGuiModel: z.string().optional(),
  jevEnabled: z.boolean(),
  /** 谨慎 / 平衡 / 放手 */
  autonomy: z.enum(["cautious", "balanced", "handsoff"]),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;

/** 模型设置页的一行：大脑这一侧能不能用、为什么不能 */
export const ModelEntry = z.object({
  /** provider:model */
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  tier: ModelTier,
  zdr: z.boolean(),
  vision: z.boolean(),
  /** 每百万 token 美元；本地为 0 */
  priceIn: z.number().nonnegative(),
  priceOut: z.number().nonnegative(),
  /** 这台大脑上现在能不能直接用（key 在不在 / 本地服务在不在） */
  available: z.boolean(),
  /** 不能用的原因，如「缺少环境变量 ZENMUX_API_KEY」 */
  unavailableReason: z.string().optional(),
  /** 用户自己加的（openai-compat / 自填模型名） */
  custom: z.boolean().default(false),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

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
  alg: z.enum(["ES256", "Ed25519"]),
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

/** 「学习应用」的原料：daemon 从 sdef / 菜单 / 窗口 / 快捷指令里扒出来的一条能力，还没变成卡片 */
export const InventoryParam = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "bool", "choice", "date", "file", "unknown"]).default("unknown"),
  required: z.boolean().default(false),
  choices: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export const InventoryItem = z.object({
  source: z.enum(["sdef", "menu", "window", "shortcuts", "explored"]),
  /** 同一应用内稳定：sdef 是 suite/command，菜单是路径 "File > Export…"，快捷指令是名字 */
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  params: z.array(InventoryParam).default([]),
  /** sdef：{suite, className, directParam}；菜单：{shortcut, enabled}；窗口：{role, actions}；快捷指令：{acceptsInput} */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type InventoryItem = z.infer<typeof InventoryItem>;
export const AppInventory = z.object({
  bundleId: z.string(),
  appName: z.string(),
  /** 这一批是哪个阶段扒出来的 */
  phase: z.enum(["sdef", "menu", "window", "shortcuts", "explore"]),
  items: z.array(InventoryItem),
  /** 条目太多被截断 */
  truncated: z.boolean().default(false),
});
export type AppInventory = z.infer<typeof AppInventory>;

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

/** 云同步的数据种类，对应 SyncSettings 里的四个开关 */
export const SyncKind = z.enum(["history", "shortcuts", "logs", "screenshots"]);
export type SyncKind = z.infer<typeof SyncKind>;

/**
 * 云同步的一块密文。hub 只看得到这些字段，看不到内容。
 * id 在同一账号同一 kind 内唯一（history 用 runId）；ts 用来排序和「新的覆盖旧的」；
 * nonce / ct 是 AES-256-GCM 的随机数和密文（含 tag），AAD = `${kind}|${id}|${deviceId}|${ts}`，
 * 所以 hub 改任何一个明文字段都会让解密失败。
 */
export const SyncBlob = z.object({
  kind: SyncKind,
  id: z.string().min(1).max(200),
  /** 产生这条数据的设备（被控端或手机） */
  deviceId: z.string(),
  ts: z.number().int(),
  /** 用哪把同步密钥加的（轮换用） */
  keyId: z.string().min(1).max(64),
  alg: z.literal("aes-256-gcm"),
  /** base64，12 字节 */
  nonce: z.string(),
  /** base64，明文 JSON 的密文 + 16 字节 tag；单块 ≤ 64 KiB（base64 前） */
  ct: z.string(),
});
export type SyncBlob = z.infer<typeof SyncBlob>;

/**
 * 终端命令块（OSC 133）：一条命令 + 输出 + 退出码。
 * 偏移量是该会话 PTY 流的累计字节数（和 terminal.ack 同一把尺子），手机据此在自己的缓冲里画块边界。
 */
export const TerminalBlock = z.object({
  sessionId: z.string(),
  /** 会话内递增 */
  blockId: z.number().int().positive(),
  state: z.enum(["prompt", "running", "done"]),
  command: z.string().optional(),
  cwd: z.string().optional(),
  exitCode: z.number().int().optional(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
  /** 提示符开始处 */
  startOffset: z.number().int().nonnegative(),
  /** 命令开始执行处（输出从这里起） */
  outputOffset: z.number().int().nonnegative().optional(),
  /** 命令结束处 */
  endOffset: z.number().int().nonnegative().optional(),
});
export type TerminalBlock = z.infer<typeof TerminalBlock>;

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
