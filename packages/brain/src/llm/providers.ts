import type { ModelTier } from "@cuaremote/protocol";
import { AnthropicWireProvider } from "./anthropic-wire.js";
import { OpenAIWireProvider } from "./openai-wire.js";
import { MockProvider } from "./mock.js";
import type { ModelInfo, Provider } from "./types.js";

/**
 * 模型 id 形如 `<provider>:<model>`：
 *   anthropic:claude-fable-5.1     官方 Anthropic（默认云端）
 *   openai:gpt-6-astra             官方 OpenAI
 *   zenmux:anthropic/claude-...    ZenMux 聚合网关（OpenAI 线格式）
 *   ollama:muse-glimmer:30b-mlx    本机 Ollama（Anthropic 兼容口，Muse 官方推荐）
 *   lmstudio:qwen3.8-27b           本机 LM Studio（OpenAI 兼容口）
 *   openai-compat:<model>@<url>    任意兼容网关（自带 key）
 *   mock                            不联网，跑测试
 *
 * key 从环境变量取：ANTHROPIC_API_KEY / OPENAI_API_KEY / ZENMUX_API_KEY / OPENAI_COMPAT_API_KEY。
 * base url 可用 ANTHROPIC_BASE_URL / OPENAI_BASE_URL / OLLAMA_HOST / LMSTUDIO_HOST 覆盖。
 */
export function createProvider(id: string, env: Record<string, string | undefined> = process.env): Provider {
  if (id === "mock" || id.startsWith("mock:")) return new MockProvider(id);
  const sep = id.indexOf(":");
  if (sep < 0) throw new Error(`模型 id 要写成 provider:model，收到「${id}」`);
  const provider = id.slice(0, sep);
  const model = id.slice(sep + 1);
  const price = lookupPrice(id);

  switch (provider) {
    case "anthropic":
      return new AnthropicWireProvider(
        { id, tier: "standard", zdr: false, vision: true, ...price },
        { baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", apiKey: need(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY"), model },
      );
    case "openai":
      return new OpenAIWireProvider(
        { id, tier: env.OPENAI_ZDR === "1" ? "zdr" : "standard", zdr: env.OPENAI_ZDR === "1", vision: true, ...price },
        { baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", apiKey: need(env.OPENAI_API_KEY, "OPENAI_API_KEY"), model },
      );
    case "zenmux":
      return new OpenAIWireProvider(
        { id, tier: "standard", zdr: false, vision: true, ...price },
        { baseUrl: env.ZENMUX_BASE_URL ?? "https://zenmux.ai/api/v1", apiKey: need(env.ZENMUX_API_KEY, "ZENMUX_API_KEY"), model },
      );
    case "ollama":
      return new AnthropicWireProvider(
        { id, tier: "local", zdr: true, vision: true, priceIn: 0, priceOut: 0 },
        { baseUrl: env.OLLAMA_HOST ?? "http://127.0.0.1:11434", apiKey: "ollama", model },
      );
    case "lmstudio":
      return new OpenAIWireProvider(
        { id, tier: "local", zdr: true, vision: true, priceIn: 0, priceOut: 0 },
        { baseUrl: env.LMSTUDIO_HOST ?? "http://127.0.0.1:1234/v1", apiKey: "lm-studio", model },
      );
    case "openai-compat": {
      const at = model.lastIndexOf("@");
      if (at < 0) throw new Error("openai-compat 要写成 openai-compat:<model>@<baseUrl>");
      return new OpenAIWireProvider(
        { id, tier: "byok", zdr: env.OPENAI_COMPAT_ZDR === "1", vision: true, ...price },
        { baseUrl: model.slice(at + 1), apiKey: env.OPENAI_COMPAT_API_KEY, model: model.slice(0, at) },
      );
    }
    default:
      throw new Error(`不认识的 provider「${provider}」`);
  }
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

/** 每百万 token 美元。不在表里的记 0 并在成本里标 unknownPrice。 */
const PRICES: Record<string, { priceIn: number; priceOut: number }> = {
  "anthropic:claude-fable-5.1": { priceIn: 3, priceOut: 15 },
  "openai:gpt-6-astra": { priceIn: 2.5, priceOut: 10 },
};
export function lookupPrice(id: string): { priceIn: number; priceOut: number } {
  return PRICES[id] ?? { priceIn: 0, priceOut: 0 };
}

export function tierOf(p: Provider): ModelTier {
  return p.info.tier;
}

export type { ModelInfo, Provider };
