import { randomUUID } from "node:crypto";
import { AnyMessage, controlFrame, decodeFrame, mkMsg, parseControl, type MsgBody, type Scope, type ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "./types.js";

/**
 * 云端大脑的宿主：工具在远端设备上执行，消息走「已解密的 Frame」。
 * 加解密和路由不在这里做（见 cloud/peer-links.ts）；这里只管：
 *   - 把 tools.list / tools.call 编成控制帧交给 transport
 *   - 收到设备回的 tools.list.result / tools.result 时对上号
 * 和 StdioHost 是同一份 agent loop 的两种宿主，逻辑对称。
 */
export class RelayHost implements Host {
  private pending = new Map<string, { resolve: (r: ToolResult) => void }>();
  private listeners = new Set<(m: AnyMessage) => void>();
  private toolsCache?: { tools: ToolDescriptor[]; scope: Scope };

  constructor(
    readonly deviceId: string,
    private readonly transport: { send(to: string, frame: Uint8Array): Promise<void> | void },
  ) {}

  /** 设备那边解密后的帧喂进来 */
  handleFrame(frame: Uint8Array) {
    const f = decodeFrame(frame);
    if (f.kind !== 0) return; // pty / media 帧云端大脑不处理
    const parsed = AnyMessage.safeParse(parseControl(f));
    if (!parsed.success) return;
    this.handleMessage(parsed.data);
  }

  /** 已经解析好的消息（CloudBrain 先按类型分流后再交给对应设备的宿主） */
  handleMessage(m: AnyMessage) {
    if (m.type === "tools.result") {
      const p = this.pending.get(m.callId);
      if (p) {
        this.pending.delete(m.callId);
        p.resolve({ ok: m.ok, output: m.output, attachments: m.attachments, error: m.error, ms: m.ms });
      }
      return;
    }
    for (const l of this.listeners) l(m);
  }

  onMessage(fn: (m: AnyMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor<T extends AnyMessage>(pred: (m: AnyMessage) => m is T, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error(`等设备 ${this.deviceId} 回消息超时`));
      }, timeoutMs);
      const off = this.onMessage((m) => {
        if (pred(m)) {
          clearTimeout(t);
          off();
          resolve(m);
        }
      });
    });
  }

  private send(body: MsgBody) {
    return this.transport.send(this.deviceId, controlFrame(mkMsg(body), 0));
  }

  async listTools() {
    if (this.toolsCache) return this.toolsCache;
    const wait = this.waitFor((m): m is Extract<AnyMessage, { type: "tools.list.result" }> => m.type === "tools.list.result", 15_000);
    await this.send({ type: "tools.list" });
    const r = await wait;
    this.toolsCache = { tools: r.tools, scope: r.scope };
    return this.toolsCache;
  }

  invalidateTools() {
    this.toolsCache = undefined;
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> {
    const callId = randomUUID();
    const done = new Promise<ToolResult>((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ ok: false, error: `设备执行 ${tool} 超时`, attachments: [], ms: timeoutMs });
      }, timeoutMs + 5_000);
      this.pending.set(callId, {
        resolve: (r) => {
          clearTimeout(t);
          resolve(r);
        },
      });
    });
    try {
      await this.send({ type: "tools.call", callId, tool, args, timeoutMs });
    } catch (e) {
      this.pending.delete(callId);
      return { ok: false, error: `发不到设备：${e instanceof Error ? e.message : String(e)}`, attachments: [], ms: 0 };
    }
    return done;
  }

  /** 设备掉线时把所有等待中的调用都判失败 */
  failAll(reason: string) {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({ ok: false, error: reason, attachments: [], ms: 0 });
    }
  }
}
