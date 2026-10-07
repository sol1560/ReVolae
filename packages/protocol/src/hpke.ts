/**
 * 端到端加密：HPKE（RFC 9180）Auth 模式
 *   DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305
 *   info = "cuaremote-v1|" + from + "|" + to
 *   每帧 seal(aad = RelayEnvelope 头部字节, pt = Frame 字节)
 *
 * 每个方向一个上下文：A→B 用 A 发起的 sender ctx，B→A 用 B 发起的另一个 sender ctx。
 * 会话建立：发起方先发一个 encrypted=0 的 RelayEnvelope，body = enc（32 字节）；
 * 对端收到后建 recipient ctx，之后该方向所有 RelayEnvelope 都是 encrypted=1。
 *
 * Swift 侧对应 CryptoKit `HPKE.Sender(recipientKey:ciphersuite:info:authenticatedBy:)` /
 * `HPKE.Recipient(privateKey:ciphersuite:info:encapsulatedKey:authenticatedBy:)`，
 * ciphersuite = .Curve25519_HKDF_SHA256_ChachaPoly。互通向量见 fixtures/hpke.json。
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeRelay, decodeRelay, type RelayEnvelope } from "./frame.js";
import { fromBase64, toBase64 } from "./bytes.js";

// 纯 JS 实现（@noble），Bun / Node / 浏览器 / React Native 都能跑，不依赖 WebCrypto。
// 正确性由 RFC 9180 A.2.3 向量和 Swift CryptoKit 互通向量（test/crypto.test.ts）保证。

export const HPKE_PROTOCOL_TAG = "cuaremote-v1";
export const KEM_PUBLIC_KEY_BYTES = 32;
export const KEM_ENC_BYTES = 32;
export const AEAD_TAG_BYTES = 16;

const utf8 = new TextEncoder();
const MODE_AUTH = 0x02;
const KEM_ID = 0x0020; // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001; // HKDF-SHA256
const AEAD_ID = 0x0003; // ChaCha20Poly1305
const NK = 32;
const NN = 12;
const NH = 32;
const HPKE_V1 = utf8.encode("HPKE-v1");
const SUITE_KEM = concat(utf8.encode("KEM"), i2osp(KEM_ID, 2));
const SUITE_HPKE = concat(utf8.encode("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const EMPTY = new Uint8Array(0);

function i2osp(n: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--, n = Math.floor(n / 256)) out[i] = n & 0xff;
  return out;
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) {
  return extract(sha256, concat(HPKE_V1, suite, utf8.encode(label), ikm), salt);
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) {
  return expand(sha256, prk, concat(i2osp(len, 2), HPKE_V1, suite, utf8.encode(label), info), len);
}

function kemShared(dh: Uint8Array, kemContext: Uint8Array) {
  const prk = labeledExtract(SUITE_KEM, EMPTY, "eae_prk", dh);
  return labeledExpand(SUITE_KEM, prk, "shared_secret", kemContext, 32);
}

export interface KemKeyPair {
  /** X25519 公钥，32 字节 */
  publicKey: Uint8Array;
  /** X25519 私钥，32 字节 */
  privateKey: Uint8Array;
}

export async function generateKemKeyPair(): Promise<KemKeyPair> {
  const privateKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

/** 从 32 字节种子确定性派生（RFC 9180 DeriveKeyPair），测试向量和从 Keychain 种子恢复用 */
export async function deriveKemKeyPair(ikm: Uint8Array): Promise<KemKeyPair> {
  return deriveSync(ikm);
}

function deriveSync(ikm: Uint8Array): KemKeyPair {
  const prk = labeledExtract(SUITE_KEM, EMPTY, "dkp_prk", ikm);
  const privateKey = labeledExpand(SUITE_KEM, prk, "sk", EMPTY, 32);
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

export function sessionInfo(from: string, to: string): Uint8Array {
  return utf8.encode(`${HPKE_PROTOCOL_TAG}|${from}|${to}`);
}

/** Auth 模式密钥调度（psk 为空） */
function keySchedule(shared: Uint8Array, info: Uint8Array) {
  const pskIdHash = labeledExtract(SUITE_HPKE, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(SUITE_HPKE, EMPTY, "info_hash", info);
  const ctx = concat(Uint8Array.of(MODE_AUTH), pskIdHash, infoHash);
  const secret = labeledExtract(SUITE_HPKE, shared, "secret", EMPTY);
  return {
    key: labeledExpand(SUITE_HPKE, secret, "key", ctx, NK),
    baseNonce: labeledExpand(SUITE_HPKE, secret, "base_nonce", ctx, NN),
    exporter: labeledExpand(SUITE_HPKE, secret, "exp", ctx, NH),
  };
}

/** 加解密共用：按序号算 nonce，序号只增不减 */
class AeadContext {
  private seq = 0;
  constructor(private readonly ks: { key: Uint8Array; baseNonce: Uint8Array; exporter: Uint8Array }) {}
  protected nextNonce(): Uint8Array {
    if (this.seq >= Number.MAX_SAFE_INTEGER) throw new Error("HPKE 序号用尽");
    const nonce = this.ks.baseNonce.slice();
    const s = i2osp(this.seq++, NN);
    for (let i = 0; i < NN; i++) nonce[i]! ^= s[i]!;
    return nonce;
  }
  protected rewind() {
    this.seq--;
  }
  protected get key() {
    return this.ks.key;
  }
  async export(context: Uint8Array, length: number): Promise<Uint8Array> {
    return labeledExpand(SUITE_HPKE, this.ks.exporter, "sec", context, length);
  }
}

/** 一个方向（from → to）的发送端 */
export class SealContext extends AeadContext {
  private constructor(
    ks: ReturnType<typeof keySchedule>,
    readonly enc: Uint8Array,
  ) {
    super(ks);
  }

  static async create(p: { self: KemKeyPair; peerPublicKey: Uint8Array; from: string; to: string; /** 测试向量用：固定临时密钥种子 */ ekm?: Uint8Array; info?: Uint8Array }): Promise<SealContext> {
    checkPair(p.self);
    if (p.peerPublicKey.byteLength !== KEM_PUBLIC_KEY_BYTES) throw new RangeError("X25519 公钥应为 32 字节");
    const eph = p.ekm ? deriveSync(p.ekm) : await generateKemKeyPair();
    const dh = concat(x25519.getSharedSecret(eph.privateKey, p.peerPublicKey), x25519.getSharedSecret(p.self.privateKey, p.peerPublicKey));
    const shared = kemShared(dh, concat(eph.publicKey, p.peerPublicKey, p.self.publicKey));
    return new SealContext(keySchedule(shared, p.info ?? sessionInfo(p.from, p.to)), eph.publicKey);
  }

  async seal(aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    return chacha20poly1305(this.key, this.nextNonce(), aad).encrypt(plaintext);
  }
}

/** 一个方向（from → to）的接收端 */
export class OpenContext extends AeadContext {
  static async create(p: { self: KemKeyPair; peerPublicKey: Uint8Array; enc: Uint8Array; from: string; to: string; info?: Uint8Array }): Promise<OpenContext> {
    if (p.enc.byteLength !== KEM_ENC_BYTES) throw new RangeError(`enc 应为 ${KEM_ENC_BYTES} 字节，收到 ${p.enc.byteLength}`);
    checkPair(p.self);
    const dh = concat(x25519.getSharedSecret(p.self.privateKey, p.enc), x25519.getSharedSecret(p.self.privateKey, p.peerPublicKey));
    const shared = kemShared(dh, concat(p.enc, p.self.publicKey, p.peerPublicKey));
    return new OpenContext(keySchedule(shared, p.info ?? sessionInfo(p.from, p.to)));
  }

  async open(aad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    // 解密失败也要消耗序号吗？RFC 9180：open 失败不递增。这里先算 nonce，失败时回退
    const nonce = this.peekNonce();
    const pt = chacha20poly1305(this.key, nonce, aad).decrypt(ciphertext);
    this.nextNonce();
    return pt;
  }

  private peekNonce(): Uint8Array {
    const n = this.nextNonce();
    this.rewind();
    return n;
  }
}

/**
 * 两个方向合起来的一条端到端链路，直接吐 / 吃 RelayEnvelope 字节。
 *   const a = await E2ELink.create({ selfId:"mac", self:kA, peerId:"phone", peerPublicKey:kB.publicKey })
 *   ws.send(a.handshake())              // encrypted=0，body=enc
 *   ws.send(await a.sealFrame(frame))   // encrypted=1
 *   const f = await a.openRelay(bytes)  // 对端来的：握手帧返回 null，密文帧返回 Frame 字节
 */
export class E2ELink {
  private opener: OpenContext | null = null;
  private constructor(readonly selfId: string, readonly peerId: string, private readonly self: KemKeyPair, private readonly peerPublicKey: Uint8Array, private readonly sealer: SealContext) {}

  static async create(p: { selfId: string; self: KemKeyPair; peerId: string; peerPublicKey: Uint8Array; ekm?: Uint8Array }): Promise<E2ELink> {
    const sealer = await SealContext.create({ self: p.self, peerPublicKey: p.peerPublicKey, from: p.selfId, to: p.peerId, ekm: p.ekm });
    return new E2ELink(p.selfId, p.peerId, p.self, p.peerPublicKey, sealer);
  }

  /** 我方发送方向的握手帧（对端拿到 enc 才能解我发的密文） */
  handshake(): Uint8Array {
    return encodeRelay({ to: this.peerId, from: this.selfId, encrypted: false, body: this.sealer.enc });
  }

  get ready() {
    return this.opener !== null;
  }

  async sealFrame(frame: Uint8Array): Promise<Uint8Array> {
    const header = relayHeader({ to: this.peerId, from: this.selfId, encrypted: true });
    const ct = await this.sealer.seal(header, frame);
    return concat(header, ct);
  }

  /** 返回解密后的 Frame 字节；如果是对端的握手帧，建好 opener 并返回 null */
  async openRelay(bytes: Uint8Array): Promise<Uint8Array | null> {
    const env = decodeRelay(bytes);
    if (env.to !== this.selfId || env.from !== this.peerId) throw new Error(`信封路由不对：${env.from}→${env.to}，本链路是 ${this.peerId}→${this.selfId}`);
    if (!env.encrypted) {
      if (this.opener) throw new Error("对端重复握手（会话中途换 enc 不允许）");
      this.opener = await OpenContext.create({ self: this.self, peerPublicKey: this.peerPublicKey, enc: env.body, from: this.peerId, to: this.selfId });
      return null;
    }
    if (!this.opener) throw new Error("还没收到对端握手就来了密文");
    const header = bytes.subarray(0, bytes.byteLength - env.body.byteLength);
    return this.opener.open(header, env.body);
  }
}

/** RelayEnvelope 的头部字节（= aad） */
export function relayHeader(e: Omit<RelayEnvelope, "body">): Uint8Array {
  return encodeRelay({ ...e, body: new Uint8Array(0) });
}

function checkPair(k: KemKeyPair) {
  if (k.publicKey.byteLength !== KEM_PUBLIC_KEY_BYTES || k.privateKey.byteLength !== 32) throw new RangeError("X25519 密钥应为 32 字节");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export const hex = {
  to: (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join(""),
  from: (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))),
};
export const b64 = {
  to: toBase64,
  from: fromBase64,
};
