import { z } from "@cuaremote/protocol";
import { runProcess } from "./process-runner.js";

/** Swift helper 独立接收 argv；请求 JSON 只走 stdin，错误消息不带请求正文。 */
export async function nativeHelper<T>(args: string[], schema: z.ZodType<T>, timeoutMs = 15_000, signal?: AbortSignal, input?: string): Promise<T> {
  signal?.throwIfAborted();
  const executable = process.env.CUAREMOTE_NATIVE_HELPER;
  if (!executable) throw new Error("Mac 原生服务未连接，请先启动 Mac App");
  const result = await runProcess([executable, ...args], { timeoutMs, signal, input });
  if (signal?.aborted || result.failure === "aborted") throw new Error("Mac 原生服务操作已取消");
  if (result.failure === "timeout") throw new Error("Mac 原生服务响应超时");
  if (result.failure === "input_limit") throw new Error("Mac 原生服务请求超过大小限制");
  if (result.failure || result.code !== 0 || result.stdinClosedEarly) {
    throw new Error(result.failure === "spawn_error" ? "无法启动 Mac 原生服务" : "Mac 原生服务执行失败");
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new Error("Mac 原生服务返回了无效响应");
  }
  try {
    return schema.parse(value);
  } catch {
    throw new Error("Mac 原生服务返回了不符合预期的响应");
  }
}
