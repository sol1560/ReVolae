/**
 * PTY 抽象：TerminalSession 只依赖这个接口，测试用假 PTY，真机用 BunPty（Bun ≥ 1.3 的 Bun.spawn terminal 选项，底层 openpty）。
 * Swift daemon 对应 posix_openpt/forkpty，行为要一致：write 到子进程 stdin、输出走 onData、resize 发 SIGWINCH、close 收尾。
 */
export interface Pty {
  readonly pid?: number;
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  /** 关 PTY 并结束子进程 */
  close(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  /** 子进程退出（exit code 或被信号杀掉时 code 为 undefined） */
  onExit(cb: (code: number | undefined) => void): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd?: string;
  /** 默认用户的登录 shell（$SHELL），退化到 /bin/zsh（Mac）或 /bin/bash */
  shell?: string;
  /** 会追加到子进程环境里；TerminalManager 会放 CUAREMOTE_SESSION */
  env?: Record<string, string>;
}

export type PtyFactory = (o: PtySpawnOptions) => Pty;

/** 真 PTY：Bun.spawn({ terminal }) */
export class BunPty implements Pty {
  private dataCb: ((c: Uint8Array) => void) | undefined;
  private exitCb: ((code: number | undefined) => void) | undefined;
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private exited = false;
  private readonly killAfterMs: number;

  constructor(o: PtySpawnOptions & { killAfterMs?: number }) {
    this.killAfterMs = o.killAfterMs ?? 2000;
    const shell = o.shell ?? process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    this.proc = Bun.spawn([shell, "-l"], {
      cwd: o.cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG ?? "en_US.UTF-8", ...o.env },
      terminal: {
        cols: o.cols,
        rows: o.rows,
        data: (_t, chunk) => this.dataCb?.(new Uint8Array(chunk)),
      },
      onExit: (_p, code) => {
        if (this.exited) return;
        this.exited = true;
        this.exitCb?.(code === null ? undefined : code);
      },
    });
  }

  get pid() {
    return this.proc.pid;
  }
  write(data: Uint8Array | string) {
    this.proc.terminal?.write(data);
  }
  resize(cols: number, rows: number) {
    this.proc.terminal?.resize(cols, rows);
  }
  close() {
    try {
      this.proc.kill("SIGHUP");
    } catch {}
    try {
      this.proc.terminal?.close();
    } catch {}
    // shell 忽略 SIGHUP（trap '' HUP）时不能留下孤儿进程
    const t = setTimeout(() => {
      if (!this.exited) {
        try {
          this.proc.kill("SIGKILL");
        } catch {}
      }
    }, this.killAfterMs);
    if (typeof t === "object" && "unref" in t) t.unref();
  }
  onData(cb: (chunk: Uint8Array) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (code: number | undefined) => void) {
    this.exitCb = cb;
  }
}

export const spawnBunPty: PtyFactory = (o) => new BunPty(o);
