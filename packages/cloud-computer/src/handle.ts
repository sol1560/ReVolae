/**
 * 云电脑对沙箱的全部依赖都在这两个接口里。真实实现是 E2B（./e2b.ts），测试用内存假实现。
 * 故意只暴露用得到的能力，换沙箱供应商时只需要重写一个适配器。
 */

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface EntryInfo {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

export interface PtyHandle {
  readonly pid: number;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  /** PTY 里的 shell 退出时 resolve（exit code 拿不到时为 undefined） */
  wait(): Promise<number | undefined>;
}

export interface SandboxHandle {
  readonly id: string;
  run(cmd: string, o?: { cwd?: string; timeoutMs?: number; background?: boolean }): Promise<RunResult>;
  list(path: string, depth?: number): Promise<EntryInfo[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** 沙箱里某个端口对外的主机名（不带协议） */
  host(port: number): string;
  /** 手机直传 / 直下用的签名地址，大文件不经过 hub */
  uploadUrl(path: string, ttlSec: number): Promise<string>;
  downloadUrl(path: string, ttlSec: number): Promise<string>;
  pty(o: { cols: number; rows: number; cwd?: string; envs?: Record<string, string>; onData: (chunk: Uint8Array) => void }): Promise<PtyHandle>;
  /** 从现在起再空闲这么久才自动暂停 */
  keepAlive(ms: number): Promise<void>;
}

export interface SandboxProvider {
  create(o: { template: string; idleMs: number; metadata: Record<string, string> }): Promise<SandboxHandle>;
  /** 连接已有机器；暂停中的会被唤醒 */
  connect(id: string, idleMs: number): Promise<SandboxHandle>;
  /** 原样复制成 count 份（文件 + 内存 + 进程）；每份独立成功或失败 */
  fork(id: string, count: number, idleMs: number): Promise<(SandboxHandle | Error)[]>;
  /** 存一份快照，返回可以用来 create 的模板 id */
  snapshot(id: string): Promise<string>;
  kill(id: string): Promise<void>;
}
