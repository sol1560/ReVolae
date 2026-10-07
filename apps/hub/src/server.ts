/**
 * `bun run apps/hub/src/server.ts [--port 8788] [--db hub.db]`
 * 环境变量：HUB_PORT、HUB_DB、HUB_JWT_SECRET、HUB_SELF_ACCOUNTS=1（手机免登录，账号由手机公钥派生）、HUB_PUBLIC_URL、APNS_TEAM_ID/APNS_KEY_ID/APNS_KEY_PEM/APNS_TOPIC/APNS_SANDBOX
 *          HUB_CLOUD_BRAIN_PROVIDER（设了就开云端大脑，值是默认模型 id）
 *          E2B_API_KEY 或 E2B_KEY（有 key 且开了云端大脑就开云电脑；HUB_CLOUD_COMPUTER=0 可关）、
 *          HUB_CLOUD_TEMPLATE（默认 cuaremote-cloud）、HUB_CLOUD_IDLE_SEC（空闲多久暂停，默认 600）、HUB_CLOUD_VARIANTS（没接 RevenueCat 时的分叉上限，默认 3）
 *          计费见 billing.ts 的 billingFromEnv；REVENUECAT_WEBHOOK_AUTH 设了就开 POST /webhooks/revenuecat
 */
import type { Server } from "bun";
import { CLOUD_TEMPLATE, CloudComputers, E2bProvider, e2bApiKey } from "@cuaremote/cloud-computer";
import { RevenueCatLedger, billingFromEnv, type RevenueCatWebhookEvent } from "./billing.js";
import { CloudBrainManager, type CloudBrainOptions } from "./cloud-brain.js";
import { CloudComputerService } from "./cloud-computer.js";
import { HubStore } from "./db.js";
import { Hub, type Conn, type HubOptions } from "./hub.js";
import { pushFromEnv } from "./push.js";

interface WsData {
  conn?: Conn;
}

export interface RevenueCatWebhookOptions {
  /** RevenueCat 后台 webhook 设置里填的 Authorization 头（原样比对） */
  authorization: string;
  ledger?: RevenueCatLedger;
}

export function createHubServer(opts: HubOptions & { port?: number; hostname?: string; cloudBrain?: CloudBrainOptions; revenueCatWebhook?: RevenueCatWebhookOptions }): { server: Server<WsData>; hub: Hub; url: string; cloudBrain?: CloudBrainManager } {
  let cloudBrain: CloudBrainManager | undefined;
  const cloud = opts.cloudBrain?.cloud;
  const hub = new Hub({
    ...opts,
    extraDevices: cloud ? (accountId) => [cloud.summary(accountId)] : opts.extraDevices,
    onPresence: (ev) => {
      cloudBrain?.onPresence(ev);
      opts.onPresence?.(ev);
    },
  });
  if (opts.cloudBrain) cloudBrain = new CloudBrainManager(hub, opts.cloudBrain);
  const server = Bun.serve<WsData>({
    port: opts.port ?? 8788,
    hostname: opts.hostname ?? "0.0.0.0",
    maxRequestBodySize: 1024 * 1024,
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024,
      idleTimeout: 120,
      open(ws) {
        ws.data.conn = { send: (d) => void ws.send(d), close: (c, r) => ws.close(c, r) };
        hub.onOpen(ws.data.conn);
      },
      message(ws, data) {
        if (ws.data.conn) hub.onMessage(ws.data.conn, typeof data === "string" ? data : new Uint8Array(data));
      },
      close(ws) {
        if (ws.data.conn) hub.onClose(ws.data.conn);
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/webhooks/revenuecat" && req.method === "POST") return onRevenueCatWebhook(req, hub, opts.revenueCatWebhook, opts.log);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("需要 WebSocket", { status: 426 });
      }
      const r = await hub.handleHttp(req);
      return r ?? new Response("CuaRemote hub\n", { status: 404 });
    },
  });
  return { server, hub, url: `ws://${server.hostname}:${server.port}/ws`, cloudBrain };
}

/**
 * RevenueCat webhook：购买、续订、虚拟货币变动都会来。我们不从 webhook 里记账（账以 RevenueCat 为准），
 * 只清掉缓存并把最新余额推给手机。
 */
async function onRevenueCatWebhook(req: Request, hub: Hub, o: RevenueCatWebhookOptions | undefined, log?: (l: string) => void): Promise<Response> {
  if (!o) return Response.json({ error: "webhook_disabled" }, { status: 404 });
  if (req.headers.get("authorization") !== o.authorization) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { event?: RevenueCatWebhookEvent } | null;
  const ev = body?.event;
  if (!ev?.type) return Response.json({ error: "bad_event" }, { status: 400 });
  const ids = [...new Set([ev.app_user_id, ev.original_app_user_id, ...(ev.aliases ?? [])].filter((x): x is string => !!x && !x.startsWith("$RCAnonymousID")))];
  let pushed = 0;
  for (const id of ids) {
    o.ledger?.invalidate(id);
    pushed += await hub.pushBillingStatus(id).catch(() => 0);
  }
  log?.(`RevenueCat ${ev.type} ${ev.environment ?? ""} → ${ids.join(",")}（推给 ${pushed} 台手机）`);
  return Response.json({ ok: true });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(arg("--port") ?? process.env.HUB_PORT ?? process.env.PORT ?? 8788);
  const dbPath = arg("--db") ?? process.env.HUB_DB ?? "hub.db";
  const store = new HubStore(dbPath);
  const billing = billingFromEnv(store);
  const brainLog = (r: Record<string, unknown>) => console.log(`[brain] ${JSON.stringify(r)}`);
  const e2bKey = e2bApiKey();
  const rcLedger = billing?.ledger instanceof RevenueCatLedger ? billing.ledger : undefined;
  // 有 RevenueCat 时按 pro 权益给分叉份数；本地开发没接就按环境变量（默认 3）
  const variantsAllowed = rcLedger ? async (acct: string) => ((await rcLedger.hasPro(acct).catch(() => false)) ? 3 : 1) : async () => Number(process.env.HUB_CLOUD_VARIANTS ?? 3);
  const cloud =
    process.env.HUB_CLOUD_BRAIN_PROVIDER && e2bKey && process.env.HUB_CLOUD_COMPUTER !== "0"
      ? new CloudComputerService({
          computers: new CloudComputers({
            provider: new E2bProvider(e2bKey),
            store,
            template: process.env.HUB_CLOUD_TEMPLATE ?? CLOUD_TEMPLATE,
            idleMs: Number(process.env.HUB_CLOUD_IDLE_SEC ?? 600) * 1000,
            log: brainLog,
          }),
          variantsAllowed,
          log: brainLog,
        })
      : undefined;
  const { hub, url } = createHubServer({
    port,
    store,
    push: pushFromEnv(),
    jwtSecret: process.env.HUB_JWT_SECRET,
    selfAccounts: process.env.HUB_SELF_ACCOUNTS === "1",
    publicURL: process.env.HUB_PUBLIC_URL ?? `ws://localhost:${port}/ws`,
    log: (l) => console.log(`[hub] ${l}`),
    billing,
    cloudBrain: process.env.HUB_CLOUD_BRAIN_PROVIDER ? { defaultProvider: process.env.HUB_CLOUD_BRAIN_PROVIDER, billing, cloud, log: brainLog } : undefined,
    revenueCatWebhook: process.env.REVENUECAT_WEBHOOK_AUTH ? { authorization: process.env.REVENUECAT_WEBHOOK_AUTH, ledger: rcLedger } : undefined,
  });
  console.log(`[hub] 监听 ${url}  db=${dbPath}  push=${hub.push.kind}  模式=${hub.singleUser ? "单机（不校验 JWT）" : "多账号"}  云端大脑=${process.env.HUB_CLOUD_BRAIN_PROVIDER ?? "关"}  云电脑=${cloud ? (process.env.HUB_CLOUD_TEMPLATE ?? CLOUD_TEMPLATE) : "关"}  计费=${billing ? billing.ledger.kind : "关"}`);
}
