import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnyMessage, E2ELink, controlFrame, decodeFrame, decodeRelay, hubAuthPayload, mkMsg, pairHmac, pairHmacEquals, parseControl, signPayload, type HubMessage } from "@cuaremote/protocol";
import { signJwt } from "../src/auth.js";
import { DryRunPush } from "../src/push.js";
import { createHubServer } from "../src/server.js";
import { Endpoint, b64, pair } from "./helpers.js";

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
    // 列表是「别的端」，不含自己
    expect(d.devices.some((x) => x.deviceId === mac.id)).toBe(false);
    const mac1 = d.devices.find((x) => x.deviceId === "mac-1")!;
    expect(mac1.online).toBe(false);
    expect(mac1.paired).toBe(false);
    expect(d.devices.find((x) => x.deviceId === "phone-1")).toMatchObject({ paired: false, online: false });
    mac.close();
  });
  test("多设备：一部手机管两台 Mac，各走各的通道；devices.list / 别名 / 解绑", async () => {
    const phone = await Endpoint.make("phone-m", "phone", "Ed25519");
    const a = await Endpoint.make("mac-work", "device");
    const b = await Endpoint.make("mac-home", "device");
    const c = await Endpoint.make("mac-other", "device");
    await Promise.all([phone.login(url), a.login(url, { name: "工作 Mac" }), b.login(url, { name: "家里 Mac" }), c.login(url, { name: "别人的 Mac" })]);
    const secret = b64(crypto.getRandomValues(new Uint8Array(16)));
    const dbg = (e: Endpoint) => e.inbox.map((m) => ("bin" in m ? "bin" : m.type === "error" ? `error:${m.code}:${m.message}` : m.type));
    const r1 = await pair(phone, a, secret).catch((e) => { throw new Error(`pair a: ${e.message} phone=${dbg(phone)} a=${dbg(a)}`); });
    expect(r1.rp.ok).toBe(true);
    const r2 = await pair(phone, b, secret).catch((e) => { throw new Error(`pair b: ${e.message} phone=${dbg(phone)} b=${dbg(b)}`); });
    expect(r2.rp.ok).toBe(true);
    // 配对后各自收到对端公钥
    const kA = await phone.expect("peer.keys", (m) => m.deviceId === a.id);
    const kB = await phone.expect("peer.keys", (m) => m.deviceId === b.id);
    const kPa = await a.expect("peer.keys");
    const kPb = await b.expect("peer.keys");

    // 手机对两台各建一条端到端链路，密文只到该去的那台
    const mk = async (peer: Endpoint, peerKem: string) => E2ELink.create({ selfId: phone.id, self: phone.kem, peerId: peer.id, peerPublicKey: new Uint8Array(Buffer.from(peerKem, "base64")) });
    const pa = await mk(a, kA.pubKeys.kem);
    const pb = await mk(b, kB.pubKeys.kem);
    const la = await E2ELink.create({ selfId: a.id, self: a.kem, peerId: phone.id, peerPublicKey: new Uint8Array(Buffer.from(kPa.pubKeys.kem, "base64")) });
    const lb = await E2ELink.create({ selfId: b.id, self: b.kem, peerId: phone.id, peerPublicKey: new Uint8Array(Buffer.from(kPb.pubKeys.kem, "base64")) });
    phone.sendBin(pa.handshake());
    expect(await la.openRelay(await a.expectBin())).toBeNull();
    a.sendBin(la.handshake());
    expect(await pa.openRelay(await phone.expectBin())).toBeNull();
    phone.sendBin(pb.handshake());
    expect(await lb.openRelay(await b.expectBin())).toBeNull();
    b.sendBin(lb.handshake());
    expect(await pb.openRelay(await phone.expectBin())).toBeNull();

    const toA = mkMsg({ type: "intent.submit", text: "给 A 的", deviceId: a.id, mode: "agent" });
    const toB = mkMsg({ type: "intent.submit", text: "给 B 的", deviceId: b.id, mode: "agent" });
    phone.sendBin(await pa.sealFrame(controlFrame(toA, 0)));
    phone.sendBin(await pb.sealFrame(controlFrame(toB, 0)));
    expect(parseControl(decodeFrame((await la.openRelay(await a.expectBin()))!))).toEqual(toA);
    expect(parseControl(decodeFrame((await lb.openRelay(await b.expectBin()))!))).toEqual(toB);
    expect(a.inbox.filter((m) => "bin" in m)).toHaveLength(0);
    expect(b.inbox.filter((m) => "bin" in m)).toHaveLength(0);
    // A 和 B 之间没配对，互相发不了
    const lab = await E2ELink.create({ selfId: a.id, self: a.kem, peerId: b.id, peerPublicKey: new Uint8Array(Buffer.from(b.pubKeys.kem, "base64")) });
    a.sendBin(lab.handshake());
    expect((await a.expect("error")).code).toBe("not_paired");

    // devices.list：A、B 配过对且在线，C 同账号但没配对
    phone.send({ type: "devices.list" });
    let page = await phone.expect("devices.page");
    expect(page.devices.map((d) => [d.deviceId, d.paired, d.online, d.name])).toEqual([
      ["mac-home", true, true, "家里 Mac"],
      ["mac-work", true, true, "工作 Mac"],
      ...page.devices.filter((d) => !d.paired).map((d) => [d.deviceId, false, d.online, d.name]),
    ]);
    expect(page.devices.find((d) => d.deviceId === c.id)).toMatchObject({ paired: false, online: true, name: "别人的 Mac" });
    expect(page.devices.some((d) => d.deviceId === phone.id)).toBe(false);
    expect(page.devices.find((d) => d.deviceId === a.id)!.pairedAt).toBe(now);

    // 别名：只能给自己或配过对的起；不影响设备自报名
    phone.send({ type: "device.rename", deviceId: c.id, name: "偷改" });
    expect((await phone.expect("error")).code).toBe("not_paired");
    phone.send({ type: "device.rename", deviceId: a.id, name: "  公司 M5  " });
    await phone.expect("ack");
    phone.send({ type: "devices.list" });
    page = await phone.expect("devices.page");
    expect(page.devices.find((d) => d.deviceId === a.id)!.name).toBe("公司 M5");
    expect(srv.hub.store.getDevice(a.id)!.name).toBe("工作 Mac");

    // 解绑 B：双方收到 pair.removed；之后手机→B 报 not_paired；列表里 B 变成未配对
    phone.send({ type: "device.unpair", deviceId: b.id });
    await phone.expect("ack");
    expect(await phone.expect("pair.removed")).toMatchObject({ deviceId: b.id, phoneId: phone.id, by: phone.id });
    expect(await b.expect("pair.removed")).toMatchObject({ deviceId: b.id, phoneId: phone.id, by: phone.id });
    phone.sendBin(await pb.sealFrame(controlFrame(toB, 0)));
    expect((await phone.expect("error")).code).toBe("not_paired");
    phone.sendBin(await pa.sealFrame(controlFrame(toA, 0)));
    expect(parseControl(decodeFrame((await la.openRelay(await a.expectBin()))!))).toEqual(toA);
    phone.send({ type: "devices.list" });
    page = await phone.expect("devices.page");
    expect(page.devices.find((d) => d.deviceId === b.id)).toMatchObject({ paired: false, online: true });
    expect(page.devices[0]!.deviceId).toBe(a.id);

    // B 掉线后 lastSeen 停在下线时刻
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    now += 100;
    phone.send({ type: "devices.list" });
    page = await phone.expect("devices.page");
    expect(page.devices.find((d) => d.deviceId === b.id)).toMatchObject({ online: false, lastSeen: now - 100 });
    for (const e of [phone, a, c]) e.close();
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
