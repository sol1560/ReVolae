import { createHash } from "node:crypto";
import type { ConcreteAction, Level, PrecheckSource, Scope, ToolDescriptor, Verdict } from "@cuaremote/protocol";
import { JevClient } from "./client.js";

export type Autonomy = "cautious" | "balanced" | "handsoff";

export interface PolicyInput {
  intent: string;
  tool: ToolDescriptor;
  args: Record<string, unknown>;
  action: ConcreteAction;
  scope: Scope;
  /** 最近几步的摘要，给 Jev 当上下文 */
  recent: string[];
}

export interface PolicyDecision {
  staticLevel: Level;
  level: Level;
  verdict: Verdict;
  source: PrecheckSource;
  intentMatch?: boolean;
  risk?: number;
  confidence?: number;
  jevMs?: number;
  jevUsd: number;
  jevTokens: number;
  reason: string;
}

export interface PolicyOptions {
  jev?: JevClient;
  jevEnabled?: boolean;
  autonomy?: Autonomy;
  /** 用户说过「以后自动」的动作指纹 */
  remembered?: Set<string>;
}

/** 静态规则：命令里出现这些片段直接升到 L2 */
const L2_PATTERNS: RegExp[] = [
  /\bsudo\b/, /\brm\s+-rf?\b/, /\bdiskutil\b/, /\bcsrutil\b/, /\bmkfs\b/, /\bdd\s+if=/, /\blaunchctl\b/, /\bdefaults\s+write\b/,
  /\bbrew\s+(install|uninstall|remove)\b/, /\bnpm\s+i(nstall)?\s+-g\b/, /\bpip3?\s+install\b/, /\bsecurity\s+(find|add|delete)-/, /\bkillall\b/, /\bshutdown\b/, /\breboot\b/,
  /\bgit\s+push\s+.*--force\b/, /\bgit\s+reset\s+--hard\b/, /\bchmod\s+777\b/, /\bcurl\b.*\|\s*(ba|z)?sh\b/, /\bosascript\b.*\bdo shell script\b.*administrator/,
];
/** 涉及支付 / 金融的应用名或路径片段 */
const FINANCE_HINTS = ["alipay", "支付宝", "wechat pay", "微信支付", "银行", "bank", "paypal", "stripe", "钱包", "wallet", "keychain", "钥匙串", "1password"];

/** 静态等级 = 工具声明的等级，命中危险模式再升级 */
export function staticLevel(tool: ToolDescriptor, args: Record<string, unknown>, action: ConcreteAction): Level {
  let lvl: Level = tool.staticLevel;
  const text = `${action.detail} ${action.summary} ${action.targetApp ?? ""} ${action.targetPath ?? ""} ${JSON.stringify(args)}`.toLowerCase();
  if (L2_PATTERNS.some((re) => re.test(text))) lvl = 2;
  if (FINANCE_HINTS.some((h) => text.includes(h))) lvl = 2;
  // GUI 里的输入类动作（打字 / 设值）至少 L1；只看不点是 L0
  if (tool.channel === "gui" && /type_text|set_value|press_key|hotkey|click|drag|scroll/.test(text) && lvl < 1) lvl = 1;
  return lvl;
}

export function actionFingerprint(a: ConcreteAction): string {
  return createHash("sha256").update(`${a.channel}\n${a.targetApp ?? ""}\n${a.detail}`).digest("hex").slice(0, 16);
}

/**
 * 策略引擎。顺序固定：静态等级 → 作用域 → Jev（等级 / 意图匹配 / 不可逆风险）→ 自治档位。
 * 「是否完成」永远不在这里问（Jev-cu 把 done 放在 risk 前面是反例）。
 */
export class PolicyEngine {
  private readonly jev: JevClient;
  private readonly jevEnabled: boolean;
  private readonly autonomy: Autonomy;
  private readonly remembered: Set<string>;
  private readonly cache = new Map<string, PolicyDecision>();

  constructor(o: PolicyOptions = {}) {
    this.jev = o.jev ?? new JevClient();
    this.jevEnabled = o.jevEnabled ?? this.jev.enabled;
    this.autonomy = o.autonomy ?? "balanced";
    this.remembered = o.remembered ?? new Set();
  }

  remember(a: ConcreteAction) {
    this.remembered.add(actionFingerprint(a));
  }

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    const sLevel = staticLevel(input.tool, input.args, input.action);

    // 作用域：路径 / 应用白名单不过 → 直接拒绝
    const scopeErr = checkScope(input);
    if (scopeErr) return { staticLevel: sLevel, level: 2, verdict: "deny", source: "static", jevUsd: 0, jevTokens: 0, reason: scopeErr };

    // L2 一律确认，Jev 只用来补充信息，不能降级
    const key = createHash("sha256").update(JSON.stringify([input.intent, input.tool.name, input.action.detail])).digest("hex");
    // 缓存的是 Jev 的评估结果，不是最终结论：用户刚说过「以后自动」，同一动作第二次必须重新算 verdict
    const cached = this.cache.get(key);
    if (cached) {
      const verdict = this.verdict({ level: cached.level, intentMatch: cached.intentMatch, risk: cached.risk, confidence: cached.confidence, source: cached.source, fingerprint: actionFingerprint(input.action) });
      return { ...cached, verdict, source: "cache" };
    }

    let level: Level = sLevel;
    let source: PrecheckSource = "static";
    let intentMatch: boolean | undefined;
    let risk: number | undefined;
    let confidence: number | undefined;
    let jevMs: number | undefined;
    let jevUsd = 0;
    let jevTokens = 0;
    let reason = `静态分级 L${sLevel}`;

    if (this.jevEnabled && sLevel < 2) {
      try {
        const r = await this.jev.ask(
          {
            user_intent: input.intent,
            next_action: { channel: input.action.channel, summary: input.action.summary, detail: input.action.detail.slice(0, 600), target_app: input.action.targetApp, target_path: input.action.targetPath },
            recent_steps: input.recent.slice(-5),
            scope: { allowed_dirs: input.scope.allowedDirs, allowed_apps: input.scope.allowedApps },
          },
          {
            level: {
              type: "choice",
              instructions: "这个动作属于哪一级？0 只读（看文件、列目录、截屏、读状态）；1 写入（改/建/删文件、发消息、跑脚本、开关应用）；2 系统级（改系统设置、装卸软件、管理员权限、钥匙串、支付/金融）。",
              criteria: { "0": "只读", "1": "写入", "2": "系统级或涉及支付/凭据" },
            },
            intent_match: { type: "noul", instructions: "这个动作是否是在执行用户原始意图所需要的（而不是跑题、越权或多余的）？", criteria: { true: "是意图的合理一步", false: "跑题 / 越权 / 与意图无关" } },
            irreversible: { type: "score", instructions: "这个动作造成不可逆后果（数据丢失、已发送、已付款、系统改动）的程度。", criteria: ["完全可逆或只读", "可逆但要花功夫恢复", "部分不可逆", "完全不可逆"] },
          },
        );
        jevMs = r.latencyMs;
        jevUsd = r.usd;
        jevTokens = r.usage.input_tokens ?? 0;
        const lv = Number(r.answers.level.choice) as Level;
        confidence = r.answers.level.confidence;
        intentMatch = r.answers.intent_match.noul >= 0.5;
        risk = Math.min(1, Math.max(0, r.answers.irreversible.score / 3));
        level = Math.max(sLevel, lv) as Level;
        source = "jev";
        reason = `Jev：等级 L${lv}（置信 ${confidence.toFixed(2)}），意图匹配 ${r.answers.intent_match.noul.toFixed(2)}，不可逆 ${risk.toFixed(2)}`;
      } catch (e) {
        source = "fallback";
        reason = `Jev 不可用（${e instanceof Error ? e.message : e}），退回静态分级 L${sLevel}`;
      }
    }

    const verdict = this.verdict({ level, intentMatch, risk, confidence, source, fingerprint: actionFingerprint(input.action) });
    const d: PolicyDecision = { staticLevel: sLevel, level, verdict, source, intentMatch, risk, confidence, jevMs, jevUsd, jevTokens, reason };
    this.cache.set(key, d);
    return d;
  }

  private verdict(p: { level: Level; intentMatch?: boolean; risk?: number; confidence?: number; source: PrecheckSource; fingerprint: string }): Verdict {
    if (p.intentMatch === false) return "confirm";
    if (p.level === 2) return "confirm";
    if (p.level === 0) return "allow";
    // L1
    if (this.remembered.has(p.fingerprint)) return "allow";
    const riskCap = this.autonomy === "cautious" ? 0.2 : this.autonomy === "balanced" ? 0.5 : 0.75;
    const confFloor = this.autonomy === "cautious" ? 0.85 : this.autonomy === "balanced" ? 0.6 : 0.4;
    if (p.source === "jev") {
      if ((p.risk ?? 1) > riskCap) return "confirm";
      if ((p.confidence ?? 0) < confFloor) return "confirm";
      return "allow";
    }
    // 没有 Jev：谨慎 → 确认；平衡 → 确认；放手 → 放行
    return this.autonomy === "handsoff" ? "allow" : "confirm";
  }
}

function checkScope(input: PolicyInput): string | null {
  const { scope, action } = input;
  if (action.targetApp && scope.allowedApps.length && !scope.allowedApps.some((a) => a.toLowerCase() === action.targetApp!.toLowerCase())) {
    return `应用「${action.targetApp}」不在允许列表里`;
  }
  const denied = scope.deniedCommands.find((d) => action.detail.includes(d));
  if (denied) return `命中禁止命令「${denied}」`;
  return null;
}
