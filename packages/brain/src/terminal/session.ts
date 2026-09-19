import { encodeFrame, type DeviceToPhone, type MsgBody, type TerminalBlock } from "@cuaremote/protocol";
import { Osc133Parser, type Osc133Options } from "./osc133.js";
import type { Pty } from "./pty.js";

/**
 * 一个远程终端会话（设备侧参考实现，Swift daemon 照此实现）。
 *
 * 出向（PTY → 手机）：PTY 字节按 chunkBytes 切成 Frame(kind=1, streamId)，走加密链路。
 * 窗口式背压：累计发出 sent、手机累计确认 acked（terminal.ack.bytes），sent - acked ≥ windowBytes 时不再发，先攒在 queue 里；
 * 收到 ack 再放。攒到 maxQueuedBytes 还没人收就认为对端死了，关会话（宁可断也不能悄悄丢字节，丢了终端状态就乱了）。
 *
 * 入向（手机 → PTY）：kind=1 帧原样写进 PTY；terminal.resize / terminal.close 由 TerminalManager 转过来。
 *
 * 命令块：输出同时喂给 Osc133Parser，块状态每变一次发一条 terminal.block；blocks(limit) 给大脑的 terminal.blocks 工具用。
 * 偏移量统一用「会话开始以来的累计输出字节数」，terminal.ack、TerminalBlock 的三个 offset 都是这把尺。
 */
export interface TerminalSessionOptions {
  sessionId: string;
  streamId: number;
  pty: Pty;
  sendFrame: (bytes: Uint8Array) => void;
  sendMsg: (body: MsgBody<DeviceToPhone>) => void;
  /** 未确认字节上限，默认 256 KiB */
  windowBytes?: number;
  /** 单帧最大字节，默认 16 KiB */
  chunkBytes?: number;
  /** 窗口满后最多攒多少，默认 8 MiB */
  maxQueuedBytes?: number;
  osc?: Osc133Options;
  log?: (rec: Record<string, unknown>) => void;
}

export interface TerminalSessionStats {
  sent: number;
  acked: number;
  queued: number;
  frames: number;
  closed: boolean;
}

export class TerminalSession {
  readonly sessionId: string;
  readonly streamId: number;
  private readonly pty: Pty;
  private readonly o: Required<Pick<TerminalSessionOptions, "windowBytes" | "chunkBytes" | "maxQueuedBytes">> & TerminalSessionOptions;
  private readonly parser: Osc133Parser;
  private sent = 0;
  private acked = 0;
  private frames = 0;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private _closed = false;
  private exitSent = false;
  /** PTY 已退出：最后一批输出不再受窗口约束 */
  private draining = false;

  constructor(o: TerminalSessionOptions) {
    this.o = { windowBytes: 256 * 1024, chunkBytes: 16 * 1024, maxQueuedBytes: 8 * 1024 * 1024, ...o };
    this.sessionId = o.sessionId;
    this.streamId = o.streamId;
    this.pty = o.pty;
    this.parser = new Osc133Parser(o.sessionId, o.osc);
    this.pty.onData((c) => this.onPtyData(c));
    this.pty.onExit((code) => this.onPtyExit(code));
    this.o.sendMsg({ type: "terminal.opened", sessionId: this.sessionId, streamId: this.streamId, ...(this.pty.pid !== undefined ? { pid: this.pty.pid } : {}) });
  }

  get closed() {
    return this._closed;
  }

  get stats(): TerminalSessionStats {
    return { sent: this.sent, acked: this.acked, queued: this.queuedBytes, frames: this.frames, closed: this._closed };
  }

  /** 手机敲的字节 */
  input(bytes: Uint8Array) {
    if (this._closed) return;
    this.pty.write(bytes);
  }

  resize(cols: number, rows: number) {
    if (this._closed) return;
    this.pty.resize(cols, rows);
  }

  /** 手机确认已收到多少（累计） */
  ack(bytes: number) {
    if (bytes <= this.acked) return; // 迟到 / 重复的 ack
    if (bytes > this.sent) {
      this.o.log?.({ t: "terminal.ack.bad", sessionId: this.sessionId, bytes, sent: this.sent });
      return;
    }
    this.acked = bytes;
    this.flush();
  }

  /** 最近几条命令块（给 terminal.blocks 工具），带纯文本输出 */
  blocks(limit = 5, maxChars = 4000): { blockId: number; state: TerminalBlock["state"]; command?: string; cwd?: string; exitCode?: number; output: string; truncated: boolean }[] {
    return this.parser.recent(limit).map((b) => ({ blockId: b.blockId, state: b.state, ...Osc133Parser.plain(b, maxChars) }));
  }

  /** 手机主动关，或者管理器收尾 */
  close(reason?: string) {
    if (this._closed) return;
    this._closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.pty.close();
    this.sendExit(undefined, reason);
  }

  private onPtyData(chunk: Uint8Array) {
    if (this._closed) return;
    for (const ev of this.parser.feed(chunk)) this.o.sendMsg({ type: "terminal.block", block: ev });
    for (let i = 0; i < chunk.length; i += this.o.chunkBytes) {
      const part = chunk.subarray(i, Math.min(i + this.o.chunkBytes, chunk.length));
      this.queue.push(part);
      this.queuedBytes += part.length;
    }
    this.flush();
    if (this.queuedBytes > this.o.maxQueuedBytes) {
      this.o.log?.({ t: "terminal.stalled", sessionId: this.sessionId, queued: this.queuedBytes, sent: this.sent, acked: this.acked });
      this.close("对端太久没确认，会话已关闭");
    }
  }

  private flush() {
    while (this.queue.length) {
      const next = this.queue[0]!;
      if (!this.draining && this.sent - this.acked + next.length > this.o.windowBytes && this.sent > this.acked) return;
      this.queue.shift();
      this.queuedBytes -= next.length;
      this.sent += next.length;
      this.frames++;
      this.o.sendFrame(encodeFrame({ kind: 1, streamId: this.streamId, payload: next }));
    }
  }

  private onPtyExit(code: number | undefined) {
    if (this._closed) return;
    this._closed = true;
    // 退出前最后一点输出可能还卡在窗口里：不等 ack 了，直接发完
    this.draining = true;
    this.flush();
    this.sendExit(code);
  }

  private sendExit(code: number | undefined, reason?: string) {
    if (this.exitSent) return;
    this.exitSent = true;
    this.o.sendMsg({ type: "terminal.exit", sessionId: this.sessionId, ...(code !== undefined ? { code } : {}) });
    if (reason) this.o.sendMsg({ type: "error", code: "terminal_closed", message: reason, ref: this.sessionId });
  }
}
