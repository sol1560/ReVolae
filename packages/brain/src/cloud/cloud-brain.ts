import { randomUUID } from "node:crypto";
import {
  AnyMessage,
  ApprovalVerifier,
  controlFrame,
  decodeFrame,
  decodeRelay,
  mkMsg,
  parseControl,
  type KemKeyPair,
  type MsgBody,
  type PrivacySettings,
  type PublicKeys,
} from "@cuaremote/protocol";
import { runIntent, type ApprovalGate, type BrainEvent } from "../agent/loop.js";
import { RelayHost } from "../host/relay-host.js";
import { JevClient } from "../jev/client.js";
import { PolicyEngine } from "../jev/policy.js";
import { createProvider } from "../llm/providers.js";
import { PeerLinks } from "./peer-links.js";

export interface CloudBrainOptions {
  /** 本大脑在 hub 里的 id，约定 `brain:<accountId>` */
  selfId: string;
  kem: KemKeyPair;
  /** 查对端公钥（hub 直接查库；同账号的手机和设备都算对端） */
  peerKeys: (peerId: string) => PublicKeys | undefined;
  /** 把 RelayEnvelope 交给 hub 中继 */
  sendRelay: (bytes: Uint8Array) => void | Promise<void>;
  /** 目标设备的平台（hub 从设备表查），进系统提示词 */
  devicePlatform?: (deviceId: string) => string | undefined;
  defaultProvider: string;
  jev?: JevClient;
  log?: (rec: Record<string, unknown>) => void;
  now?: () => number;
}

interface RunState {
  ctrl: AbortController;
  phoneId: string;
  deviceId: string;
}

const PHONE_TYPES = new Set(["intent.submit", "approval.decision", "run.cancel"]);

/**
 * 云端大脑：跑在 hub 进程里的一个虚拟端点。
 *
 * - 手机发来 intent.submit（密文，to=brain:<account>）→ 这里跑 agent loop，
 *   工具经 RelayHost 转成 tools.call 发给目标设备，事件封给发指令的手机。
 * - 需要确认的步骤：先把 step.approval_required 发给手机并记住 challenge，
 *   等手机回签过名的 approval.decision，验签通过才放行（和 Swift daemon 的四条规则一致）。
 * - 设备发来 privacy.state 时记住它的 jev/autonomy 档位，后续这台设备上的 run 用同一套。
 *
 * 加解密由 PeerLinks 负责；这里只见明文 Frame。
 */
export class CloudBrain {
  readonly links: PeerLinks;
  private readonly hosts = new Map<string, RelayHost>();
  private readonly runs = new Map<string, RunState>();
  private readonly verifiers = new Map<string, ApprovalVerifier>();
  private readonly privacy = new Map<string, PrivacySettings>();
  private readonly phoneListeners = new Set<(from: string, m: AnyMessage) => void>();
  private readonly inbound = new Map<string, Promise<void>>();
  private readonly jev: JevClient;
  private readonly now: () => number;

  constructor(private readonly o: CloudBrainOptions) {
    this.links = new PeerLinks(o.selfId, o.kem, o.peerKeys, o.sendRelay);
    this.jev = o.jev ?? new JevClient();
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get selfId() {
    return this.o.selfId;
  }

  /**
   * hub 转来的 RelayEnvelope（to = 我）。
   * 同一个对端的信封按到达顺序串行处理：握手帧建链路是异步的，
   * 对端紧跟着发的密文不能抢在前面（否则会「还没握手就发了密文」）。
   */
  receive(bytes: Uint8Array): Promise<void> {
    const from = decodeRelay(bytes).from;
    const prev = this.inbound.get(from) ?? Promise.resolve();
    const next = prev.then(() => this.process(bytes));
    this.inbound.set(from, next.catch(() => {}));
    return next;
  }

  private async process(bytes: Uint8Array): Promise<void> {
    const r = await this.links.receive(bytes);
    if (!r) return; // 握手帧
    const f = decodeFrame(r.frame);
    if (f.kind !== 0) return;
    const parsed = AnyMessage.safeParse(parseControl(f));
    if (!parsed.success) return;
    const m = parsed.data;
    if (PHONE_TYPES.has(m.type)) {
      void this.onPhoneMessage(r.from, m);
      return;
    }
    if (m.type === "privacy.state") {
      this.privacy.set(m.deviceId, m.settings);
      this.hosts.get(m.deviceId)?.invalidateTools();
    }
    this.hostFor(r.from).handleMessage(m);
  }

  /** 对端掉线：等它回消息的调用全部判失败，链路作废（重连要重新握手） */
  peerOffline(peerId: string) {
    this.hosts.get(peerId)?.failAll(`${peerId} 掉线了`);
    this.links.drop(peerId);
    this.inbound.delete(peerId);
    for (const [runId, st] of this.runs) {
      if (st.deviceId === peerId || st.phoneId === peerId) {
        st.ctrl.abort();
        this.runs.delete(runId);
      }
    }
  }

  get activeRuns() {
    return this.runs.size;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private hostFor(deviceId: string) {
    let h = this.hosts.get(deviceId);
    if (!h) {
      h = new RelayHost(deviceId, { send: (to, frame) => this.links.send(to, frame) });
      this.hosts.set(deviceId, h);
    }
    return h;
  }

  private verifierFor(phoneId: string) {
    let v = this.verifiers.get(phoneId);
    if (!v) {
      const keys = this.o.peerKeys(phoneId);
      if (!keys) throw new Error(`不知道手机 ${phoneId} 的公钥`);
      v = new ApprovalVerifier({ phoneKeys: keys, now: this.now });
      this.verifiers.set(phoneId, v);
    }
    return v;
  }

  private sendTo(peerId: string, body: MsgBody) {
    return this.links.send(peerId, controlFrame(mkMsg(body), 0));
  }

  private waitPhone<T extends AnyMessage>(phoneId: string, pred: (m: AnyMessage) => m is T, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.phoneListeners.delete(fn);
        resolve(null);
      }, Math.max(0, timeoutMs));
      const fn = (from: string, m: AnyMessage) => {
        if (from !== phoneId || !pred(m)) return;
        clearTimeout(t);
        this.phoneListeners.delete(fn);
        resolve(m);
      };
      this.phoneListeners.add(fn);
    });
  }

  private async onPhoneMessage(phoneId: string, m: AnyMessage) {
    for (const l of [...this.phoneListeners]) l(phoneId, m);
    switch (m.type) {
      case "intent.submit":
        await this.startRun(phoneId, m);
        break;
      case "run.cancel": {
        const st = this.runs.get(m.runId);
        if (st && st.phoneId === phoneId) st.ctrl.abort();
        break;
      }
      default:
        break; // approval.decision 由 waitPhone 消费
    }
  }

  private async startRun(phoneId: string, m: Extract<AnyMessage, { type: "intent.submit" }>) {
    const deviceId = m.deviceId;
    const providerId = m.provider ?? this.o.defaultProvider;
    let provider;
    try {
      provider = createProvider(providerId);
    } catch (e) {
      await this.sendTo(phoneId, { type: "error", code: "provider", message: e instanceof Error ? e.message : String(e), ref: m.id });
      return;
    }
    const settings = this.privacy.get(deviceId);
    const policy = new PolicyEngine({ jev: this.jev, jevEnabled: settings?.jevEnabled ?? this.jev.enabled, autonomy: settings?.autonomy ?? "balanced" });
    const host = this.hostFor(deviceId);
    const ctrl = new AbortController();
    const runId = randomUUID();
    this.runs.set(runId, { ctrl, phoneId, deviceId });

    const emit = (e: BrainEvent) => {
      if (e.type === "step.approval_required") {
        this.verifierFor(phoneId).remember({ runId: e.runId, stepId: e.stepId, challenge: e.challenge, expiresAt: e.expiresAt });
      }
      void this.sendTo(phoneId, e).catch((err) => this.o.log?.({ t: "emit_failed", phoneId, err: String(err) }));
    };

    const approvals: ApprovalGate = {
      request: async (req) => {
        const d = await this.waitPhone(
          phoneId,
          (x): x is Extract<AnyMessage, { type: "approval.decision" }> => x.type === "approval.decision" && x.runId === req.runId && x.stepId === req.stepId,
          (req.expiresAt - this.now()) * 1000,
        );
        if (!d) return { allow: false, remember: "once" };
        const v = this.verifierFor(phoneId).verify(d);
        if (!v.ok) {
          this.o.log?.({ t: "approval_rejected", runId: req.runId, stepId: req.stepId, reason: v.reason });
          await this.sendTo(phoneId, { type: "error", code: `approval_${v.reason}`, message: v.message, ref: d.id });
          return { allow: false, remember: "once" };
        }
        return { allow: d.allow, remember: d.remember };
      },
    };

    try {
      await runIntent(
        { host, provider, policy, approvals, jev: this.jev, emit, log: this.o.log, signal: ctrl.signal, platform: this.o.devicePlatform?.(deviceId) ?? "unknown" },
        { runId, deviceId, intent: m.text, mode: m.mode, terminalSessionId: m.terminalSessionId },
      );
    } catch (e) {
      await this.sendTo(phoneId, { type: "error", code: "run", message: e instanceof Error ? e.message : String(e), ref: m.id }).catch(() => {});
    } finally {
      this.runs.delete(runId);
    }
  }
}
