/**
 * 端到端帧（解密后的明文，或加密前的明文）：
 *   [u8 kind][u32 streamId BE][payload]
 * kind: 0 控制 JSON（UTF-8） / 1 PTY 字节 / 2 媒体帧（JPEG 或 H.264 NAL）
 *
 * 经 hub 中继时外面再套一层路由信封（hub 只读信封，不读帧）：
 *   [u8 version=1][u8 toLen][to utf8][u8 fromLen][from utf8][u8 flags][sealed frame]
 * flags bit0 = payload 已端到端加密。
 */

export const FrameKind = { control: 0, pty: 1, media: 2 } as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  kind: FrameKind;
  streamId: number;
  payload: Uint8Array;
}

export const FRAME_HEADER_BYTES = 5;
export const MAX_STREAM_ID = 0xffff_ffff;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(f: Frame): Uint8Array {
  if (!Number.isInteger(f.streamId) || f.streamId < 0 || f.streamId > MAX_STREAM_ID) {
    throw new RangeError(`streamId out of range: ${f.streamId}`);
  }
  if (f.kind !== 0 && f.kind !== 1 && f.kind !== 2) throw new RangeError(`bad kind ${f.kind}`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + f.payload.byteLength);
  out[0] = f.kind;
  new DataView(out.buffer).setUint32(1, f.streamId, false);
  out.set(f.payload, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.byteLength < FRAME_HEADER_BYTES) throw new RangeError("frame too short");
  const kind = buf[0]!;
  if (kind !== 0 && kind !== 1 && kind !== 2) throw new RangeError(`bad kind ${kind}`);
  const streamId = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
  return { kind, streamId, payload: buf.subarray(FRAME_HEADER_BYTES) };
}

export function controlFrame(message: unknown, streamId = 0): Uint8Array {
  return encodeFrame({ kind: 0, streamId, payload: enc.encode(JSON.stringify(message)) });
}

export function parseControl(frame: Frame): unknown {
  if (frame.kind !== 0) throw new TypeError("not a control frame");
  return JSON.parse(dec.decode(frame.payload));
}

export interface RelayEnvelope {
  to: string;
  from: string;
  encrypted: boolean;
  body: Uint8Array;
}

export const RELAY_VERSION = 1;

export function encodeRelay(e: RelayEnvelope): Uint8Array {
  const to = enc.encode(e.to);
  const from = enc.encode(e.from);
  if (to.byteLength > 255 || from.byteLength > 255) throw new RangeError("device id too long");
  const out = new Uint8Array(1 + 1 + to.byteLength + 1 + from.byteLength + 1 + e.body.byteLength);
  let o = 0;
  out[o++] = RELAY_VERSION;
  out[o++] = to.byteLength;
  out.set(to, o);
  o += to.byteLength;
  out[o++] = from.byteLength;
  out.set(from, o);
  o += from.byteLength;
  out[o++] = e.encrypted ? 1 : 0;
  out.set(e.body, o);
  return out;
}

export function decodeRelay(buf: Uint8Array): RelayEnvelope {
  if (buf.byteLength < 4) throw new RangeError("relay too short");
  let o = 0;
  const v = buf[o++]!;
  if (v !== RELAY_VERSION) throw new RangeError(`bad relay version ${v}`);
  const toLen = buf[o++]!;
  const to = dec.decode(buf.subarray(o, o + toLen));
  o += toLen;
  const fromLen = buf[o++]!;
  const from = dec.decode(buf.subarray(o, o + fromLen));
  o += fromLen;
  const flags = buf[o++]!;
  return { to, from, encrypted: (flags & 1) === 1, body: buf.subarray(o) };
}

/**
 * 审批签名的 canonical 串。手机对它签名，daemon 验签。
 * 顺序固定、字段用 \n 分隔，避免 JSON 序列化差异。
 */
export function approvalChallenge(p: {
  runId: string;
  stepId: string;
  actionDetail: string;
  nonce: string;
  expiresAt: number;
}): string {
  return ["cuaremote-approval-v1", p.runId, p.stepId, sha256Hex(p.actionDetail), p.nonce, String(p.expiresAt)].join("\n");
}

/**
 * 开终端（L2）的 challenge：没有 run/step，手机自己选 nonce 和 expiresAt，设备按同样规则重建后验签。
 * 签名内容仍是 approvalSignedPayload(challenge, true)，手机端和审批共用一套 Face ID 签名流程。
 */
export function terminalOpenChallenge(p: { sessionId: string; deviceId: string; nonce: string; expiresAt: number }): string {
  // deviceId 进 actionDetail：同一个签名不能拿到另一台配过对的设备上开终端
  return approvalChallenge({ runId: "terminal", stepId: p.sessionId, actionDetail: `terminal.open\n${p.deviceId}`, nonce: p.nonce, expiresAt: p.expiresAt });
}

/** terminal.open.sessionId 的合法形式：短、只含 URL 安全字符（会进环境变量、日志和每条 terminal.block） */
export const TERMINAL_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function approvalSignedPayload(challenge: string, allow: boolean): string {
  return `${challenge}\n${allow ? "allow" : "deny"}`;
}

function sha256Hex(s: string): string {
  // Bun / Node 都有 crypto.subtle，但这里要同步：用 Bun.CryptoHasher 或 node:crypto
  // 为了在浏览器也能用，退化为同步纯 JS 不现实；这里假定运行在 Bun/Node。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(s, "utf8").digest("hex");
}
