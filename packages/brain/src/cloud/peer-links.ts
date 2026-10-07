import { E2ELink, decodeRelay, type KemKeyPair, type PublicKeys } from "@cuaremote/protocol";

/**
 * 一个端和多个对端之间的端到端链路（每个对端一条 E2ELink）。
 * 规则和 Swift/Kotlin 端一致：
 *   - 第一次给某个对端发东西前，先发我方握手帧
 *   - 同一在线会话只接收一次握手；收到离线通知或连接断开后由宿主 drop 再建立
 *   - 收到密文但还没收到对端握手 → 丢弃并报错（不缓存，让对端重发）
 */
export class PeerLinks {
  private links = new Map<string, Promise<{ link: E2ELink; sentHandshake: boolean }>>();
  private sends = new Map<string, Promise<void>>();

  constructor(
    readonly selfId: string,
    private readonly self: KemKeyPair,
    private readonly peerKeys: (peerId: string) => PublicKeys | undefined,
    private readonly sendRelay: (bytes: Uint8Array) => void | Promise<void>,
  ) {}

  hasPeer(peerId: string) {
    return this.links.has(peerId);
  }

  drop(peerId: string) {
    void this.links.get(peerId)?.then((entry) => entry.link.close(), () => {});
    this.links.delete(peerId);
    this.sends.delete(peerId);
  }

  close() {
    for (const peerId of this.links.keys()) this.drop(peerId);
  }

  private async linkFor(peerId: string) {
    const entry = this.links.get(peerId);
    if (entry) return entry;
    const keys = this.peerKeys(peerId);
    if (!keys) throw new Error(`不知道 ${peerId} 的公钥（还没配对或 hub 没发 peer.keys）`);
    const creating = E2ELink.create({ selfId: this.selfId, self: this.self, peerId, peerPublicKey: new Uint8Array(Buffer.from(keys.kem, "base64")) })
      .then((link) => ({ link, sentHandshake: false }));
    this.links.set(peerId, creating);
    try { return await creating; }
    catch (e) { if (this.links.get(peerId) === creating) this.links.delete(peerId); throw e; }
  }

  private async ensureHandshake(entry: { link: E2ELink; sentHandshake: boolean }) {
    if (entry.sentHandshake) return;
    entry.sentHandshake = true;
    await this.sendRelay(entry.link.handshake());
  }

  /** 发一帧明文 Frame 给对端（自动补握手） */
  send(peerId: string, frame: Uint8Array): Promise<void> {
    const previous = this.sends.get(peerId) ?? Promise.resolve();
    const result = Promise.all([previous, this.linkFor(peerId)]).then(async ([, entry]) => {
      await this.ensureHandshake(entry);
      await this.sendRelay(await entry.link.sealFrame(frame));
    });
    this.sends.set(peerId, result.catch(() => {}));
    return result;
  }

  /** 收到一个 RelayEnvelope；返回 {from, frame} 或 null（握手帧） */
  async receive(bytes: Uint8Array): Promise<{ from: string; frame: Uint8Array } | null> {
    const env = decodeRelay(bytes);
    if (env.to !== this.selfId) throw new Error(`信封不是给我的：to=${env.to}`);
    if (!env.encrypted) {
      // 重复握手由 E2ELink 拒绝；不得互相重建导致无限交换握手。
      const entry = await this.linkFor(env.from);
      await entry.link.openRelay(bytes);
      await this.ensureHandshake(entry);
      return null;
    }
    const entry = await this.links.get(env.from);
    if (!entry || !entry.link.ready) throw new Error(`${env.from} 还没握手就发了密文`);
    const frame = await entry.link.openRelay(bytes);
    return frame ? { from: env.from, frame } : null;
  }
}
