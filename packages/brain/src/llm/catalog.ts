import type { BrainLocation, ModelEntry, ModelTier, PrivacySettings } from "@cuaremote/protocol";
import { createProvider, lookupPrice } from "./providers.js";
import type { Provider } from "./types.js";

/**
 * 模型注册表：手机上的「模型设置页」显示的就是这张表 + 大脑这一侧的可用性。
 * 选模型的规则（resolveProvider）：
 *   1. 用户在设置里选了档位（modelTier），大脑只在这个档位里选，**选了 zdr / local 绝不悄悄退回普通云端**；
 *   2. intent.submit.provider 可以指定具体模型，但仍要符合当前档位，不符合直接报错；
 *   3. 档位内没指定模型：local 用 localBrainModel，其它用 cloudModel，再没有就用大脑默认（默认不合档位也报错）。
 */

type Env = Record<string, string | undefined>;

interface CatalogRow {
  id: string;
  label: string;
  vision: boolean;
  /** 需要哪个环境变量才能用；本地服务用 probe 探测 */
  needsEnv?: string;
  /** zdr 由哪个环境变量开关（账号级 ZDR 是运营方和厂商签的，大脑只能信配置） */
  zdrEnv?: string;
  zdr?: boolean;
  tier: ModelTier;
  local?: boolean;
}

/** 内置清单。价格在 providers.ts 的 PRICES 里，这里不重复。 */
export const BUILTIN_MODELS: CatalogRow[] = [
  { id: "anthropic:claude-fable-5.1", label: "Claude Fable 5.1", vision: true, needsEnv: "ANTHROPIC_API_KEY", zdrEnv: "ANTHROPIC_ZDR", tier: "standard" },
  { id: "anthropic:claude-opus-5", label: "Claude Opus 5", vision: true, needsEnv: "ANTHROPIC_API_KEY", zdrEnv: "ANTHROPIC_ZDR", tier: "standard" },
  { id: "openai:gpt-6-astra", label: "GPT-6 Astra", vision: true, needsEnv: "OPENAI_API_KEY", zdrEnv: "OPENAI_ZDR", tier: "standard" },
  { id: "zenmux:anthropic/claude-fable-5.1", label: "Claude Fable 5.1（ZenMux）", vision: true, needsEnv: "ZENMUX_API_KEY", zdrEnv: "ZENMUX_ZDR", tier: "standard" },
  { id: "zenmux:openai/gpt-6-astra", label: "GPT-6 Astra（ZenMux）", vision: true, needsEnv: "ZENMUX_API_KEY", zdrEnv: "ZENMUX_ZDR", tier: "standard" },
  { id: "ollama:muse-glimmer:30b-mlx", label: "Muse Glimmer 30B（Ollama，本机）", vision: true, tier: "local", local: true, zdr: true },
  { id: "lmstudio:qwen3.8-27b", label: "Qwen 3.8 27B（LM Studio，本机）", vision: true, tier: "local", local: true, zdr: true },
];

export interface CatalogOptions {
  env?: Env;
  /** 本地服务探测结果（host 模式启动时探一次；云端大脑没有本地服务，全部 false） */
  localUp?: { ollama?: boolean; lmstudio?: boolean };
  /** 用户自己加的模型（openai-compat:<model>@<url> 等） */
  custom?: { id: string; label?: string; zdr?: boolean }[];
}

/** 一行 → 手机能显示的 ModelEntry，附带可用性判断 */
export function listModels(o: CatalogOptions = {}): ModelEntry[] {
  const env = o.env ?? process.env;
  const rows: ModelEntry[] = BUILTIN_MODELS.map((r) => {
    const price = lookupPrice(r.id);
    const zdr = r.zdr ?? (r.zdrEnv ? env[r.zdrEnv] === "1" : false);
    let available = true;
    let unavailableReason: string | undefined;
    if (r.needsEnv && !env[r.needsEnv]) {
      available = false;
      unavailableReason = `缺少环境变量 ${r.needsEnv}`;
    } else if (r.local) {
      const up = r.id.startsWith("ollama:") ? o.localUp?.ollama : o.localUp?.lmstudio;
      if (!up) {
        available = false;
        unavailableReason = r.id.startsWith("ollama:") ? "本机 Ollama 没在运行" : "本机 LM Studio 没在运行";
      }
    }
    // 账号级 ZDR 开着的模型同时算 zdr 档位可选；tier 字段报「最严格能满足的档位」
    const tier: ModelTier = r.local ? "local" : zdr ? "zdr" : "standard";
    return { id: r.id, label: r.label, provider: r.id.slice(0, r.id.indexOf(":")), tier, zdr, vision: r.vision, priceIn: price.priceIn, priceOut: price.priceOut, available, unavailableReason, custom: false };
  });
  for (const c of o.custom ?? []) {
    const provider = c.id.slice(0, Math.max(0, c.id.indexOf(":")));
    const price = lookupPrice(c.id);
    const available = true; // 自带网关允许无 key，能不能连上要等真正调用时才知道
    rows.push({ id: c.id, label: c.label ?? c.id, provider, tier: "byok", zdr: c.zdr ?? env.OPENAI_COMPAT_ZDR === "1", vision: true, priceIn: price.priceIn, priceOut: price.priceOut, available, custom: true });
  }
  return rows;
}

/** 探测本机 Ollama / LM Studio 是否在跑（各 800ms 超时；失败就当没开） */
export async function probeLocal(env: Env = process.env): Promise<{ ollama: boolean; lmstudio: boolean }> {
  const hit = async (url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      return r.ok;
    } catch {
      return false;
    }
  };
  const [ollama, lmstudio] = await Promise.all([hit(`${env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}/api/tags`), hit(`${env.LMSTUDIO_HOST ?? "http://127.0.0.1:1234/v1"}/models`)]);
  return { ollama, lmstudio };
}

export interface ResolveInput {
  settings?: Pick<PrivacySettings, "modelTier" | "localBrainModel" | "cloudModel">;
  /** intent.submit.provider */
  requested?: string;
  defaultModel: string;
  env?: Env;
}

/** 档位是否容得下这个模型：zdr 档只收 zdr 模型；local 档只收本地；byok 收 openai-compat 或任何自带 key 的；standard 全收 */
export function tierAccepts(tier: ModelTier, info: { tier: ModelTier; zdr: boolean }): boolean {
  switch (tier) {
    case "local":
      return info.tier === "local";
    case "zdr":
      return info.zdr;
    case "byok":
      return info.tier === "byok" || info.tier === "local";
    case "standard":
      return true;
  }
}

const TIER_LABEL: Record<ModelTier, string> = { standard: "标准云端", zdr: "零数据保留（ZDR）", byok: "自带 key", local: "本地" };

/**
 * 按用户档位选模型并建 Provider。选错不会静默降级：抛错，调用方回 error{code:"provider"} 给手机。
 */
export function resolveProvider(i: ResolveInput): Provider {
  const tier = i.settings?.modelTier ?? "standard";
  const chosen = i.requested ?? (tier === "local" ? i.settings?.localBrainModel : i.settings?.cloudModel) ?? i.defaultModel;
  if (!chosen) throw new Error(`「${TIER_LABEL[tier]}」档位下还没选模型`);
  const p = createProvider(chosen, i.env);
  if (!tierAccepts(tier, p.info)) {
    const why = tier === "zdr" ? "它不支持零数据保留" : tier === "local" ? "它不是本地模型" : "它不是自带 key 的模型";
    throw new Error(`当前档位是「${TIER_LABEL[tier]}」，模型 ${chosen} 用不了：${why}。换个模型或改档位。`);
  }
  return p;
}

export function catalogMessage(o: CatalogOptions & { defaultModel: string; brainLocation: BrainLocation }) {
  return { type: "models.catalog" as const, models: listModels(o), defaultModel: o.defaultModel, brainLocation: o.brainLocation };
}
