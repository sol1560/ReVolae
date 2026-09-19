/**
 * `bun run apps/hub/src/server.ts [--port 8788] [--db hub.db]`
 * 环境变量：HUB_PORT、HUB_DB、HUB_JWT_SECRET、HUB_PUBLIC_URL、APNS_TEAM_ID/APNS_KEY_ID/APNS_KEY_PEM/APNS_TOPIC/APNS_SANDBOX
 *          HUB_CLOUD_BRAIN_PROVIDER（设了就开云端大脑，值是默认模型 id）
 */
import type { Server } from "bun";
import { CloudBrainManager, type CloudBrainOptions } from "./cloud-brain.js";
import { HubStore } from "./db.js";
import { Hub, type Conn, type HubOptions } from "./hub.js";
import { pushFromEnv } from "./push.js";

interface WsData {
  conn?: Conn;
}

export function createHubServer(opts: HubOptions & { port?: number; hostname?: string; cloudBrain?: CloudBrainOptions }): { server: Server<WsData>; hub: Hub; url: string; cloudBrain?: CloudBrainManager } {
  let cloudBrain: CloudBrainManager | undefined;
  const hub = new Hub({
    ...opts,
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(arg("--port") ?? process.env.HUB_PORT ?? 8788);
  const dbPath = arg("--db") ?? process.env.HUB_DB ?? "hub.db";
  const { hub, url } = createHubServer({
    port,
    store: new HubStore(dbPath),
    push: pushFromEnv(),
    jwtSecret: process.env.HUB_JWT_SECRET,
    publicURL: process.env.HUB_PUBLIC_URL ?? `ws://localhost:${port}/ws`,
    log: (l) => console.log(`[hub] ${l}`),
    cloudBrain: process.env.HUB_CLOUD_BRAIN_PROVIDER ? { defaultProvider: process.env.HUB_CLOUD_BRAIN_PROVIDER, log: (r) => console.log(`[brain] ${JSON.stringify(r)}`) } : undefined,
  });
  console.log(`[hub] 监听 ${url}  db=${dbPath}  push=${hub.push.kind}  模式=${hub.singleUser ? "单机（不校验 JWT）" : "多账号"}  云端大脑=${process.env.HUB_CLOUD_BRAIN_PROVIDER ?? "关"}`);
}
