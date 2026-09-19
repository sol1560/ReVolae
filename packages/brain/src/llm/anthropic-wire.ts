import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, Provider, ToolCall } from "./types.js";

/**
 * Anthropic Messages 线格式。覆盖：anthropic 官方、ollama 的 Anthropic 兼容口（Muse Glimmer 官方推荐走法）。
 */
export class AnthropicWireProvider implements Provider {
  constructor(
    readonly info: ModelInfo,
    private readonly cfg: { baseUrl: string; apiKey?: string; model: string; version?: string },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => (m as { content: string }).content).join("\n\n");
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
      ...(system ? { system } : {}),
      messages: mergeAdjacent(req.messages.filter((m) => m.role !== "system").map(toAnthropic)),
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      body.tool_choice = req.forceTool ? { type: "tool", name: req.forceTool } : { type: "auto" };
    }
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.cfg.version ?? "2023-06-01",
        ...(this.cfg.apiKey ? { "x-api-key": this.cfg.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`${this.info.id} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const json = (await res.json()) as AnthropicResponse;
    const text = json.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const toolCalls: ToolCall[] = json.content.filter((c) => c.type === "tool_use").map((c) => ({ id: c.id!, name: c.name!, args: (c.input as Record<string, unknown>) ?? {} }));
    return {
      text,
      toolCalls,
      usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
      stopReason: json.stop_reason === "tool_use" ? "tool_use" : json.stop_reason === "max_tokens" ? "length" : json.stop_reason === "end_turn" ? "end" : "other",
    };
  }
}

type ABlock = Record<string, unknown>;
type AMsg = { role: "user" | "assistant"; content: ABlock[] };

function toAnthropic(m: ChatMessage): AMsg {
  switch (m.role) {
    case "user":
      return { role: "user", content: m.content.map(part) };
    case "assistant": {
      const blocks: ABlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      return { role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(继续)" }] };
    }
    case "tool":
      return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content.map(part) }] };
    default:
      throw new Error("system 消息应当已被过滤");
  }
}

function part(p: { type: "text"; text: string } | { type: "image"; mime: string; base64: string }): ABlock {
  return p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mime, data: p.base64 } };
}

/** Anthropic 要求 user/assistant 交替；多个 tool_result 要合并进同一条 user */
function mergeAdjacent(msgs: AMsg[]): AMsg[] {
  const out: AMsg[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

interface AnthropicResponse {
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}
