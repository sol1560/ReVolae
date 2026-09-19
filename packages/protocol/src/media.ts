/**
 * 实时画面（Frame kind=2）的 payload 格式，两个编码共用：
 *   [u8 flags][u32 pts BE, 毫秒][u16 width BE][u16 height BE][data]
 * flags bit0 = 关键帧（JPEG 永远是 1；H.264 IDR 为 1）
 *       bit1 = 带参数集（H.264 时 data 前面先放 Annex-B 的 SPS/PPS，再放 IDR；手机端拿它初始化解码器）
 * pts 是设备侧单调时钟的毫秒（从 media.subscribe 起算，32 位约 49 天够用），只用来排序 / 丢旧帧，不做音画同步。
 * width/height 是这帧的像素尺寸；分辨率变了手机端重建解码层。
 * H.264 的 data 是 Annex-B（00 00 00 01 起始码）码流，一帧一个 access unit；JPEG 的 data 就是整张 JPEG。
 *
 * 一条订阅一个 streamId（设备分配，由 media.info 回给手机），退订后 streamId 不复用。
 */

export const MEDIA_HEADER_BYTES = 9;

export interface MediaFrame {
  keyframe: boolean;
  /** H.264：data 前带 SPS/PPS */
  hasParameterSets: boolean;
  /** 毫秒，u32 回绕 */
  pts: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export function encodeMediaFrame(f: MediaFrame): Uint8Array {
  if (!Number.isInteger(f.pts) || f.pts < 0 || f.pts > 0xffff_ffff) throw new RangeError(`pts out of range: ${f.pts}`);
  for (const [k, v] of [["width", f.width], ["height", f.height]] as const) {
    if (!Number.isInteger(v) || v <= 0 || v > 0xffff) throw new RangeError(`${k} out of range: ${v}`);
  }
  const out = new Uint8Array(MEDIA_HEADER_BYTES + f.data.byteLength);
  const dv = new DataView(out.buffer);
  out[0] = (f.keyframe ? 1 : 0) | (f.hasParameterSets ? 2 : 0);
  dv.setUint32(1, f.pts, false);
  dv.setUint16(5, f.width, false);
  dv.setUint16(7, f.height, false);
  out.set(f.data, MEDIA_HEADER_BYTES);
  return out;
}

export function decodeMediaFrame(buf: Uint8Array): MediaFrame {
  if (buf.byteLength < MEDIA_HEADER_BYTES) throw new RangeError("media frame too short");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[0]!;
  if (flags & ~3) throw new RangeError(`unknown media flags ${flags}`);
  const width = dv.getUint16(5, false);
  const height = dv.getUint16(7, false);
  if (width === 0 || height === 0) throw new RangeError("zero size");
  return {
    keyframe: (flags & 1) === 1,
    hasParameterSets: (flags & 2) === 2,
    pts: dv.getUint32(1, false),
    width,
    height,
    data: buf.subarray(MEDIA_HEADER_BYTES),
  };
}

/** 手机端丢帧规则：只保留比上一帧新的（考虑 u32 回绕），非关键帧在没有关键帧之前全丢 */
export function mediaFrameIsNewer(pts: number, lastPts: number | undefined): boolean {
  if (lastPts === undefined) return true;
  const d = (pts - lastPts) >>> 0;
  return d !== 0 && d < 0x8000_0000;
}

/**
 * 局域网直连（Bonjour）：设备广播 `_cuaremote._tcp`，TXT 里放 deviceId 与协议版本；
 * 手机在同一网络且已配对时直接连设备的 WebSocket，链路上跑的还是 RelayEnvelope + HPKE，
 * 只是「hub」变成设备自己（信封 to/from 不变，密钥不变），所以 hub 掉线也能用，画面走直连不占中继带宽。
 */
export const LAN_SERVICE_TYPE = "_cuaremote._tcp";
export const LAN_TXT_KEYS = { deviceId: "id", protocolVersion: "v", name: "n" } as const;
export const LAN_PROTOCOL_VERSION = "1";

export interface LanAdvert {
  deviceId: string;
  name: string;
  port: number;
}

/** Bonjour TXT record 的键值（两端都按这个填 / 读） */
export function lanTxtRecord(a: Pick<LanAdvert, "deviceId" | "name">): Record<string, string> {
  return { [LAN_TXT_KEYS.deviceId]: a.deviceId, [LAN_TXT_KEYS.protocolVersion]: LAN_PROTOCOL_VERSION, [LAN_TXT_KEYS.name]: a.name };
}

/** 手机发现服务后判断能不能连：版本对得上且 deviceId 是配过对的 */
export function lanAdvertUsable(txt: Record<string, string>, pairedDeviceIds: ReadonlySet<string>): { ok: true; deviceId: string } | { ok: false; reason: "version" | "unpaired" | "missing" } {
  const id = txt[LAN_TXT_KEYS.deviceId];
  if (!id) return { ok: false, reason: "missing" };
  if (txt[LAN_TXT_KEYS.protocolVersion] !== LAN_PROTOCOL_VERSION) return { ok: false, reason: "version" };
  if (!pairedDeviceIds.has(id)) return { ok: false, reason: "unpaired" };
  return { ok: true, deviceId: id };
}
