import { randomBytes } from "node:crypto";
import { CloudBrain, JevClient } from "@cuaremote/brain";
import { deriveKemKeyPair, generateSigningKeyPair, type PublicKeys } from "@cuaremote/protocol";
import type { Billing } from "./billing.js";
import type { Hub } from "./hub.js";

export interface CloudBrainOptions {
  /** 手机没指定 provider 时用的模型，如 "anthropic:claude-fable-5.1" */
  defaultProvider: string;
  jev?: JevClient;
  /** 云端 run 的计费；不给 = 不限量 */
  billing?: Billing;
  log?: (rec: Record<string, unknown>) => void;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** 云端大脑的 id 约定：每个账号一个 */
export function brainIdOf(accountId: string) {
  return `brain:${accountId}`;
}

/**
 * 按账号起云端大脑：账号里第一个端（手机或设备）登录时挂上 `brain:<account>`，
 * 密钥存 brain_keys 表，重启后 id 和公钥不变（手机端固定过的公钥不会失效）。
 * 手机把 intent.submit 密文发给 brain:<account> 就是「云端大脑」模式；
 * 目标设备要像响应本地大脑一样响应来自 brain 的 tools.list / tools.call。
 */
export class CloudBrainManager {
  private readonly brains = new Map<string, { brain: CloudBrain; detach: () => void }>();
  private readonly pending = new Map<string, Promise<CloudBrain>>();

  constructor(
    private readonly hub: Hub,
    private readonly o: CloudBrainOptions,
  ) {}

  get(accountId: string) {
    return this.brains.get(accountId)?.brain;
  }

  /** hub 的 onPresence 钩子 */
  onPresence(ev: { deviceId: string; role: string; accountId: string; online: boolean }) {
    if (ev.role === "brain" || ev.accountId === "unclaimed") return;
    if (ev.online) void this.ensure(ev.accountId).catch((e) => this.o.log?.({ t: "cloud_brain_start_failed", accountId: ev.accountId, err: String(e) }));
    else this.brains.get(ev.accountId)?.brain.peerOffline(ev.deviceId);
  }

  ensure(accountId: string): Promise<CloudBrain> {
    const have = this.brains.get(accountId);
    if (have) return Promise.resolve(have.brain);
    let p = this.pending.get(accountId);
    if (!p) {
      p = this.start(accountId).finally(() => this.pending.delete(accountId));
      this.pending.set(accountId, p);
    }
    return p;
  }

  private async start(accountId: string): Promise<CloudBrain> {
    const store = this.hub.store;
    let row = store.getBrainKeys(accountId);
    if (!row) {
      const sig = generateSigningKeyPair("Ed25519");
      row = { accountId, kemSeed: b64(randomBytes(32)), sigPriv: b64(sig.privateKey), sigPub: b64(sig.publicKey), sigAlg: "Ed25519", createdAt: Math.floor(Date.now() / 1000) };
      store.putBrainKeys(row);
      row = store.getBrainKeys(accountId)!; // 并发时以库里那份为准
    }
    const kem = await deriveKemKeyPair(unb64(row.kemSeed));
    const selfId = brainIdOf(accountId);
    const pubKeys: PublicKeys = { kem: b64(kem.publicKey), sig: row.sigPub, sigAlg: row.sigAlg };

    let attached: { send: (bytes: Uint8Array) => void; detach: () => void } | undefined;
    const brain = new CloudBrain({
      selfId,
      kem,
      peerKeys: (id) => {
        const d = store.getDevice(id);
        return d && d.accountId === accountId ? { kem: d.kem, sig: d.sig, sigAlg: d.sigAlg } : undefined;
      },
      devicePlatform: (id) => store.getDevice(id)?.platform,
      sendRelay: (bytes) => attached?.send(bytes),
      defaultProvider: this.o.defaultProvider,
      jev: this.o.jev,
      billing: this.o.billing
        ? {
            reserve: (runId) => this.o.billing!.reserve(accountId, runId),
            settle: (runId, cost) => this.o.billing!.settle(accountId, runId, cost),
          }
        : undefined,
      log: this.o.log,
    });
    attached = this.hub.attachEndpoint({
      deviceId: selfId,
      role: "brain",
      accountId,
      platform: "cloud",
      name: "云端大脑",
      pubKeys,
      onBinary: (bytes) => void brain.receive(bytes).catch((e) => this.o.log?.({ t: "cloud_brain_receive_failed", accountId, err: String(e) })),
      onText: (m) => {
        if (m.type === "error") this.o.log?.({ t: "cloud_brain_hub_error", accountId, code: m.code, message: m.message });
      },
    });
    this.brains.set(accountId, { brain, detach: attached.detach });
    return brain;
  }

  stopAll() {
    for (const [id, b] of this.brains) {
      b.detach();
      this.brains.delete(id);
    }
  }
}
