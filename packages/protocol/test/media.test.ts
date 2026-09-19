import { describe, expect, test } from "bun:test";
import { LAN_PROTOCOL_VERSION, MEDIA_HEADER_BYTES, decodeMediaFrame, encodeMediaFrame, lanAdvertUsable, lanTxtRecord, mediaFrameIsNewer } from "../src/media.js";

describe("媒体帧 payload", () => {
  test("头部字节布局固定：flags / pts BE / width BE / height BE，往返一致", () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x67, 0xaa]);
    const buf = encodeMediaFrame({ keyframe: true, hasParameterSets: true, pts: 0x01020304, width: 1440, height: 900, data });
    expect(Buffer.from(buf.subarray(0, MEDIA_HEADER_BYTES)).toString("hex")).toBe("03" + "01020304" + "05a0" + "0384");
    const f = decodeMediaFrame(buf);
    expect(f).toMatchObject({ keyframe: true, hasParameterSets: true, pts: 0x01020304, width: 1440, height: 900 });
    expect([...f.data]).toEqual([...data]);
  });

  test("非关键帧 flags=0；pts 允许到 u32 上限；越界与零尺寸拒绝", () => {
    const buf = encodeMediaFrame({ keyframe: false, hasParameterSets: false, pts: 0xffff_ffff, width: 1, height: 65535, data: new Uint8Array() });
    expect(buf[0]).toBe(0);
    expect(decodeMediaFrame(buf).pts).toBe(0xffff_ffff);
    expect(() => encodeMediaFrame({ keyframe: true, hasParameterSets: false, pts: 0x1_0000_0000, width: 1, height: 1, data: new Uint8Array() })).toThrow(RangeError);
    expect(() => encodeMediaFrame({ keyframe: true, hasParameterSets: false, pts: 0, width: 0, height: 1, data: new Uint8Array() })).toThrow(RangeError);
    expect(() => encodeMediaFrame({ keyframe: true, hasParameterSets: false, pts: 0, width: 65536, height: 1, data: new Uint8Array() })).toThrow(RangeError);
  });

  test("解码：太短、未知 flag 位、零尺寸都抛错；subarray 偏移不为 0 也能正确读", () => {
    expect(() => decodeMediaFrame(new Uint8Array(8))).toThrow("too short");
    const bad = encodeMediaFrame({ keyframe: true, hasParameterSets: false, pts: 1, width: 2, height: 2, data: new Uint8Array() });
    bad[0] = 0x05;
    expect(() => decodeMediaFrame(bad)).toThrow("flags");
    const zero = encodeMediaFrame({ keyframe: true, hasParameterSets: false, pts: 1, width: 2, height: 2, data: new Uint8Array() });
    zero[5] = 0; zero[6] = 0;
    expect(() => decodeMediaFrame(zero)).toThrow("zero size");
    const padded = new Uint8Array(3 + MEDIA_HEADER_BYTES + 2);
    padded.set(encodeMediaFrame({ keyframe: true, hasParameterSets: false, pts: 7, width: 3, height: 4, data: new Uint8Array([9, 8]) }), 3);
    const f = decodeMediaFrame(padded.subarray(3));
    expect(f).toMatchObject({ pts: 7, width: 3, height: 4 });
    expect([...f.data]).toEqual([9, 8]);
  });

  test("丢帧规则：更新的才要，相同丢，回绕后的小数字算更新，倒退的丢", () => {
    expect(mediaFrameIsNewer(5, undefined)).toBe(true);
    expect(mediaFrameIsNewer(6, 5)).toBe(true);
    expect(mediaFrameIsNewer(5, 5)).toBe(false);
    expect(mediaFrameIsNewer(4, 5)).toBe(false);
    expect(mediaFrameIsNewer(3, 0xffff_fffe)).toBe(true); // 回绕
    expect(mediaFrameIsNewer(0xffff_fffe, 3)).toBe(false);
  });
});

describe("Bonjour 直连 TXT", () => {
  test("TXT 三个键；版本不对 / 没配对 / 缺 id 都不能连", () => {
    const txt = lanTxtRecord({ deviceId: "mac-1", name: "Sol 的 Mac" });
    expect(txt).toEqual({ id: "mac-1", v: LAN_PROTOCOL_VERSION, n: "Sol 的 Mac" });
    const paired = new Set(["mac-1"]);
    expect(lanAdvertUsable(txt, paired)).toEqual({ ok: true, deviceId: "mac-1" });
    expect(lanAdvertUsable({ ...txt, v: "2" }, paired)).toEqual({ ok: false, reason: "version" });
    expect(lanAdvertUsable(txt, new Set())).toEqual({ ok: false, reason: "unpaired" });
    expect(lanAdvertUsable({ v: "1" }, paired)).toEqual({ ok: false, reason: "missing" });
  });
});
