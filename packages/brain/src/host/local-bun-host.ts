import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { AppInventory, type CapabilityCard, type Scope, type ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "./types.js";
import { TERMINAL_BLOCKS_DESCRIPTOR, type TerminalManager } from "../terminal/manager.js";
import { nativeHelper } from "./native-helper.js";
import { PROCESS_OUTPUT_LIMIT, runProcess, type ProcessRunResult } from "./process-runner.js";

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
  /** 只读设备已保存的卡片，不接受模型传入脚本覆盖。 */
  getCard?: (id: string) => CapabilityCard | undefined;
}

/** M0：大脑和被控设备是同一台机器时的宿主 */
export class LocalBunHost implements Host {
  readonly scope: Scope;
  private readonly shell: string;
  private readonly loginShell: boolean;
  private readonly terminals?: TerminalManager;
  private readonly getCard?: LocalHostOptions["getCard"];
  private readonly preparedShellCalls = new WeakMap<Record<string, unknown>, string>();

  constructor(opts: LocalHostOptions = {}) {
    this.loginShell = opts.loginShell ?? true;
    this.terminals = opts.terminals;
    this.getCard = opts.getCard;
    this.scope = {
      allowedDirs: opts.scope?.allowedDirs ?? [homedir()],
      allowedApps: opts.scope?.allowedApps ?? [],
      deniedCommands: opts.scope?.deniedCommands ?? ["sudo", "rm -rf /", "diskutil", "csrutil", "mkfs", "dd if="],
    };
    this.shell = opts.shell ?? (isMac ? "/bin/zsh" : "/bin/sh");
  }

  async listTools() {
    const base = isMac ? LOCAL_TOOLS : LOCAL_TOOLS.filter((t) => !["applescript.run", "jxa.run", "shortcuts.run", "shortcuts.list"].includes(t.name));
    const allowedDirs = await this.canonicalAllowedDirs();
    const defaultCwd = allowedDirs[0];
    const tools: ToolDescriptor[] = base.map((tool) => tool.name !== "shell.run" || !defaultCwd ? tool : {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema.properties as Record<string, unknown>),
          cwd: { type: "string", default: defaultCwd },
        },
        required: ["cmd", "cwd"],
      },
    });
    tools.push(...(this.adb() ? [ADB_TOOL] : []), ...(this.terminals ? [TERMINAL_BLOCKS_DESCRIPTOR] : []));
    if (process.env.CUAREMOTE_NATIVE_HELPER) tools.push({ name: "app.inventory", description: "只读采集指定应用的脚本、菜单、窗口或快捷指令能力。", channel: "app", staticLevel: 0, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object", properties: { bundleId: { type: "string" }, phase: { type: "string", enum: ["sdef", "menu", "window", "shortcuts"] } }, required: ["bundleId", "phase"] } });
    if (this.getCard) tools.push({ name: "app.card.get", description: "读取已保存的应用操作卡片。", channel: "app", staticLevel: 0, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object", properties: { cardId: { type: "string" } }, required: ["cardId"] } });
    return { tools, scope: { ...this.scope, allowedDirs } };
  }

  async prepareCall(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (tool !== "shell.run") return args;
    const prepared = await this.prepareShellArgs(args);
    this.preparedShellCalls.set(prepared, prepared.cwd as string);
    return prepared;
  }

  private adb(): string | undefined {
    return process.env.CUAREMOTE_ADB || Bun.which("adb") || undefined;
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000, signal?: AbortSignal): Promise<ToolResult> {
    const t0 = Date.now();
    const done = (r: Omit<ToolResult, "ms" | "attachments"> & Partial<Pick<ToolResult, "attachments">>): ToolResult => ({ attachments: [], ...r, ms: Date.now() - t0 });
    try {
      signal?.throwIfAborted();
      switch (tool) {
        case "app.inventory": {
          const phase = String(args.phase);
          if (!["sdef", "menu", "window", "shortcuts"].includes(phase)) return done({ ok: false, error: "不支持的只读采集阶段" });
          const bundleId = String(args.bundleId);
          if (this.scope.allowedApps.length && !this.scope.allowedApps.includes(bundleId)) return done({ ok: false, error: "应用不在允许范围内" });
          const inventory = await nativeHelper(["inventory", bundleId, phase], AppInventory, timeoutMs, signal);
          if (inventory.bundleId !== bundleId || inventory.phase !== phase) return done({ ok: false, error: "应用采集结果与请求不匹配" });
          return done({ ok: true, output: JSON.stringify(inventory) });
        }
        case "app.card.get": {
          const card = this.getCard?.(String(args.cardId));
          return card ? done({ ok: true, output: JSON.stringify(card) }) : done({ ok: false, error: "找不到这张卡片" });
        }
        case "shell.run": {
          const prepared = await this.revalidateShellCall(args);
          const cmd = prepared.cmd as string;
          const denied = this.scope.deniedCommands.find((d) => cmd.includes(d));
          if (denied) return done({ ok: false, error: `命令包含被禁止的片段「${denied}」` });
          return done(await this.exec([this.shell, this.loginShell ? "-lc" : "-c", cmd], {
            cwd: prepared.cwd as string,
            timeoutMs: prepared.timeoutMs as number,
            stdin: prepared.stdin as string | undefined,
            signal,
          }));
        }
        case "applescript.run": {
          if (typeof args.script !== "string") throw new Error("AppleScript 脚本格式无效");
          return done(await this.exec(["osascript", "-e", args.script], { timeoutMs: this.timeoutArgument(args, timeoutMs), signal }));
        }
        case "jxa.run":
          if (typeof args.script !== "string") throw new Error("JXA 脚本格式无效");
          return done(await this.exec(["osascript", "-l", "JavaScript", "-e", args.script], { timeoutMs: this.timeoutArgument(args, timeoutMs), signal }));
        case "shortcuts.run": {
          if (typeof args.name !== "string" || (args.input !== undefined && typeof args.input !== "string")) throw new Error("快捷指令参数格式无效");
          const a = ["shortcuts", "run", args.name];
          return done(await this.exec(a, { timeoutMs: this.timeoutArgument(args, timeoutMs), stdin: args.input as string | undefined, signal }));
        }
        case "shortcuts.list":
          return done(await this.exec(["shortcuts", "list"], { timeoutMs, signal }));
        case "fs.list": {
          if (typeof args.path !== "string") throw new Error("路径格式无效");
          const p = await this.checkPath(args.path);
          const requestedDepth = args.depth ?? 1;
          if (typeof requestedDepth !== "number" || !Number.isSafeInteger(requestedDepth)) throw new Error("目录深度格式无效");
          const depth = Math.min(Math.max(requestedDepth, 1), 3);
          signal?.throwIfAborted();
          return done({ ok: true, output: await this.listDir(p, depth, "", signal) });
        }
        case "fs.read": {
          if (typeof args.path !== "string") throw new Error("路径格式无效");
          const p = await this.checkPath(args.path);
          const requestedMax = args.maxBytes ?? 16_384;
          if (typeof requestedMax !== "number" || !Number.isSafeInteger(requestedMax) || requestedMax < 0) throw new Error("读取大小格式无效");
          const max = Math.min(requestedMax, 256_000);
          signal?.throwIfAborted();
          const file = await open(p, "r");
          try {
            const buf = Buffer.alloc(max + 1);
            const { bytesRead } = await file.read(buf, 0, buf.length, 0);
            const size = (await file.stat()).size;
            signal?.throwIfAborted();
            const text = buf.subarray(0, Math.min(bytesRead, max)).toString("utf8");
            return done({ ok: true, output: bytesRead > max || size > max ? `${text}\n…(截断，超过 ${max} 字节)` : text });
          } finally {
            await file.close();
          }
        }
        case "screenshot": {
          if (!isMac) return done({ ok: false, error: "此平台没有截图实现" });
          const file = `/tmp/cuaremote-shot-${Date.now()}.jpg`;
          const r = await this.exec(["screencapture", "-x", "-t", "jpg", file], { timeoutMs: 10_000, signal });
          if (!r.ok) return done(r);
          signal?.throwIfAborted();
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
          const to = this.timeoutArgument(args, 30_000);
          if (!args.image) return done(await this.exec(["/bin/sh", "-c", shellCmd], { timeoutMs: to, signal }));
          const png = await this.execBytes(["/bin/sh", "-c", shellCmd], to, signal);
          if (!png.ok) return done({ ok: false, error: png.error, output: png.text });
          if (png.bytes.length < 8) return done({ ok: false, error: "adb 没回图片数据" });
          if (isMac) {
            const src = `/tmp/cuaremote-adb-${Date.now()}.png`;
            const dst = src.replace(/\.png$/, ".jpg");
            await Bun.write(src, png.bytes);
            const r = await this.exec(["sips", "-Z", String(Number(args.maxWidth ?? 720)), "-s", "format", "jpeg", "-s", "formatOptions", "70", src, "--out", dst], { timeoutMs: 15_000, signal });
            if (r.ok) {
              signal?.throwIfAborted();
              const jpg = await readFile(dst);
              return done({ ok: true, output: `截图 ${jpg.length} 字节`, attachments: [{ kind: "image/jpeg", inline: jpg.toString("base64") }] });
            }
          }
          return done({ ok: true, output: `截图 ${png.bytes.length} 字节（PNG 原图）`, attachments: [{ kind: "image/png", inline: Buffer.from(png.bytes).toString("base64") }] });
        }
        case "apps.running": {
          if (!isMac) return done({ ok: false, error: "此平台没有实现" });
          return done(await this.exec(["osascript", "-e", 'tell application "System Events" to get {name, bundle identifier} of every application process whose background only is false'], { timeoutMs: 8_000, signal }));
        }
        default:
          return done({ ok: false, error: `没有工具 ${tool}` });
      }
    } catch (e) {
      return done({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private expandHome(path: string): string {
    return path.replace(/^~(?=$|\/)/, homedir());
  }

  private async canonicalAllowedDirs(): Promise<string[]> {
    const roots = await Promise.all(this.scope.allowedDirs.map(async (dir) => {
      const path = await realpath(resolve(this.expandHome(dir)));
      if (!(await stat(path)).isDirectory()) throw new Error(`允许范围不是目录：${path}`);
      return path;
    }));
    return [...new Set(roots)];
  }

  private withinAllowedRoot(path: string, roots: string[]): boolean {
    return roots.some((root) => {
      const rel = relative(root, path);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    });
  }

  private async canonicalPath(path: string, roots: string[]): Promise<string> {
    const defaultRoot = roots[0];
    if (!defaultRoot) throw new Error("没有配置允许的目录");
    const expanded = this.expandHome(path);
    const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(defaultRoot, expanded);
    const canonical = await realpath(absolute);
    if (!this.withinAllowedRoot(canonical, roots)) {
      throw new Error(`路径 ${canonical} 不在允许的目录里（${roots.join(", ")}）`);
    }
    return canonical;
  }

  private async checkPath(path: string): Promise<string> {
    return this.canonicalPath(path, await this.canonicalAllowedDirs());
  }

  private async prepareShellArgs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const accepted = new Set(["cmd", "cwd", "timeoutMs", "stdin"]);
    const unknown = Object.keys(args).find((key) => !accepted.has(key));
    if (unknown) throw new Error(`shell.run 不支持参数 ${unknown}`);
    if (typeof args.cmd !== "string") throw new Error("shell.run 的 cmd 必须是字符串");
    if (args.cwd !== undefined && typeof args.cwd !== "string") throw new Error("shell.run 的 cwd 必须是字符串");
    if (args.stdin !== undefined && typeof args.stdin !== "string") throw new Error("shell.run 的 stdin 必须是字符串");

    const timeoutMs = args.timeoutMs === undefined ? 60_000 : args.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new Error("shell.run 的 timeoutMs 必须是 1 到 120000 之间的正整数");
    }

    const roots = await this.canonicalAllowedDirs();
    const requestedCwd = args.cwd === undefined ? roots[0] : args.cwd;
    if (typeof requestedCwd !== "string") throw new Error("没有配置默认工作目录");
    const cwd = await this.canonicalPath(requestedCwd, roots);
    if (!(await stat(cwd)).isDirectory()) throw new Error("shell.run 的 cwd 必须是目录");
    return {
      cmd: args.cmd,
      cwd,
      timeoutMs,
      ...(args.stdin === undefined ? {} : { stdin: args.stdin }),
    };
  }

  private async revalidateShellCall(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const preparedCwd = this.preparedShellCalls.get(args);
    const normalized = await this.prepareShellArgs(args);
    if (preparedCwd !== undefined && (args.cwd !== preparedCwd || normalized.cwd !== preparedCwd)) {
      throw new Error("已审批的工作目录已改变，请重新确认");
    }
    return normalized;
  }

  private timeoutArgument(args: Record<string, unknown>, fallback: number): number {
    const timeout = args.timeoutMs === undefined ? fallback : args.timeoutMs;
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000) {
      throw new Error("timeoutMs 必须是 1 到 120000 之间的正整数");
    }
    return timeout;
  }

  private async listDir(dir: string, depth: number, indent: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true });
    const lines: string[] = [];
    for (const e of entries.slice(0, 200)) {
      signal?.throwIfAborted();
      const entry = join(dir, e.name);
      if (e.isSymbolicLink()) {
        lines.push(`${indent}${e.name} (symlink)`);
        continue;
      }
      if (e.isDirectory()) {
        const canonical = await this.checkPath(entry);
        lines.push(`${indent}${e.name}/`);
        if (depth > 1) lines.push(await this.listDir(canonical, depth - 1, indent + "  ", signal));
      } else {
        const canonical = await this.checkPath(entry);
        const s = await stat(canonical).catch(() => null);
        lines.push(`${indent}${e.name}${s ? `  ${s.size}B` : ""}`);
      }
    }
    if (entries.length > 200) lines.push(`${indent}…还有 ${entries.length - 200} 项`);
    return lines.filter(Boolean).join("\n");
  }

  /** stdout 按字节拿（图片）；失败时 text 是 stderr */
  private async execBytes(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string; text: string }> {
    const result = await runProcess(argv, { timeoutMs, signal, env: { ...process.env, CUAREMOTE: "1" } });
    const text = result.stderr.toString("utf8").slice(0, 4000);
    if (result.failure) return { ok: false, error: this.processFailure(result), text };
    if (result.code !== 0) return { ok: false, error: `退出码 ${result.code}`, text };
    return { ok: true, bytes: result.stdout };
  }

  private async exec(argv: string[], o: { cwd?: string; timeoutMs: number; stdin?: string; signal?: AbortSignal }): Promise<Omit<ToolResult, "ms" | "attachments">> {
    const result = await runProcess(argv, { cwd: o.cwd, timeoutMs: o.timeoutMs, signal: o.signal, input: o.stdin, env: { ...process.env, CUAREMOTE: "1" } });
    const out = result.stdout.toString("utf8");
    const err = result.stderr.toString("utf8");
    const output = (out + (err ? (out ? "\n" : "") + err : "")).slice(0, 32_000);
    if (result.failure) return { ok: false, output, error: this.processFailure(result) };
    if (result.stdinClosedEarly) return { ok: false, output, error: "子进程提前关闭标准输入" };
    return result.code === 0 ? { ok: true, output } : { ok: false, output, error: `退出码 ${result.code}` };
  }

  private processFailure(result: ProcessRunResult): string {
    switch (result.failure) {
      case "aborted": return "操作已取消，子进程已终止";
      case "timeout": return "命令超时，子进程已终止";
      case "output_limit": return `命令输出超过 ${PROCESS_OUTPUT_LIMIT} 字节限制，子进程已终止`;
      case "drain_timeout": return "子进程退出后输出管道未及时关闭，已停止读取";
      case "spawn_error": return result.spawnCode ? `无法启动子进程（${result.spawnCode}）` : "无法启动子进程";
      case "input_limit": return `标准输入超过 ${PROCESS_OUTPUT_LIMIT} 字节限制`;
      case "invalid_timeout": return "子进程超时时间无效";
      case "stdin_error": return "无法向子进程写入标准输入";
      default: return "子进程执行失败";
    }
  }
}
