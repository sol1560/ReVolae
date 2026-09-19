/**
 * 配对与 hub 登录用的几个 canonical 串（TS / Swift / Kotlin 三端都要一模一样）。
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** hub 登录挑战应答：端用自己的签名私钥对这串 UTF-8 签名 */
export function hubAuthPayload(deviceId: string, nonce: string): string {
  return ["cuaremote-hub-auth-v1", deviceId, nonce].join("\n");
}

/** 配对请求的 HMAC：HMAC-SHA256(secret, deviceKem || phoneKem)，入参都是 base64，输出 base64 */
export function pairHmac(secretB64: string, deviceKemB64: string, phoneKemB64: string): string {
  const key = Buffer.from(secretB64, "base64");
  const msg = Buffer.concat([Buffer.from(deviceKemB64, "base64"), Buffer.from(phoneKemB64, "base64")]);
  return Buffer.from(hmac(sha256, key, msg)).toString("base64");
}

export function pairHmacEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "base64");
  const y = Buffer.from(b, "base64");
  if (x.byteLength !== y.byteLength || x.byteLength === 0) return false;
  let d = 0;
  for (let i = 0; i < x.byteLength; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}
