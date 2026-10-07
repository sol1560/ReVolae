import {
  AnyMessage,
  E2ELink,
  b64,
  controlFrame,
  decodeFrame,
  decodeRelay,
  encodeFrame,
  generateKemKeyPair,
  generateSigningKeyPair,
  hubAuthPayload,
  mkMsg,
  parseControl,
  signApproval,
  signPayload,
  signTerminalOpen,
  type KemKeyPair,
  type MsgBody,
  type PublicKeys,
} from "@cuaremote/protocol";

/** 手机的长期身份：一把 X25519（端到端加密）+ 一把 Ed25519（登录、审批签名）。存进钥匙串 / SecureStore */
export interface Identity {
  deviceId: string;
  kem: KemKeyPair;
  sig: { publicKey: Uint8Array; privateKey: Uint8Array };
}

export async function newIdentity(): Promise<Identity> {
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const deviceId = `phone-${Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return { deviceId, kem: await generateKemKeyPair(), sig: generateSigningKeyPair("Ed25519") };
}

export function serializeIdentity(i: Identity): string {
  return JSON.stringify({ v: 1, deviceId: i.deviceId, kem: [b64.to(i.kem.publicKey), b64.to(i.kem.privateKey)], sig: [b64.to(i.sig.publicKey), b64.to(i.sig.privateKey)] });
}

export function parseIdentity(s: string): Identity {
  const o = JSON.parse(s) as { v: number; deviceId: string; kem: [string, string]; sig: [string, string] };
  if (o.v !== 1) throw new Error("身份格式版本不对");
  return { deviceId: o.deviceId, kem: { publicKey: b64.from(o.kem[0]), privateKey: b64.from(o.kem[1]) }, sig: { publicKey: b64.from(o.sig[0]), privateKey: b64.from(o.sig[1]) } };
}

export type ConnState = "connecting" | "online" | "offline";
type Msg = AnyMessage;
type StepApproval = Extract<Msg, { type: "step.approval_required" }>;

export type ClientEvent =
  | { kind: "state"; state: ConnState; accountId?: string; error?: string }
  /** 来自云端大脑（已解密）或 hub 的消息 */
  | { kind: "message"; message: Msg; from: "brain" | "hub" };

export interface ClientOptions {
  /** hub 的 wss 地址，例如 wss://hub.example.com/ws */
  url: string;
  identity: Identity;
  name: string;
  platform?: "ios" | "android";
  WebSocket?: typeof WebSocket;
  fetch?: typeof fetch;
  now?: () => number;
  /** 断线后自动重连（默认开） */
  reconnect?: boolean;
  log?: (line: string) => void;
}

export interface TerminalHandle {
  readonly sessionId: string;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /** 收到终端输出（已自动回 ack） */
  onData(cb: (bytes: Uint8Array) => void): () => void;
  onExit(cb: (code?: number) => void): () => void;
}

/**
 * 手机端和 hub / 云端大脑说话的全部逻辑，不依赖任何 UI 框架：
 * 登录（签挑战）→ 等 hub 推来云端大脑的公钥 → 建端到端加密链路 → 收发消息、终端字节、审批签名。
 * 掉线自动重连，重连后链路重新握手。
 */
export class CuaClient {
  private ws?: WebSocket;
  private link?: E2ELink;
  private linkReady?: Promise<E2ELink>;
  private resolveLink?: (l: E2ELink) => void;
  private listeners = new Set<(e: ClientEvent) => void>();
  private terminals = new Map<string, { streamId?: number; received: number; data: Set<(b: Uint8Array) => void>; exit: Set<(c?: number) => void>; opened: (streamId: number) => void; failed: (err: Error) => void }>();
  private stopped = true;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private inbound: Promise<void> = Promise.resolve();
  state: ConnState = "offline";
  accountId?: string;
  brainId?: string;

  constructor(private readonly o: ClientOptions) {}

  /** 云电脑在设备列表里的 id（和大脑同一个账号） */
  get cloudDeviceId() {
    return this.brainId ? `cloud:${this.brainId.slice("brain:".length)}` : undefined;
  }

  get pubKeys(): PublicKeys {
    return { kem: b64.to(this.o.identity.kem.publicKey), sig: b64.to(this.o.identity.sig.publicKey), sigAlg: "Ed25519" };
  }

  subscribe(fn: (e: ClientEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.setState("offline");
  }

  // ───────────── 连接 ─────────────

  private emit(e: ClientEvent) {
    for (const l of [...this.listeners]) l(e);
  }

  private setState(state: ConnState, error?: string) {
    this.state = state;
    this.emit({ kind: "state", state, accountId: this.accountId, ...(error ? { error } : {}) });
  }

  private resetLink() {
    this.link = undefined;
    this.linkReady = new Promise((r) => (this.resolveLink = r));
  }

  private open() {
    const WS = this.o.WebSocket ?? WebSocket;
    this.resetLink();
    this.setState("connecting");
    const ws = new WS(this.o.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.sendHub({ type: "hello", role: "phone", deviceId: this.o.identity.deviceId, platform: this.o.platform ?? "ios", name: this.o.name, pubKeys: this.pubKeys, protocolVersion: 1 });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.onText(ev.data);
      else {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        // 同一条链路的帧必须按顺序解（HPKE 序号），串起来
        this.inbound = this.inbound.then(() => this.onBinary(bytes)).catch((e) => this.o.log?.(`解密失败：${String(e)}`));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      for (const t of this.terminals.values()) for (const cb of t.exit) cb(undefined);
      this.terminals.clear();
      this.setState("offline");
      if (!this.stopped && this.o.reconnect !== false) {
        const delay = Math.min(30_000, 500 * 2 ** this.retry++);
        this.timer = setTimeout(() => this.open(), delay);
      }
    };
    ws.onerror = () => this.o.log?.("WebSocket 出错");
  }

  private onText(raw: string) {
    const parsed = AnyMessage.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const m = parsed.data;
    switch (m.type) {
      case "auth.challenge": {
        const payload = new TextEncoder().encode(hubAuthPayload(this.o.identity.deviceId, m.nonce));
        this.sendHub({ type: "auth.response", nonce: m.nonce, signature: signPayload(payload, this.o.identity.sig.privateKey, "Ed25519") });
        return;
      }
      case "auth.ok":
        this.retry = 0;
        return;
      case "peer.keys":
        if (m.deviceId.startsWith("brain:")) void this.onBrainKeys(m.deviceId, m.pubKeys);
        return;
      case "error":
        if (m.code === "token_required" || m.code === "key_mismatch" || m.code === "bad_token") this.setState("offline", m.message);
        break;
    }
    this.emit({ kind: "message", message: m, from: "hub" });
  }

  private async onBrainKeys(brainId: string, keys: PublicKeys) {
    this.brainId = brainId;
    this.accountId = brainId.slice("brain:".length);
    const link = await E2ELink.create({ selfId: this.o.identity.deviceId, self: this.o.identity.kem, peerId: brainId, peerPublicKey: b64.from(keys.kem) });
    this.ws?.send(link.handshake());
    this.link = link;
    this.resolveLink?.(link);
    this.setState("online");
  }

  private async onBinary(bytes: Uint8Array) {
    const env = decodeRelay(bytes);
    if (!this.link || env.from !== this.link.peerId) return;
    const frame = await this.link.openRelay(bytes);
    if (!frame) return; // 大脑的握手帧
    const f = decodeFrame(frame);
    if (f.kind === 1) return this.onPty(f.streamId, f.payload);
    if (f.kind !== 0) return;
    const parsed = AnyMessage.safeParse(parseControl(f));
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.type === "terminal.opened") this.terminals.get(m.sessionId)?.opened(m.streamId);
    if (m.type === "terminal.exit") {
      const t = this.terminals.get(m.sessionId);
      if (t) for (const cb of t.exit) cb(m.code);
      this.terminals.delete(m.sessionId);
    }
    if (m.type === "error" && m.ref && this.terminals.has(m.ref)) this.terminals.get(m.ref)!.failed(new Error(m.message));
    this.emit({ kind: "message", message: m, from: "brain" });
  }

  private onPty(streamId: number, bytes: Uint8Array) {
    for (const [sessionId, t] of this.terminals) {
      if (t.streamId !== streamId) continue;
      t.received += bytes.byteLength;
      for (const cb of t.data) cb(bytes);
      void this.send({ type: "terminal.ack", sessionId, bytes: t.received });
      return;
    }
  }

  // ───────────── 发送 ─────────────

  /** 发给 hub（明文控制消息：设备列表、余额等） */
  sendHub(body: MsgBody) {
    this.ws?.send(JSON.stringify(mkMsg(body)));
  }

  /** 发给云端大脑（端到端加密）；链路没好会等 */
  async send(body: MsgBody, id?: string): Promise<string> {
    const link = this.link ?? (await this.linkReady!);
    const msg = mkMsg(body, id);
    this.ws?.send(await link.sealFrame(controlFrame(msg, 0)));
    return msg.id;
  }

  /**
   * 发一条请求，等第一条 replyType 回复（或 ref 指向它的 error）。
   * cloud.* 的回复大多不带 ref，所以同一类请求不要并发发。
   */
  async request<T extends Msg["type"]>(body: MsgBody, replyType: T, timeoutMs = 30_000): Promise<Extract<Msg, { type: T }>> {
    const id = crypto.randomUUID();
    const reply = new Promise<Extract<Msg, { type: T }>>((resolve, reject) => {
      const t = setTimeout(() => (off(), reject(new Error(`等 ${replyType} 超时`))), timeoutMs);
      const off = this.subscribe((e) => {
        if (e.kind !== "message") return;
        const m = e.message;
        if (m.type === "error" && m.ref === id) {
          clearTimeout(t);
          off();
          reject(new Error(m.message));
        } else if (m.type === replyType && (!("ref" in m) || m.ref === undefined || m.ref === id)) {
          clearTimeout(t);
          off();
          resolve(m as Extract<Msg, { type: T }>);
        }
      });
    });
    await this.send(body, id);
    return reply;
  }

  /** 在云电脑（默认）或某台设备上跑一句话 */
  submit(text: string, o: { deviceId?: string; variants?: number; mode?: "agent" | "terminal"; title?: string } = {}) {
    const deviceId = o.deviceId ?? this.cloudDeviceId;
    if (!deviceId) throw new Error("还没连上");
    return this.send({ type: "intent.submit", text, deviceId, mode: o.mode ?? "agent", ...(o.title ? { title: o.title.slice(0, 200) } : {}), ...(o.variants && o.variants > 1 ? { variants: o.variants } : {}) });
  }

  /** 审批：签名后回给大脑（调用方先过 Face ID） */
  approve(req: StepApproval, allow: boolean, remember: "once" | "always" = "once") {
    const parts = req.challenge.split("\n");
    const signature = signApproval({ challenge: req.challenge, allow, privateKey: this.o.identity.sig.privateKey, alg: "Ed25519", keyId: this.o.identity.deviceId, nonce: parts[4]!, expiresAt: Number(parts[5]) });
    return this.send({ type: "approval.decision", runId: req.runId, stepId: req.stepId, allow, remember, signature });
  }

  /** 开云电脑终端（开终端要签名；调用方先过 Face ID） */
  async openTerminal(cols: number, rows: number): Promise<TerminalHandle> {
    const deviceId = this.cloudDeviceId;
    if (!deviceId) throw new Error("还没连上");
    const sessionId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const now = this.o.now?.() ?? Math.floor(Date.now() / 1000);
    const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
    const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const signature = signTerminalOpen({ sessionId, deviceId, privateKey: this.o.identity.sig.privateKey, alg: "Ed25519", keyId: this.o.identity.deviceId, nonce, expiresAt: now + 120 });
    const data = new Set<(b: Uint8Array) => void>();
    const exit = new Set<(c?: number) => void>();
    const streamId = await new Promise<number>((opened, failed) => {
      this.terminals.set(sessionId, { received: 0, data, exit, opened, failed });
      void this.send({ type: "terminal.open", sessionId, cols, rows, signature }).catch(failed);
      setTimeout(() => failed(new Error("开终端超时")), 30_000);
    }).catch((e: Error) => {
      this.terminals.delete(sessionId);
      throw e;
    });
    const t = this.terminals.get(sessionId)!;
    t.streamId = streamId;
    const enc = new TextEncoder();
    return {
      sessionId,
      write: (d) => {
        const payload = typeof d === "string" ? enc.encode(d) : d;
        void Promise.resolve(this.link ?? this.linkReady!).then(async (link) => this.ws?.send(await link.sealFrame(encodeFrame({ kind: 1, streamId, payload }))));
      },
      resize: (c, r) => void this.send({ type: "terminal.resize", sessionId, cols: c, rows: r }),
      close: () => {
        void this.send({ type: "terminal.close", sessionId });
        this.terminals.delete(sessionId);
      },
      onData: (cb) => (data.add(cb), () => data.delete(cb)),
      onExit: (cb) => (exit.add(cb), () => exit.delete(cb)),
    };
  }

  /**
   * 上传文件到云电脑（work/inbox/）：先要直传地址，再直接 POST 给沙箱，不经过 hub。
   * 返回沙箱里的路径。
   */
  async upload(name: string, file: Blob): Promise<string> {
    const up = await this.request({ type: "cloud.upload.begin", name, size: file.size }, "cloud.upload.url");
    const form = new FormData();
    form.append("file", file, name);
    const res = await (this.o.fetch ?? fetch)(up.url, { method: "POST", body: form });
    if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`);
    return up.path;
  }
}
