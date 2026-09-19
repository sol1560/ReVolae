#!/usr/bin/env bun
/**
 * CuaRemote PoC 网页版：手机 Safari 打开 http://<mac 的局域网 ip>:8787
 *   bun run apps/poc-web/src/server.ts [--port 8787] [--provider mock] [--autonomy balanced] [--no-gui]
 * 大脑和宿主都在本机（LocalBunHost），手机只是显示和确认。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { CuaDriver, JevClient, JsonlLog, LocalBunHost, type Autonomy } from "@cuaremote/brain";
import type { DeviceToPhone, HistoryItem } from "@cuaremote/protocol";
import { PocSession } from "./session.js";

export interface PocServerOptions {
  port?: number;
  hostname?: string;
  defaultProvider?: string;
  autonomy?: Autonomy;
  gui?: CuaDriver;
  logPath?: string;
  env?: Record<string, string | undefined>;
}

/** 手机页面里的模型下拉：哪些能用取决于本机有没有对应的 key */
export function providerOptions(env: Record<string, string | undefined> = process.env) {
  return [
    { id: "mock", label: "本地假模型（演示）", tier: "local", available: true },
    { id: "anthropic:claude-fable-5.1", label: "Claude Fable 5.1", tier: "standard", available: Boolean(env.ANTHROPIC_API_KEY) },
    { id: "openai:gpt-6-astra", label: "GPT-6 Astra", tier: env.OPENAI_ZDR === "1" ? "zdr" : "standard", available: Boolean(env.OPENAI_API_KEY) },
    { id: "zenmux:anthropic/claude-fable-5.1", label: "Claude Fable 5.1（zenmux）", tier: "standard", available: Boolean(env.ZENMUX_API_KEY) },
    { id: "ollama:muse-glimmer:30b-mlx", label: "Muse Glimmer 30B（Ollama 本地）", tier: "local", available: true },
    { id: "lmstudio:qwen3.8-27b", label: "Qwen3.8 27B（LM Studio 本地）", tier: "local", available: true },
  ];
}

const INDEX = Bun.file(new URL("./public/index.html", import.meta.url));

export function createPocServer(o: PocServerOptions = {}) {
  const env = o.env ?? process.env;
  const host = new LocalBunHost();
  const jev = new JevClient({ apiKey: env.TYPESAFE_API_KEY });
  const log = o.logPath ? new JsonlLog(o.logPath) : undefined;
  const history: HistoryItem[] = [];
  const sessions = new Map<object, PocSession>();

  const server = Bun.serve<{ session?: PocSession }>({
    port: o.port ?? 8787,
    hostname: o.hostname ?? "0.0.0.0",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: {} })) return undefined;
        return new Response("需要 WebSocket", { status: 426 });
      }
      if (url.pathname === "/api/providers") {
        return Response.json({ default: o.defaultProvider ?? "mock", autonomy: o.autonomy ?? "balanced", options: providerOptions(env) });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(INDEX, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const session = new PocSession({
          send: (m: DeviceToPhone) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
          defaultProvider: o.defaultProvider ?? "mock",
          autonomy: o.autonomy ?? "balanced",
          host,
          jev,
          gui: o.gui,
          log: log ? (r) => log.write(r) : undefined,
          history,
        });
        ws.data.session = session;
        sessions.set(ws, session);
        void session.hello();
      },
      message(ws, data) {
        let obj: unknown;
        try {
          obj = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
        } catch {
          ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), type: "error", code: "bad_json", message: "不是合法 JSON" }));
          return;
        }
        void ws.data.session?.handle(obj);
      },
      close(ws) {
        ws.data.session?.close();
        sessions.delete(ws);
      },
    },
  });
  return { server, history, close: () => { for (const s of sessions.values()) s.close(); server.stop(true); } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(flag("port") ?? process.env.CUAREMOTE_POC_PORT ?? 8787);
  const gui = new CuaDriver({ argv: flag("cua")?.split(" ") });
  const guiUp = argv.includes("--no-gui") ? false : await gui.start();
  const { server } = createPocServer({
    port,
    defaultProvider: flag("provider") ?? process.env.CUAREMOTE_PROVIDER ?? "mock",
    autonomy: (flag("autonomy") as Autonomy | undefined) ?? "balanced",
    gui: guiUp ? gui : undefined,
    logPath: flag("log") ?? join(homedir(), ".cuaremote", "logs", `poc-web-${new Date().toISOString().slice(0, 10)}.jsonl`),
  });
  console.log(`CuaRemote PoC 网页版：http://localhost:${server.port}  （手机用 http://<本机局域网 IP>:${server.port}）`);
  console.log(`模型：${flag("provider") ?? process.env.CUAREMOTE_PROVIDER ?? "mock"}，GUI：${guiUp ? "cua-driver 已连" : "关"}，Jev：${process.env.TYPESAFE_API_KEY ? "开" : "无 key，用静态分级"}`);
}
