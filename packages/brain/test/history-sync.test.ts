import { describe, expect, test } from "bun:test";
import { generateSyncKey, mkMsg, openSync, type HistoryItem, type HubMessage, type MsgBody, type SyncBlob } from "@cuaremote/protocol";
import { HistorySync, type HistoryStore, type HistorySyncState } from "../src/sync/history-sync.js";

/** 内存版 hub：和真 hub 一样按 (kind,id) 覆盖、只认更新的 ts、seq 递增、按 seq 分页 */
class FakeHub {
  rows: { seq: number; blob: SyncBlob }[] = [];
  seq = 0;
  log: string[] = [];
  request = async (body: MsgBody<HubMessage>): Promise<HubMessage> => {
    this.log.push(body.type);
    switch (body.type) {
      case "sync.put":
        for (const b of body.items) {
          const i = this.rows.findIndex((r) => r.blob.kind === b.kind && r.blob.id === b.id);
          if (i >= 0) {
            if (this.rows[i]!.blob.ts > b.ts) continue;
            this.rows.splice(i, 1);
          }
          this.rows.push({ seq: ++this.seq, blob: b });
        }
        return mkMsg({ type: "ack", ref: "x" });
      case "sync.pull": {
        const after = body.cursor ? Number(body.cursor) : 0;
        const all = this.rows.filter((r) => r.blob.kind === body.kind && r.seq > after);
        const page = all.slice(0, body.limit);
        const last = page.at(-1);
        return mkMsg({ type: "sync.page", kind: body.kind, items: page.map((r) => r.blob), more: all.length > page.length, ...(last ? { cursor: String(last.seq) } : {}) });
      }
      case "sync.delete":
        this.rows = this.rows.filter((r) => r.blob.kind !== body.kind || (body.ids ? !body.ids.includes(r.blob.id) : false));
        return mkMsg({ type: "ack", ref: "x" });
      default:
        return mkMsg({ type: "error", code: "unsupported", message: body.type });
    }
  };
}

class MemStore implements HistoryStore {
  items = new Map<string, HistoryItem>();
  constructor(init: HistoryItem[] = []) {
    for (const h of init) this.items.set(h.runId, h);
  }
  list() {
    return [...this.items.values()];
  }
  upsert(items: HistoryItem[]) {
    for (const h of items) this.items.set(h.runId, h);
  }
}

const h = (runId: string, deviceId: string, finishedAt?: number, intent = "做事"): HistoryItem => ({ runId, deviceId, intent, startedAt: (finishedAt ?? 100) - 10, ...(finishedAt !== undefined ? { finishedAt, ok: true } : {}) });

describe("HistorySync", () => {
  test("只传结束的 run；ack 后记住；本地 finishedAt 变新才重传；关掉开关 / 没密钥不传", async () => {
    const hub = new FakeHub();
    const key = generateSyncKey();
    const store = new MemStore([h("r1", "mac", 1000), h("r2", "mac"), h("r3", "mac", 3000)]);
    let enabled = true;
    const saved: HistorySyncState[] = [];
    const sync = new HistorySync({ deviceId: "mac", store, request: hub.request, enabled: () => enabled, key, persist: (s) => saved.push(s), batch: 1 });

    expect(await sync.push()).toEqual({ uploaded: 2, skipped: null });
    expect(hub.rows.map((r) => r.blob.id).sort()).toEqual(["r1", "r3"]);
    expect(hub.log.filter((t) => t === "sync.put").length).toBe(2); // batch=1 → 两次
    expect(saved.at(-1)!.uploaded).toEqual({ r1: 1000, r3: 3000 });

    // 没变化：不再发
    expect(await sync.push()).toEqual({ uploaded: 0, skipped: null });
    expect(hub.log.filter((t) => t === "sync.put").length).toBe(2);

    // r2 结束了、r1 被改（更新的 finishedAt）→ 只传这两条
    store.upsert([h("r2", "mac", 2000), h("r1", "mac", 1500, "改过")]);
    expect((await sync.push()).uploaded).toBe(2);
    const r1 = hub.rows.find((r) => r.blob.id === "r1")!.blob;
    expect(r1.ts).toBe(1500);
    expect((await openSync<HistoryItem>(key, r1)).intent).toBe("改过");

    enabled = false;
    store.upsert([h("r4", "mac", 4000)]);
    expect(await sync.push()).toEqual({ uploaded: 0, skipped: "disabled" });
    enabled = true;
    const noKey = new HistorySync({ deviceId: "mac", store, request: hub.request, enabled: () => true });
    expect(await noKey.push()).toEqual({ uploaded: 0, skipped: "no_key" });
  });

  test("拉取：游标增量、分页到底、解不开的跳过、合并时 finishedAt 大的赢、拉回来的不再回传", async () => {
    const hub = new FakeHub();
    const key = generateSyncKey();
    // 手机那边先传了 3 条（其中 p2 与本地 r 冲突）
    const phoneStore = new MemStore([h("p1", "phone", 100), h("p2", "phone", 250, "手机版"), h("p3", "phone", 300)]);
    const phone = new HistorySync({ deviceId: "phone", store: phoneStore, request: hub.request, enabled: () => true, key });
    await phone.push();
    // 混进一块别的密钥封的
    const other = new HistorySync({ deviceId: "x", store: new MemStore([h("bad", "x", 50)]), request: hub.request, enabled: () => true, key: generateSyncKey() });
    await other.push();

    const macStore = new MemStore([h("p2", "phone", 200, "本地旧版"), h("p3", "phone", 400, "本地新版"), h("m1", "mac", 500)]);
    const saved: HistorySyncState[] = [];
    const mac = new HistorySync({ deviceId: "mac", store: macStore, request: hub.request, enabled: () => true, key, persist: (s) => saved.push(s) });
    const r = await mac.pull();
    expect(r).toEqual({ merged: 2, undecryptable: 1, pages: 1 });
    expect(macStore.items.get("p1")).toBeDefined();
    expect(macStore.items.get("p2")!.intent).toBe("手机版"); // 250 > 200
    expect(macStore.items.get("p3")!.intent).toBe("本地新版"); // 400 > 300，本地赢
    expect(saved.at(-1)!.cursor).toBe("4");

    // 拉回来的 p1/p2 不用回传；p3 本地更新要传；m1 要传
    const pushed = await mac.push();
    expect(pushed.uploaded).toBe(2);
    expect(hub.rows.find((x) => x.blob.id === "p3")!.blob.ts).toBe(400);

    // 再拉：只拿到新 seq（p3、m1 是自己传的，merge 不写入）
    hub.log.length = 0;
    const again = await mac.pull();
    expect(again).toEqual({ merged: 0, undecryptable: 0, pages: 1 });
    expect(hub.log).toEqual(["sync.pull"]);

    // 手机再拉：拿到 p3 新版和 m1，且分页（limit 由引擎定 200，这里数据少，验证 more=false 收尾）
    const rp = await phone.pull();
    expect(rp.merged).toBe(2);
    expect(phoneStore.items.get("p3")!.intent).toBe("本地新版");
  });

  test("关掉同步抹掉 hub 上的历史并忘记上传记录；换 keyId 后全部重传", async () => {
    const hub = new FakeHub();
    const key = generateSyncKey();
    const store = new MemStore([h("r1", "mac", 1000), h("r2", "mac", 2000)]);
    const sync = new HistorySync({ deviceId: "mac", store, request: hub.request, enabled: () => true, key });
    await sync.push();
    expect(hub.rows.length).toBe(2);
    await sync.disable();
    expect(hub.rows.length).toBe(0);
    expect(sync.snapshot.uploaded).toEqual({});
    expect((await sync.push()).uploaded).toBe(2);

    const k2 = generateSyncKey();
    sync.setKey(k2);
    expect(sync.snapshot.uploaded).toEqual({});
    expect((await sync.push()).uploaded).toBe(2);
    for (const r of hub.rows) expect(r.blob.keyId).toBe(k2.keyId);
    // 同 keyId 再 set 不清状态
    sync.setKey(k2);
    expect((await sync.push()).uploaded).toBe(0);
  });

  test("hub 报错时抛出且不标记已上传", async () => {
    const store = new MemStore([h("r1", "mac", 1000)]);
    const sync = new HistorySync({ deviceId: "mac", store, request: async () => mkMsg({ type: "error", code: "sync_quota", message: "满了" }), enabled: () => true, key: generateSyncKey() });
    await expect(sync.push()).rejects.toThrow(/sync_quota/);
    expect(sync.snapshot.uploaded).toEqual({});
  });
});
