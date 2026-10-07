/**
 * base64 / 拼接：纯 JS，不依赖 Node 的 Buffer，手机端（Hermes）也能用。
 */
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REV = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHA.length; i++) REV[ALPHA.charCodeAt(i)] = i;
REV["-".charCodeAt(0)] = 62; // 顺带接受 base64url
REV["_".charCodeAt(0)] = 63;

export function toBase64(u: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < u.length; i += 3) {
    const n = (u[i]! << 16) | (u[i + 1]! << 8) | u[i + 2]!;
    out += ALPHA[n >> 18]! + ALPHA[(n >> 12) & 63]! + ALPHA[(n >> 6) & 63]! + ALPHA[n & 63]!;
  }
  if (i < u.length) {
    const n = (u[i]! << 16) | ((u[i + 1] ?? 0) << 8);
    out += ALPHA[n >> 18]! + ALPHA[(n >> 12) & 63]! + (i + 1 < u.length ? ALPHA[(n >> 6) & 63]! : "=") + "=";
  }
  return out;
}

/** 忽略空白和末尾的 =；遇到非法字符抛错（和 Buffer 静默跳过不同，更早暴露坏数据） */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? REV[c]! : -1;
    if (v < 0) throw new Error(`base64 里有非法字符：${clean[i]}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
