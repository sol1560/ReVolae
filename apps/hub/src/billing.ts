import type { Cost, HubMessage, MsgBody } from "@cuaremote/protocol";
import type { HubStore } from "./db.js";

/**
 * 计费。只有云端大脑跑的 run 才计费：本地大脑用的是用户自己的 key，hub 见不到成本也不该收钱。
 *
 * 规则（PRD「托管服务定价」）：
 * - 免费层：每个自然月（UTC）N 次云端 run，超出后要有 credit 余额才能继续；最多绑 1 台被控设备；
 * - 付费层：按 run 的真实模型成本（美元）× (1 + margin) × creditsPerUsd 折成 credit，run 结束后扣；
 * - 一次 run 只扣一次（按 runId 幂等），预占成功但中途断线的 run 按已发生的成本结算。
 *
 * credit 账本在哪：接了 JustOne Connector（`JocLedger`）就以它为准；没接（开发 / 自建）用 hub 自己的 credits 表（`LocalLedger`）。
 */

export interface CreditLedger {
  readonly kind: string;
  balance(accountId: string): Promise<number>;
  /** 扣 credits；ref 是 runId，同一 ref 重复扣要幂等。返回扣后余额 */
  charge(accountId: string, credits: number, ref: string, memo: string): Promise<number>;
  /** 充值页地址（可选，手机端展示） */
  topUpURL?(accountId: string): string | undefined;
}

/** hub 自己的账本：开发 / 自建部署用。可以用 `addCredits` 手工充值 */
export class LocalLedger implements CreditLedger {
  readonly kind = "local";
  private readonly charged = new Set<string>();
  constructor(private readonly store: HubStore, private readonly now: () => number) {}
  async balance(accountId: string) {
    return this.store.getCredits(accountId);
  }
  async charge(accountId: string, credits: number, ref: string) {
    // 幂等靠 run_billing.settled；这里只兜进程内的重复调用
    if (this.charged.has(ref)) return this.store.getCredits(accountId);
    this.charged.add(ref);
    return this.store.addCredits(accountId, -credits, this.now());
  }
}

export interface JocLedgerOptions {
  baseURL: string;
  apiKey: string;
  /** 默认 /api/credits/balance 与 /api/credits/charge，JOC 那边如果路径不同在这里改 */
  balancePath?: string;
  chargePath?: string;
  topUpURL?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * JustOne Connector 的 credit 体系。
 * 接口契约是按「余额查询 + 幂等扣款」的最小假设写的，路径和字段可配：
 * - `GET  {baseURL}{balancePath}?account=<id>`            → `{ credits: number }`
 * - `POST {baseURL}{chargePath}` `{account, credits, ref, memo}` → `{ credits: number }`；同一 ref 再扣回 409 视为已扣成功
 * 都带 `Authorization: Bearer <apiKey>`。
 */
export class JocLedger implements CreditLedger {
  readonly kind = "joc";
  private readonly f: typeof fetch;
  constructor(private readonly o: JocLedgerOptions) {
    this.f = o.fetch ?? fetch;
  }
  private async req(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.f(`${this.o.baseURL.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* 非 JSON 响应按空对象处理 */
    }
    return { status: res.status, body };
  }
  async balance(accountId: string) {
    const r = await this.req(`${this.o.balancePath ?? "/api/credits/balance"}?account=${encodeURIComponent(accountId)}`, { method: "GET" });
    if (r.status !== 200) throw new Error(`JOC balance ${r.status}`);
    return Number(r.body.credits ?? 0);
  }
  async charge(accountId: string, credits: number, ref: string, memo: string) {
    const r = await this.req(this.o.chargePath ?? "/api/credits/charge", { method: "POST", body: JSON.stringify({ account: accountId, credits, ref, memo }) });
    if (r.status === 409) return this.balance(accountId); // 已扣过
    if (r.status !== 200) throw new Error(`JOC charge ${r.status}: ${String(r.body.error ?? "")}`);
    return Number(r.body.credits ?? 0);
  }
  topUpURL() {
    return this.o.topUpURL;
  }
}

export interface RevenueCatOptions {
  /** RevenueCat Developer API v2 的 secret key（sk_…），只放在 hub */
  secretKey: string;
  projectId: string;
  /** 虚拟货币代码，默认 CRD */
  currency?: string;
  /** 解锁分叉的权益 lookup key，默认 pro */
  proEntitlement?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 余额 / 权益缓存秒数（webhook 到了会清掉），默认 30 */
  cacheSec?: number;
  now?: () => number;
}

/**
 * RevenueCat 虚拟货币（In-App Currency）当 credit 账本：
 * - 手机端用 RevenueCat SDK 买额度包 / 订阅，RevenueCat 按商品配置自动发放 CRD；
 * - hub 用 Developer API v2 查余额、在 run 结算时扣（reference = runId）；
 * - appUserId 就是 hub 的 accountId（手机登录后 Purchases.logIn(accountId)）。
 * 虚拟货币只能是整数，扣款时向上取整（最少扣 1）。
 */
export class RevenueCatLedger implements CreditLedger {
  readonly kind = "revenuecat";
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly currency: string;
  private readonly proKey: string;
  private readonly cacheSec: number;
  private readonly now: () => number;
  private readonly balances = new Map<string, { v: number; at: number }>();
  private readonly pros = new Map<string, { v: boolean; at: number }>();
  private proEntitlementId?: Promise<string | undefined>;

  constructor(private readonly o: RevenueCatOptions) {
    this.f = o.fetch ?? fetch;
    this.base = `${(o.baseURL ?? "https://api.revenuecat.com/v2").replace(/\/$/, "")}/projects/${encodeURIComponent(o.projectId)}`;
    this.currency = o.currency ?? "CRD";
    this.proKey = o.proEntitlement ?? "pro";
    this.cacheSec = o.cacheSec ?? 30;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async req(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.f(`${this.base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.secretKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body };
  }

  private customer(accountId: string) {
    return `/customers/${encodeURIComponent(accountId)}`;
  }

  private pickBalance(body: Record<string, unknown>): number {
    const items = (body.items as { currency_code?: string; balance?: number }[] | undefined) ?? [];
    return Number(items.find((i) => i.currency_code === this.currency)?.balance ?? 0);
  }

  async balance(accountId: string): Promise<number> {
    const c = this.balances.get(accountId);
    if (c && this.now() - c.at < this.cacheSec) return c.v;
    const r = await this.req(`${this.customer(accountId)}/virtual_currencies?include_empty_balances=true`);
    // 还没在 RevenueCat 出现过的用户（从没打开过付费页）= 余额 0
    const v = r.status === 404 ? 0 : r.status === 200 ? this.pickBalance(r.body) : NaN;
    if (Number.isNaN(v)) throw new Error(`RevenueCat balance ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    this.balances.set(accountId, { v, at: this.now() });
    return v;
  }

  async charge(accountId: string, credits: number, ref: string, _memo: string): Promise<number> {
    const n = Math.max(1, Math.ceil(credits));
    const r = await this.req(`${this.customer(accountId)}/virtual_currencies/transactions`, {
      method: "POST",
      body: JSON.stringify({ adjustments: { [this.currency]: -n }, reference: ref }),
    });
    if (r.status === 422) {
      // 余额不够：能扣多少扣多少（run 已经跑完了），剩下的记日志由调用方重试
      this.invalidate(accountId);
      throw new Error(`RevenueCat 余额不足（要扣 ${n} ${this.currency}）`);
    }
    if (r.status !== 200) throw new Error(`RevenueCat charge ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const v = this.pickBalance(r.body);
    this.balances.set(accountId, { v, at: this.now() });
    return v;
  }

  /** 有没有 pro 权益（解锁分叉）。active_entitlements 只给内部 id，先按 lookup key 查一次 id 并缓存 */
  async hasPro(accountId: string): Promise<boolean> {
    const c = this.pros.get(accountId);
    if (c && this.now() - c.at < this.cacheSec) return c.v;
    this.proEntitlementId ??= this.req(`/entitlements?limit=100`).then((r) => {
      const items = (r.body.items as { id: string; lookup_key: string }[] | undefined) ?? [];
      return items.find((i) => i.lookup_key === this.proKey)?.id;
    });
    const id = await this.proEntitlementId;
    if (!id) {
      this.proEntitlementId = undefined; // 后台还没建这个权益，下次再查
      return false;
    }
    const r = await this.req(`${this.customer(accountId)}/active_entitlements`);
    const items = (r.body.items as { entitlement_id: string; expires_at: number | null }[] | undefined) ?? [];
    const v = r.status === 200 && items.some((i) => i.entitlement_id === id && (i.expires_at === null || i.expires_at > Date.now()));
    this.pros.set(accountId, { v, at: this.now() });
    return v;
  }

  /** webhook 到了：清掉这个账号的缓存 */
  invalidate(accountId: string) {
    this.balances.delete(accountId);
    this.pros.delete(accountId);
  }
}

/** RevenueCat webhook 里我们关心的字段 */
export interface RevenueCatWebhookEvent {
  type: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  environment?: string;
}

export interface BillingOptions {
  ledger: CreditLedger;
  /** 每月免费云端 run 次数（默认 50） */
  freeRunsPerMonth?: number;
  /** 免费层最多几台被控设备（默认 1） */
  freeDeviceLimit?: number;
  /** 模型成本加成（默认 0.3 = 30%） */
  margin?: number;
  /** 1 美元（含加成）= 多少 credit（默认 100） */
  creditsPerUsd?: number;
  now?: () => number;
  log?: (rec: Record<string, unknown>) => void;
}

export type BillingStatus = MsgBody<Extract<HubMessage, { type: "billing.status" }>>;

export type ReserveResult = { ok: true; kind: "free" | "credits" } | { ok: false; code: "credits_exhausted"; message: string };

/** 自然月（UTC）起止 */
export function monthWindow(nowSec: number): { start: number; end: number } {
  const d = new Date(nowSec * 1000);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { start, end };
}

export class Billing {
  readonly ledger: CreditLedger;
  readonly freeRuns: number;
  readonly freeDeviceLimit: number;
  readonly margin: number;
  readonly creditsPerUsd: number;
  private readonly now: () => number;
  private readonly log: (rec: Record<string, unknown>) => void;

  constructor(private readonly store: HubStore, o: BillingOptions) {
    this.ledger = o.ledger;
    this.freeRuns = o.freeRunsPerMonth ?? 50;
    this.freeDeviceLimit = o.freeDeviceLimit ?? 1;
    this.margin = o.margin ?? 0.3;
    this.creditsPerUsd = o.creditsPerUsd ?? 100;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = o.log ?? (() => {});
  }

  /** 美元成本 → 要扣的 credit（两位小数向上取整，避免 0 成本的 run 被免费漏过又不至于扣整数） */
  creditsFor(usd: number): number {
    return Math.ceil(usd * (1 + this.margin) * this.creditsPerUsd * 100) / 100;
  }

  async status(accountId: string): Promise<BillingStatus> {
    const { start, end } = monthWindow(this.now());
    const used = this.store.freeRunsSince(accountId, start);
    const credits = await this.ledger.balance(accountId);
    return {
      type: "billing.status",
      plan: credits > 0 ? "paid" : "free",
      freeRunsTotal: this.freeRuns,
      freeRunsUsed: Math.min(used, this.freeRuns),
      periodEndsAt: end,
      credits,
      creditsPerUsd: this.creditsPerUsd,
      freeDeviceLimit: this.freeDeviceLimit,
      topUpURL: this.ledger.topUpURL?.(accountId),
    };
  }

  /** 免费层还能不能再绑一台被控设备：只数已经和手机配过对的被控设备（登录了但没配对的不算） */
  async canAddDevice(accountId: string): Promise<boolean> {
    const devices = this.store.listAccountDevices(accountId).filter((d) => d.role === "device" && this.store.peersOf(d.deviceId).length > 0).length;
    if (devices < this.freeDeviceLimit) return true;
    return (await this.ledger.balance(accountId)) > 0;
  }

  /** run 开始前：先占免费次数，没有了看 credit 余额；同一 runId 重复预占返回同一结果 */
  async reserve(accountId: string, runId: string): Promise<ReserveResult> {
    const have = this.store.getRunBilling(runId);
    if (have) return { ok: true, kind: have.kind };
    const { start } = monthWindow(this.now());
    if (this.store.freeRunsSince(accountId, start) < this.freeRuns) {
      this.store.reserveRun({ runId, accountId, kind: "free" }, this.now());
      return { ok: true, kind: "free" };
    }
    let credits: number;
    try {
      credits = await this.ledger.balance(accountId);
    } catch (e) {
      this.log({ t: "billing_balance_failed", accountId, err: String(e) });
      return { ok: false, code: "credits_exhausted", message: "查不到余额，稍后再试" };
    }
    if (credits <= 0) return { ok: false, code: "credits_exhausted", message: `本月 ${this.freeRuns} 次免费额度已用完，充值后继续` };
    this.store.reserveRun({ runId, accountId, kind: "credits" }, this.now());
    return { ok: true, kind: "credits" };
  }

  /** run 结束后结算：免费 run 只记账不扣款；credits run 按成本扣。幂等 */
  async settle(accountId: string, runId: string, cost: Cost): Promise<{ credits: number; balance?: number }> {
    const row = this.store.getRunBilling(runId) ?? this.store.reserveRun({ runId, accountId, kind: "free" }, this.now());
    if (row.settled) return { credits: row.credits };
    const credits = row.kind === "credits" ? this.creditsFor(cost.usd) : 0;
    let balance: number | undefined;
    if (credits > 0) {
      try {
        balance = await this.ledger.charge(accountId, credits, runId, `CuaRemote run ${runId}`);
      } catch (e) {
        // 扣款失败不标 settled，下次同 runId 再来会重试
        this.log({ t: "billing_charge_failed", accountId, runId, credits, err: String(e) });
        throw e;
      }
    }
    this.store.settleRun(runId, credits, cost.usd, this.now());
    this.log({ t: "billing_settled", accountId, runId, kind: row.kind, usd: cost.usd, credits, balance });
    return { credits, balance };
  }
}

/**
 * 环境变量：
 * - `HUB_BILLING=off|local|joc|revenuecat`（默认：有 REVENUECAT_SECRET_KEY 就 revenuecat，有 JOC_BASE_URL 就 joc，否则 off）
 * - `REVENUECAT_SECRET_KEY` / `REVENUECAT_PROJECT_ID` / `REVENUECAT_CURRENCY`（CRD）/ `REVENUECAT_PRO_ENTITLEMENT`（pro）/ `REVENUECAT_WEBHOOK_AUTH`
 * - `JOC_BASE_URL` / `JOC_API_KEY` / `JOC_TOPUP_URL` / `JOC_BALANCE_PATH` / `JOC_CHARGE_PATH`
 * - `HUB_FREE_RUNS`（默认 50）/ `HUB_FREE_DEVICES`（1）/ `HUB_MARGIN`（0.3）/ `HUB_CREDITS_PER_USD`（100）
 */
export function billingFromEnv(store: HubStore, env: NodeJS.ProcessEnv = process.env): Billing | undefined {
  const mode = env.HUB_BILLING ?? (env.REVENUECAT_SECRET_KEY ? "revenuecat" : env.JOC_BASE_URL ? "joc" : "off");
  if (mode === "off") return undefined;
  const now = () => Math.floor(Date.now() / 1000);
  let ledger: CreditLedger;
  if (mode === "revenuecat") {
    if (!env.REVENUECAT_SECRET_KEY || !env.REVENUECAT_PROJECT_ID) throw new Error("HUB_BILLING=revenuecat 需要 REVENUECAT_SECRET_KEY 和 REVENUECAT_PROJECT_ID");
    ledger = new RevenueCatLedger({ secretKey: env.REVENUECAT_SECRET_KEY, projectId: env.REVENUECAT_PROJECT_ID, currency: env.REVENUECAT_CURRENCY, proEntitlement: env.REVENUECAT_PRO_ENTITLEMENT });
  } else if (mode === "joc") {
    if (!env.JOC_BASE_URL || !env.JOC_API_KEY) throw new Error("HUB_BILLING=joc 需要 JOC_BASE_URL 和 JOC_API_KEY");
    ledger = new JocLedger({ baseURL: env.JOC_BASE_URL, apiKey: env.JOC_API_KEY, topUpURL: env.JOC_TOPUP_URL, balancePath: env.JOC_BALANCE_PATH, chargePath: env.JOC_CHARGE_PATH });
  } else {
    ledger = new LocalLedger(store, now);
  }
  const num = (k: string) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : undefined);
  return new Billing(store, {
    ledger,
    freeRunsPerMonth: num("HUB_FREE_RUNS"),
    freeDeviceLimit: num("HUB_FREE_DEVICES"),
    margin: num("HUB_MARGIN"),
    creditsPerUsd: num("HUB_CREDITS_PER_USD"),
    now,
    log: (r) => console.log(`[billing] ${JSON.stringify(r)}`),
  });
}
