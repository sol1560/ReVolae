import { AnyMessage, E2ELink, controlFrame, decodeFrame, decodeRelay, encodeFrame, mkMsg, parseControl, type Frame, type MsgBody } from "@cuaremote/protocol";
import type { Endpoint } from "./helpers.js";

/** 手机 ↔ 云端大脑的加密链路：控制消息进 inbox，终端字节（kind 1）进 pty */
export class PhoneLink {
  link!: E2ELink;
  inbox: AnyMessage[] = [];
  pty: Frame[] = [];
  private waiters: { pred: (m: AnyMessage) => boolean; resolve: (m: AnyMessage) => void }[] = [];
  private stopped = false;

  constructor(
    readonly ep: Endpoint,
    readonly brainId: string,
  ) {}

  async open() {
    const keys = await this.ep.expect("peer.keys", (m) => m.deviceId === this.brainId);
    this.link = await E2ELink.create({ selfId: this.ep.id, self: this.ep.kem, peerId: this.brainId, peerPublicKey: new Uint8Array(Buffer.from(keys.pubKeys.kem, "base64")) });
    this.ep.sendBin(this.link.handshake());
    void this.run();
    return this;
  }

  private async run() {
    for (;;) {
      const bin = await this.ep.expectBin(5_000).catch(() => null);
      if (this.stopped) return;
      if (!bin) continue;
      if (decodeRelay(bin).from !== this.brainId) continue;
      const frame = await this.link.openRelay(bin);
      if (!frame) continue;
      const f = decodeFrame(frame);
      if (f.kind === 1) {
        this.pty.push(f);
        continue;
      }
      const m = AnyMessage.parse(parseControl(f));
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    }
  }

  stop() {
    this.stopped = true;
  }

  async send(body: MsgBody) {
    this.ep.sendBin(await this.link.sealFrame(controlFrame(mkMsg(body), 0)));
  }

  async sendFrame(f: Frame) {
    this.ep.sendBin(await this.link.sealFrame(encodeFrame(f)));
  }

  expect<T extends AnyMessage["type"]>(type: T, extra?: (m: Extract<AnyMessage, { type: T }>) => boolean, timeoutMs = 8000): Promise<Extract<AnyMessage, { type: T }>> {
    const pred = (m: AnyMessage): m is Extract<AnyMessage, { type: T }> => m.type === type && (extra ? extra(m as Extract<AnyMessage, { type: T }>) : true);
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as Extract<AnyMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等 ${type} 超时；收件箱 ${JSON.stringify(this.inbox.map((m) => m.type))}`)), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m as Extract<AnyMessage, { type: T }>)) });
    });
  }
}

