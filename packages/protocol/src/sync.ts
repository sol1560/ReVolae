/**
 * 云同步密文块：把一段 JSON 用同步密钥（32 字节，AES-256-GCM）封成 SyncBlob，hub 只存不看。
 *
 * 密钥怎么来：手机第一次开同步时随机生成 {keyId, key}，通过端到端链路（sync.key 消息）发给每台配过对的设备；
 * 云端大脑和 hub 都拿不到。换手机时靠旧设备再发一次 sync.key，或用户在新手机上重新生成并把旧数据抹掉。
 *
 * AAD 绑定 kind / id / deviceId / ts：hub 或中间人改这些明文字段，解密直接失败。
 */
import { SyncBlob, type SyncKind } from "./common.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** 单块明文上限（加密前的 JSON 字节数） */
export const SYNC_BLOB_MAX_BYTES = 64 * 1024;

export interface SyncKeyMaterial {
  keyId: string;
  /** 32 字节 */
  key: Uint8Array;
}

export function generateSyncKey(): SyncKeyMaterial {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return { keyId: b64(crypto.getRandomValues(new Uint8Array(9))), key };
}

export function syncAad(b: Pick<SyncBlob, "kind" | "id" | "deviceId" | "ts">): ArrayBuffer {
  return ab(enc.encode(`${b.kind}|${b.id}|${b.deviceId}|${b.ts}`));
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.byteLength !== 32) throw new RangeError(`同步密钥要 32 字节，收到 ${key.byteLength}`);
  return crypto.subtle.importKey("raw", ab(key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealSync(k: SyncKeyMaterial, meta: { kind: SyncKind; id: string; deviceId: string; ts: number }, plain: unknown): Promise<SyncBlob> {
  const body = enc.encode(JSON.stringify(plain));
  if (body.byteLength > SYNC_BLOB_MAX_BYTES) throw new RangeError(`同步块太大：${body.byteLength} 字节，上限 ${SYNC_BLOB_MAX_BYTES}`);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: syncAad(meta) }, await importKey(k.key), ab(body));
  return { ...meta, keyId: k.keyId, alg: "aes-256-gcm", nonce: b64(nonce), ct: b64(new Uint8Array(ct)) };
}

/** 解不开（密钥不对、被改过、keyId 不匹配）一律抛错，调用方按「这块作废」处理 */
export async function openSync<T = unknown>(k: SyncKeyMaterial, blob: SyncBlob): Promise<T> {
  const b = SyncBlob.parse(blob);
  if (b.keyId !== k.keyId) throw new Error(`同步块用的是别的密钥（${b.keyId}），当前是 ${k.keyId}`);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(unb64(b.nonce)), additionalData: syncAad(b) }, await importKey(k.key), ab(unb64(b.ct)));
  } catch {
    throw new Error(`同步块 ${b.kind}/${b.id} 解密失败：密钥不对或内容被改过`);
  }
  return JSON.parse(dec.decode(plain)) as T;
}

/** 发 sync.key 用的 base64 形式 */
export function exportSyncKey(k: SyncKeyMaterial): { keyId: string; key: string } {
  return { keyId: k.keyId, key: b64(k.key) };
}

export function importSyncKey(k: { keyId: string; key: string }): SyncKeyMaterial {
  const key = unb64(k.key);
  if (key.byteLength !== 32) throw new RangeError("sync.key 里的 key 不是 32 字节");
  return { keyId: k.keyId, key };
}
