import { describe, expect, test } from "bun:test";
import { listModels, resolveProvider, tierAccepts, catalogMessage } from "../src/llm/catalog.js";

const KEYS = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", ZENMUX_API_KEY: "z" };

function index<T extends { id: string }>(rows: T[]) {
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string): T => {
    const v = m.get(id);
    if (!v) throw new Error(`清单里没有 ${id}`);
    return v;
  };
}

describe("resolveProvider 档位强制", () => {
  test("zdr 档 + 没开 ZDR 的 anthropic → 报错，不降级", () => {
    expect(() => resolveProvider({ settings: { modelTier: "zdr", cloudModel: "anthropic:claude-fable-5.1" }, defaultModel: "mock", env: KEYS })).toThrow(/零数据保留/);
  });

  test("zdr 档 + OPENAI_ZDR=1 的 openai → 放行", () => {
    const p = resolveProvider({ settings: { modelTier: "zdr", cloudModel: "openai:gpt-6-astra" }, defaultModel: "mock", env: { ...KEYS, OPENAI_ZDR: "1" } });
    expect(p.info.id).toBe("openai:gpt-6-astra");
    expect(p.info.zdr).toBe(true);
  });

  test("ANTHROPIC_ZDR / ZENMUX_ZDR 也生效（providers 与 catalog 一致）", () => {
    expect(resolveProvider({ settings: { modelTier: "zdr", cloudModel: "anthropic:claude-fable-5.1" }, defaultModel: "mock", env: { ...KEYS, ANTHROPIC_ZDR: "1" } }).info.zdr).toBe(true);
    expect(resolveProvider({ settings: { modelTier: "zdr", cloudModel: "zenmux:openai/gpt-6-astra" }, defaultModel: "mock", env: { ...KEYS, ZENMUX_ZDR: "1" } }).info.zdr).toBe(true);
  });

  test("local 档 + 云端模型 → 报错；local 档不填模型走 localBrainModel", () => {
    expect(() => resolveProvider({ settings: { modelTier: "local", localBrainModel: "anthropic:claude-fable-5.1" }, defaultModel: "mock", env: KEYS })).toThrow(/不是本地模型/);
    const p = resolveProvider({ settings: { modelTier: "local", localBrainModel: "ollama:muse-glimmer:30b-mlx" }, defaultModel: "anthropic:claude-fable-5.1", env: KEYS });
    expect(p.info.tier).toBe("local");
  });

  test("local 档下 cloudModel 不会被误用；没有 localBrainModel 时用默认模型并照样受档位约束", () => {
    // cloudModel 是本地模型 id 也不该被 local 档拿来用（字段语义不同）；默认是云端 → 报错
    expect(() => resolveProvider({ settings: { modelTier: "local", cloudModel: "ollama:x" }, defaultModel: "anthropic:claude-fable-5.1", env: KEYS })).toThrow(/不是本地模型/);
  });

  test("requested 可覆盖设置里的模型，但仍受档位约束", () => {
    const ok = resolveProvider({ settings: { modelTier: "standard", cloudModel: "anthropic:claude-fable-5.1" }, requested: "openai:gpt-6-astra", defaultModel: "mock", env: KEYS });
    expect(ok.info.id).toBe("openai:gpt-6-astra");
    expect(() => resolveProvider({ settings: { modelTier: "zdr", cloudModel: "openai:gpt-6-astra" }, requested: "anthropic:claude-fable-5.1", defaultModel: "mock", env: { ...KEYS, OPENAI_ZDR: "1" } })).toThrow(/零数据保留/);
  });

  test("standard 档任何模型都放行；没设置时按 standard 处理", () => {
    expect(resolveProvider({ settings: { modelTier: "standard" }, defaultModel: "ollama:m", env: KEYS }).info.tier).toBe("local");
    expect(resolveProvider({ defaultModel: "anthropic:claude-fable-5.1", env: KEYS }).info.id).toBe("anthropic:claude-fable-5.1");
  });

  test("byok 档只收 openai-compat 或本地", () => {
    expect(() => resolveProvider({ settings: { modelTier: "byok", cloudModel: "openai:gpt-6-astra" }, defaultModel: "mock", env: KEYS })).toThrow(/自带 key/);
    expect(resolveProvider({ settings: { modelTier: "byok", cloudModel: "openai-compat:foo@http://gw.local/v1" }, defaultModel: "mock", env: KEYS }).info.tier).toBe("byok");
  });

  test("缺 key 的报错原样冒出（不是档位错）", () => {
    expect(() => resolveProvider({ settings: { modelTier: "standard", cloudModel: "openai:gpt-6-astra" }, defaultModel: "mock", env: {} })).toThrow(/OPENAI_API_KEY/);
  });
});

describe("tierAccepts", () => {
  test("边界：zdr 档看 zdr 标志而非 tier 字段", () => {
    expect(tierAccepts("zdr", { tier: "local", zdr: true })).toBe(true);
    expect(tierAccepts("zdr", { tier: "byok", zdr: false })).toBe(false);
    expect(tierAccepts("local", { tier: "zdr", zdr: true })).toBe(false);
    expect(tierAccepts("byok", { tier: "standard", zdr: true })).toBe(false);
  });
});

describe("listModels", () => {
  test("缺 key 标 unavailable 且说明缺哪个变量", () => {
    const rows = listModels({ env: { OPENAI_API_KEY: "o" } });
    const byId = index(rows);
    expect(byId("openai:gpt-6-astra").available).toBe(true);
    expect(byId("anthropic:claude-fable-5.1").available).toBe(false);
    expect(byId("anthropic:claude-fable-5.1").unavailableReason).toContain("ANTHROPIC_API_KEY");
  });

  test("OPENAI_ZDR=1 时 tier 变 zdr，其它厂商不受影响", () => {
    const rows = listModels({ env: { ...KEYS, OPENAI_ZDR: "1" } });
    const byId = index(rows);
    expect(byId("openai:gpt-6-astra").tier).toBe("zdr");
    expect(byId("openai:gpt-6-astra").zdr).toBe(true);
    expect(byId("anthropic:claude-fable-5.1").tier).toBe("standard");
    expect(byId("zenmux:openai/gpt-6-astra").zdr).toBe(false);
  });

  test("本地模型可用性由 localUp 决定，且永远是 local 档 + zdr", () => {
    const down = listModels({ env: KEYS, localUp: { ollama: false, lmstudio: true } });
    const byId = index(down);
    expect(byId("ollama:muse-glimmer:30b-mlx").available).toBe(false);
    expect(byId("ollama:muse-glimmer:30b-mlx").unavailableReason).toContain("Ollama");
    expect(byId("lmstudio:qwen3.8-27b").available).toBe(true);
    expect(byId("lmstudio:qwen3.8-27b").tier).toBe("local");
    expect(byId("lmstudio:qwen3.8-27b").zdr).toBe(true);
    expect(byId("lmstudio:qwen3.8-27b").priceIn).toBe(0);
  });

  test("custom 模型标 custom=true、byok 档，无 key 也算可用", () => {
    const rows = listModels({ env: {}, custom: [{ id: "openai-compat:foo@http://gw/v1", label: "我的网关" }] });
    const c = rows.find((r) => r.custom)!;
    expect(c).toMatchObject({ id: "openai-compat:foo@http://gw/v1", label: "我的网关", provider: "openai-compat", tier: "byok", available: true });
  });

  test("catalogMessage 产出 models.catalog 报文", () => {
    const m = catalogMessage({ env: KEYS, defaultModel: "anthropic:claude-fable-5.1", brainLocation: "cloud" });
    expect(m.type).toBe("models.catalog");
    expect(m.brainLocation).toBe("cloud");
    expect(m.models.length).toBeGreaterThanOrEqual(7);
  });
});
