/**
 * 手机账号 JWT（HS256，`sub` = 账号 id）和 hub 会话 token。
 * 不设 HUB_JWT_SECRET 时 hub 跑「单机模式」：不校验 JWT，所有端都归 account "local"。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64url = {
  enc: (b: Uint8Array | string) => Buffer.from(b).toString("base64url"),
  dec: (s: string) => Buffer.from(s, "base64url"),
};

export interface JwtClaims {
  sub: string;
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const head = b64url.enc(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url.enc(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64url.enc(sig)}`;
}

export type JwtResult = { ok: true; claims: JwtClaims } | { ok: false; reason: "malformed" | "bad_alg" | "bad_signature" | "expired" | "no_sub" };

export function verifyJwt(token: string, secret: string, nowSec: number): JwtResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(b64url.dec(head).toString("utf8"));
    claims = JSON.parse(b64url.dec(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "bad_alg" };
  const expect = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const got = b64url.dec(sig);
  if (got.byteLength !== expect.byteLength || !timingSafeEqual(got, expect)) return { ok: false, reason: "bad_signature" };
  if (typeof claims.exp === "number" && claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "no_sub" };
  return { ok: true, claims };
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newPairCode(): string {
  // 6 位数字，首位可为 0
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, "0");
}
