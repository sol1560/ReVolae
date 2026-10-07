import { posix } from "node:path";
import type { EntryInfo, PtyHandle, RunResult, SandboxHandle, SandboxProvider } from "../src/handle.js";

/** 内存假沙箱：文件系统是一张 Map，命令按脚本表回应 */
export class FakeSandbox implements SandboxHandle {
  files = new Map<string, Uint8Array>();
  commands: { cmd: string; cwd?: string; background?: boolean }[] = [];
  /** 按命令正则返回结果；没匹配的返回 exit 0 空输出 */
  responders: [RegExp, (cmd: string) => RunResult][] = [];
  keepAlives: number[] = [];
  ptys: FakePty[] = [];
  killed = false;

  constructor(readonly id: string) {}

  clone(id: string) {
    const f = new FakeSandbox(id);
    f.files = new Map([...this.files].map(([k, v]) => [k, v.slice()]));
    f.responders = [...this.responders];
    return f;
  }

  async run(cmd: string, o: { cwd?: string; timeoutMs?: number; background?: boolean } = {}): Promise<RunResult> {
    if (this.killed) throw new Error(`sandbox ${this.id} killed`);
    this.commands.push({ cmd, cwd: o.cwd, background: o.background });
    for (const [re, fn] of this.responders) if (re.test(cmd)) return fn(cmd);
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async list(path: string): Promise<EntryInfo[]> {
    const out: EntryInfo[] = [];
    for (const [p, data] of this.files) if (posix.dirname(p) === path) out.push({ name: posix.basename(p), path: p, type: "file", size: data.length });
    return out;
  }

  async read(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file ${path}`);
    return f;
  }

  async write(path: string, data: string | Uint8Array) {
    this.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  host(port: number) {
    return `${port}-${this.id}.e2b.test`;
  }

  async uploadUrl(path: string, ttl: number) {
    return `https://up.e2b.test/${this.id}${path}?ttl=${ttl}`;
  }

  async downloadUrl(path: string, ttl: number) {
    return `https://down.e2b.test/${this.id}${path}?ttl=${ttl}`;
  }

  async pty(o: { cols: number; rows: number; cwd?: string; envs?: Record<string, string>; onData: (c: Uint8Array) => void }) {
    const p = new FakePty(o);
    this.ptys.push(p);
    return p;
  }

  async keepAlive(ms: number) {
    if (this.killed) throw new Error("gone");
    this.keepAlives.push(ms);
  }
}

export class FakePty implements PtyHandle {
  readonly pid = 42;
  input: Uint8Array[] = [];
  sizes: { cols: number; rows: number }[] = [];
  killed = false;
  private exit!: (code: number | undefined) => void;
  private readonly exited = new Promise<number | undefined>((r) => (this.exit = r));
  constructor(readonly opts: { cols: number; rows: number; cwd?: string; envs?: Record<string, string>; onData: (c: Uint8Array) => void }) {}
  async write(d: Uint8Array) {
    this.input.push(d);
  }
  async resize(cols: number, rows: number) {
    this.sizes.push({ cols, rows });
  }
  async kill() {
    this.killed = true;
    this.exit(undefined);
  }
  wait() {
    return this.exited;
  }
  /** 模拟 shell 输出 / 退出 */
  emit(s: string) {
    this.opts.onData(new TextEncoder().encode(s));
  }
  quit(code: number) {
    this.exit(code);
  }
}

export class FakeProvider implements SandboxProvider {
  boxes = new Map<string, FakeSandbox>();
  created: { template: string; metadata: Record<string, string> }[] = [];
  killed: string[] = [];
  connects: string[] = [];
  snapshots = new Map<string, FakeSandbox>();
  private n = 0;
  failForkIndex?: number;

  private fresh(from?: FakeSandbox) {
    const id = `sb${++this.n}`;
    const box = from ? from.clone(id) : new FakeSandbox(id);
    this.boxes.set(id, box);
    return box;
  }

  async create(o: { template: string; idleMs: number; metadata: Record<string, string> }) {
    this.created.push({ template: o.template, metadata: o.metadata });
    return this.fresh(this.snapshots.get(o.template));
  }

  async connect(id: string) {
    this.connects.push(id);
    const b = this.boxes.get(id);
    if (!b || b.killed) throw new Error(`sandbox ${id} not found`);
    return b;
  }

  async fork(id: string, count: number) {
    const src = this.boxes.get(id)!;
    return Array.from({ length: count }, (_, i) => (i === this.failForkIndex ? new Error("rate limited") : this.fresh(src)));
  }

  async snapshot(id: string) {
    const snapId = `snap-${id}-${this.snapshots.size + 1}`;
    this.snapshots.set(snapId, this.boxes.get(id)!.clone("snapshot"));
    return snapId;
  }

  async kill(id: string) {
    this.killed.push(id);
    const b = this.boxes.get(id);
    if (b) b.killed = true;
  }
}
