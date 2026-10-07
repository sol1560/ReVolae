import { CommandExitError, Sandbox, type SandboxOpts } from "e2b";
import type { EntryInfo, PtyHandle, RunResult, SandboxHandle, SandboxProvider } from "./handle.js";

/** E2B 的 key：官方变量名 E2B_API_KEY，orb 里存的是 E2B_KEY */
export function e2bApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.E2B_API_KEY ?? env.E2B_KEY;
}

/** 空闲超时后暂停（文件和内存都保留），之后任何 SDK 调用或访问预览链接都会自动唤醒 */
const lifecycle = { onTimeout: "pause", autoResume: true } as const satisfies SandboxOpts["lifecycle"];

class E2bHandle implements SandboxHandle {
  constructor(private readonly sb: Sandbox) {}

  get id() {
    return this.sb.sandboxId;
  }

  async run(cmd: string, o: { cwd?: string; timeoutMs?: number; background?: boolean } = {}): Promise<RunResult> {
    if (o.background) {
      const h = await this.sb.commands.run(cmd, { cwd: o.cwd, background: true, timeoutMs: 0 });
      return { exitCode: 0, stdout: `已在后台启动（pid ${h.pid}）`, stderr: "" };
    }
    try {
      const r = await this.sb.commands.run(cmd, { cwd: o.cwd, timeoutMs: o.timeoutMs ?? 60_000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      // 非 0 退出码 SDK 会抛 CommandExitError，这里还原成普通结果交给模型看
      if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
      throw e;
    }
  }

  async list(path: string, depth = 1): Promise<EntryInfo[]> {
    const items = await this.sb.files.list(path, { depth });
    return items.map((e) => ({ name: e.name, path: e.path, type: e.type === "dir" ? "dir" : "file", size: e.size }));
  }

  async read(path: string): Promise<Uint8Array> {
    return this.sb.files.read(path, { format: "bytes" });
  }

  async write(path: string, data: string | Uint8Array) {
    await this.sb.files.write(path, typeof data === "string" ? data : new Blob([data as Uint8Array<ArrayBuffer>]));
  }

  host(port: number) {
    return this.sb.getHost(port);
  }

  uploadUrl(path: string, ttlSec: number) {
    return this.sb.uploadUrl(path, { useSignatureExpiration: ttlSec });
  }

  downloadUrl(path: string, ttlSec: number) {
    return this.sb.downloadUrl(path, { useSignatureExpiration: ttlSec });
  }

  async pty(o: { cols: number; rows: number; cwd?: string; envs?: Record<string, string>; onData: (chunk: Uint8Array) => void }): Promise<PtyHandle> {
    const h = await this.sb.pty.create({ cols: o.cols, rows: o.rows, cwd: o.cwd, envs: o.envs, onData: o.onData, timeoutMs: 0 });
    const pty = this.sb.pty;
    return {
      pid: h.pid,
      write: (data) => pty.sendInput(h.pid, data),
      resize: (cols, rows) => pty.resize(h.pid, { cols, rows }),
      kill: async () => {
        await pty.kill(h.pid);
      },
      wait: () =>
        h.wait().then(
          (r) => r.exitCode,
          (e) => (e instanceof CommandExitError ? e.exitCode : undefined),
        ),
    };
  }

  keepAlive(ms: number) {
    return this.sb.setTimeout(ms);
  }
}

export class E2bProvider implements SandboxProvider {
  constructor(private readonly apiKey: string) {}

  async create(o: { template: string; idleMs: number; metadata: Record<string, string> }) {
    return new E2bHandle(await Sandbox.create(o.template, { apiKey: this.apiKey, timeoutMs: o.idleMs, metadata: o.metadata, lifecycle }));
  }

  async connect(id: string, idleMs: number) {
    return new E2bHandle(await Sandbox.connect(id, { apiKey: this.apiKey, timeoutMs: idleMs }));
  }

  async fork(id: string, count: number, idleMs: number) {
    const forks = await Sandbox.fork(id, { apiKey: this.apiKey, count, timeoutMs: idleMs });
    return forks.map((f) => (f instanceof Error ? f : new E2bHandle(f)));
  }

  async snapshot(id: string) {
    return (await Sandbox.createSnapshot(id, { apiKey: this.apiKey })).snapshotId;
  }

  async kill(id: string) {
    await Sandbox.kill(id, { apiKey: this.apiKey });
  }
}
