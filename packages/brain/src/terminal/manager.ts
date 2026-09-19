import { statSync } from "node:fs";
import { MAX_STREAM_ID, TERMINAL_SESSION_ID_RE, verifyTerminalOpen, type DeviceToPhone, type Frame, type MsgBody, type PhoneToDevice, type PublicKeys, type ToolDescriptor } from "@cuaremote/protocol";
import type { ToolResult } from "../host/types.js";
import type { PtyFactory } from "./pty.js";
import { TerminalSession, type TerminalSessionOptions } from "./session.js";

/** 大脑在终端模式会先调这个工具（L0）看最近几条命令；宿主有 TerminalManager 时才提供 */
export const TERMINAL_BLOCKS_DESCRIPTOR: ToolDescriptor = {
  name: "terminal.blocks",
  description: "读取某个远程终端会话最近几条命令块（命令、目录、退出码、去掉颜色的输出尾部）。只在开了 shell 集成的会话里有内容。",
  channel: "terminal", staticLevel: 0, costClass: 0, dataLeavesDevice: true,
  inputSchema: { type: "object", properties: { sessionId: { type: "string" }, limit: { type: "integer" } }, required: ["sessionId"] },
};

export type TerminalMessage = Extract<PhoneToDevice, { type: `terminal.${string}` }>;

export interface TerminalManagerOptions {
  spawn: PtyFactory;
  sendFrame: (bytes: Uint8Array) => void;
  sendMsg: (body: MsgBody<DeviceToPhone>) => void;
  /** 这台设备自己的 id：签名里绑了它，别的设备上签的 terminal.open 在这里无效 */
  deviceId: string;
  /**
   * 开终端是 L2：需要手机用 Secure Enclave 签过名（verifyTerminalOpen）。
   * 生产 daemon 必须给 phoneKeys；M0 网页 PoC / 同机调试要显式写 unsafeUnsigned: true，两个都不给构造时直接抛错（不能静默放行）。
   */
  phoneKeys?: Pick<PublicKeys, "sig" | "sigAlg">;
  unsafeUnsigned?: boolean;
  /**
   * 已用过的 nonce → expiresAt。传进来可以让宿主持久化（重启后旧签名 300 秒内仍不能重放）；不传就只在内存里记。
   */
  nonces?: Map<string, number>;
  /** 第一个 streamId。默认按进程启动时间取一个大数，重启后不会和上一轮的 streamId 撞上 */
  firstStreamId?: number;
  /** 同时最多几个会话，默认 8 */
  maxSessions?: number;
  /** 传给每个会话的窗口 / 分块参数 */
  session?: Pick<TerminalSessionOptions, "windowBytes" | "chunkBytes" | "maxQueuedBytes" | "osc">;
  /** 子进程默认工作目录（terminal.open 没带 cwd 时） */
  defaultCwd?: string;
  shell?: string;
  now?: () => number;
  log?: (rec: Record<string, unknown>) => void;
}

/**
 * 多个终端会话 + 手机消息路由（设备侧）。
 * - terminal.open：验签（L2）→ spawn PTY（环境变量 CUAREMOTE_SESSION=sessionId，shell 集成靠它启用）→ 分配 streamId → terminal.opened
 * - kind=1 帧按 streamId 找会话写进 PTY
 * - terminal.resize / terminal.close / terminal.ack 按 sessionId 转给会话
 * - terminal.blocks 工具给大脑
 */
export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly byStream = new Map<number, TerminalSession>();
  private readonly nonces: Map<string, number>;
  private nextStream: number;

  constructor(private readonly o: TerminalManagerOptions) {
    if (!o.phoneKeys && !o.unsafeUnsigned) throw new Error("TerminalManager 需要 phoneKeys（生产）或显式 unsafeUnsigned: true（调试）");
    this.nonces = o.nonces ?? new Map();
    // 高 28 位放秒级时间戳、低 4 位从 1 起：重启后种子一定比上一轮大（2^28 秒 ≈ 8.5 年才绕一圈），最大 0xfffffff1 仍在 u32 内
    const nowSec = o.now?.() ?? Math.floor(Date.now() / 1000);
    this.nextStream = o.firstStreamId ?? ((nowSec % 0x1000_0000) * 16 + 1);
  }

  get size() {
    return this.sessions.size;
  }

  get(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  /** 处理 terminal.* 控制消息；不是终端消息返回 false */
  handle(m: PhoneToDevice): boolean {
    switch (m.type) {
      case "terminal.open":
        this.open(m);
        return true;
      case "terminal.resize":
        this.sessions.get(m.sessionId)?.resize(m.cols, m.rows);
        return true;
      case "terminal.ack":
        this.sessions.get(m.sessionId)?.ack(m.bytes);
        return true;
      case "terminal.close": {
        const s = this.sessions.get(m.sessionId);
        if (s) {
          s.close();
          this.drop(s);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** 手机来的 kind=1 帧 */
  input(frame: Frame): boolean {
    if (frame.kind !== 1) return false;
    const s = this.byStream.get(frame.streamId);
    if (!s) return false;
    s.input(frame.payload);
    return true;
  }

  /** terminal.blocks 工具实现（LocalBunHost 挂进工具表） */
  async callBlocks(args: Record<string, unknown>): Promise<ToolResult> {
    const t0 = Date.now();
    const s = this.sessions.get(String(args.sessionId ?? ""));
    if (!s) return { ok: false, attachments: [], error: `没有会话 ${String(args.sessionId)}`, ms: Date.now() - t0 };
    const raw = Number(args.limit);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.floor(raw))) : 5;
    return { ok: true, attachments: [], output: JSON.stringify({ blocks: s.blocks(limit) }), ms: Date.now() - t0 };
  }

  /**
   * 关掉全部会话。拥有链路的那层在端到端链路重新握手 / 断开时必须调它：
   * 新链路上不能让旧 streamId 的帧（可能是中继方重放的）写进还活着的 shell。
   */
  closeAll() {
    for (const s of [...this.sessions.values()]) {
      s.close();
      this.drop(s);
    }
  }

  private open(m: Extract<PhoneToDevice, { type: "terminal.open" }>) {
    const fail = (code: string, message: string) => this.o.sendMsg({ type: "error", code, message, ref: m.sessionId });
    // 便宜的检查放在验签前面：这些失败不该烧掉一次 Face ID 签名
    if (!TERMINAL_SESSION_ID_RE.test(m.sessionId)) return fail("terminal_bad_session_id", "sessionId 只能是 1–64 个字母、数字、_ 或 -");
    if (this.sessions.has(m.sessionId)) return fail("terminal_exists", `会话 ${m.sessionId} 已经开着`);
    if (this.sessions.size >= (this.o.maxSessions ?? 8)) return fail("terminal_limit", "同时打开的终端太多了");
    const cwd = m.cwd ?? this.o.defaultCwd;
    if (cwd !== undefined && !isDirectory(cwd)) return fail("terminal_bad_cwd", `目录不存在：${cwd}`);
    if (this.o.phoneKeys) {
      const now = this.o.now?.() ?? Math.floor(Date.now() / 1000);
      this.pruneNonces(now);
      const r = verifyTerminalOpen({ sessionId: m.sessionId, deviceId: this.o.deviceId, signature: m.signature, phoneKeys: this.o.phoneKeys, seenNonce: (n) => this.nonces.has(n), now });
      if (!r.ok) {
        this.o.log?.({ t: "terminal.open.rejected", sessionId: m.sessionId, reason: r.reason });
        return fail("approval_invalid", r.message);
      }
      this.nonces.set(m.signature!.nonce, m.signature!.expiresAt);
    }
    let pty;
    try {
      pty = this.o.spawn({ cols: m.cols, rows: m.rows, cwd, shell: this.o.shell, env: { CUAREMOTE_SESSION: m.sessionId } });
    } catch (e) {
      return fail("terminal_spawn_failed", e instanceof Error ? e.message : String(e));
    }
    const streamId = this.nextStream++;
    if (this.nextStream > MAX_STREAM_ID) this.nextStream = 1;
    const s = new TerminalSession({
      sessionId: m.sessionId,
      streamId,
      pty,
      sendFrame: this.o.sendFrame,
      sendMsg: (body) => {
        this.o.sendMsg(body);
        if (body.type === "terminal.exit") this.drop(s);
      },
      log: this.o.log,
      ...this.o.session,
    });
    this.sessions.set(m.sessionId, s);
    this.byStream.set(streamId, s);
    this.o.log?.({ t: "terminal.open", sessionId: m.sessionId, streamId, pid: pty.pid });
  }

  private drop(s: TerminalSession) {
    if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
    if (this.byStream.get(s.streamId) === s) this.byStream.delete(s.streamId);
  }

  /** 过期的 nonce 不可能再验过（expiresAt ≤ now 会先被拒），可以忘掉 */
  private pruneNonces(now: number) {
    for (const [n, exp] of this.nonces) if (exp <= now) this.nonces.delete(n);
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
