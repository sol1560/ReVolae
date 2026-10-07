/** 独立的原生网络测试服务：真实 Hub/JWT/签名，仅在回环地址提供受密钥保护的断网控制。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hub } from "../../hub/src/hub.ts";
import { HubStore } from "../../hub/src/db.ts";
import { signJwt } from "../../hub/src/auth.ts";

const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("需要全新私有测试目录");
mkdirSync(directory, { mode: 0o700 });
const secret = crypto.randomUUID(), control = crypto.randomUUID();
const store = new HubStore(":memory:"), hub = new Hub({ store, jwtSecret: secret });
type Socket = Bun.ServerWebSocket<{ conn: { send: (data: string | Uint8Array) => void; close: (code: number, reason: string) => void } }>;
const sockets = new Set<Socket>();
let opened = 0, renames = 0;
const server = Bun.serve<Socket["data"]>({
  hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/ws" && server.upgrade(request, { data: {} as Socket["data"] })) return;
    if (request.headers.get("authorization") !== `Bearer ${control}`) return new Response(null, { status: 403 });
    if (path === "/counts") return Response.json({ opened, renames });
    if (path !== "/control" || request.method !== "POST") return new Response(null, { status: 404 });
    const action = await request.text();
    if (action === "stop") {
      setTimeout(() => { server.stop(true); store.close(); process.exit(0); }, 100);
    } else if (action === "network") {
      for (const socket of sockets) socket.terminate();
    } else if (action === "invalid") {
      for (const socket of sockets) socket.send("not JSON");
    } else if (["1000", "4001"].includes(action)) {
      for (const socket of sockets) socket.close(Number(action), "isolated native test");
    } else return new Response(null, { status: 400 });
    return Response.json({ sent: true });
  },
  websocket: {
    open(socket) {
      opened++; sockets.add(socket);
      socket.data.conn = { send: data => { socket.send(data); }, close: (code, reason) => socket.close(code, reason) };
      hub.onOpen(socket.data.conn);
    },
    message(socket, data) {
      if (typeof data === "string" && JSON.parse(data).type === "device.rename") renames++;
      hub.onMessage(socket.data.conn, typeof data === "string" ? data : new Uint8Array(data));
    },
    close(socket) { hub.onClose(socket.data.conn); sockets.delete(socket); },
  },
});
const token = signJwt({ sub: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 }, secret);
writeFileSync(resolve(directory, "connection.json"), JSON.stringify({
  E2E_RECONNECT_URL: `ws://127.0.0.1:${server.port}/ws`, E2E_RECONNECT_TOKEN: token,
  E2E_RECONNECT_CONTROL: control,
}), { mode: 0o600 });
console.log("RECONNECT_TEST_HUB_READY");
