import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AnyMessage,
  E2ELink,
  controlFrame,
  decodeFrame,
  decodeRelay,
  generateKemKeyPair,
  generateSigningKeyPair,
  hubAuthPayload,
  mkMsg,
  pairHmac,
  pairHmacEquals,
  parseControl,
  signPayload,
  type HubMessage,
  type MsgBody,
  type PublicKeys,
  type SigAlg,
} from "@cuaremote/protocol";
import { signJwt } from "../src/auth.js";
import { DryRunPush } from "../src/push.js";
import { createHubServer } from "../src/server.js";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

/** 测试用端：一个 WebSocket + 密钥 + 消息收件箱 */
class Endpoint {
  ws!: WebSocket;
  inbox: (HubMessage | { bin: Uint8Array })[] = [];
  waiters: { pred: (m: HubMessage | { bin: Uint8Array }) => boolean; resolve: (m: any) => void }[] = [];
  sessionToken = "";
  closed = false;
  closeCode = 0;

  constructor(
    readonly id: string,
    readonly role: "device" | "phone" | "brain",
    readonly kem: Awaited<ReturnType<typeof generateKemKeyPair>>,
    readonly sig: { publicKey: Uint8Array; privateKey: Uint8Array },
    readonly alg: SigAlg,
  ) {}

  static async make(id: string, role: "device" | "phone" | "brain", alg: SigAlg = "ES256") {
    return new Endpoint(id, role, await generateKemKeyPair(), generateSigningKeyPair(alg), alg);
  }

  get pubKeys(): PublicKeys {
    return { kem: b64(this.kem.publicKey), sig: b64(this.sig.publicKey), sigAlg: this.alg };
  }

  connect(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => {
      const m = typeof ev.data === "string" ? (AnyMessage.parse(JSON.parse(ev.data)) as HubMessage) : { bin: new Uint8Array(ev.data as ArrayBuffer) };
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    };
    this.ws.onclose = (ev) => {
      this.closed = true;
      this.closeCode = ev.code;
    };
    return new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("ws error"));
    });
  }

  send(body: MsgBody) {
    this.ws.send(JSON.stringify(mkMsg(body)));
  }

  sendBin(b: Uint8Array) {
    this.ws.send(b);
  }

  expect<T extends HubMessage["type"]>(type: T, extra?: (m: Extract<HubMessage, { type: T }>) => boolean, timeoutMs = 3000): Promise<Extract<HubMessage, { type: T }>> {
    return this.wait((m) => !("bin" in m) && m.type === type && (extra ? extra(m as any) : true), timeoutMs) as any;
  }

  expectBin(timeoutMs = 3000): Promise<Uint8Array> {
    return this.wait((m) => "bin" in m, timeoutMs).then((m) => (m as { bin: Uint8Array }).bin);
  }

  private wait(pred: (m: HubMessage | { bin: Uint8Array }) => boolean, timeoutMs: number) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise<HubMessage | { bin: Uint8Array }>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== ok);
        reject(new Error(`等消息超时；收件箱里有 ${JSON.stringify(this.inbox.map((m) => ("bin" in m ? "bin" : m.type)))}`));
      }, timeoutMs);
      const ok = (m: any) => {
        clearTimeout(t);
        resolve(m);
      };
      this.waiters.push({ pred, resolve: ok });
    });
  }

  async login(url: string, o: { token?: string; platform?: string; name?: string; badSig?: boolean } = {}) {
    await this.connect(url);
    this.send({ type: "hello", role: this.role, deviceId: this.id, platform: (o.platform ?? (this.role === "phone" ? "ios" : "macos")) as any, name: o.name ?? this.id, pubKeys: this.pubKeys, protocolVersion: 1, ...(o.token ? { token: o.token } : {}) });
    const ch = await this.expect("auth.challenge");
    const payload = new TextEncoder().encode(hubAuthPayload(this.id, o.badSig ? "nope" : ch.nonce));
    this.send({ type: "auth.response", nonce: ch.nonce, signature: signPayload(payload, this.sig.privateKey, this.alg) });
    const ok = await this.expect("auth.ok");
    this.sessionToken = ok.sessionToken;
    return ok;
  }

  close() {
    this.ws.close();
  }
}

/** 走完整配对：手机 pair.request（HMAC）→ 设备验 HMAC → pair.confirm */
async function pair(phone: Endpoint, device: Endpoint, secretB64: string) {
  phone.send({ type: "pair.request", deviceId: device.id, phoneId: phone.id, phoneName: "iPhone", phonePubKeys: phone.pubKeys, hmac: pairHmac(secretB64, device.pubKeys.kem, phone.pubKeys.kem) });
  const req = await device.expect("pair.request");
  const expected = pairHmac(secretB64, device.pubKeys.kem, req.phonePubKeys.kem);
  const accept = pairHmacEquals(req.hmac, expected);
  device.send({ type: "pair.confirm", deviceId: device.id, phoneId: req.phoneId, accept });
  const [rp, rd] = await Promise.all([phone.expect("pair.result"), device.expect("pair.result")]);
  return { accept, rp, rd };
}

describe("hub 单机模式", () => {
  const push = new DryRunPush();
  let now = 1_800_000_000;
  const srv = createHubServer({ port: 0, push, now: () => now, publicURL: "ws://hub.test/ws" });
  const url = srv.url;
  afterAll(() => {
    void srv.server.stop(true);
  });

  test("登录：签错 nonce 被拒并断开；签对拿到 sessionToken", async () => {
    const bad = await Endpoint.make("mac-bad", "device");
    await bad.connect(url);
    bad.send({ type: "hello", role: "device", deviceId: bad.id, platform: "macos", name: "x", pubKeys: bad.pubKeys, protocolVersion: 1 });
    const ch = await bad.expect("auth.challenge");
    bad.send({ type: "auth.response", nonce: ch.nonce, signature: signPayload(new TextEncoder().encode(hubAuthPayload(bad.id, "other")), bad.sig.privateKey, bad.alg) });
    const err = await bad.expect("error");
    expect(err.code).toBe("bad_signature");
    await Bun.sleep(50);
    expect(bad.closed).toBe(true);
    expect(bad.closeCode).toBe(4001);

    const good = await Endpoint.make("mac-good", "device", "Ed25519");
    const ok = await good.login(url);
    expect(ok.sessionToken.length).toBeGreaterThan(20);
    expect(ok.expiresAt).toBe(now + 24 * 3600);
    good.close();
  });

  test("没登录不能发业务消息；没配对不能中继", async () => {
    const p = await Endpoint.make("phone-x", "phone");
    await p.connect(url);
    p.send({ type: "usage.report", runId: "r", cost: { inputTokens: 1, outputTokens: 1, jevTokens: 0, usd: 0 }, steps: 1, jevCalls: 0 });
    expect((await p.expect("error")).code).toBe("unauthenticated");
    p.close();

    const a = await Endpoint.make("mac-a", "device");
    const b = await Endpoint.make("phone-b", "phone");
    await a.login(url);
    await b.login(url);
    const link = await E2ELink.create({ selfId: b.id, self: b.kem, peerId: a.id, peerPublicKey: a.kem.publicKey });
    b.sendBin(link.handshake());
    expect((await b.expect("error")).code).toBe("not_paired");
    a.close();
    b.close();
  });

  test("配对 + 端到端中继 + 上下线 presence + 离线推送 dry-run", async () => {
    const mac = await Endpoint.make("mac-1", "device");
    const phone = await Endpoint.make("phone-1", "phone", "Ed25519");
    await mac.login(url, { name: "Sol 的 Mac" });
    await phone.login(url, { platform: "ios" });

    // 手机拿错 secret 算 HMAC：设备用二维码里的真 secret 验不过 → 拒绝
    const secret = b64(crypto.getRandomValues(new Uint8Array(16)));
    phone.send({ type: "pair.request", deviceId: mac.id, phoneId: phone.id, phoneName: "iPhone", phonePubKeys: phone.pubKeys, hmac: pairHmac(b64(new Uint8Array(16)), mac.pubKeys.kem, phone.pubKeys.kem) });
    const badReq = await mac.expect("pair.request");
    expect(pairHmacEquals(badReq.hmac, pairHmac(secret, mac.pubKeys.kem, badReq.phonePubKeys.kem))).toBe(false);
    mac.send({ type: "pair.confirm", deviceId: mac.id, phoneId: phone.id, accept: false });
    expect((await phone.expect("pair.result")).ok).toBe(false);
    expect((await mac.expect("pair.result")).ok).toBe(false);

    // 正确配对
    const r = await pair(phone, mac, secret);
    expect(r.accept).toBe(true);
    expect(r.rp.ok).toBe(true);
    expect(r.rd.ok).toBe(true);
    const keysAtPhone = await phone.expect("peer.keys");
    expect(keysAtPhone.deviceId).toBe(mac.id);
    expect(keysAtPhone.pubKeys).toEqual(mac.pubKeys);
    const keysAtMac = await mac.expect("peer.keys");
    expect(keysAtMac.pubKeys).toEqual(phone.pubKeys);
    expect((await phone.expect("presence", (m) => m.deviceId === mac.id)).online).toBe(true);
    expect((await mac.expect("presence", (m) => m.deviceId === phone.id)).online).toBe(true);

    // 端到端：两边各自握手，再互发密文，hub 只转发
    const phoneLink = await E2ELink.create({ selfId: phone.id, self: phone.kem, peerId: mac.id, peerPublicKey: new Uint8Array(Buffer.from(keysAtPhone.pubKeys.kem, "base64")) });
    const macLink = await E2ELink.create({ selfId: mac.id, self: mac.kem, peerId: phone.id, peerPublicKey: new Uint8Array(Buffer.from(keysAtMac.pubKeys.kem, "base64")) });
    phone.sendBin(phoneLink.handshake());
    expect(await macLink.openRelay(await mac.expectBin())).toBeNull();
    mac.sendBin(macLink.handshake());
    expect(await phoneLink.openRelay(await phone.expectBin())).toBeNull();

    const intent = mkMsg({ type: "intent.submit", text: "把桌面上的 pdf 列出来", deviceId: mac.id, mode: "agent" });
    phone.sendBin(await phoneLink.sealFrame(controlFrame(intent, 0)));
    const gotAtMac = await mac.expectBin();
    expect(decodeRelay(gotAtMac).encrypted).toBe(true);
    expect(parseControl(decodeFrame((await macLink.openRelay(gotAtMac))!))).toEqual(intent);

    const evt = mkMsg({ type: "run.finished", runId: "r1", ok: true, summary: "3 个 pdf", cost: { inputTokens: 1, outputTokens: 1, jevTokens: 0, usd: 0 }, stepCount: 1, cancelled: false });
    mac.sendBin(await macLink.sealFrame(controlFrame(evt, 0)));
    expect(parseControl(decodeFrame((await phoneLink.openRelay(await phone.expectBin()))!))).toEqual(evt);

    // 冒充别人发信封 → from_mismatch
    const forged = await macLink.sealFrame(controlFrame(evt, 0));
    phone.sendBin(forged);
    expect((await phone.expect("error")).code).toBe("from_mismatch");

    // 手机没登记 token 时推送失败；登记后 dry-run 成功
    phone.send({ type: "push.register", platform: "apns", token: "abcdef0123456789", pushKem: phone.pubKeys.kem });
    await phone.expect("ack");
    phone.close();
    const off = await mac.expect("presence", (m) => m.deviceId === phone.id);
    expect(off.online).toBe(false);

    mac.send({ type: "push.send", to: phone.id, sealed: "c2VhbGVk", category: "approval" });
    await mac.expect("ack");
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.target.token).toBe("abcdef0123456789");
    const outbox = srv.hub.store.listPush(phone.id);
    expect(outbox.map((o) => o.status)).toEqual(["dry-run"]);

    // 手机离线时中继报 peer_offline
    mac.sendBin(await macLink.sealFrame(controlFrame(evt, 0)));
    const e = await mac.expect("error");
    expect(e.code).toBe("peer_offline");
    expect(e.ref).toBe(phone.id);

    // 手机重连：直接收到对端公钥 + 在线状态（不用再配对）
    const phone2 = new Endpoint(phone.id, "phone", phone.kem, phone.sig, phone.alg);
    await phone2.login(url);
    expect((await phone2.expect("peer.keys")).deviceId).toBe(mac.id);
    expect((await phone2.expect("presence")).online).toBe(true);
    expect((await mac.expect("presence", (m) => m.deviceId === phone.id)).online).toBe(true);

    // 同一个 id 换公钥 → key_mismatch
    const impostor = await Endpoint.make(phone.id, "phone");
    await impostor.connect(url);
    impostor.send({ type: "hello", role: "phone", deviceId: phone.id, platform: "ios", name: "x", pubKeys: impostor.pubKeys, protocolVersion: 1 });
    expect((await impostor.expect("error")).code).toBe("key_mismatch");
    // 原连接不受影响
    phone2.send({ type: "usage.report", runId: "r1", cost: { inputTokens: 1200, outputTokens: 300, jevTokens: 40, usd: 0.012 }, steps: 3, jevCalls: 3 });
    await phone2.expect("ack");
    phone2.close();
    mac.close();
  });

  test("6 位配对码：设备 HTTP 领码 → 手机 claim 拿到 offer → 二次 claim 失败 → 过期失败", async () => {
    const mac = await Endpoint.make("mac-code", "device");
    const phone = await Endpoint.make("phone-code", "phone");
    await mac.login(url);
    await phone.login(url);
    const http = `http://${srv.server.hostname}:${srv.server.port}`;
    const unauthorized = await fetch(`${http}/api/pair/code`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    const res = await fetch(`${http}/api/pair/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${mac.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "别人的id", name: "Mac", pubKeys: mac.pubKeys, secret: "c2VjcmV0c2VjcmV0MTI=" }),
    });
    expect(res.status).toBe(200);
    const { code, expiresAt } = (await res.json()) as { code: string; expiresAt: number };
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(now + 300);

    phone.send({ type: "pair.code.claim", code, phoneId: phone.id, phonePubKeys: phone.pubKeys });
    const offer = await phone.expect("pair.offer");
    expect(offer.deviceId).toBe(mac.id); // 不能冒充别的 deviceId
    expect(offer.secret).toBe("c2VjcmV0c2VjcmV0MTI=");
    expect(offer.hubURL).toBe("ws://hub.test/ws");
    phone.send({ type: "pair.code.claim", code, phoneId: phone.id, phonePubKeys: phone.pubKeys });
    expect((await phone.expect("error")).code).toBe("bad_code");

    const res2 = await fetch(`${http}/api/pair/code`, { method: "POST", headers: { authorization: `Bearer ${mac.sessionToken}` }, body: JSON.stringify({ deviceId: mac.id, name: "Mac", pubKeys: mac.pubKeys, secret: "c2VjcmV0c2VjcmV0MTI=" }) });
    const { code: code2 } = (await res2.json()) as { code: string };
    now += 301;
    phone.send({ type: "pair.code.claim", code: code2, phoneId: phone.id, phonePubKeys: phone.pubKeys });
    expect((await phone.expect("error")).code).toBe("bad_code");
    now -= 301;

    // 手机不能领码
    const forbidden = await fetch(`${http}/api/pair/code`, { method: "POST", headers: { authorization: `Bearer ${phone.sessionToken}` }, body: "{}" });
    expect(forbidden.status).toBe(403);
    mac.close();
    phone.close();
  });

  test("用量：usage.report 汇总到账号；/api/devices 列出在线与配对状态", async () => {
    const mac = await Endpoint.make("mac-u", "device");
    await mac.login(url);
    mac.send({ type: "usage.report", runId: "r2", cost: { inputTokens: 100, outputTokens: 50, jevTokens: 10, usd: 0.005 }, steps: 2, jevCalls: 1 });
    await mac.expect("ack");
    const http = `http://${srv.server.hostname}:${srv.server.port}`;
    const u = (await (await fetch(`${http}/api/usage?since=0`, { headers: { authorization: `Bearer ${mac.sessionToken}` } })).json()) as { summary: { runs: number; usd: number; inputTokens: number } };
    // 单机模式所有端同一个账号：前面 phone2 报过 1 条（0.012），这里 1 条（0.005）
    expect(u.summary.runs).toBe(2);
    expect(u.summary.usd).toBeCloseTo(0.017, 6);
    expect(u.summary.inputTokens).toBe(1300);
    const d = (await (await fetch(`${http}/api/devices`, { headers: { authorization: `Bearer ${mac.sessionToken}` } })).json()) as { devices: { deviceId: string; online: boolean; paired: boolean }[] };
    const me = d.devices.find((x) => x.deviceId === mac.id)!;
    expect(me.online).toBe(true);
    const mac1 = d.devices.find((x) => x.deviceId === "mac-1")!;
    expect(mac1.online).toBe(false);
    expect(mac1.paired).toBe(false);
    mac.close();
  });
});

describe("hub 多账号模式（HUB_JWT_SECRET）", () => {
  const secret = "test-secret";
  const now = 1_800_000_000;
  const srv = createHubServer({ port: 0, now: () => now, jwtSecret: secret });
  const url = srv.url;
  afterAll(() => {
    void srv.server.stop(true);
  });
  const jwt = (sub: string, exp = now + 3600) => signJwt({ sub, exp }, secret);

  test("手机没 token 拒；过期 token 拒；设备先 unclaimed，配对后归入手机账号；别的账号碰不到", async () => {
    const noToken = await Endpoint.make("phone-nt", "phone");
    await noToken.connect(url);
    noToken.send({ type: "hello", role: "phone", deviceId: noToken.id, platform: "ios", name: "x", pubKeys: noToken.pubKeys, protocolVersion: 1 });
    expect((await noToken.expect("error")).code).toBe("token_required");

    const expired = await Endpoint.make("phone-exp", "phone");
    await expired.connect(url);
    expired.send({ type: "hello", role: "phone", deviceId: expired.id, platform: "ios", name: "x", pubKeys: expired.pubKeys, protocolVersion: 1, token: jwt("alice", now - 1) });
    expect((await expired.expect("error")).code).toBe("bad_token");

    const mac = await Endpoint.make("mac-m", "device");
    const alice = await Endpoint.make("phone-alice", "phone");
    const bob = await Endpoint.make("phone-bob", "phone");
    await mac.login(url);
    await alice.login(url, { token: jwt("alice") });
    await bob.login(url, { token: jwt("bob") });

    // 设备 unclaimed 时不能中继（哪怕对方在线）
    const link = await E2ELink.create({ selfId: mac.id, self: mac.kem, peerId: alice.id, peerPublicKey: alice.kem.publicKey });
    mac.sendBin(link.handshake());
    expect((await mac.expect("error")).code).toBe("not_paired");

    const pairSecret = b64(crypto.getRandomValues(new Uint8Array(16)));
    const r = await pair(alice, mac, pairSecret);
    expect(r.rp.ok).toBe(true);
    expect(srv.hub.store.getDevice(mac.id)!.accountId).toBe("alice");

    // bob 想配同一台：账号不符
    bob.send({ type: "pair.request", deviceId: mac.id, phoneId: bob.id, phoneName: "Bob", phonePubKeys: bob.pubKeys, hmac: pairHmac(pairSecret, mac.pubKeys.kem, bob.pubKeys.kem) });
    expect((await bob.expect("error")).code).toBe("account_mismatch");

    // 设备重连时带别的账号 token 也不行
    mac.close();
    await Bun.sleep(30);
    const mac2 = new Endpoint(mac.id, "device", mac.kem, mac.sig, mac.alg);
    await mac2.connect(url);
    mac2.send({ type: "hello", role: "device", deviceId: mac.id, platform: "macos", name: "x", pubKeys: mac.pubKeys, protocolVersion: 1, token: jwt("bob") });
    expect((await mac2.expect("error")).code).toBe("account_mismatch");

    // 用量按账号隔离
    alice.send({ type: "usage.report", runId: "ra", cost: { inputTokens: 10, outputTokens: 5, jevTokens: 0, usd: 0.001 }, steps: 1, jevCalls: 0 });
    await alice.expect("ack");
    expect(srv.hub.store.usageSummary("alice", 0).runs).toBe(1);
    expect(srv.hub.store.usageSummary("bob", 0).runs).toBe(0);
    alice.close();
    bob.close();
  });
});
