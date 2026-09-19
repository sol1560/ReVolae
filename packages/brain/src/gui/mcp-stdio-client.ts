import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 极简 MCP stdio 客户端（JSON-RPC 2.0，每行一个消息）。只实现 initialize / tools/list / tools/call。
 * 不引入 @modelcontextprotocol/sdk 是为了避开 zod 版本冲突和一大坨依赖。
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export class McpStdioClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private stderrTail: string[] = [];

  constructor(private readonly argv: string[], private readonly env: Record<string, string | undefined> = process.env) {}

  async start(): Promise<void> {
    const [cmd, ...args] = this.argv;
    this.proc = spawn(cmd!, args, { stdio: ["pipe", "pipe", "pipe"], env: this.env as NodeJS.ProcessEnv });
    const spawnFailed = new Promise<never>((_, reject) => this.proc!.once("error", (e) => reject(new Error(`起不来 ${cmd}: ${e.message}`))));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => this.onData(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => {
      this.stderrTail.push(d);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`MCP 进程退出 ${code}：${this.stderrTail.join("").slice(-500)}`));
      this.pending.clear();
    });
    this.proc.stdin.on("error", () => {});
    await Promise.race([spawnFailed, this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cuaremote-brain", version: "0.1.0" } }, 10_000)]);
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const r = (await this.request("tools/list", {})) as { tools: McpTool[] };
    return r.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as McpCallResult;
  }

  async close(): Promise<void> {
    this.proc?.stdin.end();
    this.proc?.kill();
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.proc) throw new Error("MCP 未启动");
    const id = this.nextId++;
    const p = new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  private notify(method: string, params: unknown) {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message: string; code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined) continue; // 通知，忽略
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`MCP 错误 ${msg.error.code ?? ""}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }
}
