/**
 * hub 的持久层：bun:sqlite。
 * 只存「路由需要知道的」：谁是谁（公钥）、谁和谁配过对、推送 token、用量。
 * 端到端密文一律不落库（推送 outbox 里的 sealed 是给手机 HPKE 公钥封好的，hub 解不开）。
 */
import { Database } from "bun:sqlite";
import type { Cost, PairOffer, PublicKeys } from "@cuaremote/protocol";

export type Role = "device" | "phone" | "brain";

export interface DeviceRow {
  deviceId: string;
  accountId: string;
  role: Role;
  platform: string;
  name: string;
  kem: string;
  sig: string;
  sigAlg: PublicKeys["sigAlg"];
  createdAt: number;
  lastSeen: number;
}

export interface PushTokenRow {
  deviceId: string;
  platform: "apns" | "fcm";
  token: string;
  pushKem: string;
}

export interface PushOutboxRow {
  id: number;
  toDeviceId: string;
  sealed: string;
  category: string;
  status: "queued" | "sent" | "dry-run" | "failed";
  detail: string | null;
  createdAt: number;
}

export interface UsageRow {
  accountId: string;
  deviceId: string;
  runId: string;
  inputTokens: number;
  outputTokens: number;
  jevTokens: number;
  usd: number;
  steps: number;
  jevCalls: number;
  at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  kem TEXT NOT NULL,
  sig TEXT NOT NULL,
  sig_alg TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (
  device_id TEXT NOT NULL,
  phone_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, phone_id)
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  offer_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_tokens (
  device_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  push_kem TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_device_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  jev_tokens INTEGER NOT NULL,
  usd REAL NOT NULL,
  steps INTEGER NOT NULL,
  jev_calls INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_account_at ON usage(account_id, at);
CREATE TABLE IF NOT EXISTS brain_keys (
  account_id TEXT PRIMARY KEY,
  kem_seed TEXT NOT NULL,
  sig_priv TEXT NOT NULL,
  sig_pub TEXT NOT NULL,
  sig_alg TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** 云端大脑的长期密钥（每个账号一套，base64） */
export interface BrainKeyRow {
  accountId: string;
  /** X25519 的 32 字节种子，用 deriveKemKeyPair 恢复 */
  kemSeed: string;
  sigPriv: string;
  sigPub: string;
  sigAlg: PublicKeys["sigAlg"];
  createdAt: number;
}

export class HubStore {
  readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ── devices ──
  getDevice(deviceId: string): DeviceRow | null {
    const r = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
    return r ? rowToDevice(r) : null;
  }

  upsertDevice(d: Omit<DeviceRow, "createdAt" | "lastSeen">, now: number) {
    this.db
      .query(
        `INSERT INTO devices (device_id, account_id, role, platform, name, kem, sig, sig_alg, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen = excluded.last_seen`,
      )
      .run(d.deviceId, d.accountId, d.role, d.platform, d.name, d.kem, d.sig, d.sigAlg, now, now);
  }

  touch(deviceId: string, now: number) {
    this.db.query("UPDATE devices SET last_seen = ? WHERE device_id = ?").run(now, deviceId);
  }

  listAccountDevices(accountId: string): DeviceRow[] {
    return this.db.query<Record<string, unknown>, [string]>("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at").all(accountId).map(rowToDevice);
  }

  // ── pairings ──
  addPairing(deviceId: string, phoneId: string, now: number) {
    this.db.query("INSERT OR IGNORE INTO pairings (device_id, phone_id, created_at) VALUES (?, ?, ?)").run(deviceId, phoneId, now);
  }

  removePairing(deviceId: string, phoneId: string) {
    this.db.query("DELETE FROM pairings WHERE device_id = ? AND phone_id = ?").run(deviceId, phoneId);
  }

  isPaired(a: string, b: string): boolean {
    const r = this.db
      .query<{ n: number }, [string, string, string, string]>("SELECT COUNT(*) AS n FROM pairings WHERE (device_id = ? AND phone_id = ?) OR (device_id = ? AND phone_id = ?)")
      .get(a, b, b, a);
    return (r?.n ?? 0) > 0;
  }

  /** 和某个 id 配过对的所有对端 id */
  peersOf(id: string): string[] {
    const rows = this.db
      .query<{ peer: string }, [string, string]>("SELECT phone_id AS peer FROM pairings WHERE device_id = ? UNION SELECT device_id AS peer FROM pairings WHERE phone_id = ?")
      .all(id, id);
    return rows.map((r) => r.peer);
  }

  // ── 6 位码 ──
  putPairCode(code: string, deviceId: string, offer: PairOffer, expiresAt: number) {
    this.db.query("INSERT OR REPLACE INTO pair_codes (code, device_id, offer_json, expires_at) VALUES (?, ?, ?, ?)").run(code, deviceId, JSON.stringify(offer), expiresAt);
  }

  takePairCode(code: string, now: number): PairOffer | null {
    const r = this.db.query<{ offer_json: string; expires_at: number }, [string]>("SELECT offer_json, expires_at FROM pair_codes WHERE code = ?").get(code);
    if (!r) return null;
    this.db.query("DELETE FROM pair_codes WHERE code = ?").run(code);
    if (r.expires_at < now) return null;
    return JSON.parse(r.offer_json) as PairOffer;
  }

  purgeExpiredPairCodes(now: number) {
    this.db.query("DELETE FROM pair_codes WHERE expires_at < ?").run(now);
  }

  // ── push ──
  setPushToken(t: PushTokenRow) {
    this.db.query("INSERT OR REPLACE INTO push_tokens (device_id, platform, token, push_kem) VALUES (?, ?, ?, ?)").run(t.deviceId, t.platform, t.token, t.pushKem);
  }

  getPushToken(deviceId: string): PushTokenRow | null {
    const r = this.db.query<{ device_id: string; platform: "apns" | "fcm"; token: string; push_kem: string }, [string]>("SELECT * FROM push_tokens WHERE device_id = ?").get(deviceId);
    return r ? { deviceId: r.device_id, platform: r.platform, token: r.token, pushKem: r.push_kem } : null;
  }

  enqueuePush(p: { toDeviceId: string; sealed: string; category: string }, now: number): number {
    const r = this.db.query("INSERT INTO push_outbox (to_device_id, sealed, category, status, created_at) VALUES (?, ?, ?, 'queued', ?)").run(p.toDeviceId, p.sealed, p.category, now);
    return Number(r.lastInsertRowid);
  }

  markPush(id: number, status: PushOutboxRow["status"], detail?: string) {
    this.db.query("UPDATE push_outbox SET status = ?, detail = ? WHERE id = ?").run(status, detail ?? null, id);
  }

  listPush(toDeviceId: string): PushOutboxRow[] {
    return this.db
      .query<Record<string, unknown>, [string]>("SELECT * FROM push_outbox WHERE to_device_id = ? ORDER BY id")
      .all(toDeviceId)
      .map((r) => ({
        id: r.id as number,
        toDeviceId: r.to_device_id as string,
        sealed: r.sealed as string,
        category: r.category as string,
        status: r.status as PushOutboxRow["status"],
        detail: (r.detail as string | null) ?? null,
        createdAt: r.created_at as number,
      }));
  }

  // ── usage ──
  addUsage(u: { accountId: string; deviceId: string; runId: string; cost: Cost; steps: number; jevCalls: number }, now: number) {
    this.db
      .query("INSERT INTO usage (account_id, device_id, run_id, input_tokens, output_tokens, jev_tokens, usd, steps, jev_calls, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(u.accountId, u.deviceId, u.runId, u.cost.inputTokens, u.cost.outputTokens, u.cost.jevTokens, u.cost.usd, u.steps, u.jevCalls, now);
  }

  usageSummary(accountId: string, since: number): { runs: number; usd: number; inputTokens: number; outputTokens: number; jevTokens: number; steps: number; jevCalls: number } {
    const r = this.db
      .query<Record<string, number | null>, [string, number]>(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(usd),0) AS usd, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(jev_tokens),0) AS jev_tokens, COALESCE(SUM(steps),0) AS steps, COALESCE(SUM(jev_calls),0) AS jev_calls
         FROM usage WHERE account_id = ? AND at >= ?`,
      )
      .get(accountId, since)!;
    return {
      runs: r.runs ?? 0,
      usd: r.usd ?? 0,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      jevTokens: r.jev_tokens ?? 0,
      steps: r.steps ?? 0,
      jevCalls: r.jev_calls ?? 0,
    };
  }

  // ── 云端大脑密钥 ──
  getBrainKeys(accountId: string): BrainKeyRow | null {
    const r = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM brain_keys WHERE account_id = ?").get(accountId);
    return r
      ? { accountId: r.account_id as string, kemSeed: r.kem_seed as string, sigPriv: r.sig_priv as string, sigPub: r.sig_pub as string, sigAlg: r.sig_alg as PublicKeys["sigAlg"], createdAt: r.created_at as number }
      : null;
  }

  putBrainKeys(k: BrainKeyRow) {
    this.db
      .query("INSERT OR IGNORE INTO brain_keys (account_id, kem_seed, sig_priv, sig_pub, sig_alg, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(k.accountId, k.kemSeed, k.sigPriv, k.sigPub, k.sigAlg, k.createdAt);
  }

  listUsage(accountId: string, since: number): UsageRow[] {
    return this.db
      .query<Record<string, unknown>, [string, number]>("SELECT * FROM usage WHERE account_id = ? AND at >= ? ORDER BY at DESC")
      .all(accountId, since)
      .map((r) => ({
        accountId: r.account_id as string,
        deviceId: r.device_id as string,
        runId: r.run_id as string,
        inputTokens: r.input_tokens as number,
        outputTokens: r.output_tokens as number,
        jevTokens: r.jev_tokens as number,
        usd: r.usd as number,
        steps: r.steps as number,
        jevCalls: r.jev_calls as number,
        at: r.at as number,
      }));
  }
}

function rowToDevice(r: Record<string, unknown>): DeviceRow {
  return {
    deviceId: r.device_id as string,
    accountId: r.account_id as string,
    role: r.role as Role,
    platform: r.platform as string,
    name: r.name as string,
    kem: r.kem as string,
    sig: r.sig as string,
    sigAlg: r.sig_alg as PublicKeys["sigAlg"],
    createdAt: r.created_at as number,
    lastSeen: r.last_seen as number,
  };
}
