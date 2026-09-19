/**
 * hub 核心：和传输层（Bun.serve 的 ws 对象）解耦，方便单测。
 *
 * 一条 WebSocket 上两种消息：
 *   - 文本帧：HubMessage JSON（端 ↔ hub 明文控制：登录、配对、推送、计量）
 *   - 二进制帧：RelayEnvelope（hub 只读头部 to/from，body 是端到端密文，原样转发）
 *
 * 登录：hello → auth.challenge{nonce} → auth.response{signature} → auth.ok
 *   签名内容 = hubAuthPayload(deviceId, nonce)，用 hello 里 pubKeys.sig 对应的私钥签。
 *   已知设备必须和库里公钥一致（key pinning）；未知设备首次连接即登记（TOFU），
 *   但没配对前只能做配对，不能中继。
 *
 * 账号：设了 HUB_JWT_SECRET 时手机必须带 JWT（sub = 账号）；设备的账号在配对成功时继承手机的。
 *   没设 secret 时是单机模式，所有端都算 account "local"。
 */
import {
  HubMessage,
  PairOffer,
  decodeRelay,
  hubAuthPayload,
  mkMsg,
  verifySignedPayload,
  type MsgBody,
  type PublicKeys,
} from "@cuaremote/protocol";
import { newNonce, newPairCode, newSessionToken, verifyJwt } from "./auth.js";
import { HubStore, type DeviceRow, type Role } from "./db.js";
import { DryRunPush, type PushSender } from "./push.js";

export interface Conn {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

type Hello = Extract<HubMessage, { type: "hello" }>;

interface Session {
  conn: Conn;
  state: "hello" | "challenge" | "authed";
  hello?: Hello;
  nonce?: string;
  accountId?: string;
  deviceId?: string;
  role?: Role;
  sessionToken?: string;
}

export interface HubOptions {
  store?: HubStore;
  push?: PushSender;
  /** 手机 JWT 的 HS256 secret；不给 = 单机模式 */
  jwtSecret?: string;
  /** 二维码 / 6 位码里写给手机的 hub 地址 */
  publicURL?: string;
  now?: () => number;
  sessionTtlSec?: number;
  pairCodeTtlSec?: number;
  log?: (line: string) => void;
}

const UNCLAIMED = "unclaimed";
const LOCAL = "local";

export class Hub {
  readonly store: HubStore;
  readonly push: PushSender;
  private readonly sessions = new Map<Conn, Session>();
  private readonly online = new Map<string, Session>();
  private readonly httpSessions = new Map<string, { deviceId: string; accountId: string; role: Role; expiresAt: number }>();
  private readonly pendingPairs = new Map<string, { phoneId: string; phoneName: string; phonePubKeys: PublicKeys; phoneAccount: string; at: number }>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly sessionTtl: number;
  private readonly pairCodeTtl: number;
  readonly publicURL: string;

  constructor(private readonly o: HubOptions = {}) {
    this.store = o.store ?? new HubStore(":memory:");
    this.push = o.push ?? new DryRunPush();
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = o.log ?? (() => {});
    this.sessionTtl = o.sessionTtlSec ?? 24 * 3600;
    this.pairCodeTtl = o.pairCodeTtlSec ?? 300;
    this.publicURL = o.publicURL ?? "ws://localhost:8788/ws";
  }

  get singleUser() {
    return !this.o.jwtSecret;
  }

  isOnline(deviceId: string) {
    return this.online.has(deviceId);
  }

  // ───────────────────────── 连接生命周期 ─────────────────────────

  onOpen(conn: Conn) {
    this.sessions.set(conn, { conn, state: "hello" });
  }

  onClose(conn: Conn) {
    const s = this.sessions.get(conn);
    this.sessions.delete(conn);
    if (!s || s.state !== "authed" || !s.deviceId) return;
    if (this.online.get(s.deviceId) === s) {
      this.online.delete(s.deviceId);
      this.store.touch(s.deviceId, this.now());
      this.broadcastPresence(s.deviceId, false);
    }
  }

  onMessage(conn: Conn, data: string | Uint8Array | ArrayBuffer) {
    const s = this.sessions.get(conn);
    if (!s) return;
    if (typeof data === "string") return this.onText(s, data);
    this.onBinary(s, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  }

  // ───────────────────────── 文本：HubMessage ─────────────────────────

  private onText(s: Session, text: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.fail(s, "bad_json", "不是 JSON");
    }
    const parsed = HubMessage.safeParse(raw);
    if (!parsed.success) {
      const ref = typeof raw === "object" && raw && "id" in raw ? String((raw as { id: unknown }).id) : undefined;
      return this.fail(s, "bad_message", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300), ref);
    }
    const m = parsed.data;
    if (s.state !== "authed") {
      if (m.type === "hello") return this.onHello(s, m);
      if (m.type === "auth.response") return this.onAuthResponse(s, m);
      return this.fail(s, "unauthenticated", "先登录再说", m.id);
    }
    switch (m.type) {
      case "hello":
        return this.fail(s, "already_authed", "这条连接已经登录过了", m.id);
      case "auth.response":
        return this.fail(s, "already_authed", "已登录", m.id);
      case "push.register":
        this.store.setPushToken({ deviceId: s.deviceId!, platform: m.platform, token: m.token, pushKem: m.pushKem });
        return this.reply(s, { type: "ack", ref: m.id });
      case "push.send":
        return this.onPushSend(s, m);
      case "usage.report":
        this.store.addUsage({ accountId: s.accountId!, deviceId: s.deviceId!, runId: m.runId, cost: m.cost, steps: m.steps, jevCalls: m.jevCalls }, this.now());
        return this.reply(s, { type: "ack", ref: m.id });
      case "pair.request":
        return this.onPairRequest(s, m);
      case "pair.confirm":
        return this.onPairConfirm(s, m);
      case "pair.code.claim":
        return this.onPairCodeClaim(s, m);
      case "presence":
      case "peer.keys":
      case "auth.challenge":
      case "auth.ok":
      case "pair.result":
      case "pair.offer":
        return this.fail(s, "not_allowed", `${m.type} 只能由 hub 发出`, m.id);
      case "error":
      case "ack":
        return;
    }
  }

  private onHello(s: Session, m: Hello) {
    if (s.state !== "hello") return this.fail(s, "bad_state", "hello 只能发一次", m.id);
    const known = this.store.getDevice(m.deviceId);
    if (known && (known.kem !== m.pubKeys.kem || known.sig !== m.pubKeys.sig || known.sigAlg !== m.pubKeys.sigAlg)) {
      this.fail(s, "key_mismatch", "这个 id 已经绑定了别的公钥；换了设备请先在旧设备上解绑", m.id);
      return s.conn.close(4003, "key_mismatch");
    }
    let accountId: string;
    if (this.singleUser) {
      accountId = LOCAL;
    } else if (m.token) {
      const r = verifyJwt(m.token, this.o.jwtSecret!, this.now());
      if (!r.ok) {
        this.fail(s, "bad_token", `JWT ${r.reason}`, m.id);
        return s.conn.close(4001, "bad_token");
      }
      if (known && known.accountId !== UNCLAIMED && known.accountId !== r.claims.sub) {
        this.fail(s, "account_mismatch", "这个设备属于别的账号", m.id);
        return s.conn.close(4001, "account_mismatch");
      }
      accountId = r.claims.sub;
    } else if (m.role === "phone") {
      this.fail(s, "token_required", "手机端必须带账号 token", m.id);
      return s.conn.close(4001, "token_required");
    } else {
      accountId = known?.accountId ?? UNCLAIMED;
    }
    s.hello = m;
    s.accountId = accountId;
    s.nonce = newNonce();
    s.state = "challenge";
    this.reply(s, { type: "auth.challenge", nonce: s.nonce });
  }

  private onAuthResponse(s: Session, m: Extract<HubMessage, { type: "auth.response" }>) {
    if (s.state !== "challenge" || !s.hello || !s.nonce) return this.fail(s, "bad_state", "先发 hello", m.id);
    if (m.nonce !== s.nonce) return this.fail(s, "bad_nonce", "nonce 对不上", m.id);
    const h = s.hello;
    const v = verifySignedPayload({ payload: new TextEncoder().encode(hubAuthPayload(h.deviceId, s.nonce)), alg: h.pubKeys.sigAlg, sig: m.signature, publicKey: h.pubKeys });
    if (!v.ok) {
      this.fail(s, "bad_signature", v.message, m.id);
      return s.conn.close(4001, "bad_signature");
    }
    const now = this.now();
    this.store.upsertDevice({ deviceId: h.deviceId, accountId: s.accountId!, role: h.role, platform: h.platform, name: h.name, kem: h.pubKeys.kem, sig: h.pubKeys.sig, sigAlg: h.pubKeys.sigAlg }, now);
    // 同一个 id 只留最新一条连接
    const prev = this.online.get(h.deviceId);
    if (prev && prev !== s) {
      this.sessions.delete(prev.conn);
      prev.conn.close(4000, "replaced");
    }
    s.state = "authed";
    s.deviceId = h.deviceId;
    s.role = h.role;
    s.sessionToken = newSessionToken();
    s.nonce = undefined;
    this.online.set(h.deviceId, s);
    const expiresAt = now + this.sessionTtl;
    this.httpSessions.set(s.sessionToken, { deviceId: h.deviceId, accountId: s.accountId!, role: h.role, expiresAt });
    this.reply(s, { type: "auth.ok", sessionToken: s.sessionToken, expiresAt });
    this.log(`登录 ${h.role} ${h.deviceId} (${h.name}) account=${s.accountId}`);
    // 把配过对的对端公钥和在线状态推给它，并告诉对端我上线了
    for (const peerId of this.store.peersOf(h.deviceId)) {
      const peer = this.store.getDevice(peerId);
      if (!peer) continue;
      this.reply(s, { type: "peer.keys", deviceId: peerId, pubKeys: { kem: peer.kem, sig: peer.sig, sigAlg: peer.sigAlg } });
      this.reply(s, { type: "presence", deviceId: peerId, online: this.online.has(peerId), lastSeen: this.online.has(peerId) ? now : peer.lastSeen });
    }
    this.broadcastPresence(h.deviceId, true);
  }

  private onPushSend(s: Session, m: Extract<HubMessage, { type: "push.send" }>) {
    if (!this.canTalk(s, m.to)) return this.fail(s, "not_paired", `和 ${m.to} 没配过对`, m.id);
    if (this.online.has(m.to)) return this.reply(s, { type: "ack", ref: m.id }); // 在线就走中继，不推
    const target = this.store.getPushToken(m.to);
    const id = this.store.enqueuePush({ toDeviceId: m.to, sealed: m.sealed, category: m.category }, this.now());
    if (!target) {
      this.store.markPush(id, "failed", "对端没登记过推送 token");
      return this.fail(s, "no_push_token", `${m.to} 没登记过推送 token`, m.id);
    }
    void this.push.send(target, { sealed: m.sealed, category: m.category }).then((r) => {
      this.store.markPush(id, r.ok ? (this.push.kind === "dry-run" ? "dry-run" : "sent") : "failed", r.detail);
      this.reply(s, r.ok ? { type: "ack", ref: m.id } : { type: "error", code: "push_failed", message: r.detail, ref: m.id });
    });
  }

  // ───────────────────────── 配对 ─────────────────────────

  private onPairRequest(s: Session, m: Extract<HubMessage, { type: "pair.request" }>) {
    if (s.role !== "phone") return this.fail(s, "not_allowed", "只有手机能发起配对", m.id);
    if (m.phoneId !== s.deviceId) return this.fail(s, "id_mismatch", "phoneId 必须是你自己", m.id);
    if (s.accountId === UNCLAIMED) return this.fail(s, "token_required", "先登录账号", m.id);
    const device = this.online.get(m.deviceId);
    if (!device || device.role !== "device") return this.fail(s, "peer_offline", `${m.deviceId} 不在线，配对时两边都得在线`, m.id);
    if (device.accountId !== UNCLAIMED && device.accountId !== s.accountId) return this.fail(s, "account_mismatch", "这台设备属于别的账号", m.id);
    this.pendingPairs.set(pairKey(m.deviceId, m.phoneId), { phoneId: m.phoneId, phoneName: m.phoneName, phonePubKeys: m.phonePubKeys, phoneAccount: s.accountId!, at: this.now() });
    // 原样转给设备：HMAC 由设备自己用二维码里的 secret 验，hub 不知道 secret
    device.conn.send(JSON.stringify(m));
  }

  private onPairConfirm(s: Session, m: Extract<HubMessage, { type: "pair.confirm" }>) {
    if (s.role !== "device" || m.deviceId !== s.deviceId) return this.fail(s, "not_allowed", "只有被配对的设备自己能确认", m.id);
    const key = pairKey(m.deviceId, m.phoneId);
    const pending = this.pendingPairs.get(key);
    if (!pending) return this.fail(s, "no_pending_pair", "没有待确认的配对请求", m.id);
    this.pendingPairs.delete(key);
    const phone = this.online.get(m.phoneId);
    if (!m.accept) {
      const result: MsgBody = { type: "pair.result", deviceId: m.deviceId, phoneId: m.phoneId, ok: false, reason: "设备拒绝了" };
      this.reply(s, result);
      if (phone) this.reply(phone, result);
      return;
    }
    const now = this.now();
    this.store.addPairing(m.deviceId, m.phoneId, now);
    if (s.accountId === UNCLAIMED) {
      // 设备第一次被认领：归入手机的账号
      s.accountId = pending.phoneAccount;
      this.store.db.query("UPDATE devices SET account_id = ? WHERE device_id = ?").run(pending.phoneAccount, m.deviceId);
      if (s.sessionToken) this.httpSessions.get(s.sessionToken)!.accountId = pending.phoneAccount;
    }
    const deviceRow = this.store.getDevice(m.deviceId)!;
    const result: MsgBody = { type: "pair.result", deviceId: m.deviceId, phoneId: m.phoneId, ok: true };
    this.reply(s, result);
    this.reply(s, { type: "peer.keys", deviceId: m.phoneId, pubKeys: pending.phonePubKeys });
    this.reply(s, { type: "presence", deviceId: m.phoneId, online: !!phone, lastSeen: now });
    if (phone) {
      this.reply(phone, result);
      this.reply(phone, { type: "peer.keys", deviceId: m.deviceId, pubKeys: keysOf(deviceRow) });
      this.reply(phone, { type: "presence", deviceId: m.deviceId, online: true, lastSeen: now });
    }
    this.log(`配对成功 ${m.deviceId} ↔ ${m.phoneId}`);
  }

  private onPairCodeClaim(s: Session, m: Extract<HubMessage, { type: "pair.code.claim" }>) {
    if (s.role !== "phone") return this.fail(s, "not_allowed", "只有手机能用配对码", m.id);
    const offer = this.store.takePairCode(m.code, this.now());
    if (!offer) return this.fail(s, "bad_code", "配对码不对或已过期", m.id);
    this.reply(s, { type: "pair.offer", ...offer });
  }

  /** 设备通过 HTTP 登记一个 6 位配对码（没摄像头 / 不想扫码时用） */
  issuePairCode(deviceId: string, offer: Omit<PairOffer, "hubURL" | "expiresAt"> & { expiresAt?: number }): { code: string; expiresAt: number } {
    const now = this.now();
    this.store.purgeExpiredPairCodes(now);
    const expiresAt = Math.min(offer.expiresAt ?? now + this.pairCodeTtl, now + this.pairCodeTtl);
    const full = PairOffer.parse({ ...offer, hubURL: this.publicURL, expiresAt, deviceId });
    let code = newPairCode();
    for (let i = 0; i < 5 && this.store.db.query("SELECT 1 FROM pair_codes WHERE code = ?").get(code); i++) code = newPairCode();
    this.store.putPairCode(code, deviceId, full, expiresAt);
    return { code, expiresAt };
  }

  // ───────────────────────── 二进制：RelayEnvelope ─────────────────────────

  private onBinary(s: Session, bytes: Uint8Array) {
    if (s.state !== "authed") return this.fail(s, "unauthenticated", "先登录再中继");
    let env;
    try {
      env = decodeRelay(bytes);
    } catch (e) {
      return this.fail(s, "bad_relay", e instanceof Error ? e.message : String(e));
    }
    if (env.from !== s.deviceId) return this.fail(s, "from_mismatch", `信封 from=${env.from} 不是你（${s.deviceId}）`);
    if (!this.canTalk(s, env.to)) return this.fail(s, "not_paired", `和 ${env.to} 没配过对`);
    const target = this.online.get(env.to);
    if (!target) return this.fail(s, "peer_offline", `${env.to} 不在线`, env.to);
    target.conn.send(bytes);
  }

  /** 允许互发：配过对，或者同账号里的 brain（云端大脑）和它账号下的端 */
  private canTalk(s: Session, peerId: string): boolean {
    if (!s.deviceId || s.accountId === UNCLAIMED) return false;
    if (this.store.isPaired(s.deviceId, peerId)) return true;
    const peer = this.online.get(peerId) ?? null;
    const peerRow = peer ? null : this.store.getDevice(peerId);
    const peerRole = peer?.role ?? peerRow?.role;
    const peerAccount = peer?.accountId ?? peerRow?.accountId;
    if (peerAccount !== s.accountId) return false;
    return s.role === "brain" || peerRole === "brain";
  }

  // ───────────────────────── HTTP ─────────────────────────

  authHttp(req: Request): { deviceId: string; accountId: string; role: Role } | null {
    const h = req.headers.get("authorization") ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const s = this.httpSessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.httpSessions.delete(token);
      return null;
    }
    return s;
  }

  async handleHttp(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, online: this.online.size, push: this.push.kind, singleUser: this.singleUser });
    if (!url.pathname.startsWith("/api/")) return null;
    const who = this.authHttp(req);
    if (!who) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (url.pathname === "/api/pair/code" && req.method === "POST") {
      if (who.role !== "device") return Response.json({ error: "只有被控设备能发配对码" }, { status: 403 });
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return Response.json({ error: "bad_json" }, { status: 400 });
      try {
        return Response.json(this.issuePairCode(who.deviceId, body as Omit<PairOffer, "hubURL" | "expiresAt">));
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    if (url.pathname === "/api/devices" && req.method === "GET") {
      const devices = this.store.listAccountDevices(who.accountId).map((d) => ({ ...d, online: this.online.has(d.deviceId), paired: this.store.isPaired(who.deviceId, d.deviceId) }));
      return Response.json({ devices });
    }
    if (url.pathname === "/api/usage" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return Response.json({ summary: this.store.usageSummary(who.accountId, since), runs: this.store.listUsage(who.accountId, since).slice(0, 200) });
    }
    if (url.pathname === "/api/pairings" && req.method === "DELETE") {
      const peer = url.searchParams.get("peer") ?? "";
      if (!this.store.isPaired(who.deviceId, peer)) return Response.json({ error: "not_paired" }, { status: 404 });
      this.store.removePairing(who.deviceId, peer);
      this.store.removePairing(peer, who.deviceId);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // ───────────────────────── 工具 ─────────────────────────

  private reply(s: Session, body: MsgBody) {
    s.conn.send(JSON.stringify(mkMsg(body)));
  }

  private fail(s: Session, code: string, message: string, ref?: string) {
    this.reply(s, { type: "error", code, message, ...(ref ? { ref } : {}) });
  }

  private broadcastPresence(deviceId: string, onlineNow: boolean) {
    const now = this.now();
    for (const peerId of this.store.peersOf(deviceId)) {
      const peer = this.online.get(peerId);
      if (peer) this.reply(peer, { type: "presence", deviceId, online: onlineNow, lastSeen: now });
    }
  }
}

function pairKey(deviceId: string, phoneId: string) {
  return `${deviceId}\u0000${phoneId}`;
}

function keysOf(d: DeviceRow): PublicKeys {
  return { kem: d.kem, sig: d.sig, sigAlg: d.sigAlg };
}
