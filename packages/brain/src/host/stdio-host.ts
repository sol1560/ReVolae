import { randomUUID } from "node:crypto";
import { AnyMessage, mkMsg, type MsgBody, type PrivacySettings, type Scope, type ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "./types.js";

/**
 * 大脑跑在 `--mode host` 时的宿主：父进程（Swift/Kotlin daemon 或 hub 云端宿主）在 stdin/stdout 上。
 * - 工具调用：写 tools.call，等 tools.result
 * - 手机来的消息（intent.submit / approval.decision / run.cancel / privacy.state）由父进程原样写进来，这里分发给监听者
 * - 大脑要发给手机的事件：直接写 stdout，父进程转发
 */
export class StdioHost implements Host {
  private buf = "";
  private pending = new Map<string, { resolve: (r: ToolResult) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: AnyMessage) => void>();
  private toolsCache?: { tools: ToolDescriptor[]; scope: Scope };
  privacy?: PrivacySettings;

  constructor(private readonly input: NodeJS.ReadableStream = process.stdin, private readonly output: NodeJS.WritableStream = process.stdout) {
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
    input.on("end", () => process.exit(0));
  }

  /** 发给父进程（父进程会转给手机，或自己消费 tools.*） */
  send(body: MsgBody) {
    this.output.write(JSON.stringify(mkMsg(body)) + "\n");
  }

  onMessage(fn: (m: AnyMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 等一条满足条件的消息 */
  waitFor<T extends AnyMessage>(pred: (m: AnyMessage) => m is T, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error("等待宿主消息超时")); }, timeoutMs);
      const off = this.onMessage((m) => {
        if (pred(m)) { clearTimeout(t); off(); resolve(m); }
      });
    });
  }

  async listTools() {
    if (this.toolsCache) return this.toolsCache;
    this.send({ type: "tools.list" });
    const r = await this.waitFor((m): m is Extract<AnyMessage, { type: "tools.list.result" }> => m.type === "tools.list.result", 15_000);
    this.toolsCache = { tools: r.tools, scope: r.scope };
    return this.toolsCache;
  }

  invalidateTools() {
    this.toolsCache = undefined;
  }

  call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> {
    const callId = randomUUID();
    return new Promise<ToolResult>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ ok: false, error: `宿主执行 ${tool} 超时`, attachments: [], ms: timeoutMs });
      }, timeoutMs + 5_000);
      this.pending.set(callId, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject });
      this.send({ type: "tools.call", callId, tool, args, timeoutMs });
    });
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const parsed = AnyMessage.safeParse(safeJson(line));
      if (!parsed.success) {
        this.send({ type: "error", code: "bad_message", message: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ").slice(0, 300) });
        continue;
      }
      const m = parsed.data;
      if (m.type === "tools.result") {
        const p = this.pending.get(m.callId);
        if (p) {
          this.pending.delete(m.callId);
          p.resolve({ ok: m.ok, output: m.output, attachments: m.attachments, error: m.error, ms: m.ms });
        }
        continue;
      }
      if (m.type === "privacy.state") this.privacy = m.settings;
      for (const l of this.listeners) l(m);
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { type: "__bad_json__" };
  }
}
