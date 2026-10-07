import { encodeFrame, encodeMediaFrame, z, type MsgBody } from "@cuaremote/protocol";
import { nativeHelper } from "./host/native-helper.js";

const Capture = z.object({ width: z.number().int().positive().max(65535), height: z.number().int().positive().max(65535), jpeg: z.string().min(1) });

/** 低频屏幕预览。只在订阅期间采集，停止会中止当前采集，旧回调不能发出新帧。 */
export class DeviceMedia {
  private readonly subscriptions = new Map<string, AbortController>();
  private nextStream = 1;
  constructor(private readonly send: (phone: string, message: MsgBody) => Promise<void>,
    private readonly sendFrame: (phone: string, bytes: Uint8Array) => Promise<void>,
    private readonly capture = (width: number, signal: AbortSignal) => nativeHelper(["capture", String(width)], Capture, 10_000, signal)) {}

  subscribe(phone: string, request: { id: string; codec: "jpeg" | "h264"; fps: number; maxWidth: number }) {
    if (request.codec !== "jpeg") throw new Error("此设备目前只支持 JPEG 预览，H.264 尚未接通");
    this.stop(phone);
    const ctrl = new AbortController();
    this.subscriptions.set(phone, ctrl);
    const streamId = this.nextStream++;
    const fps = Math.min(1, request.fps);
    const start = performance.now();
    void (async () => {
      let size = "";
      try {
        while (!ctrl.signal.aborted) {
          const tick = performance.now();
          const frame = await this.capture(Math.min(1920, request.maxWidth), ctrl.signal);
          if (ctrl.signal.aborted) break;
          const nextSize = `${frame.width}x${frame.height}`;
          if (size !== nextSize) {
            await this.send(phone, { type: "media.info", streamId, codec: "jpeg", fps, width: frame.width, height: frame.height });
            size = nextSize;
          }
          if (ctrl.signal.aborted) break;
          await this.sendFrame(phone, encodeFrame({ kind: 2, streamId, payload: encodeMediaFrame({
            keyframe: true, hasParameterSets: false, pts: Math.floor(performance.now() - start) >>> 0,
            width: frame.width, height: frame.height, data: Buffer.from(frame.jpeg, "base64"),
          }) }));
          await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(timer); ctrl.signal.removeEventListener("abort", finish); resolve(); };
            const timer = setTimeout(finish, Math.max(0, 1000 / fps - (performance.now() - tick)));
            ctrl.signal.addEventListener("abort", finish, { once: true });
            if (ctrl.signal.aborted) finish();
          });
        }
      } catch (e) {
        if (!ctrl.signal.aborted) await this.send(phone, { type: "error", code: "media_capture", message: e instanceof Error ? e.message : String(e), ref: request.id }).catch(() => {});
      } finally {
        if (this.subscriptions.get(phone) === ctrl) this.subscriptions.delete(phone);
      }
    })();
  }
  stop(phone: string) { this.subscriptions.get(phone)?.abort(); this.subscriptions.delete(phone); }
  close() { for (const phone of this.subscriptions.keys()) this.stop(phone); }
}
