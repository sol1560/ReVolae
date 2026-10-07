import { posix } from "node:path";
import type { Host, ToolResult } from "@cuaremote/brain";
import type { Scope, ToolDescriptor } from "@cuaremote/protocol";
import { WORK_DIR } from "./constants.js";
import type { SandboxHandle } from "./handle.js";
const MAX_OUTPUT = 32_000;

const common = { staticLevel: 0, costClass: 0, dataLeavesDevice: true, sandboxed: true } as const;

/**
 * 云电脑工具表。全部标 sandboxed：沙箱里删改、装软件都能整机撤销，
 * 策略引擎只对「把数据发出沙箱」的命令要求确认。
 */
export const CLOUD_TOOLS: ToolDescriptor[] = [
  {
    ...common,
    name: "shell.run",
    description: `在云电脑（Debian 12，用户 user，可以 sudo）里用 bash 跑一条命令，返回 stdout+stderr。默认目录 ${WORK_DIR}。已装 python3/uv、node/bun、git、ffmpeg、pandoc、LibreOffice（soffice --headless）、ImageMagick、poppler、chromium、faster-whisper、yt-dlp。PDF 转 Word 用「pdf2docx convert in.pdf out.docx」（保留排版最好）；Word/Excel/PPT 转 PDF 用「soffice --headless --convert-to pdf」。要长期运行的服务（网页服务器等）把 background 设为 true，再用 cloud.preview 拿链接。`,
    channel: "shell",
    inputSchema: { type: "object", properties: { cmd: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer" }, background: { type: "boolean" } }, required: ["cmd"] },
  },
  {
    ...common,
    name: "fs.list",
    description: "列云电脑里的目录。返回名字、类型、大小。",
    channel: "fs",
    inputSchema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 3 } }, required: ["path"] },
  },
  {
    ...common,
    name: "fs.read",
    description: "读云电脑里文本文件的前 maxBytes 字节（默认 16KB）。",
    channel: "fs",
    inputSchema: { type: "object", properties: { path: { type: "string" }, maxBytes: { type: "integer" } }, required: ["path"] },
  },
  {
    ...common,
    name: "fs.write",
    description: "在云电脑里写一个文本文件（覆盖），目录不存在会自动创建。",
    channel: "fs",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    ...common,
    name: "cloud.preview",
    description: "等云电脑里某个端口开始监听，返回手机能直接打开的 https 预览链接。先用 shell.run(background=true) 启动服务。",
    channel: "cloud",
    inputSchema: { type: "object", properties: { port: { type: "integer" }, path: { type: "string" }, waitMs: { type: "integer" } }, required: ["port"] },
  },
  {
    ...common,
    name: "cloud.download",
    description: "把云电脑里做好的文件交给用户：返回一个 1 小时内有效的下载链接，手机上会显示成下载按钮。任务产出文件时最后一步调用它。",
    channel: "cloud",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    ...common,
    costClass: 2,
    name: "browser.screenshot",
    description: "用云电脑里的无头 Chromium 打开一个网址（可以是 http://localhost:端口）并截图，返回 PNG。用来检查做出来的网页长什么样。",
    channel: "cloud",
    inputSchema: { type: "object", properties: { url: { type: "string" }, width: { type: "integer" }, height: { type: "integer" } }, required: ["url"] },
  },
];

export interface PreviewEvent {
  port: number;
  url: string;
}

export interface DownloadEvent {
  path: string;
  name: string;
  size: number;
  url: string;
}

export interface E2bHostOptions {
  /** 拿到（必要时唤醒）这台机器；每次工具调用前都会调 */
  sandbox: () => Promise<SandboxHandle>;
  /** 有了预览链接 / 可下载文件时通知 hub，推给手机 */
  onPreview?: (e: PreviewEvent) => void;
  onDownload?: (e: DownloadEvent) => void;
  /** 等端口的轮询间隔，测试里调小 */
  pollMs?: number;
}

/** 工具经 E2B SDK 在云电脑里执行的宿主 */
export class E2bHost implements Host {
  readonly scope: Scope = { allowedDirs: ["/"], allowedApps: [], deniedCommands: [] };

  constructor(private readonly o: E2bHostOptions) {}

  async listTools() {
    return { tools: CLOUD_TOOLS, scope: this.scope };
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<ToolResult> {
    const t0 = Date.now();
    const done = (r: Omit<ToolResult, "ms" | "attachments"> & Partial<Pick<ToolResult, "attachments">>): ToolResult => ({ attachments: [], ...r, ms: Date.now() - t0 });
    try {
      const sb = await this.o.sandbox();
      switch (tool) {
        case "shell.run": {
          const cmd = String(args.cmd ?? "");
          if (!cmd.trim()) return done({ ok: false, error: "cmd 为空" });
          const cwd = resolvePath(args.cwd as string | undefined);
          const r = await sb.run(cmd, { cwd, timeoutMs: Number(args.timeoutMs ?? timeoutMs), background: args.background === true });
          const output = clip(r.stdout + (r.stderr ? (r.stdout ? "\n" : "") + r.stderr : ""));
          return r.exitCode === 0 ? done({ ok: true, output }) : done({ ok: false, output, error: `退出码 ${r.exitCode}` });
        }
        case "fs.list": {
          const depth = Math.min(Math.max(Number(args.depth ?? 1), 1), 3);
          const base = resolvePath(args.path as string);
          const items = await sb.list(base, depth);
          const lines = items.slice(0, 300).map((e) => `${posix.relative(base, e.path) || e.name}${e.type === "dir" ? "/" : `  ${e.size}B`}`);
          if (items.length > 300) lines.push(`…还有 ${items.length - 300} 项`);
          return done({ ok: true, output: lines.join("\n") || "（空目录）" });
        }
        case "fs.read": {
          const max = Math.min(Number(args.maxBytes ?? 16_384), 256_000);
          const buf = await sb.read(resolvePath(args.path as string));
          const text = new TextDecoder().decode(buf.subarray(0, max));
          return done({ ok: true, output: buf.length > max ? `${text}\n…(截断，共 ${buf.length} 字节)` : text });
        }
        case "fs.write": {
          const p = resolvePath(args.path as string);
          await sb.run(`mkdir -p ${shq(posix.dirname(p))}`);
          await sb.write(p, String(args.content ?? ""));
          return done({ ok: true, output: `已写入 ${p}` });
        }
        case "cloud.preview": {
          const port = Number(args.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) return done({ ok: false, error: "port 不合法" });
          const up = await this.waitForPort(sb, port, Number(args.waitMs ?? 30_000));
          if (!up) return done({ ok: false, error: `端口 ${port} 在等待时间内没有开始监听；先确认服务启动成功（看日志）` });
          const path = typeof args.path === "string" && args.path.startsWith("/") ? args.path : "/";
          const url = `https://${sb.host(port)}${path}`;
          this.o.onPreview?.({ port, url });
          return done({ ok: true, output: `预览链接：${url}（已推送到用户手机）` });
        }
        case "cloud.download": {
          const p = resolvePath(args.path as string);
          const info = (await sb.list(posix.dirname(p), 1)).find((e) => e.path === p || e.name === posix.basename(p));
          if (!info || info.type !== "file") return done({ ok: false, error: `找不到文件 ${p}` });
          const url = await sb.downloadUrl(p, 3600);
          this.o.onDownload?.({ path: p, name: info.name, size: info.size, url });
          return done({ ok: true, output: `已把 ${info.name}（${info.size} 字节）的下载按钮推送到用户手机` });
        }
        case "browser.screenshot": {
          const url = String(args.url ?? "");
          if (!/^https?:\/\//.test(url)) return done({ ok: false, error: "url 必须以 http:// 或 https:// 开头" });
          const w = clampInt(args.width, 390, 320, 1920);
          const h = clampInt(args.height, 844, 320, 2400);
          const file = `/tmp/cuaremote-shot-${Date.now()}.png`;
          const r = await sb.run(`chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=3000 --window-size=${w},${h} --screenshot=${file} ${shq(url)}`, { timeoutMs: 45_000 });
          if (r.exitCode !== 0) return done({ ok: false, error: `截图失败：${clip(r.stderr, 2000)}` });
          const png = await sb.read(file);
          return done({ ok: true, output: `截图 ${w}x${h}（2 倍），${png.length} 字节`, attachments: [{ kind: "image/png", inline: Buffer.from(png).toString("base64") }] });
        }
        default:
          return done({ ok: false, error: `没有工具 ${tool}` });
      }
    } catch (e) {
      return done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async waitForPort(sb: SandboxHandle, port: number, waitMs: number) {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 120_000);
    const probe = `ss -ltnH 'sport = :${port}' | grep -q .`;
    for (;;) {
      if ((await sb.run(probe, { timeoutMs: 5000 })).exitCode === 0) return true;
      if (Date.now() >= deadline) return false;
      await Bun.sleep(this.o.pollMs ?? 500);
    }
  }
}

/** 相对路径以工作目录为根；~ 是 /home/user */
export function resolvePath(p: string | undefined): string {
  if (!p) return WORK_DIR;
  const expanded = p.replace(/^~(?=$|\/)/, "/home/user");
  return posix.resolve(WORK_DIR, expanded);
}

function clip(s: string, max = MAX_OUTPUT) {
  return s.length > max ? `${s.slice(0, max)}\n…(截断，共 ${s.length} 字符)` : s;
}

function clampInt(v: unknown, dflt: number, min: number, max: number) {
  const n = Number(v ?? dflt);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : dflt;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
