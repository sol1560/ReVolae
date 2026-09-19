/**
 * 手机审批签名的验签（宿主侧）。规则照 docs/protocol.md「审批签名」：
 *   1. expiresAt 未过期，且 ≤ 请求时的 expiresAt
 *   2. nonce 没用过（保留最近 1000 个）
 *   3. 用配对时存的手机签名公钥验签
 *   4. challenge 与自己发出的一致（按 runId+stepId 缓存）
 *
 * 手机端：Secure Enclave P-256（ES256，sig = raw r||s 64 字节，公钥 = x963 65 字节或 raw 64 字节）
 * 或 Ed25519（Android 可用）。这里两种都收。
 */
import { p256 } from "@noble/curves/nist.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { ApprovalSignature, PublicKeys } from "./common.js";

export type SigAlg = PublicKeys["sigAlg"];
import { approvalSignedPayload, terminalOpenChallenge } from "./frame.js";

const utf8 = new TextEncoder();

export type ApprovalVerifyFailure = "expired" | "expires_after_request" | "nonce_reused" | "unknown_step" | "challenge_mismatch" | "bad_signature" | "unsupported_alg" | "bad_key";
export type ApprovalVerifyResult = { ok: true } | { ok: false; reason: ApprovalVerifyFailure; message: string };

export interface PendingApprovalRecord {
  runId: string;
  stepId: string;
  challenge: string;
  expiresAt: number;
}

export interface ApprovalVerifierOptions {
  /** 手机的签名公钥（配对时存的） */
  phoneKeys: Pick<PublicKeys, "sig" | "sigAlg">;
  nonceHistory?: number;
  now?: () => number;
}

/** 有状态：记着自己发过哪些 challenge、用过哪些 nonce */
export class ApprovalVerifier {
  private readonly pending = new Map<string, PendingApprovalRecord>();
  private readonly nonces: string[] = [];
  private readonly nonceSet = new Set<string>();
  private readonly limit: number;
  private readonly now: () => number;

  constructor(private readonly o: ApprovalVerifierOptions) {
    this.limit = o.nonceHistory ?? 1000;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** 宿主转发 step.approval_required 给手机时调用 */
  remember(rec: PendingApprovalRecord) {
    this.pending.set(`${rec.runId}/${rec.stepId}`, rec);
  }
  forget(runId: string, stepId: string) {
    this.pending.delete(`${runId}/${stepId}`);
  }

  verify(decision: { runId: string; stepId: string; allow: boolean; signature?: ApprovalSignature }): ApprovalVerifyResult {
    const sig = decision.signature;
    if (!sig) return { ok: false, reason: "bad_signature", message: "缺少签名" };
    const rec = this.pending.get(`${decision.runId}/${decision.stepId}`);
    if (!rec) return { ok: false, reason: "unknown_step", message: "这一步没有等待中的确认" };
    const now = this.now();
    if (sig.expiresAt <= now) return { ok: false, reason: "expired", message: "签名已过期" };
    if (sig.expiresAt > rec.expiresAt) return { ok: false, reason: "expires_after_request", message: "签名有效期不能晚于请求的有效期" };
    if (this.nonceSet.has(sig.nonce)) return { ok: false, reason: "nonce_reused", message: "nonce 重复（疑似重放）" };
    // challenge 里带了 nonce 和 expiresAt；手机回的 nonce 必须就是 challenge 里的那个
    const parts = rec.challenge.split("\n");
    if (parts[4] !== sig.nonce || parts[5] !== String(sig.expiresAt)) return { ok: false, reason: "challenge_mismatch", message: "nonce / expiresAt 与发出的 challenge 不一致" };

    const r = verifyApprovalSignature({ challenge: rec.challenge, allow: decision.allow, signature: sig, phoneKeys: this.o.phoneKeys });
    if (!r.ok) return r;
    this.nonceSet.add(sig.nonce);
    this.nonces.push(sig.nonce);
    if (this.nonces.length > this.limit) this.nonceSet.delete(this.nonces.shift()!);
    this.pending.delete(`${decision.runId}/${decision.stepId}`);
    return { ok: true };
  }
}

/**
 * 验 terminal.open 的签名：expiresAt 必须在 (now, now+maxTtlSec]，nonce 不能用过（seen 由调用方保管），签名对 terminalOpenChallenge 成立。
 * 通过后调用方要把 nonce 记进 seen。
 */
export function verifyTerminalOpen(p: {
  sessionId: string;
  signature?: ApprovalSignature;
  phoneKeys: Pick<PublicKeys, "sig" | "sigAlg">;
  seenNonce: (nonce: string) => boolean;
  now?: number;
  maxTtlSec?: number;
}): ApprovalVerifyResult {
  const sig = p.signature;
  if (!sig) return { ok: false, reason: "bad_signature", message: "开终端需要签名确认" };
  const now = p.now ?? Math.floor(Date.now() / 1000);
  if (sig.expiresAt <= now) return { ok: false, reason: "expired", message: "签名已过期" };
  if (sig.expiresAt > now + (p.maxTtlSec ?? 300)) return { ok: false, reason: "expires_after_request", message: "签名有效期太长" };
  if (p.seenNonce(sig.nonce)) return { ok: false, reason: "nonce_reused", message: "nonce 重复（疑似重放）" };
  const challenge = terminalOpenChallenge({ sessionId: p.sessionId, nonce: sig.nonce, expiresAt: sig.expiresAt });
  return verifySignedPayload({ payload: utf8.encode(approvalSignedPayload(challenge, true)), alg: sig.alg, sig: sig.sig, publicKey: p.phoneKeys });
}

/** 手机侧：给 terminal.open 签名 */
export function signTerminalOpen(p: { sessionId: string; privateKey: Uint8Array; alg: SigAlg; keyId: string; nonce: string; expiresAt: number }): ApprovalSignature {
  const challenge = terminalOpenChallenge({ sessionId: p.sessionId, nonce: p.nonce, expiresAt: p.expiresAt });
  return { alg: p.alg, keyId: p.keyId, sig: signPayload(utf8.encode(approvalSignedPayload(challenge, true)), p.privateKey, p.alg), expiresAt: p.expiresAt, nonce: p.nonce };
}

/** 无状态：只验签名本身（规则 3） */
export function verifyApprovalSignature(p: { challenge: string; allow: boolean; signature: ApprovalSignature; phoneKeys: Pick<PublicKeys, "sig" | "sigAlg"> }): ApprovalVerifyResult {
  return verifySignedPayload({ payload: utf8.encode(approvalSignedPayload(p.challenge, p.allow)), alg: p.signature.alg, sig: p.signature.sig, publicKey: p.phoneKeys });
}

/**
 * 通用验签：审批签名、hub 登录挑战应答都走这里。
 * sig / publicKey.sig 都是 base64。ES256 公钥收 x963/raw/压缩，签名收 raw r||s 或 DER。
 */
export function verifySignedPayload(p: { payload: Uint8Array; alg: SigAlg; sig: string; publicKey: Pick<PublicKeys, "sig" | "sigAlg"> }): ApprovalVerifyResult {
  const pub = fromB64(p.publicKey.sig);
  const sigBytes = fromB64(p.sig);
  try {
    if (p.publicKey.sigAlg === "ES256" && p.alg === "ES256") {
      const pubKey = normalizeP256Public(pub);
      if (!pubKey) return { ok: false, reason: "bad_key", message: `P-256 公钥长度不对：${pub.byteLength}` };
      const sig = normalizeP256Signature(sigBytes);
      if (!sig) return { ok: false, reason: "bad_signature", message: `签名格式不对（长度 ${sigBytes.byteLength}）` };
      const ok = p256.verify(sig, sha256(p.payload), pubKey, { prehash: false, lowS: false });
      return ok ? { ok: true } : { ok: false, reason: "bad_signature", message: "ES256 验签失败" };
    }
    if (p.publicKey.sigAlg === "Ed25519" && p.alg === "Ed25519") {
      if (pub.byteLength !== 32) return { ok: false, reason: "bad_key", message: "Ed25519 公钥应为 32 字节" };
      if (sigBytes.byteLength !== 64) return { ok: false, reason: "bad_signature", message: "Ed25519 签名应为 64 字节" };
      return ed25519.verify(sigBytes, p.payload, pub) ? { ok: true } : { ok: false, reason: "bad_signature", message: "Ed25519 验签失败" };
    }
    return { ok: false, reason: "unsupported_alg", message: `不支持的算法组合 ${p.publicKey.sigAlg}/${p.alg}` };
  } catch (e) {
    return { ok: false, reason: "bad_signature", message: e instanceof Error ? e.message : String(e) };
  }
}

/** 软件密钥签名（测试 / 无 Secure Enclave 平台）。返回 base64 raw 签名。 */
export function signPayload(payload: Uint8Array, privateKey: Uint8Array, alg: SigAlg): string {
  const raw = alg === "ES256" ? p256.sign(sha256(payload), privateKey, { prehash: false, lowS: true }) : ed25519.sign(payload, privateKey);
  return Buffer.from(raw).toString("base64");
}

/** 测试 / 非 Secure Enclave 平台用：软件密钥签名 */
export function signApproval(p: { challenge: string; allow: boolean; privateKey: Uint8Array; alg: SigAlg; keyId: string; nonce: string; expiresAt: number }): ApprovalSignature {
  return { alg: p.alg, keyId: p.keyId, sig: signPayload(utf8.encode(approvalSignedPayload(p.challenge, p.allow)), p.privateKey, p.alg), expiresAt: p.expiresAt, nonce: p.nonce };
}

export function generateSigningKeyPair(alg: SigAlg): { publicKey: Uint8Array; privateKey: Uint8Array } {
  if (alg === "ES256") {
    const priv = p256.utils.randomSecretKey();
    return { privateKey: priv, publicKey: p256.getPublicKey(priv, false) }; // x963 65 字节，和 CryptoKit x963Representation 一致
  }
  const priv = ed25519.utils.randomSecretKey();
  return { privateKey: priv, publicKey: ed25519.getPublicKey(priv) };
}

/** 65 字节 x963（04||x||y）/ 64 字节 raw（x||y，CryptoKit rawRepresentation）/ 33 字节压缩 都接受 */
function normalizeP256Public(pub: Uint8Array): Uint8Array | null {
  if (pub.byteLength === 65 && pub[0] === 4) return pub;
  if (pub.byteLength === 64) { const out = new Uint8Array(65); out[0] = 4; out.set(pub, 1); return out; }
  if (pub.byteLength === 33 && (pub[0] === 2 || pub[0] === 3)) return pub;
  return null;
}

/** 64 字节 raw r||s（CryptoKit rawRepresentation）或 DER（derRepresentation）→ 64 字节 raw */
function normalizeP256Signature(sig: Uint8Array): Uint8Array | null {
  if (sig.byteLength === 64) return sig;
  if (sig[0] === 0x30) {
    try {
      return p256.Signature.fromBytes(sig, "der").toBytes("compact");
    } catch {
      return null;
    }
  }
  return null;
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
