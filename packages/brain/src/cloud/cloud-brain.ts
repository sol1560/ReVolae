import { randomUUID } from "node:crypto";
import {
  AnyMessage,
  ApprovalVerifier,
  controlFrame,
  decodeFrame,
  decodeRelay,
  mkMsg,
  parseControl,
  type Cost,
  type KemKeyPair,
  type MsgBody,
  type PrivacySettings,
  type PublicKeys,
} from "@cuaremote/protocol";
import { runIntent, type ApprovalGate, type BrainEvent } from "../agent/loop.js";
import { fetchCard, learnApp, runCard, type LearnEvent } from "../learn/learn.js";
import { AdbHost } from "../android/adb-host.js";
import { IpadHost } from "../ipad/ipad-host.js";
import { RelayHost } from "../host/relay-host.js";
import type { Host } from "../host/types.js";
import { JevClient } from "../jev/client.js";
import { PolicyEngine } from "../jev/policy.js";
import { catalogMessage, resolveProvider } from "../llm/catalog.js";
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
  /** 计费钩子（hub 按账号绑好）：reserve 不通过就不开跑；settle 在 run 结束后按实际成本结算 */
  billing?: {
    reserve: (runId: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
    settle: (runId: string, cost: Cost) => Promise<unknown>;
  };
  log?: (rec: Record<string, unknown>) => void;
  now?: () => number;
}

interface RunState {
  ctrl: AbortController;
  phoneId: string;
  deviceId: string;
}

const PHONE_TYPES = new Set(["intent.submit", "approval.decision", "run.cancel", "app.learn.start", "app.learn.stop", "app.card.run", "models.list"]);

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
  private readonly learns = new Map<string, AbortController>();
  private readonly ipadHosts = new Map<string, IpadHost>();
  private readonly adbHosts = new Map<string, AdbHost>();
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
    // iPad 重连后指针位置不可信，校准模型也重新从设备取
    this.ipadHosts.delete(peerId);
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

  /**
   * 给 agent / 卡片用的宿主：
   * - iPad 设备外面包一层绝对坐标工具（校准模型随实例缓存）
   * - 其它设备（主要是 Mac）包一层 AdbHost：宿主工具表里有 android.adb 时把它翻成 android.* 工具，没有就透传（ui_tree 的 index 缓存随实例）
   */
  private agentHostFor(deviceId: string): Host {
    const relay = this.hostFor(deviceId);
    if (this.o.devicePlatform?.(deviceId) === "ipados") {
      let h = this.ipadHosts.get(deviceId);
      if (!h) {
        h = new IpadHost(relay, { log: this.o.log });
        this.ipadHosts.set(deviceId, h);
      }
      return h;
    }
    let h = this.adbHosts.get(deviceId);
    if (!h) {
      h = new AdbHost(relay, { log: this.o.log });
      this.adbHosts.set(deviceId, h);
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
      case "app.learn.start":
        await this.startLearn(phoneId, m);
        break;
      case "app.learn.stop":
        this.learns.get(m.bundleId)?.abort();
        break;
      case "app.card.run":
        await this.startCard(phoneId, m);
        break;
      case "models.list":
        // 云端大脑机器上没有用户的本地模型，本地条目一律标不可用
        await this.sendTo(phoneId, catalogMessage({ localUp: { ollama: false, lmstudio: false }, defaultModel: this.o.defaultProvider, brainLocation: "cloud" })).catch(() => {});
        break;
      default:
        break; // approval.decision 由 waitPhone 消费
    }
  }

  private async startLearn(phoneId: string, m: Extract<AnyMessage, { type: "app.learn.start" }>) {
    if (!m.deviceId) {
      await this.sendTo(phoneId, { type: "error", code: "device_required", message: "发给云端大脑的 app.learn.start 必须带 deviceId", ref: m.id });
      return;
    }
    let provider;
    try {
      provider = resolveProvider({ settings: this.privacy.get(m.deviceId), defaultModel: this.o.defaultProvider });
    } catch (e) {
      await this.sendTo(phoneId, { type: "error", code: "provider", message: e instanceof Error ? e.message : String(e), ref: m.id });
      return;
    }
    const ctrl = new AbortController();
    this.learns.set(m.bundleId, ctrl);
    const emit = (e: LearnEvent) => void this.sendTo(phoneId, e).catch((err) => this.o.log?.({ t: "emit_failed", phoneId, err: String(err) }));
    try {
      await learnApp({ host: this.agentHostFor(m.deviceId), provider, emit, log: this.o.log, signal: ctrl.signal }, { bundleId: m.bundleId, explore: m.explore });
    } catch (e) {
      await this.sendTo(phoneId, { type: "error", code: "learn", message: e instanceof Error ? e.message : String(e), ref: m.id }).catch(() => {});
    } finally {
      this.learns.delete(m.bundleId);
    }
  }

  private async startCard(phoneId: string, m: Extract<AnyMessage, { type: "app.card.run" }>) {
    if (!m.deviceId) {
      await this.sendTo(phoneId, { type: "error", code: "device_required", message: "发给云端大脑的 app.card.run 必须带 deviceId", ref: m.id });
      return;
    }
    const deviceId = m.deviceId;
    const host = this.agentHostFor(deviceId);
    const got = await fetchCard(host, m.cardId);
    if ("error" in got) {
      await this.sendTo(phoneId, { type: "error", code: "card_not_found", message: got.error, ref: m.id });
      return;
    }
    const settings = this.privacy.get(deviceId);
    const policy = new PolicyEngine({ jev: this.jev, jevEnabled: settings?.jevEnabled ?? this.jev.enabled, autonomy: settings?.autonomy ?? "balanced" });
    const { emit, approvals } = this.phoneGate(phoneId);
    try {
      await runCard({ host, policy, approvals, emit, log: this.o.log, deviceId, providerId: this.o.defaultProvider }, got.card, m.params);
    } catch (e) {
      await this.sendTo(phoneId, { type: "error", code: "card", message: e instanceof Error ? e.message : String(e), ref: m.id }).catch(() => {});
    }
  }

  /** 发给某台手机的事件通道 + 需要它签名确认的门（intent 和卡片共用） */
  private phoneGate(phoneId: string) {
    const emit = (e: BrainEvent | LearnEvent) => {
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
    return { emit, approvals };
  }

  private async startRun(phoneId: string, m: Extract<AnyMessage, { type: "intent.submit" }>) {
    const deviceId = m.deviceId;
    let provider;
    try {
      provider = resolveProvider({ settings: this.privacy.get(deviceId), requested: m.provider, defaultModel: this.o.defaultProvider });
    } catch (e) {
      await this.sendTo(phoneId, { type: "error", code: "provider", message: e instanceof Error ? e.message : String(e), ref: m.id });
      return;
    }
    const settings = this.privacy.get(deviceId);
    const policy = new PolicyEngine({ jev: this.jev, jevEnabled: settings?.jevEnabled ?? this.jev.enabled, autonomy: settings?.autonomy ?? "balanced" });
    const host = this.agentHostFor(deviceId);
    const ctrl = new AbortController();
    const runId = randomUUID();
    if (this.o.billing) {
      const r = await this.o.billing.reserve(runId);
      if (!r.ok) {
        await this.sendTo(phoneId, { type: "error", code: r.code, message: r.message, ref: m.id });
        return;
      }
    }
    this.runs.set(runId, { ctrl, phoneId, deviceId });

    const { emit, approvals } = this.phoneGate(phoneId);
    let cost: Cost = { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 };
    const emitTracked: typeof emit = (e) => {
      if ("cost" in e && e.cost) cost = e.cost;
      emit(e);
    };

    try {
      const out = await runIntent(
        { host, provider, policy, approvals, jev: this.jev, emit: emitTracked, log: this.o.log, signal: ctrl.signal, platform: this.o.devicePlatform?.(deviceId) ?? "unknown" },
        { runId, deviceId, intent: m.text, mode: m.mode, terminalSessionId: m.terminalSessionId },
      );
      cost = out.cost;
    } catch (e) {
      await this.sendTo(phoneId, { type: "error", code: "run", message: e instanceof Error ? e.message : String(e), ref: m.id }).catch(() => {});
    } finally {
      this.runs.delete(runId);
      // 断线 / 抛错的 run 也按已发生的成本结算；扣款失败只记日志，不影响手机
      if (this.o.billing) await this.o.billing.settle(runId, cost).catch((e) => this.o.log?.({ t: "billing_settle_failed", runId, err: String(e) }));
    }
  }
}
