import { randomBytes } from "node:crypto";
import { z } from "zod";
import { decodeRelay, encodeRelay } from "./frame.js";
import { KEM_PUBLIC_KEY_BYTES, OpenContext, SealContext, relayHeader, type KemKeyPair } from "./hpke.js";

const nonce = z.string().regex(/^[0-9a-f]{64}$/);
const hello = z.object({ v: z.literal(2), type: z.literal("hello"), nonce }).strict();
const key = z.object({ v: z.literal(2), type: z.literal("key"), nonce, peerNonce: nonce, enc: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const handshake = z.discriminatedUnion("type", [hello, key]);
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function freshLinkInfo(from: string, to: string, senderNonce: string, receiverNonce: string): Uint8Array {
  for (const id of [from, to]) {
    if (!id || /[\r\n]/.test(id) || utf8.encode(id).byteLength > 255 || utf8Decoder.decode(utf8.encode(id)) !== id) {
      throw new Error("invalid link identity");
    }
  }
  nonce.parse(senderNonce);
  nonce.parse(receiverNonce);
  const info = ["cuaremote-link-v2", from, to, senderNonce, receiverNonce].join("\n");
  return utf8.encode(info);
}

/** v2 不接受 v1 降级；每次传输重连创建新实例，不能从收到的握手重置旧实例。 */
export class FreshLink {
  private readonly nonce = randomBytes(32).toString("hex");
  private peerNonce?: string;
  private sealer?: SealContext;
  private opener?: OpenContext;
  private failed = false;
  private helloSent = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: { selfId: string; self: KemKeyPair; peerId: string; peerPublicKey: Uint8Array }) {
    freshLinkInfo(o.selfId, o.peerId, this.nonce, this.nonce);
    if (o.selfId === o.peerId) throw new Error("self link is not allowed");
    if (o.self.publicKey.byteLength !== KEM_PUBLIC_KEY_BYTES || o.self.privateKey.byteLength !== KEM_PUBLIC_KEY_BYTES || o.peerPublicKey.byteLength !== KEM_PUBLIC_KEY_BYTES) {
      throw new RangeError("X25519 keys must be 32 bytes");
    }
  }

  get ready() { return !this.failed && Boolean(this.sealer && this.opener); }

  hello(): Uint8Array {
    if (this.failed) throw new Error("link failed; reconnect transport first");
    if (this.helloSent) return this.fail(new Error("hello already sent; reconnect transport first"));
    this.helloSent = true;
    try {
      return this.envelope({ v: 2, type: "hello", nonce: this.nonce });
    } catch (error) {
      return this.fail(error);
    }
  }

  receive(bytes: Uint8Array): Promise<{ reply?: Uint8Array; frame?: Uint8Array }> {
    return this.serial(async () => {
      const e = decodeRelay(bytes);
      if (e.from !== this.o.peerId || e.to !== this.o.selfId) throw new Error("wrong link identity");
      if (e.encrypted) {
        if (!this.ready) throw new Error("link not ready");
        const header = bytes.subarray(0, bytes.byteLength - e.body.byteLength);
        return { frame: await this.opener!.open(header, e.body) };
      }
      if (!this.helloSent) throw new Error("send hello before receiving handshake");
      if (e.body.length > 1024) throw new Error("handshake too large");
      const h = handshake.parse(JSON.parse(utf8Decoder.decode(e.body)));
      if (h.type === "hello") {
        if (this.peerNonce) throw new Error("duplicate hello; reconnect transport first");
        this.peerNonce = h.nonce;
        this.sealer = await SealContext.create({
          self: this.o.self, peerPublicKey: this.o.peerPublicKey, from: this.o.selfId, to: this.o.peerId,
          info: freshLinkInfo(this.o.selfId, this.o.peerId, this.nonce, h.nonce),
        });
        return { reply: this.envelope({ v: 2, type: "key", nonce: this.nonce, peerNonce: h.nonce, enc: Buffer.from(this.sealer.enc).toString("hex") }) };
      }
      if (!this.peerNonce || this.opener || h.peerNonce !== this.nonce || h.nonce !== this.peerNonce) throw new Error("stale or unexpected key");
      this.opener = await OpenContext.create({
        self: this.o.self, peerPublicKey: this.o.peerPublicKey, from: this.o.peerId, to: this.o.selfId,
        enc: new Uint8Array(Buffer.from(h.enc, "hex")), info: freshLinkInfo(this.o.peerId, this.o.selfId, h.nonce, this.nonce),
      });
      return {};
    });
  }

  seal(frame: Uint8Array): Promise<Uint8Array> {
    return this.serial(async () => {
      if (!this.ready) throw new Error("link not ready");
      const header = relayHeader({ from: this.o.selfId, to: this.o.peerId, encrypted: true });
      const body = await this.sealer!.seal(header, frame);
      return encodeRelay({ from: this.o.selfId, to: this.o.peerId, encrypted: true, body });
    });
  }

  private envelope(h: z.infer<typeof handshake>) {
    return encodeRelay({ from: this.o.selfId, to: this.o.peerId, encrypted: false, body: utf8.encode(JSON.stringify(h)) });
  }

  private fail(error: unknown): never {
    this.failed = true;
    throw error;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.failed) throw new Error("link failed; reconnect transport first");
      try { return await operation(); } catch (error) { this.failed = true; throw error; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
