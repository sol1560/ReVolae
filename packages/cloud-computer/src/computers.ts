import type { CloudState } from "@cuaremote/protocol";
import type { SandboxHandle, SandboxProvider } from "./handle.js";

/** 一个账号的云电脑。运行中 / 已暂停不存，按 lastActiveAt 和空闲时长算 */
export interface CloudComputerRow {
  accountId: string;
  sandboxId: string;
  template: string;
  createdAt: number;
  /** 秒 */
  lastActiveAt: number;
}

export interface CloudSnapshotRow {
  accountId: string;
  runId: string;
  snapshotId: string;
  createdAt: number;
  /** 任务标题（意图前几十个字），手机上撤销列表显示用 */
  title?: string;
}

/** 持久化：hub 用 sqlite 实现，测试用 MemoryCloudStore */
export interface CloudStore {
  getComputer(accountId: string): CloudComputerRow | undefined;
  putComputer(row: CloudComputerRow): void;
  deleteComputer(accountId: string): void;
  addSnapshot(row: CloudSnapshotRow): void;
  getSnapshot(accountId: string, runId: string): CloudSnapshotRow | undefined;
  /** 新的在前 */
  listSnapshots(accountId: string): CloudSnapshotRow[];
  deleteSnapshot(accountId: string, runId: string): void;
}

export interface CloudStatus {
  state: CloudState;
  sandboxId?: string;
  lastActiveAt?: number;
  createdAt?: number;
}

export interface CloudComputersOptions {
  provider: SandboxProvider;
  store: CloudStore;
  template: string;
  /** 空闲多久自动暂停，默认 10 分钟 */
  idleMs?: number;
  /** 每个账号保留的快照数，默认 5 */
  keepSnapshots?: number;
  now?: () => number;
  log?: (rec: Record<string, unknown>) => void;
}

/**
 * 每个账号一台长期保留的云电脑。
 * - 第一次用时从模板创建；之后一直是同一台（空闲自动暂停，调用时自动唤醒）。
 * - 每个任务开始前可存快照，做坏了整机撤销；可以复制成几份各做一种，选中的那份成为新的主机器。
 */
export class CloudComputers {
  private readonly handles = new Map<string, SandboxHandle>();
  private readonly pending = new Map<string, Promise<SandboxHandle>>();
  private readonly idleMs: number;
  private readonly keep: number;
  private readonly now: () => number;

  constructor(private readonly o: CloudComputersOptions) {
    this.idleMs = o.idleMs ?? 10 * 60_000;
    this.keep = o.keepSnapshots ?? 5;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get idleSeconds() {
    return Math.floor(this.idleMs / 1000);
  }

  status(accountId: string): CloudStatus {
    const row = this.o.store.getComputer(accountId);
    if (!row) return { state: "none" };
    const state: CloudState = this.now() - row.lastActiveAt < this.idleSeconds ? "running" : "paused";
    return { state, sandboxId: row.sandboxId, lastActiveAt: row.lastActiveAt, createdAt: row.createdAt };
  }

  /** 拿到这个账号的机器：没有就创建，暂停的会被唤醒；同一账号并发调用只建一台 */
  handle(accountId: string): Promise<SandboxHandle> {
    let p = this.pending.get(accountId);
    if (!p) {
      p = this.open(accountId).finally(() => this.pending.delete(accountId));
      this.pending.set(accountId, p);
    }
    return p;
  }

  private async open(accountId: string): Promise<SandboxHandle> {
    const row = this.o.store.getComputer(accountId);
    const cached = this.handles.get(accountId);
    let h: SandboxHandle;
    if (row && cached?.id === row.sandboxId) {
      h = cached;
      // 一分钟内刚用过就不再续时（省一次 API 调用）；否则 keepAlive 会唤醒并重新计时，缓存的连接失效时退回重新 connect
      if (this.now() - row.lastActiveAt >= 60) {
        await h.keepAlive(this.idleMs).catch(async () => {
          h = await this.o.provider.connect(row.sandboxId, this.idleMs);
        });
      }
    } else if (row) {
      h = await this.o.provider.connect(row.sandboxId, this.idleMs);
    } else {
      h = await this.o.provider.create({ template: this.o.template, idleMs: this.idleMs, metadata: { accountId } });
      this.o.store.putComputer({ accountId, sandboxId: h.id, template: this.o.template, createdAt: this.now(), lastActiveAt: this.now() });
      this.o.log?.({ t: "cloud_created", accountId, sandboxId: h.id });
    }
    this.handles.set(accountId, h);
    this.touch(accountId);
    return h;
  }

  /** 可撤销回去的快照，新的在前 */
  snapshots(accountId: string): CloudSnapshotRow[] {
    return this.o.store.listSnapshots(accountId);
  }

  /** 记一次活跃（每次工具调用后调） */
  touch(accountId: string) {
    const row = this.o.store.getComputer(accountId);
    if (row) this.o.store.putComputer({ ...row, lastActiveAt: this.now() });
  }

  /** 任务开始前存快照；超出保留数的旧快照从表里删掉（E2B 侧的快照模板留给后台清理） */
  async snapshot(accountId: string, runId: string, title?: string): Promise<string> {
    const h = await this.handle(accountId);
    const snapshotId = await this.o.provider.snapshot(h.id);
    this.o.store.addSnapshot({ accountId, runId, snapshotId, createdAt: this.now(), ...(title ? { title } : {}) });
    for (const old of this.o.store.listSnapshots(accountId).slice(this.keep)) this.o.store.deleteSnapshot(accountId, old.runId);
    return snapshotId;
  }

  /** 整机撤销到某个任务开始前：用快照新建一台替换当前这台 */
  async undo(accountId: string, runId: string): Promise<SandboxHandle> {
    const snap = this.o.store.getSnapshot(accountId, runId);
    if (!snap) throw new Error("这个任务没有快照，无法撤销");
    const row = this.o.store.getComputer(accountId);
    const h = await this.o.provider.create({ template: snap.snapshotId, idleMs: this.idleMs, metadata: { accountId, restoredFrom: runId } });
    this.replace(accountId, h, row ? [row.sandboxId] : []);
    // 撤销到这一步之后的快照都作废（包括这一份：它描述的就是现在的状态）
    for (const s of this.o.store.listSnapshots(accountId)) if (s.createdAt >= snap.createdAt) this.o.store.deleteSnapshot(accountId, s.runId);
    this.o.log?.({ t: "cloud_undo", accountId, runId, sandboxId: h.id });
    return h;
  }

  /** 把主机器原样复制成 count 份；失败的那份返回 Error */
  async fork(accountId: string, count: number): Promise<(SandboxHandle | Error)[]> {
    const h = await this.handle(accountId);
    return this.o.provider.fork(h.id, count, this.idleMs);
  }

  /** 选中一份分叉：它成为主机器，原主机器和其余分叉都删掉 */
  adopt(accountId: string, chosen: SandboxHandle, discard: SandboxHandle[]) {
    const row = this.o.store.getComputer(accountId);
    this.replace(accountId, chosen, [...(row ? [row.sandboxId] : []), ...discard.map((d) => d.id)]);
    this.o.log?.({ t: "cloud_adopt", accountId, sandboxId: chosen.id });
  }

  /** 丢弃分叉（一份都不要） */
  discard(forks: SandboxHandle[]) {
    for (const f of forks) void this.o.provider.kill(f.id).catch(() => {});
  }

  /** 删号时调用：机器和快照记录都删掉 */
  async destroy(accountId: string) {
    const row = this.o.store.getComputer(accountId);
    if (row) await this.o.provider.kill(row.sandboxId).catch(() => {});
    for (const s of this.o.store.listSnapshots(accountId)) this.o.store.deleteSnapshot(accountId, s.runId);
    this.o.store.deleteComputer(accountId);
    this.handles.delete(accountId);
  }

  private replace(accountId: string, h: SandboxHandle, kill: string[]) {
    const row = this.o.store.getComputer(accountId);
    this.o.store.putComputer({
      accountId,
      sandboxId: h.id,
      template: row?.template ?? this.o.template,
      createdAt: row?.createdAt ?? this.now(),
      lastActiveAt: this.now(),
    });
    this.handles.set(accountId, h);
    for (const id of new Set(kill)) if (id !== h.id) void this.o.provider.kill(id).catch((e) => this.o.log?.({ t: "cloud_kill_failed", sandboxId: id, err: String(e) }));
  }
}

/** 内存版存储：测试和单机开发用 */
export class MemoryCloudStore implements CloudStore {
  private readonly computers = new Map<string, CloudComputerRow>();
  private readonly snaps: CloudSnapshotRow[] = [];
  getComputer(a: string) {
    return this.computers.get(a);
  }
  putComputer(r: CloudComputerRow) {
    this.computers.set(r.accountId, r);
  }
  deleteComputer(a: string) {
    this.computers.delete(a);
  }
  addSnapshot(r: CloudSnapshotRow) {
    this.snaps.push(r);
  }
  getSnapshot(a: string, runId: string) {
    return this.snaps.find((s) => s.accountId === a && s.runId === runId);
  }
  listSnapshots(a: string) {
    return this.snaps.filter((s) => s.accountId === a).sort((x, y) => y.createdAt - x.createdAt || this.snaps.indexOf(y) - this.snaps.indexOf(x));
  }
  deleteSnapshot(a: string, runId: string) {
    const i = this.snaps.findIndex((s) => s.accountId === a && s.runId === runId);
    if (i >= 0) this.snaps.splice(i, 1);
  }
}
