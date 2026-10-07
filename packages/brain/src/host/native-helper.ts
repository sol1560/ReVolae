import { z } from "@cuaremote/protocol";

/** Swift helper 只接收独立参数，不通过 shell 拼接。未安装或权限不足时保留真实错误。 */
export async function nativeHelper<T>(args: string[], schema: z.ZodType<T>, timeoutMs = 15_000, signal?: AbortSignal, input?: string): Promise<T> {
  signal?.throwIfAborted();
  const executable = process.env.CUAREMOTE_NATIVE_HELPER;
  if (!executable) throw new Error("Mac 原生服务未连接，请先启动 Mac App");
  const proc = Bun.spawn([executable, ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const abort = () => proc.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(error.trim().slice(0, 500) || `Mac 原生服务退出：${code}`);
    return schema.parse(JSON.parse(output));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
