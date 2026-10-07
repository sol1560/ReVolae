/**
 * 网页预览服务器：把 `expo export --platform web` 的产物当静态站点发出去，并把 /ws 的 WebSocket 原样转给 hub。
 * 这样浏览器只需要一个地址（同源），手机浏览器也能直接打开看界面。
 *   bun run apps/mobile/scripts/web-preview.ts --dist /tmp/mobile-web --port 8790 --hub ws://localhost:8788/ws
 */
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const dist = arg("--dist", "/tmp/mobile-web");
const port = Number(arg("--port", process.env.PORT ?? "8790"));
const hub = arg("--hub", "ws://localhost:8788/ws");

interface Pipe {
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
}

Bun.serve<Pipe>({
  port,
  hostname: "0.0.0.0",
  websocket: {
    maxPayloadLength: 8 * 1024 * 1024,
    open(ws) {
      const up = new WebSocket(hub);
      up.binaryType = "arraybuffer";
      ws.data.upstream = up;
      up.onopen = () => {
        for (const m of ws.data.queue.splice(0)) up.send(m);
      };
      up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      up.onclose = () => ws.close();
    },
    message(ws, m) {
      const up = ws.data.upstream;
      const data = typeof m === "string" ? m : new Uint8Array(m);
      if (up?.readyState === WebSocket.OPEN) up.send(data);
      else ws.data.queue.push(data);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: { queue: [] } })) return undefined as unknown as Response;
      return new Response("需要 WebSocket", { status: 426 });
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    for (const cand of [rel, `${rel}.html`, join(rel, "index.html")]) {
      const p = join(dist, cand);
      if (p.startsWith(dist) && existsSync(p) && !(await Bun.file(p).stat()).isDirectory()) return new Response(Bun.file(p));
    }
    // 单页应用：没匹配到的路由都回首页
    return new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`网页预览：http://localhost:${port}  →  hub ${hub}`);
