import type { ChatMessage, ChatRequest, ChatResponse, ModelInfo, Provider, ToolCall } from "./types.js";

/**
 * OpenAI Chat Completions 线格式。覆盖：openai、lmstudio、ollama(/v1)、zenmux、任何兼容网关。
 */
export class OpenAIWireProvider implements Provider {
  constructor(
    readonly info: ModelInfo,
    private readonly cfg: { baseUrl: string; apiKey?: string; model: string; extraHeaders?: Record<string, string> },
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages.map(toOpenAI),
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      body.tool_choice = req.forceTool ? { type: "function", function: { name: req.forceTool } } : "auto";
    }
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}), ...this.cfg.extraHeaders },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`${this.info.id} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const json = (await res.json()) as OpenAIResponse;
    const choice = json.choices?.[0];
    const msg = choice?.message ?? { content: "" };
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, args: safeJson(tc.function.arguments) }));
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolCalls,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
      stopReason: choice?.finish_reason === "tool_calls" || toolCalls.length ? "tool_use" : choice?.finish_reason === "length" ? "length" : choice?.finish_reason === "stop" ? "end" : "other",
    };
  }
}

function toOpenAI(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content.map(partToOpenAI) };
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) } : {}),
      };
    case "tool": {
      // OpenAI 的 tool 消息只能是文本；图片另起一条 user 消息（由 loop 负责），这里只拼文本
      const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      return { role: "tool", tool_call_id: m.toolCallId, content: text || "(无文本输出)" };
    }
  }
}

function partToOpenAI(p: { type: "text"; text: string } | { type: "image"; mime: string; base64: string }) {
  return p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.base64}` } };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return { _raw: s };
  }
}

interface OpenAIResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
