/**
 * 端到端加密：HPKE（RFC 9180）Auth 模式
 *   DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305
 *   info = "cuaremote-v2|" + from + "|" + to
 *   每帧 seal(aad = RelayEnvelope 头部字节, pt = Frame 字节)
 *
 * 每个方向一个上下文：A→B 用 A 发起的 sender ctx，B→A 用 B 发起的另一个 sender ctx。
 * 双方先交换 encrypted=0 的 RelayEnvelope，body=[版本2][enc32][本次随机nonce32]。
 * 密文内包含接收方本次nonce，旧握手连同旧密文不能在重启后重放。旧版本不降级。
 *
 * Swift 侧对应 CryptoKit `HPKE.Sender(recipientKey:ciphersuite:info:authenticatedBy:)` /
 * `HPKE.Recipient(privateKey:ciphersuite:info:encapsulatedKey:authenticatedBy:)`，
 * ciphersuite = .Curve25519_HKDF_SHA256_ChachaPoly。互通向量见 fixtures/hpke.json。
 */
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { encodeRelay, decodeRelay, type RelayEnvelope } from "./frame.js";

export const HPKE_PROTOCOL_TAG = "cuaremote-v2";
export const KEM_PUBLIC_KEY_BYTES = 32;
export const KEM_ENC_BYTES = 32;
export const AEAD_TAG_BYTES = 16;

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const utf8 = new TextEncoder();

export interface KemKeyPair {
  /** X25519 公钥，32 字节 */
  publicKey: Uint8Array;
  /** X25519 私钥，32 字节 */
  privateKey: Uint8Array;
}

export async function generateKemKeyPair(): Promise<KemKeyPair> {
  const kp = await suite.kem.generateKeyPair();
  return { publicKey: new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)), privateKey: new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey)) };
}

/** 从 32 字节种子确定性派生（RFC 9180 DeriveKeyPair），测试向量和从 Keychain 种子恢复用 */
export async function deriveKemKeyPair(ikm: Uint8Array): Promise<KemKeyPair> {
  const kp = await suite.kem.deriveKeyPair(toBuf(ikm));
  return { publicKey: new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)), privateKey: new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey)) };
}

export function sessionInfo(from: string, to: string): Uint8Array {
  return utf8.encode(`${HPKE_PROTOCOL_TAG}|${from}|${to}`);
}

/** 一个方向（from → to）的发送端 */
export class SealContext {
  private constructor(private readonly ctx: Awaited<ReturnType<CipherSuite["createSenderContext"]>>, readonly enc: Uint8Array) {}

  static async create(p: { self: KemKeyPair; peerPublicKey: Uint8Array; from: string; to: string; /** 测试向量用：固定临时密钥种子 */ ekm?: Uint8Array; info?: Uint8Array }): Promise<SealContext> {
    const recipientPublicKey = await suite.kem.deserializePublicKey(toBuf(p.peerPublicKey));
    const senderKey = await importPair(p.self);
    const ctx = await suite.createSenderContext({ recipientPublicKey, senderKey, info: toBuf(p.info ?? sessionInfo(p.from, p.to)), ...(p.ekm ? { ekm: toBuf(p.ekm) } : {}) });
    return new SealContext(ctx, new Uint8Array(ctx.enc));
  }

  async seal(aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await this.ctx.seal(toBuf(plaintext), toBuf(aad)));
  }
  async export(context: Uint8Array, length: number): Promise<Uint8Array> {
    return new Uint8Array(await this.ctx.export(toBuf(context), length));
  }
}

/** 一个方向（from → to）的接收端 */
export class OpenContext {
  private constructor(private readonly ctx: Awaited<ReturnType<CipherSuite["createRecipientContext"]>>) {}

  static async create(p: { self: KemKeyPair; peerPublicKey: Uint8Array; enc: Uint8Array; from: string; to: string; info?: Uint8Array }): Promise<OpenContext> {
    if (p.enc.byteLength !== KEM_ENC_BYTES) throw new RangeError(`enc 应为 ${KEM_ENC_BYTES} 字节，收到 ${p.enc.byteLength}`);
    const recipientKey = await importPair(p.self);
    const senderPublicKey = await suite.kem.deserializePublicKey(toBuf(p.peerPublicKey));
    const ctx = await suite.createRecipientContext({ recipientKey, enc: toBuf(p.enc), senderPublicKey, info: toBuf(p.info ?? sessionInfo(p.from, p.to)) });
    return new OpenContext(ctx);
  }

  async open(aad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await this.ctx.open(toBuf(ciphertext), toBuf(aad)));
  }
  async export(context: Uint8Array, length: number): Promise<Uint8Array> {
    return new Uint8Array(await this.ctx.export(toBuf(context), length));
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
  private peerNonce?: Uint8Array;
  private closed = false;
  private sends = Promise.resolve();
  private readonly waiters = new Set<(error?: Error) => void>();
  private constructor(readonly selfId: string, readonly peerId: string, private readonly self: KemKeyPair, private readonly peerPublicKey: Uint8Array, private readonly sealer: SealContext, private readonly nonce: Uint8Array) {}

  static async create(p: { selfId: string; self: KemKeyPair; peerId: string; peerPublicKey: Uint8Array; ekm?: Uint8Array; /** 固定值仅用于互通测试 */ nonce?: Uint8Array }): Promise<E2ELink> {
    const sealer = await SealContext.create({ self: p.self, peerPublicKey: p.peerPublicKey, from: p.selfId, to: p.peerId, ekm: p.ekm });
    const nonce = p.nonce?.slice() ?? crypto.getRandomValues(new Uint8Array(32));
    if (nonce.length !== 32) throw new Error("连接随机值必须为32字节");
    return new E2ELink(p.selfId, p.peerId, p.self, p.peerPublicKey, sealer, nonce);
  }

  /** 我方发送方向的握手帧（对端拿到 enc 才能解我发的密文） */
  handshake(): Uint8Array {
    return encodeRelay({ to: this.peerId, from: this.selfId, encrypted: false, body: concat(new Uint8Array([2]), concat(this.sealer.enc, this.nonce)) });
  }

  get ready() {
    return !this.closed && this.opener !== null;
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters) waiter(new Error("加密连接已关闭"));
  }

  private async waitReady() {
    if (this.closed) throw new Error("加密连接已关闭");
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.waiters.delete(finish); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("等待对端加密握手超时")), 10_000);
      this.waiters.add(finish);
    });
  }

  sealFrame(frame: Uint8Array): Promise<Uint8Array> {
    const result = this.sends.then(async () => {
      await this.waitReady();
      if (this.closed) throw new Error("加密连接已关闭");
      const header = relayHeader({ to: this.peerId, from: this.selfId, encrypted: true });
      const ct = await this.sealer.seal(header, concat(this.peerNonce!, frame));
      return concat(header, ct);
    });
    this.sends = result.then(() => {}, () => {});
    return result;
  }

  /** 返回解密后的 Frame 字节；如果是对端的握手帧，建好 opener 并返回 null */
  async openRelay(bytes: Uint8Array): Promise<Uint8Array | null> {
    if (this.closed) throw new Error("加密连接已关闭");
    const env = decodeRelay(bytes);
    if (env.to !== this.selfId || env.from !== this.peerId) throw new Error(`信封路由不对：${env.from}→${env.to}，本链路是 ${this.peerId}→${this.selfId}`);
    if (!env.encrypted) {
      if (this.opener) throw new Error("对端重复握手（会话中途换 enc 不允许）");
      if (env.body.length !== 65 || env.body[0] !== 2) throw new Error("加密握手版本不匹配，请升级两端应用");
      this.opener = await OpenContext.create({ self: this.self, peerPublicKey: this.peerPublicKey, enc: env.body.subarray(1, 33), from: this.peerId, to: this.selfId });
      this.peerNonce = env.body.slice(33);
      for (const waiter of this.waiters) waiter();
      return null;
    }
    if (!this.opener) throw new Error("还没收到对端握手就来了密文");
    const header = bytes.subarray(0, bytes.byteLength - env.body.byteLength);
    const plaintext = await this.opener.open(header, env.body);
    if (plaintext.length < 32 || !this.nonce.every((byte, i) => plaintext[i] === byte)) throw new Error("旧连接密文或连接随机值不匹配");
    return plaintext.subarray(32);
  }
}

/** RelayEnvelope 的头部字节（= aad） */
export function relayHeader(e: Omit<RelayEnvelope, "body">): Uint8Array {
  return encodeRelay({ ...e, body: new Uint8Array(0) });
}

async function importPair(k: KemKeyPair) {
  if (k.publicKey.byteLength !== KEM_PUBLIC_KEY_BYTES || k.privateKey.byteLength !== 32) throw new RangeError("X25519 密钥应为 32 字节");
  return { publicKey: await suite.kem.deserializePublicKey(toBuf(k.publicKey)), privateKey: await suite.kem.deserializePrivateKey(toBuf(k.privateKey)) } as CryptoKeyPair;
}

function toBuf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export const hex = {
  to: (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join(""),
  from: (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))),
};
export const b64 = {
  to: (u: Uint8Array) => Buffer.from(u).toString("base64"),
  from: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};
