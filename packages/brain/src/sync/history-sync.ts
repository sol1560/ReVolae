/**
 * 操作历史的云同步（端这一侧的参考实现；Swift daemon / iOS 照这个逻辑移植）。
 *
 * 规则：
 *   - 只有用户把 sync.history 打开才会上传；关掉时把 hub 上这一类整个抹掉，本地不动。
 *   - 上传的是 AES-GCM 密文块（protocol/sync.ts），密钥由手机通过 sync.key 端到端发来；没密钥就什么也不传。
 *   - 谁手里有明文谁上传：本地大脑的 run 由设备传；云端大脑的 run 由手机传（手机收到了整条时间线）。
 *   - 只传已经结束的 run（有 finishedAt），未结束的等结束再传；本地改了（finishedAt 变新）会覆盖。
 *   - 拉取按 hub 的 seq 游标增量拉；解不开的块跳过并计数，不影响其他块；合并时 finishedAt 大的赢。
 */
import { openSync, sealSync, type HistoryItem, type HubMessage, type MsgBody, type SyncBlob, type SyncKeyMaterial } from "@cuaremote/protocol";

export interface HistoryStore {
  list(): HistoryItem[];
  upsert(items: HistoryItem[]): void;
}

/** 需要持久化的同步状态（设备重启后接着传 / 接着拉） */
export interface HistorySyncState {
  /** runId → 上次上传时的 finishedAt */
  uploaded: Record<string, number>;
  cursor?: string;
}

export interface HistorySyncDeps {
  deviceId: string;
  store: HistoryStore;
  /** 发一条 hub 消息并等它的回复（ack / sync.page / error） */
  request: (body: MsgBody<HubMessage>) => Promise<HubMessage>;
  /** 用户开关：PrivacySettings.sync.history */
  enabled: () => boolean;
  key?: SyncKeyMaterial;
  state?: HistorySyncState;
  /** 状态变了就回调，让宿主落盘 */
  persist?: (s: HistorySyncState) => void;
  batch?: number;
}

export interface PushResult {
  uploaded: number;
  skipped: "disabled" | "no_key" | null;
}

export interface PullResult {
  merged: number;
  undecryptable: number;
  pages: number;
}

export class HistorySync {
  private state: HistorySyncState;
  private key?: SyncKeyMaterial;
  private readonly batch: number;

  constructor(private readonly d: HistorySyncDeps) {
    this.state = d.state ?? { uploaded: {} };
    this.key = d.key;
    this.batch = Math.min(100, Math.max(1, d.batch ?? 100));
  }

  /** 手机发来 sync.key；换了 keyId 说明用户重新生成了密钥，之前传的都作废，要全部重传 */
  setKey(k: SyncKeyMaterial) {
    if (this.key && this.key.keyId !== k.keyId) {
      this.state = { uploaded: {}, cursor: undefined };
      this.save();
    }
    this.key = k;
  }

  get snapshot(): HistorySyncState {
    return { uploaded: { ...this.state.uploaded }, cursor: this.state.cursor };
  }

  /** 本地哪些 run 该传：结束了、且没传过或结束时间比上次传的新 */
  pending(): HistoryItem[] {
    return this.d.store.list().filter((h) => h.finishedAt !== undefined && (this.state.uploaded[h.runId] ?? -1) < h.finishedAt);
  }

  async push(): Promise<PushResult> {
    if (!this.d.enabled()) return { uploaded: 0, skipped: "disabled" };
    if (!this.key) return { uploaded: 0, skipped: "no_key" };
    const key = this.key;
    let uploaded = 0;
    const todo = this.pending();
    for (let i = 0; i < todo.length; i += this.batch) {
      const chunk = todo.slice(i, i + this.batch);
      const items: SyncBlob[] = [];
      for (const h of chunk) items.push(await sealSync(key, { kind: "history", id: h.runId, deviceId: h.deviceId || this.d.deviceId, ts: h.finishedAt! }, h));
      const r = await this.d.request({ type: "sync.put", items });
      if (r.type === "error") throw new Error(`上传历史失败：${r.code} ${r.message}`);
      for (const h of chunk) this.state.uploaded[h.runId] = h.finishedAt!;
      uploaded += chunk.length;
      this.save();
    }
    return { uploaded, skipped: null };
  }

  /** 从上次游标接着拉到没有为止 */
  async pull(): Promise<PullResult> {
    if (!this.d.enabled() || !this.key) return { merged: 0, undecryptable: 0, pages: 0 };
    const key = this.key;
    let merged = 0;
    let undecryptable = 0;
    let pages = 0;
    for (;;) {
      const r = await this.d.request({ type: "sync.pull", kind: "history", limit: 200, ...(this.state.cursor ? { cursor: this.state.cursor } : {}) });
      if (r.type === "error") throw new Error(`拉取历史失败：${r.code} ${r.message}`);
      if (r.type !== "sync.page") throw new Error(`拉取历史收到了 ${r.type}`);
      pages++;
      const incoming: HistoryItem[] = [];
      for (const b of r.items) {
        try {
          incoming.push(await openSync<HistoryItem>(key, b));
        } catch {
          undecryptable++;
        }
      }
      merged += this.merge(incoming);
      // 别人传上来的块本机不用再传；本机传的块自己也会拉回来，记一下省得重传
      for (const h of incoming) if (h.finishedAt !== undefined && (this.state.uploaded[h.runId] ?? -1) < h.finishedAt) this.state.uploaded[h.runId] = h.finishedAt;
      if (r.cursor) this.state.cursor = r.cursor;
      this.save();
      if (!r.more) break;
    }
    return { merged, undecryptable, pages };
  }

  /** 用户关掉同步：抹掉 hub 上的历史，忘掉已上传记录（再打开时会整份重传） */
  async disable(): Promise<void> {
    const r = await this.d.request({ type: "sync.delete", kind: "history" });
    if (r.type === "error") throw new Error(`抹掉云端历史失败：${r.code} ${r.message}`);
    this.state = { uploaded: {} };
    this.save();
  }

  /** finishedAt 大的赢；同 finishedAt 保留本地；返回真正写入的条数 */
  private merge(incoming: HistoryItem[]): number {
    const local = new Map(this.d.store.list().map((h) => [h.runId, h]));
    const write: HistoryItem[] = [];
    for (const h of incoming) {
      const mine = local.get(h.runId);
      if (!mine || (mine.finishedAt ?? -1) < (h.finishedAt ?? -1)) write.push(h);
    }
    if (write.length) this.d.store.upsert(write);
    return write.length;
  }


  private save() {
    this.d.persist?.(this.snapshot);
  }
}
