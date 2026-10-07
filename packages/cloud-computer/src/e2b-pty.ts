import type { Pty, PtySpawnOptions } from "@cuaremote/brain";
import type { PtyHandle, SandboxHandle } from "./handle.js";
import { WORK_DIR } from "./constants.js";

/**
 * 云电脑里的 PTY，给现有 TerminalManager 用（分帧、背压、OSC 133 都不用改）。
 * Pty 接口是同步构造的，E2B 建 PTY 是异步的：建好之前的输入和 resize 先排队。
 */
export class E2bPty implements Pty {
  private dataCb: ((c: Uint8Array) => void) | undefined;
  private exitCb: ((code: number | undefined) => void) | undefined;
  private handle: PtyHandle | undefined;
  private queue: Uint8Array[] = [];
  private pendingSize: { cols: number; rows: number } | undefined;
  private closed = false;
  private exited = false;
  /** 正在发往沙箱的输入；E2B 每次 sendInput 是一个独立请求，并发发会乱序，所以一次只发一批 */
  private sending = false;
  private readonly enc = new TextEncoder();
  /** 建好（或失败）时 resolve；测试用 */
  readonly ready: Promise<void>;

  constructor(sandbox: () => Promise<SandboxHandle>, o: PtySpawnOptions) {
    this.ready = this.start(sandbox, o);
  }

  private async start(sandbox: () => Promise<SandboxHandle>, o: PtySpawnOptions) {
    try {
      const sb = await sandbox();
      const h = await sb.pty({
        cols: o.cols,
        rows: o.rows,
        cwd: o.cwd ?? WORK_DIR,
        envs: { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8", ...o.env },
        onData: (chunk) => this.dataCb?.(chunk),
      });
      this.handle = h;
      if (this.closed) {
        await h.kill().catch(() => {});
        this.finish(undefined);
        return;
      }
      void h.wait().then((code) => this.finish(code));
      if (this.pendingSize) await h.resize(this.pendingSize.cols, this.pendingSize.rows);
      void this.flush();
    } catch (e) {
      this.dataCb?.(this.enc.encode(`\r\n[云电脑终端启动失败：${e instanceof Error ? e.message : String(e)}]\r\n`));
      this.finish(undefined);
    }
  }

  private finish(code: number | undefined) {
    if (this.exited) return;
    this.exited = true;
    this.exitCb?.(code);
  }

  get pid() {
    return this.handle?.pid;
  }

  write(data: Uint8Array | string) {
    if (this.closed) return;
    this.queue.push(typeof data === "string" ? this.enc.encode(data) : data);
    void this.flush();
  }

  /** 按顺序发：攒着的输入合成一块，上一块发完再发下一块 */
  private async flush() {
    if (this.sending || !this.handle) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const parts = this.queue.splice(0);
        const merged = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
        let o = 0;
        for (const p of parts) {
          merged.set(p, o);
          o += p.byteLength;
        }
        await this.handle.write(merged).catch(() => {});
      }
    } finally {
      this.sending = false;
    }
  }

  resize(cols: number, rows: number) {
    if (this.handle) void this.handle.resize(cols, rows).catch(() => {});
    else this.pendingSize = { cols, rows };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.handle) void this.handle.kill().catch(() => {}).finally(() => this.finish(undefined));
  }

  onData(cb: (chunk: Uint8Array) => void) {
    this.dataCb = cb;
  }

  onExit(cb: (code: number | undefined) => void) {
    this.exitCb = cb;
  }
}
