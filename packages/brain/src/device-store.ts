import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { HistoryDetail, HistoryItem, mkMsg, type AnyMessage, type MsgBody } from "@cuaremote/protocol";

/** 设备自己的设置和执行记录。历史按发起手机隔离，更新和去重在同一数据库中。 */
export class DeviceStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL, request_id TEXT NOT NULL, item TEXT NOT NULL,
        UNIQUE(phone, request_id)
      );
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `);
  }

  get<T>(key: string): T | undefined {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown) {
    this.db.query("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
  request(phone: string, id: string): string | undefined {
    return (this.db.query("SELECT run_id FROM runs WHERE phone=? AND request_id=?").get(phone, id) as { run_id: string } | null)?.run_id;
  }
  begin(phone: string, requestId: string, item: HistoryItem) {
    this.db.query("INSERT INTO runs(run_id,phone,request_id,item) VALUES (?,?,?,?)").run(item.runId, phone, requestId, JSON.stringify(HistoryItem.parse(item)));
  }
  append(body: MsgBody) {
    if (!("runId" in body)) return;
    const parsed = HistoryDetail.shape.events.element.safeParse(mkMsg(body));
    if (!parsed.success) return;
    this.db.transaction(() => {
      const row = this.db.query("SELECT item FROM runs WHERE run_id=?").get(body.runId) as { item: string } | null;
      if (!row) return;
      this.db.query("INSERT INTO events(run_id,body) VALUES (?,?)").run(body.runId, JSON.stringify(parsed.data));
      if (body.type === "run.finished") {
        const status = body.status ?? (body.cancelled ? "cancelled" : body.ok ? "succeeded" : "failed");
        const item: HistoryItem = { ...JSON.parse(row.item), finishedAt: Date.now(), ok: body.ok, status, summary: body.summary, cost: body.cost, stepCount: body.stepCount };
        this.db.query("UPDATE runs SET item=? WHERE run_id=?").run(JSON.stringify(item), body.runId);
      }
    })();
  }
  list(phone: string, limit: number, cursor?: string): { items: HistoryItem[]; nextCursor?: string } {
    if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new Error("历史分页位置无效");
    const rows = this.db.query("SELECT seq,item FROM runs WHERE phone=? AND seq<? ORDER BY seq DESC LIMIT ?")
      .all(phone, cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER, limit + 1) as { seq: number; item: string }[];
    const page = rows.slice(0, limit);
    return { items: page.map((r) => HistoryItem.parse(JSON.parse(r.item))), ...(rows.length > limit ? { nextCursor: String(page.at(-1)!.seq) } : {}) };
  }
  detail(phone: string, runId: string): MsgBody<Extract<AnyMessage, { type: "history.detail" }>> | undefined {
    const row = this.db.query("SELECT item FROM runs WHERE phone=? AND run_id=?").get(phone, runId) as { item: string } | null;
    if (!row) return;
    const events = this.db.query("SELECT body FROM events WHERE run_id=? ORDER BY seq").all(runId) as { body: string }[];
    return HistoryDetail.parse({ v: 1, id: crypto.randomUUID(), type: "history.detail", item: JSON.parse(row.item), events: events.map((e) => JSON.parse(e.body)) });
  }
  interruptUnfinished() {
    const rows = this.db.query("SELECT run_id,item FROM runs").all() as { run_id: string; item: string }[];
    for (const row of rows) {
      const item = HistoryItem.parse(JSON.parse(row.item));
      if (item.finishedAt === undefined) this.append({ type: "run.finished", runId: row.run_id, ok: false, status: "cancelled", summary: "设备进程已重启，任务已停止；请检查实际结果，不会自动重新执行", stepCount: 0, cancelled: true, cost: { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 } });
    }
  }
  nonces(): Map<string, number> {
    this.db.query("DELETE FROM nonces WHERE expires_at<=?").run(Math.floor(Date.now() / 1000));
    const rows = this.db.query("SELECT nonce,expires_at FROM nonces").all() as { nonce: string; expires_at: number }[];
    return new Map(rows.map((r) => [r.nonce, r.expires_at]));
  }
  consumeNonce(nonce: string, expiresAt: number) {
    this.db.query("INSERT INTO nonces VALUES (?,?)").run(nonce, expiresAt);
  }
  close() { this.db.close(); }
}
