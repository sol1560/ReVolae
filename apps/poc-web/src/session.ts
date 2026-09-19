import { randomUUID } from "node:crypto";
import { mkMsg, PhoneToDevice, type DeviceToPhone, type HistoryItem, type MsgBody } from "@cuaremote/protocol";
import {
  createProvider,
  CuaDriver,
  JevClient,
  LocalBunHost,
  PolicyEngine,
  runIntent,
  type ApprovalGate,
  type ApprovalRequest,
  type Autonomy,
  type BrainEvent,
  type Host,
  type Provider,
} from "@cuaremote/brain";

/** 一个手机页面（一条 WebSocket）对应一个会话。 */
export interface SessionOptions {
  send: (msg: DeviceToPhone) => void;
  deviceId?: string;
  deviceName?: string;
  defaultProvider?: string;
  autonomy?: Autonomy;
  host?: Host;
  /** 测试注入；不给就按 provider id 创建 */
  providerFactory?: (id: string) => Provider;
  jev?: JevClient;
  gui?: CuaDriver;
  log?: (rec: Record<string, unknown>) => void;
  history?: HistoryItem[];
  approvalTtlSec?: number;
}

interface PendingApproval {
  resolve: (a: { allow: boolean; remember: "once" | "always" }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PocSession {
  private readonly o: Required<Pick<SessionOptions, "send" | "deviceId" | "deviceName" | "defaultProvider" | "autonomy" | "host" | "providerFactory" | "jev" | "history">> & SessionOptions;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly runs = new Map<string, AbortController>();
  private readonly policy: PolicyEngine;

  constructor(o: SessionOptions) {
    this.o = {
      ...o,
      deviceId: o.deviceId ?? "local",
      deviceName: o.deviceName ?? "这台电脑",
      defaultProvider: o.defaultProvider ?? "mock",
      autonomy: o.autonomy ?? "balanced",
      host: o.host ?? new LocalBunHost(),
      providerFactory: o.providerFactory ?? ((id) => createProvider(id)),
      jev: o.jev ?? new JevClient(),
      history: o.history ?? [],
    };
    this.policy = new PolicyEngine({ jev: this.o.jev, autonomy: this.o.autonomy });
  }

  get busy() {
    return this.runs.size > 0;
  }

  /** 页面一连上就把能力表推过去 */
  async hello() {
    await this.sendCapabilities();
  }

  /** 收到手机消息（已 JSON.parse 的对象） */
  async handle(raw: unknown) {
    const parsed = PhoneToDevice.safeParse(raw);
    if (!parsed.success) {
      const ref = typeof raw === "object" && raw && "id" in raw ? String((raw as { id: unknown }).id) : undefined;
      this.emit({ type: "error", code: "bad_message", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), ref });
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case "intent.submit":
        void this.startRun(m.id, m.text, m.mode, m.provider, m.terminalSessionId);
        return;
      case "approval.decision": {
        const p = this.pending.get(`${m.runId}/${m.stepId}`);
        if (!p) {
          this.emit({ type: "error", code: "no_pending_approval", message: "这一步已经不需要确认了（可能超时或已处理）", ref: m.id });
          return;
        }
        clearTimeout(p.timer);
        this.pending.delete(`${m.runId}/${m.stepId}`);
        p.resolve({ allow: m.allow, remember: m.remember });
        this.emit({ type: "ack", ref: m.id });
        return;
      }
      case "run.cancel": {
        const c = this.runs.get(m.runId);
        if (c) c.abort();
        // 正在等确认的步骤也一起结束掉
        for (const [k, p] of this.pending) if (k.startsWith(`${m.runId}/`)) { clearTimeout(p.timer); p.resolve({ allow: false, remember: "once" }); this.pending.delete(k); }
        this.emit({ type: "ack", ref: m.id });
        return;
      }
      case "capabilities.get":
        await this.sendCapabilities();
        return;
      case "history.list": {
        const items = [...this.o.history].reverse().slice(0, m.limit);
        this.emit({ type: "history.page", items });
        return;
      }
      default:
        this.emit({ type: "error", code: "unsupported", message: `PoC 网页版还不支持 ${m.type}`, ref: m.id });
    }
  }

  /** 页面断开：取消所有跑着的任务、拒绝所有等待中的确认 */
  close() {
    for (const c of this.runs.values()) c.abort();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ allow: false, remember: "once" }); }
    this.pending.clear();
  }

  private emit(body: MsgBody<DeviceToPhone>) {
    this.o.send(mkMsg(body) as DeviceToPhone);
  }

  private async sendCapabilities() {
    const { tools, scope } = await this.o.host.listTools();
    let brainAvailable = true;
    let brainUnavailableReason: string | undefined;
    try {
      this.o.providerFactory(this.o.defaultProvider);
    } catch (e) {
      brainAvailable = false;
      brainUnavailableReason = e instanceof Error ? e.message : String(e);
    }
    this.emit({
      type: "capabilities",
      deviceId: this.o.deviceId,
      platform: process.platform === "darwin" ? "macos" : "cloud",
      name: this.o.deviceName,
      tools,
      scope,
      brainAvailable,
      brainUnavailableReason,
      daemonVersion: "poc-web/0.1.0",
    });
  }

  private async startRun(msgId: string, intent: string, mode: "agent" | "terminal", providerId: string | undefined, terminalSessionId?: string) {
    if (this.busy) {
      this.emit({ type: "error", code: "busy", message: "上一条还在跑，等它结束或先取消", ref: msgId });
      return;
    }
    let provider: Provider;
    try {
      provider = this.o.providerFactory(providerId ?? this.o.defaultProvider);
    } catch (e) {
      this.emit({ type: "error", code: "provider_unavailable", message: e instanceof Error ? e.message : String(e), ref: msgId });
      return;
    }
    const runId = randomUUID();
    const ctrl = new AbortController();
    this.runs.set(runId, ctrl);
    const item: HistoryItem = { runId, deviceId: this.o.deviceId, intent, startedAt: Date.now() };
    this.o.history.push(item);
    this.emit({ type: "ack", ref: msgId });

    const approvals: ApprovalGate = { request: (req: ApprovalRequest) => this.waitApproval(req) };
    // run.finished 一发出去就算结束：手机马上再发下一条不该撞上 busy，历史里也要立刻能看到结果
    const emit = (e: BrainEvent) => {
      if (e.type === "run.finished") {
        this.runs.delete(runId);
        Object.assign(item, { finishedAt: Date.now(), ok: e.ok, summary: e.summary, cost: e.cost, stepCount: e.stepCount });
      }
      this.emit(e);
    };
    try {
      await runIntent(
        {
          host: this.o.host,
          provider,
          policy: this.policy,
          approvals,
          emit,
          gui: this.o.gui?.running ? this.o.gui : undefined,
          jev: this.o.jev,
          log: this.o.log,
          signal: ctrl.signal,
          limits: { approvalTtlSec: this.o.approvalTtlSec },
        },
        { runId, deviceId: this.o.deviceId, intent, mode, terminalSessionId },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit({ type: "error", code: "run_crashed", message, ref: runId });
      emit({ type: "run.finished", runId, ok: false, summary: message, cost: { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 }, stepCount: 0, cancelled: ctrl.signal.aborted });
    } finally {
      this.runs.delete(runId);
    }
  }

  private waitApproval(req: ApprovalRequest) {
    // step.approval_required 已经由 agent loop 自己 emit 过了，这里只等手机的回答
    return new Promise<{ allow: boolean; remember: "once" | "always" }>((resolve) => {
      const key = `${req.runId}/${req.stepId}`;
      const ms = Math.max(0, req.expiresAt * 1000 - Date.now());
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve({ allow: false, remember: "once" });
      }, ms);
      this.pending.set(key, { resolve, timer });
    });
  }
}
