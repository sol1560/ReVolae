import type { Scope, ToolDescriptor } from "@cuaremote/protocol";

/** 一次工具调用的结果，和协议里的 tools.result 对齐 */
export interface ToolResult {
  ok: boolean;
  output?: string;
  attachments: { kind: "image/jpeg" | "image/png" | "text/plain"; inline?: string; streamId?: number }[];
  error?: string;
  ms: number;
}

/**
 * 宿主：真正能碰到设备的一方。
 * - LocalBunHost：M0，大脑和设备是同一台机器
 * - StdioHost：M1，Swift/Kotlin daemon spawn 大脑，工具经 stdin/stdout
 * - RelayHost：云端大脑，工具经 hub 中继到设备
 */
export interface Host {
  listTools(): Promise<{ tools: ToolDescriptor[]; scope: Scope }>;
  call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
  close?(): Promise<void>;
}
