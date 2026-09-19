import type { ModelTier } from "@cuaremote/protocol";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: "image/jpeg" | "image/png"; base64: string };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: ContentPart[] };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: "end" | "tool_use" | "length" | "other";
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** 强制模型调用某个工具（做计划时用） */
  forceTool?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ModelInfo {
  /** provider:model，如 anthropic:claude-fable-5.1 */
  id: string;
  tier: ModelTier;
  /** 是否支持 ZDR（零数据保留） */
  zdr: boolean;
  vision: boolean;
  /** 每百万 token 美元 */
  priceIn: number;
  priceOut: number;
}

export interface Provider {
  info: ModelInfo;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
