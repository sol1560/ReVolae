import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ApprovalVerifier,
  approvalChallenge,
  controlFrame,
  decodeFrame,
  deriveKemKeyPair,
  E2ELink,
  generateKemKeyPair,
  generateSigningKeyPair,
  hex,
  OpenContext,
  parseControl,
  relayHeader,
  SealContext,
  sessionInfo,
  signApproval,
  verifyApprovalSignature,
  decodeRelay,
} from "../src/index.js";

const vec = JSON.parse(readFileSync(new URL("../fixtures/rfc9180-a2-3.json", import.meta.url), "utf8")) as {
  info: string; ikmE: string; pkEm: string; ikmR: string; pkRm: string; skRm: string; ikmS: string; pkSm: string; skSm: string; enc: string;
  encryptions: { sequence_number: string; pt: string; aad: string; ct: string }[];
};

describe("HPKE 套件对得上 RFC 9180 A.2.3（X25519 / HKDF-SHA256 / ChaCha20Poly1305 / Auth）", () => {
  test("DeriveKeyPair 结果和向量一致", async () => {
    const r = await deriveKemKeyPair(hex.from(vec.ikmR));
    const s = await deriveKemKeyPair(hex.from(vec.ikmS));
    expect(hex.to(r.publicKey)).toBe(vec.pkRm);
    expect(hex.to(r.privateKey)).toBe(vec.skRm);
    expect(hex.to(s.publicKey)).toBe(vec.pkSm);
    expect(hex.to(s.privateKey)).toBe(vec.skSm);
  });

  test("固定 ikmE 时 enc 与前几条密文逐字节一致", async () => {
    const r = await deriveKemKeyPair(hex.from(vec.ikmR));
    const s = await deriveKemKeyPair(hex.from(vec.ikmS));
    const sender = await SealContext.create({ self: s, peerPublicKey: r.publicKey, from: "x", to: "y", info: hex.from(vec.info), ekm: hex.from(vec.ikmE) });
    expect(hex.to(sender.enc)).toBe(vec.enc);
    // 向量里 seq 0,1,2 连续；之后跳到 4，需要中间多 seal 一次
    const want = new Map(vec.encryptions.map((e) => [Number(e.sequence_number), e]));
    for (let seq = 0; seq <= 4; seq++) {
      const e = want.get(seq);
      const ct = await sender.seal(hex.from(e?.aad ?? "00"), hex.from(e?.pt ?? "00"));
      if (e) expect(hex.to(ct)).toBe(e.ct);
    }
    // 接收端用 skR + pkS 能解开 seq 0
    const recipient = await OpenContext.create({ self: r, peerPublicKey: s.publicKey, enc: hex.from(vec.enc), from: "x", to: "y", info: hex.from(vec.info) });
    const e0 = want.get(0)!;
    expect(hex.to(await recipient.open(hex.from(e0.aad), hex.from(e0.ct)))).toBe(e0.pt);
  });

  test("Auth 模式：冒充的发送方（换 pkS）解不开", async () => {
    const r = await deriveKemKeyPair(hex.from(vec.ikmR));
    const impostor = await generateKemKeyPair();
    const recipient = await OpenContext.create({ self: r, peerPublicKey: impostor.publicKey, enc: hex.from(vec.enc), from: "x", to: "y", info: hex.from(vec.info) });
    const e0 = vec.encryptions[0]!;
    await expect(recipient.open(hex.from(e0.aad), hex.from(e0.ct))).rejects.toThrow();
  });
});

describe("E2ELink 双向链路", () => {
  test("握手 + 双向密文 + aad 绑定信封头", async () => {
    const kMac = await generateKemKeyPair();
    const kPhone = await generateKemKeyPair();
    const mac = await E2ELink.create({ selfId: "mac-1", self: kMac, peerId: "phone-1", peerPublicKey: kPhone.publicKey });
    const phone = await E2ELink.create({ selfId: "phone-1", self: kPhone, peerId: "mac-1", peerPublicKey: kMac.publicKey });

    // 各自先发握手
    expect(await phone.openRelay(mac.handshake())).toBeNull();
    expect(await mac.openRelay(phone.handshake())).toBeNull();
    expect(mac.ready && phone.ready).toBe(true);

    const f1 = controlFrame({ v: 1, id: "1", type: "stats.get" });
    const sealed = await phone.sealFrame(f1);
    const env = decodeRelay(sealed);
    expect(env.encrypted).toBe(true);
    expect(env.to).toBe("mac-1");
    expect(env.body.byteLength).toBe(f1.byteLength + 16);
    const got = await mac.openRelay(sealed);
    expect(parseControl(decodeFrame(got!))).toEqual({ v: 1, id: "1", type: "stats.get" });

    // 反向也通，且序号独立
    const f2 = controlFrame({ v: 1, id: "2", type: "ack", ref: "1" });
    expect(parseControl(decodeFrame((await phone.openRelay(await mac.sealFrame(f2)))!))).toEqual({ v: 1, id: "2", type: "ack", ref: "1" });

    // 改信封头（改 to）→ aad 不匹配 → 解不开
    const tampered = new Uint8Array(await phone.sealFrame(f1));
    const hdrLen = relayHeader({ to: "mac-1", from: "phone-1", encrypted: true }).byteLength;
    expect(hdrLen).toBeGreaterThan(4);
    const evil = await E2ELink.create({ selfId: "mac-1", self: kMac, peerId: "phone-1", peerPublicKey: kPhone.publicKey });
    // 中继方把 from 改成别人：路由检查先拦
    tampered[2 + 5 + 1] = 0x7a; // from 的第一个字节 'p' → 'z'
    await expect(mac.openRelay(tampered)).rejects.toThrow(/路由不对/);
    void evil;

    // 改密文一个字节 → 认证失败
    const flipped = new Uint8Array(await phone.sealFrame(f1));
    flipped[flipped.byteLength - 1] = (flipped[flipped.byteLength - 1] ?? 0) ^ 1;
    await expect(mac.openRelay(flipped)).rejects.toThrow();
  });

  test("没握手就来密文 / 重复握手 都拒", async () => {
    const kA = await generateKemKeyPair();
    const kB = await generateKemKeyPair();
    const a = await E2ELink.create({ selfId: "a", self: kA, peerId: "b", peerPublicKey: kB.publicKey });
    const b = await E2ELink.create({ selfId: "b", self: kB, peerId: "a", peerPublicKey: kA.publicKey });
    await expect(b.openRelay(await a.sealFrame(new Uint8Array([0, 0, 0, 0, 0]))).then(() => "ok")).rejects.toThrow(/没收到对端握手/);
    await b.openRelay(a.handshake());
    await expect(b.openRelay(a.handshake())).rejects.toThrow(/重复握手/);
  });

  test("重放：同一密文第二次解不开（序号已前进）", async () => {
    const kA = await generateKemKeyPair();
    const kB = await generateKemKeyPair();
    const a = await E2ELink.create({ selfId: "a", self: kA, peerId: "b", peerPublicKey: kB.publicKey });
    const b = await E2ELink.create({ selfId: "b", self: kB, peerId: "a", peerPublicKey: kA.publicKey });
    await b.openRelay(a.handshake());
    const c = await a.sealFrame(controlFrame({ v: 1, id: "1", type: "stats.get" }));
    expect(await b.openRelay(c)).not.toBeNull();
    await expect(b.openRelay(c)).rejects.toThrow();
  });

  test("sessionInfo 含方向：a→b 与 b→a 不同", () => {
    expect(new TextDecoder().decode(sessionInfo("a", "b"))).toBe("cuaremote-v1|a|b");
    expect(hex.to(sessionInfo("a", "b"))).not.toBe(hex.to(sessionInfo("b", "a")));
  });
});

describe("审批签名验签", () => {
  const now = 1_800_000_000;
  const mk = (alg: "ES256" | "Ed25519") => {
    const keys = generateSigningKeyPair(alg);
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const v = new ApprovalVerifier({ phoneKeys: { sig: b64(keys.publicKey), sigAlg: alg }, now: () => now, nonceHistory: 3 });
    const rec = (i: number) => {
      const nonce = `n${i}`;
      const expiresAt = now + 300;
      const challenge = approvalChallenge({ runId: "r", stepId: `s${i}`, actionDetail: "rm foo", nonce, expiresAt });
      v.remember({ runId: "r", stepId: `s${i}`, challenge, expiresAt });
      return { nonce, expiresAt, challenge, stepId: `s${i}` };
    };
    return { keys, v, rec, alg };
  };

  for (const alg of ["ES256", "Ed25519"] as const) {
    test(`${alg}：正常签名通过；allow/deny 绑定在签名里`, () => {
      const { keys, v, rec } = mk(alg);
      const r = rec(1);
      const sig = signApproval({ challenge: r.challenge, allow: true, privateKey: keys.privateKey, alg, keyId: "k", nonce: r.nonce, expiresAt: r.expiresAt });
      // 手机签的是 allow，中间人改成 deny → 验签失败
      expect(v.verify({ runId: "r", stepId: "s1", allow: false, signature: sig }).ok).toBe(false);
      expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: sig })).toEqual({ ok: true });
      // 同一 step 第二次 → 已消费
      expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: sig })).toMatchObject({ ok: false, reason: "unknown_step" });
    });
  }

  test("四条规则：过期 / 晚于请求 / nonce 重放 / challenge 不一致 / 换钥匙", () => {
    const { keys, v, rec } = mk("ES256");
    const r = rec(1);
    const base = { challenge: r.challenge, allow: true, privateKey: keys.privateKey, alg: "ES256" as const, keyId: "k" };

    expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: signApproval({ ...base, nonce: r.nonce, expiresAt: now }) })).toMatchObject({ ok: false, reason: "expired" });
    expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: signApproval({ ...base, nonce: r.nonce, expiresAt: r.expiresAt + 1 }) })).toMatchObject({ ok: false, reason: "expires_after_request" });
    expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: signApproval({ ...base, nonce: "other", expiresAt: r.expiresAt }) })).toMatchObject({ ok: false, reason: "challenge_mismatch" });
    expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: signApproval({ ...base, nonce: r.nonce, expiresAt: r.expiresAt - 1 }) })).toMatchObject({ ok: false, reason: "challenge_mismatch" });

    const other = generateSigningKeyPair("ES256");
    expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: signApproval({ ...base, privateKey: other.privateKey, nonce: r.nonce, expiresAt: r.expiresAt }) })).toMatchObject({ ok: false, reason: "bad_signature" });

    // 正确的一次
    const good = signApproval({ ...base, nonce: r.nonce, expiresAt: r.expiresAt });
    expect(v.verify({ runId: "r", stepId: "s1", allow: true, signature: good }).ok).toBe(true);
    // 攻击者拿同一个 nonce 去配另一步的 challenge（假设宿主又发了同 nonce 的请求）：nonce 已用 → 拒
    const expiresAt = now + 300;
    const ch2 = approvalChallenge({ runId: "r", stepId: "s9", actionDetail: "x", nonce: r.nonce, expiresAt });
    v.remember({ runId: "r", stepId: "s9", challenge: ch2, expiresAt });
    expect(v.verify({ runId: "r", stepId: "s9", allow: true, signature: signApproval({ ...base, challenge: ch2, nonce: r.nonce, expiresAt }) })).toMatchObject({ ok: false, reason: "nonce_reused" });
    // 缺签名
    expect(v.verify({ runId: "r", stepId: "s9", allow: true })).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  test("nonce 历史只留最近 N 个", () => {
    const { keys, v, rec } = mk("ES256");
    const rs = [1, 2, 3, 4].map(rec);
    for (const r of rs) expect(v.verify({ runId: "r", stepId: r.stepId, allow: true, signature: signApproval({ challenge: r.challenge, allow: true, privateKey: keys.privateKey, alg: "ES256", keyId: "k", nonce: r.nonce, expiresAt: r.expiresAt }) }).ok).toBe(true);
    // n1 已被挤出历史；重新 remember 一个用 n1 的 challenge 就能过（这是历史上限的代价，文档写明 1000）
    const expiresAt = now + 300;
    const ch = approvalChallenge({ runId: "r", stepId: "s10", actionDetail: "x", nonce: "n1", expiresAt });
    v.remember({ runId: "r", stepId: "s10", challenge: ch, expiresAt });
    expect(v.verify({ runId: "r", stepId: "s10", allow: true, signature: signApproval({ challenge: ch, allow: true, privateKey: keys.privateKey, alg: "ES256", keyId: "k", nonce: "n1", expiresAt }) }).ok).toBe(true);
    const ch2 = approvalChallenge({ runId: "r", stepId: "s11", actionDetail: "x", nonce: "n4", expiresAt });
    v.remember({ runId: "r", stepId: "s11", challenge: ch2, expiresAt });
    expect(v.verify({ runId: "r", stepId: "s11", allow: true, signature: signApproval({ challenge: ch2, allow: true, privateKey: keys.privateKey, alg: "ES256", keyId: "k", nonce: "n4", expiresAt }) })).toMatchObject({ ok: false, reason: "nonce_reused" });
  });

  test("公钥格式：x963(65) / raw(64) / 压缩(33) 都认；DER 签名也认", () => {
    const keys = generateSigningKeyPair("ES256");
    const challenge = "c";
    const sig = signApproval({ challenge, allow: true, privateKey: keys.privateKey, alg: "ES256", keyId: "k", nonce: "n", expiresAt: now + 10 });
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const raw64 = keys.publicKey.subarray(1);
    for (const pub of [keys.publicKey, raw64]) {
      expect(verifyApprovalSignature({ challenge, allow: true, signature: sig, phoneKeys: { sig: b64(pub), sigAlg: "ES256" } })).toEqual({ ok: true });
    }
    // DER 编码同一签名
    const { p256 } = require("@noble/curves/nist.js") as typeof import("@noble/curves/nist.js");
    const der = p256.Signature.fromBytes(new Uint8Array(Buffer.from(sig.sig, "base64")), "compact").toBytes("der");
    expect(verifyApprovalSignature({ challenge, allow: true, signature: { ...sig, sig: b64(der) }, phoneKeys: { sig: b64(keys.publicKey), sigAlg: "ES256" } })).toEqual({ ok: true });
    expect(verifyApprovalSignature({ challenge, allow: true, signature: sig, phoneKeys: { sig: b64(keys.publicKey.subarray(0, 40)), sigAlg: "ES256" } })).toMatchObject({ ok: false, reason: "bad_key" });
  });
});

describe("Swift 互通向量（fixtures/hpke.json、approval.json）可回放", () => {
  const hp = JSON.parse(readFileSync(new URL("../fixtures/hpke.json", import.meta.url), "utf8")) as {
    phone: { id: string; ikm: string; pk: string; sk: string; ekm: string };
    mac: { id: string; ikm: string; pk: string; sk: string; ekm: string };
    infoPhoneToMac: string; aadPhoneToMac: string; phoneHandshake: string; macHandshake: string;
    plaintexts: string[]; phoneToMac: string[]; macToPhonePlaintext: string; macToPhone: string;
    exporter: { context: string; length: number; value: string };
  };
  const ap = JSON.parse(readFileSync(new URL("../fixtures/approval.json", import.meta.url), "utf8")) as {
    vectors: { alg: "ES256" | "Ed25519"; privateKey: string; publicKey: string; challenge: string; signedPayload: string; signature: { alg: "ES256" | "Ed25519"; keyId: string; sig: string; expiresAt: number; nonce: string }; denySignature: { alg: "ES256" | "Ed25519"; keyId: string; sig: string; expiresAt: number; nonce: string } }[];
  };

  test("密钥、握手 enc、info、aad 都能从种子重新算出", async () => {
    const phone = await deriveKemKeyPair(hex.from(hp.phone.ikm));
    const mac = await deriveKemKeyPair(hex.from(hp.mac.ikm));
    expect(hex.to(phone.publicKey)).toBe(hp.phone.pk);
    expect(hex.to(mac.privateKey)).toBe(hp.mac.sk);
    expect(hex.to(sessionInfo(hp.phone.id, hp.mac.id))).toBe(hp.infoPhoneToMac);
    expect(hex.to(relayHeader({ to: hp.mac.id, from: hp.phone.id, encrypted: true }))).toBe(hp.aadPhoneToMac);
    const link = await E2ELink.create({ selfId: hp.phone.id, self: phone, peerId: hp.mac.id, peerPublicKey: mac.publicKey, ekm: hex.from(hp.phone.ekm) });
    expect(hex.to(link.handshake())).toBe(hp.phoneHandshake);
  });

  test("Mac 侧只用向量里的 sk + enc 就能解出手机发的两帧，并且顺序不能换", async () => {
    const mac = await deriveKemKeyPair(hex.from(hp.mac.ikm));
    const enc = decodeRelay(hex.from(hp.phoneHandshake)).body;
    const opener = await OpenContext.create({ self: mac, peerPublicKey: hex.from(hp.phone.pk), enc, from: hp.phone.id, to: hp.mac.id });
    const aad = hex.from(hp.aadPhoneToMac);
    for (let i = 0; i < hp.phoneToMac.length; i++) {
      const env = decodeRelay(hex.from(hp.phoneToMac[i]!));
      expect(hex.to(await opener.open(aad, env.body))).toBe(hp.plaintexts[i]!);
    }
    // 第二帧再喂一次 → seq 已经过了，必须失败（防重放）
    const again = decodeRelay(hex.from(hp.phoneToMac[1]!));
    await expect(opener.open(aad, again.body)).rejects.toThrow();
    // 反向：手机解 Mac 发的
    const phone = await deriveKemKeyPair(hex.from(hp.phone.ikm));
    const macEnc = decodeRelay(hex.from(hp.macHandshake)).body;
    const phoneOpener = await OpenContext.create({ self: phone, peerPublicKey: hex.from(hp.mac.pk), enc: macEnc, from: hp.mac.id, to: hp.phone.id });
    const m2p = decodeRelay(hex.from(hp.macToPhone));
    expect(hex.to(await phoneOpener.open(relayHeader({ to: hp.phone.id, from: hp.mac.id, encrypted: true }), m2p.body))).toBe(hp.macToPhonePlaintext);
    // exporter
    const sealer = await SealContext.create({ self: phone, peerPublicKey: hex.from(hp.mac.pk), from: hp.phone.id, to: hp.mac.id, ekm: hex.from(hp.phone.ekm) });
    expect(hex.to(await sealer.export(hex.from(hp.exporter.context), hp.exporter.length))).toBe(hp.exporter.value);
  });

  test("审批签名向量：两种算法都验得过，allow 翻转就验不过", () => {
    for (const v of ap.vectors) {
      const phoneKeys = { sig: Buffer.from(hex.from(v.publicKey)).toString("base64"), sigAlg: v.alg };
      expect(verifyApprovalSignature({ challenge: v.challenge, allow: true, signature: v.signature, phoneKeys })).toEqual({ ok: true });
      expect(verifyApprovalSignature({ challenge: v.challenge, allow: false, signature: v.denySignature, phoneKeys })).toEqual({ ok: true });
      expect(verifyApprovalSignature({ challenge: v.challenge, allow: false, signature: v.signature, phoneKeys })).toMatchObject({ ok: false });
      // 重新签一次要和向量一致（RFC 6979 / Ed25519 都是确定性的，Swift 侧 CryptoKit ES256 不是，只需验签）
      expect(signApproval({ challenge: v.challenge, allow: true, privateKey: hex.from(v.privateKey), alg: v.alg, keyId: v.signature.keyId, nonce: v.signature.nonce, expiresAt: v.signature.expiresAt })).toEqual(v.signature);
    }
  });
});
