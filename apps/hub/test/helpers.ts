import {
  AnyMessage,
  generateKemKeyPair,
  generateSigningKeyPair,
  hubAuthPayload,
  mkMsg,
  pairHmac,
  pairHmacEquals,
  signPayload,
  type HubMessage,
  type MsgBody,
  type PublicKeys,
  type SigAlg,
} from "@cuaremote/protocol";

export const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

/** 测试用端：一个 WebSocket + 密钥 + 消息收件箱 */
export class Endpoint {
  ws!: WebSocket;
  inbox: (HubMessage | { bin: Uint8Array })[] = [];
  waiters: { pred: (m: HubMessage | { bin: Uint8Array }) => boolean; resolve: (m: any) => void }[] = [];
  sessionToken = "";
  closed = false;
  closeCode = 0;

  constructor(
    readonly id: string,
    readonly role: "device" | "phone" | "brain",
    readonly kem: Awaited<ReturnType<typeof generateKemKeyPair>>,
    readonly sig: { publicKey: Uint8Array; privateKey: Uint8Array },
    readonly alg: SigAlg,
  ) {}

  static async make(id: string, role: "device" | "phone" | "brain", alg: SigAlg = "ES256") {
    return new Endpoint(id, role, await generateKemKeyPair(), generateSigningKeyPair(alg), alg);
  }

  get pubKeys(): PublicKeys {
    return { kem: b64(this.kem.publicKey), sig: b64(this.sig.publicKey), sigAlg: this.alg };
  }

  connect(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => {
      const m = typeof ev.data === "string" ? (AnyMessage.parse(JSON.parse(ev.data)) as HubMessage) : { bin: new Uint8Array(ev.data as ArrayBuffer) };
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    };
    this.ws.onclose = (ev) => {
      this.closed = true;
      this.closeCode = ev.code;
    };
    return new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("ws error"));
    });
  }

  send(body: MsgBody) {
    this.ws.send(JSON.stringify(mkMsg(body)));
  }

  sendBin(b: Uint8Array) {
    this.ws.send(b);
  }

  expect<T extends HubMessage["type"]>(type: T, extra?: (m: Extract<HubMessage, { type: T }>) => boolean, timeoutMs = 3000): Promise<Extract<HubMessage, { type: T }>> {
    return this.wait((m) => !("bin" in m) && m.type === type && (extra ? extra(m as any) : true), timeoutMs) as any;
  }

  expectBin(timeoutMs = 3000): Promise<Uint8Array> {
    return this.wait((m) => "bin" in m, timeoutMs).then((m) => (m as { bin: Uint8Array }).bin);
  }

  private wait(pred: (m: HubMessage | { bin: Uint8Array }) => boolean, timeoutMs: number) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise<HubMessage | { bin: Uint8Array }>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== ok);
        reject(new Error(`等消息超时；收件箱里有 ${JSON.stringify(this.inbox.map((m) => ("bin" in m ? "bin" : m.type === "error" ? `error:${m.code}:${m.message}` : m.type)))}`));
      }, timeoutMs);
      const ok = (m: any) => {
        clearTimeout(t);
        resolve(m);
      };
      this.waiters.push({ pred, resolve: ok });
    });
  }

  async login(url: string, o: { token?: string; platform?: string; name?: string; badSig?: boolean } = {}) {
    await this.connect(url);
    this.send({ type: "hello", role: this.role, deviceId: this.id, platform: (o.platform ?? (this.role === "phone" ? "ios" : "macos")) as any, name: o.name ?? this.id, pubKeys: this.pubKeys, protocolVersion: 1, ...(o.token ? { token: o.token } : {}) });
    const ch = await this.expect("auth.challenge");
    const payload = new TextEncoder().encode(hubAuthPayload(this.id, o.badSig ? "nope" : ch.nonce));
    this.send({ type: "auth.response", nonce: ch.nonce, signature: signPayload(payload, this.sig.privateKey, this.alg) });
    const ok = await this.expect("auth.ok");
    this.sessionToken = ok.sessionToken;
    return ok;
  }

  close() {
    this.ws.close();
  }
}

/** 走完整配对：手机 pair.request（HMAC）→ 设备验 HMAC → pair.confirm */
export async function pair(phone: Endpoint, device: Endpoint, secretB64: string) {
  phone.send({ type: "pair.request", deviceId: device.id, phoneId: phone.id, phoneName: "iPhone", phonePubKeys: phone.pubKeys, hmac: pairHmac(secretB64, device.pubKeys.kem, phone.pubKeys.kem) });
  const req = await device.expect("pair.request");
  const expected = pairHmac(secretB64, device.pubKeys.kem, req.phonePubKeys.kem);
  const accept = pairHmacEquals(req.hmac, expected);
  device.send({ type: "pair.confirm", deviceId: device.id, phoneId: req.phoneId, accept });
  const [rp, rd] = await Promise.all([phone.expect("pair.result"), device.expect("pair.result")]);
  return { accept, rp, rd };
}

