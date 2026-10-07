import { expect, test } from "bun:test";
import { decodeFrame, decodeMediaFrame, type MsgBody } from "@cuaremote/protocol";
import { DeviceMedia } from "../src/device-media.js";

test("替换订阅与停止：丢弃旧采集结果，停止后不再发送；设备错误有明确回执", async () => {
  const messages: MsgBody[] = [];
  const frames: Uint8Array[] = [];
  const captures: { width: number; signal: AbortSignal; resolve: (image: { width: number; height: number; jpeg: string }) => void; reject: (error: Error) => void }[] = [];
  const media = new DeviceMedia(async (_phone, msg) => { messages.push(msg); }, async (_phone, bytes) => { frames.push(bytes); },
    (width, signal) => new Promise((resolve, reject) => captures.push({ width, signal, resolve, reject })));
  const request = { id: "old", codec: "jpeg" as const, fps: 30, maxWidth: 9000 };
  const image = { width: 120, height: 80, jpeg: Buffer.from([255, 216, 1, 2, 255, 217]).toString("base64") };
  try {
    media.subscribe("phone", request);
    media.subscribe("phone", { ...request, id: "new" });
    expect(captures[0]!.signal.aborted).toBe(true);
    expect(captures[1]!.width).toBe(1920);
    captures[0]!.resolve(image);
    await Bun.sleep(10);
    expect(messages).toHaveLength(0);
    captures[1]!.resolve(image);
    await Bun.sleep(10);
    expect(messages).toEqual([{ type: "media.info", streamId: 2, codec: "jpeg", fps: 1, width: 120, height: 80 }]);
    expect(frames).toHaveLength(1);
    const frame = decodeFrame(frames[0]!);
    expect(frame.kind).toBe(2);
    expect(frame.streamId).toBe(2);
    expect([...decodeMediaFrame(frame.payload).data]).toEqual([255, 216, 1, 2, 255, 217]);
    media.stop("phone");
    expect(captures[1]!.signal.aborted).toBe(true);
    await Bun.sleep(1050);
    expect(captures).toHaveLength(2);
    expect(frames).toHaveLength(1);

    media.subscribe("phone", { ...request, id: "denied" });
    captures[2]!.reject(new Error("缺少录屏权限"));
    await Bun.sleep(10);
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "media_capture", ref: "denied", message: "缺少录屏权限" });
    expect(() => media.subscribe("phone", { ...request, codec: "h264" })).toThrow("H.264");
  } finally { media.close(); }
});
