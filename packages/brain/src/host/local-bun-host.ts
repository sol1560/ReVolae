import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";
import type { Scope, ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "./types.js";
import { TERMINAL_BLOCKS_DESCRIPTOR, type TerminalManager } from "../terminal/manager.js";

const isMac = process.platform === "darwin";
/** 单引号包起来给 sh 用 */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 宿主本地工具表：Swift daemon 也要实现同一张表（docs/protocol.md） */
export const LOCAL_TOOLS: ToolDescriptor[] = [
  {
    name: "shell.run",
    description: "在用户默认 shell 里运行一条命令，返回 stdout+stderr。适合文件操作、git、脚本、包管理。",
    channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: { cmd: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer" }, stdin: { type: "string" } }, required: ["cmd"] },
  },
  {
    name: "applescript.run",
    description: "运行 AppleScript，控制 Finder / Mail / Safari / Pages / Music 等 Apple 应用。",
    channel: "applescript", staticLevel: 1, costClass: 0, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: { script: { type: "string" }, timeoutMs: { type: "integer" } }, required: ["script"] },
  },
  {
    name: "jxa.run",
    description: "运行 JavaScript for Automation（osascript -l JavaScript）。",
    channel: "jxa", staticLevel: 1, costClass: 0, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
  },
  {
    name: "shortcuts.run",
    description: "运行用户已有的「快捷指令」。",
    channel: "shortcuts", staticLevel: 1, costClass: 0, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: { name: { type: "string" }, input: { type: "string" } }, required: ["name"] },
  },
  { name: "shortcuts.list", description: "列出用户的快捷指令名字。", channel: "shortcuts", staticLevel: 0, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object", properties: {} } },
  {
    name: "fs.list",
    description: "列目录（只读）。返回名字、类型、大小。",
    channel: "fs", staticLevel: 0, costClass: 0, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 3 } }, required: ["path"] },
  },
  {
    name: "fs.read",
    description: "读取文本文件前 maxBytes 字节（默认 16KB，只读）。",
    channel: "fs", staticLevel: 0, costClass: 0, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: { path: { type: "string" }, maxBytes: { type: "integer" } }, required: ["path"] },
  },
  {
    name: "screenshot",
    description: "截取整屏或某个应用窗口，返回 JPEG。很贵，只有 CLI/脚本做不到时才用。",
    channel: "gui", staticLevel: 0, costClass: 2, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: { app: { type: "string" }, maxWidth: { type: "integer" } } },
  },
  { name: "apps.running", description: "列出正在运行的应用（名字 + bundle id）。", channel: "app", staticLevel: 0, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object", properties: {} } },
];

/**
 * 有 adb 时多一个底层工具；模型看不到它，大脑侧 AdbHost 把它包成和 Android daemon 同名的 android.* 工具。
 * cmd 是 adb 子命令（不含 "adb"），经 sh -c 运行；image=true 把 stdout 当图片（screencap -p 的 PNG），Mac 上用 sips 缩成 JPEG。
 */
export const ADB_TOOL: ToolDescriptor = {
  name: "android.adb",
  description: "对通过 adb 连接的 Android 设备执行一条 adb 子命令。",
  channel: "android", staticLevel: 1, costClass: 0, dataLeavesDevice: true,
  inputSchema: { type: "object", properties: { serial: { type: "string" }, cmd: { type: "string" }, timeoutMs: { type: "integer" }, image: { type: "boolean" }, maxWidth: { type: "integer" } }, required: ["cmd"] },
};

export interface LocalHostOptions {
  scope?: Partial<Scope>;
  shell?: string;
  /** 用登录 shell（-l）跑命令，拿到用户的 PATH；测试里关掉 */
  loginShell?: boolean;
  /** 有远程终端会话时挂上，工具表多一个 terminal.blocks */
  terminals?: TerminalManager;
}

/** M0：大脑和被控设备是同一台机器时的宿主 */
export class LocalBunHost implements Host {
  readonly scope: Scope;
  private readonly shell: string;
  private readonly loginShell: boolean;
  private readonly terminals?: TerminalManager;

  constructor(opts: LocalHostOptions = {}) {
    this.loginShell = opts.loginShell ?? true;
    this.terminals = opts.terminals;
    this.scope = {
      allowedDirs: opts.scope?.allowedDirs ?? [homedir()],
      allowedApps: opts.scope?.allowedApps ?? [],
      deniedCommands: opts.scope?.deniedCommands ?? ["sudo", "rm -rf /", "diskutil", "csrutil", "mkfs", "dd if="],
    };
    this.shell = opts.shell ?? (isMac ? "/bin/zsh" : "/bin/sh");
  }

  async listTools() {
    const base = isMac ? LOCAL_TOOLS : LOCAL_TOOLS.filter((t) => !["applescript.run", "jxa.run", "shortcuts.run", "shortcuts.list"].includes(t.name));
    const tools = [...base, ...(this.adb() ? [ADB_TOOL] : []), ...(this.terminals ? [TERMINAL_BLOCKS_DESCRIPTOR] : [])];
    return { tools, scope: this.scope };
  }

  private adb(): string | undefined {
    return process.env.CUAREMOTE_ADB || Bun.which("adb") || undefined;
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> {
    const t0 = Date.now();
    const done = (r: Omit<ToolResult, "ms" | "attachments"> & Partial<Pick<ToolResult, "attachments">>): ToolResult => ({ attachments: [], ...r, ms: Date.now() - t0 });
    try {
      switch (tool) {
        case "shell.run": {
          const cmd = String(args.cmd ?? "");
          const denied = this.scope.deniedCommands.find((d) => cmd.includes(d));
          if (denied) return done({ ok: false, error: `命令包含被禁止的片段「${denied}」` });
          const cwd = args.cwd ? this.checkPath(String(args.cwd)) : undefined;
          return done(await this.exec([this.shell, this.loginShell ? "-lc" : "-c", cmd], { cwd, timeoutMs: Number(args.timeoutMs ?? timeoutMs), stdin: args.stdin as string | undefined }));
        }
        case "applescript.run":
          return done(await this.exec(["osascript", "-e", String(args.script)], { timeoutMs: Number(args.timeoutMs ?? timeoutMs) }));
        case "jxa.run":
          return done(await this.exec(["osascript", "-l", "JavaScript", "-e", String(args.script)], { timeoutMs }));
        case "shortcuts.run": {
          const a = ["shortcuts", "run", String(args.name)];
          return done(await this.exec(a, { timeoutMs, stdin: args.input as string | undefined }));
        }
        case "shortcuts.list":
          return done(await this.exec(["shortcuts", "list"], { timeoutMs }));
        case "fs.list": {
          const p = this.checkPath(String(args.path));
          const depth = Math.min(Math.max(Number(args.depth ?? 1), 1), 3);
          return done({ ok: true, output: await this.listDir(p, depth, "") });
        }
        case "fs.read": {
          const p = this.checkPath(String(args.path));
          const max = Math.min(Number(args.maxBytes ?? 16_384), 256_000);
          const buf = await readFile(p);
          const text = buf.subarray(0, max).toString("utf8");
          return done({ ok: true, output: buf.length > max ? `${text}\n…(截断，共 ${buf.length} 字节)` : text });
        }
        case "screenshot": {
          if (!isMac) return done({ ok: false, error: "此平台没有截图实现" });
          const file = `/tmp/cuaremote-shot-${Date.now()}.jpg`;
          const r = await this.exec(["screencapture", "-x", "-t", "jpg", file], { timeoutMs: 10_000 });
          if (!r.ok) return done(r);
          const data = await readFile(file);
          return done({ ok: true, output: `截图 ${data.length} 字节`, attachments: [{ kind: "image/jpeg", inline: data.toString("base64") }] });
        }
        case "terminal.blocks": {
          if (!this.terminals) return done({ ok: false, error: "这台机器没有远程终端会话" });
          return done(await this.terminals.callBlocks(args));
        }
        case "android.adb": {
          const adb = this.adb();
          if (!adb) return done({ ok: false, error: "这台机器没有 adb" });
          const serial = args.serial ? ["-s", String(args.serial)] : [];
          const cmd = String(args.cmd ?? "");
          const shellCmd = [adb, ...serial].map(shq).join(" ") + " " + cmd;
          const to = Number(args.timeoutMs ?? 30_000);
          if (!args.image) return done(await this.exec(["/bin/sh", "-c", shellCmd], { timeoutMs: to }));
          const png = await this.execBytes(["/bin/sh", "-c", shellCmd], to);
          if (!png.ok) return done({ ok: false, error: png.error, output: png.text });
          if (png.bytes.length < 8) return done({ ok: false, error: "adb 没回图片数据" });
          if (isMac) {
            const src = `/tmp/cuaremote-adb-${Date.now()}.png`;
            const dst = src.replace(/\.png$/, ".jpg");
            await Bun.write(src, png.bytes);
            const r = await this.exec(["sips", "-Z", String(Number(args.maxWidth ?? 720)), "-s", "format", "jpeg", "-s", "formatOptions", "70", src, "--out", dst], { timeoutMs: 15_000 });
            if (r.ok) {
              const jpg = await readFile(dst);
              return done({ ok: true, output: `截图 ${jpg.length} 字节`, attachments: [{ kind: "image/jpeg", inline: jpg.toString("base64") }] });
            }
          }
          return done({ ok: true, output: `截图 ${png.bytes.length} 字节（PNG 原图）`, attachments: [{ kind: "image/png", inline: Buffer.from(png.bytes).toString("base64") }] });
        }
        case "apps.running": {
          if (!isMac) return done({ ok: false, error: "此平台没有实现" });
          return done(await this.exec(["osascript", "-e", 'tell application "System Events" to get {name, bundle identifier} of every application process whose background only is false'], { timeoutMs: 8_000 }));
        }
        default:
          return done({ ok: false, error: `没有工具 ${tool}` });
      }
    } catch (e) {
      return done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 路径必须落在 allowedDirs 内 */
  private checkPath(p: string): string {
    const abs = resolve(p.replace(/^~(?=$|\/)/, homedir()));
    const ok = this.scope.allowedDirs.some((d) => {
      const rel = relative(resolve(d.replace(/^~(?=$|\/)/, homedir())), abs);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!ok) throw new Error(`路径 ${abs} 不在允许的目录里（${this.scope.allowedDirs.join(", ")}）`);
    return abs;
  }

  private async listDir(dir: string, depth: number, indent: string): Promise<string> {
    const entries = await readdir(dir, { withFileTypes: true });
    const lines: string[] = [];
    for (const e of entries.slice(0, 200)) {
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        if (depth > 1) lines.push(await this.listDir(join(dir, e.name), depth - 1, indent + "  "));
      } else {
        const s = await stat(join(dir, e.name)).catch(() => null);
        lines.push(`${indent}${e.name}${s ? `  ${s.size}B` : ""}`);
      }
    }
    if (entries.length > 200) lines.push(`${indent}…还有 ${entries.length - 200} 项`);
    return lines.filter(Boolean).join("\n");
  }

  /** stdout 按字节拿（图片）；失败时 text 是 stderr */
  private async execBytes(argv: string[], timeoutMs: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string; text: string }> {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, CUAREMOTE: "1" } });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? { ok: true, bytes: new Uint8Array(out) } : { ok: false, error: `退出码 ${code}`, text: err.slice(0, 4000) };
  }

  private async exec(argv: string[], o: { cwd?: string; timeoutMs: number; stdin?: string }): Promise<Omit<ToolResult, "ms" | "attachments">> {
    const proc = Bun.spawn(argv, { cwd: o.cwd, stdout: "pipe", stderr: "pipe", stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : undefined, env: { ...process.env, CUAREMOTE: "1" } });
    const timer = setTimeout(() => proc.kill(), o.timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const output = (out + (err ? (out ? "\n" : "") + err : "")).slice(0, 32_000);
    return code === 0 ? { ok: true, output } : { ok: false, output, error: `退出码 ${code}` };
  }
}
