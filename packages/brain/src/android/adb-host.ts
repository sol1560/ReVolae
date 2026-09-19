import type { ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "../host/types.js";

/**
 * 用 adb 控制 Android 的大脑侧适配（F4.1）。
 *
 * Mac daemon 装了 adb 时会多一个底层工具 `android.adb{serial?, cmd, image?}`（LocalBunHost / Swift 宿主同名实现）。
 * 这里把它包成和 Android daemon（apps/android-daemon ToolCatalog）**同名同参数**的十个 android.* 工具，
 * 模型不用关心这台 Android 是装了 daemon 还是只连了 adb。另加一个 `android.devices` 列设备。
 *
 * 和 daemon 的差别（能力受 adb 限制）：
 * - ui_tree 来自 `uiautomator dump`（不是无障碍 API），元素少一些、慢一些（~1s）；index 只在下一次 ui_tree 之前有效；
 * - set_text 先点元素再 `input text`，只支持 ASCII；非 ASCII 直接报错，提示装 daemon；
 * - notifications 来自 `dumpsys notification`，只有标题 / 正文 / 包名；
 * - apps 只列第三方包（`pm list packages -3`）。
 */

export const ADB_RAW_TOOL = "android.adb";

const t = (name: string, description: string, staticLevel: 0 | 1, props: Record<string, unknown>, required: string[] = [], costClass: 0 | 1 | 2 = 0): ToolDescriptor => ({
  name,
  description,
  channel: "android",
  staticLevel,
  costClass,
  dataLeavesDevice: true,
  inputSchema: { type: "object", properties: { serial: { type: "string" }, ...props }, ...(required.length ? { required } : {}) },
});
const int = { type: "integer" };

/** 模型看到的工具；名字和参数与 Android daemon 一致，多了可选 serial */
export const ADB_TOOLS: ToolDescriptor[] = [
  t("android.devices", "列出 adb 连着的 Android 设备（serial、状态、型号）。多台时其它工具要带 serial。", 0, {}),
  t("android.screenshot", "截取 Android 当前屏幕，返回 JPEG。很贵，只在需要看画面时用。", 0, { maxWidth: int }, [], 2),
  t("android.ui_tree", "读取当前界面元素（uiautomator dump）：index、className、text、contentDescription、bounds、clickable、editable。index 用于 tap/long_press/set_text，下一次 ui_tree 后失效。", 0, { maxElements: int, maxDepth: int }),
  t("android.tap", "点击元素（index）或坐标（x,y）。", 1, { index: int, x: int, y: int }),
  t("android.long_press", "长按元素（index）或坐标（x,y）。", 1, { index: int, x: int, y: int }),
  t("android.swipe", "从一个坐标滑到另一个坐标。", 1, { fromX: int, fromY: int, toX: int, toY: int, durationMs: int }, ["fromX", "fromY", "toX", "toY"]),
  t("android.set_text", "向可编辑元素输入文字（先点它再输入；adb 路径只支持 ASCII）。", 1, { index: int, text: { type: "string" } }, ["index", "text"]),
  t("android.key", "发送系统按键。", 1, { key: { type: "string", enum: ["back", "home", "recents", "enter", "volume_up", "volume_down"] } }, ["key"]),
  t("android.launch", "启动指定包名的应用。", 1, { packageName: { type: "string" } }, ["packageName"]),
  t("android.apps", "列出已安装的第三方应用包名。", 0, {}),
  t("android.notifications", "读取当前通知（包名、标题、正文）。", 0, {}),
];
const TOOL_NAMES = new Set(ADB_TOOLS.map((x) => x.name));

const KEYCODES: Record<string, number> = { back: 4, home: 3, recents: 187, enter: 66, volume_up: 24, volume_down: 25 };

export interface UiElement {
  index: number;
  className?: string;
  text?: string;
  contentDescription?: string;
  /** "left,top,right,bottom"，和 daemon 一样 */
  bounds: string;
  clickable: boolean;
  editable: boolean;
}

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

export function hasAdbTool(tools: ToolDescriptor[]): boolean {
  return tools.some((x) => x.name === ADB_RAW_TOOL);
}

/** 内层宿主有 android.adb 就包一层，否则原样返回 */
export async function wrapIfAdb(host: Host, opts: AdbHostOptions = {}): Promise<Host> {
  const { tools } = await host.listTools();
  return hasAdbTool(tools) ? new AdbHost(host, opts) : host;
}

export interface AdbHostOptions {
  /** 没给 serial 时的默认设备；不给 = 只有一台在线时自动选它 */
  serial?: string;
  log?: (rec: Record<string, unknown>) => void;
}

export class AdbHost implements Host {
  /** 上一次 ui_tree 的元素中心点，按 serial 分开 */
  private readonly centers = new Map<string, Map<number, { x: number; y: number }>>();
  /** 自动选中的 serial（只有一台在线时），免得每步都跑一遍 adb devices；命令失败或过期就重查 */
  private auto?: { serial: string; at: number };
  private static readonly AUTO_TTL_MS = 30_000;

  constructor(
    private readonly inner: Host,
    private readonly opts: AdbHostOptions = {},
  ) {}

  async listTools() {
    const { tools, scope } = await this.inner.listTools();
    if (!hasAdbTool(tools)) return { tools, scope };
    return { tools: [...tools.filter((x) => x.name !== ADB_RAW_TOOL), ...ADB_TOOLS], scope };
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> {
    if (!TOOL_NAMES.has(tool)) return this.inner.call(tool, args, timeoutMs);
    const t0 = Date.now();
    try {
      const r = await this.dispatch(tool, args);
      return { attachments: [], ...r, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, attachments: [], error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
    }
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<Omit<ToolResult, "ms" | "attachments"> & Partial<Pick<ToolResult, "attachments">>> {
    if (tool === "android.devices") {
      const devices = await this.devices();
      return { ok: true, output: JSON.stringify(devices) };
    }
    const serial = await this.pickSerial(args.serial);
    const sh = (cmd: string, timeoutMs = 20_000) => this.adb(serial, `shell ${cmd}`, timeoutMs);
    switch (tool) {
      case "android.screenshot": {
        const r = await this.inner.call(ADB_RAW_TOOL, { serial, cmd: "exec-out screencap -p", image: true, maxWidth: args.maxWidth ?? 720 }, 30_000);
        return r.ok ? { ok: true, output: r.output ?? "", attachments: r.attachments } : { ok: false, error: r.error ?? "截图失败", output: r.output };
      }
      case "android.ui_tree": {
        const dump = await sh("uiautomator dump /sdcard/cuaremote-ui.xml >/dev/null 2>&1 && cat /sdcard/cuaremote-ui.xml", 30_000);
        if (!dump.ok) return { ok: false, error: `uiautomator dump 失败：${dump.error ?? ""}`, output: dump.output };
        const els = parseUiAutomatorXml(dump.output ?? "", { maxElements: num(args.maxElements) ?? 500, maxDepth: num(args.maxDepth) ?? 30 });
        this.centers.set(serial, new Map(els.map((e) => [e.index, center(e.bounds)])));
        return { ok: true, output: JSON.stringify(els) };
      }
      case "android.tap": {
        const p = this.point(serial, args);
        return this.okIf(await sh(`input tap ${p.x} ${p.y}`), `已点击 (${p.x},${p.y})`);
      }
      case "android.long_press": {
        const p = this.point(serial, args);
        return this.okIf(await sh(`input swipe ${p.x} ${p.y} ${p.x} ${p.y} 600`), `已长按 (${p.x},${p.y})`);
      }
      case "android.swipe": {
        const [fx, fy, tx, ty] = ["fromX", "fromY", "toX", "toY"].map((k) => need(args, k));
        const d = num(args.durationMs) ?? 300;
        return this.okIf(await sh(`input swipe ${fx} ${fy} ${tx} ${ty} ${d}`), `已滑动 (${fx},${fy}) → (${tx},${ty})`);
      }
      case "android.set_text": {
        const text = String(args.text ?? "");
        // eslint-disable-next-line no-control-regex
        if (/[^\x20-\x7e]/.test(text)) return { ok: false, error: "adb 路径只能输入 ASCII 文字；中文等请在这台 Android 上装 CuaRemote daemon" };
        const p = this.point(serial, { index: need(args, "index") });
        const tap = await sh(`input tap ${p.x} ${p.y}`);
        if (!tap.ok) return { ok: false, error: `点不到元素：${tap.error ?? ""}` };
        return this.okIf(await sh(`input text ${adbTextArg(text)}`), "文字已输入");
      }
      case "android.key": {
        const code = KEYCODES[String(args.key)];
        if (code === undefined) return { ok: false, error: `不认识的按键 ${String(args.key)}` };
        return this.okIf(await sh(`input keyevent ${code}`), `已按 ${String(args.key)}`);
      }
      case "android.launch": {
        const pkg = String(args.packageName ?? "");
        if (!/^[A-Za-z0-9_.]+$/.test(pkg)) return { ok: false, error: "包名不合法" };
        const r = await sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        if (!r.ok || /No activities found|monkey aborted/i.test(r.output ?? "")) return { ok: false, error: `启动 ${pkg} 失败`, output: r.output };
        return { ok: true, output: `已启动 ${pkg}` };
      }
      case "android.apps": {
        const r = await sh("pm list packages -3");
        if (!r.ok) return { ok: false, error: r.error, output: r.output };
        const pkgs = (r.output ?? "").split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(Boolean).sort();
        return { ok: true, output: JSON.stringify(pkgs) };
      }
      case "android.notifications": {
        const r = await sh("dumpsys notification --noredact");
        if (!r.ok) return { ok: false, error: r.error, output: r.output };
        return { ok: true, output: JSON.stringify(parseNotifications(r.output ?? "")) };
      }
      default:
        return { ok: false, error: `没有工具 ${tool}` };
    }
  }

  private okIf(r: ToolResult, msg: string) {
    return r.ok ? { ok: true, output: msg } : { ok: false, error: r.error ?? "adb 命令失败", output: r.output };
  }

  private point(serial: string, args: Record<string, unknown>): { x: number; y: number } {
    const idx = num(args.index);
    if (idx !== undefined) {
      const p = this.centers.get(serial)?.get(idx);
      if (!p) throw new Error(`index ${idx} 已失效，先调 android.ui_tree`);
      return p;
    }
    return { x: need(args, "x"), y: need(args, "y") };
  }

  private async adb(serial: string, cmd: string, timeoutMs: number): Promise<ToolResult> {
    const r = await this.inner.call(ADB_RAW_TOOL, { serial, cmd, timeoutMs }, timeoutMs + 2000);
    this.opts.log?.({ t: "adb", serial, cmd: cmd.slice(0, 120), ok: r.ok, ms: r.ms });
    if (!r.ok && this.auto?.serial === serial) this.auto = undefined;
    return r;
  }

  async devices(): Promise<AdbDevice[]> {
    const r = await this.inner.call(ADB_RAW_TOOL, { cmd: "devices -l", timeoutMs: 10_000 }, 12_000);
    if (!r.ok) throw new Error(`adb devices 失败：${r.error ?? ""}`);
    return parseDevices(r.output ?? "");
  }

  private async pickSerial(requested: unknown): Promise<string> {
    if (typeof requested === "string" && requested) return requested;
    if (this.opts.serial) return this.opts.serial;
    if (this.auto && Date.now() - this.auto.at < AdbHost.AUTO_TTL_MS) return this.auto.serial;
    const online = (await this.devices()).filter((d) => d.state === "device");
    if (online.length === 1) {
      this.auto = { serial: online[0]!.serial, at: Date.now() };
      return this.auto.serial;
    }
    if (online.length === 0) throw new Error("没有在线的 Android 设备（adb devices 为空；无线调试要先配对）");
    throw new Error(`有 ${online.length} 台 Android 在线，请带 serial：${online.map((d) => d.serial).join(", ")}`);
  }
}

// ───────────────────────── 解析 ─────────────────────────

/** `adb devices -l` */
export function parseDevices(out: string): AdbDevice[] {
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model = rest.find((x) => x.startsWith("model:"))?.slice(6);
      return { serial: serial!, state: state ?? "unknown", ...(model ? { model } : {}) };
    });
}

/** uiautomator dump 的 XML → 扁平元素表（先序，和 daemon 的 tree 一样） */
export function parseUiAutomatorXml(xml: string, o: { maxElements: number; maxDepth: number }): UiElement[] {
  const out: UiElement[] = [];
  let depth = -1;
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < o.maxElements) {
    if (m[0] === "</node>") {
      depth--;
      continue;
    }
    depth++;
    const attrs = parseAttrs(m[1]!);
    const selfClosing = m[2] === "/";
    if (depth <= o.maxDepth) {
      const cls = attrs.class;
      out.push({
        index: out.length,
        ...(cls ? { className: cls } : {}),
        ...(attrs.text ? { text: attrs.text } : {}),
        ...(attrs["content-desc"] ? { contentDescription: attrs["content-desc"] } : {}),
        bounds: boundsOf(attrs.bounds ?? ""),
        clickable: attrs.clickable === "true",
        editable: /EditText|AutoCompleteTextView/.test(cls ?? "") || attrs.focusable === "true" && attrs.password === "true",
      });
    }
    if (selfClosing) depth--;
  }
  return out;
}

function parseAttrs(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) o[m[1]!] = unescapeXml(m[2]!);
  return o;
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
}

/** "[l,t][r,b]" → "l,t,r,b" */
function boundsOf(b: string): string {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b);
  return m ? `${m[1]},${m[2]},${m[3]},${m[4]}` : "0,0,0,0";
}

function center(bounds: string): { x: number; y: number } {
  const [l, t, r, b] = bounds.split(",").map(Number) as [number, number, number, number];
  return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
}

/** `dumpsys notification --noredact` → 包名 / 标题 / 正文 */
export function parseNotifications(out: string): { packageName: string; title?: string; text?: string }[] {
  const res: { packageName: string; title?: string; text?: string }[] = [];
  let cur: { packageName: string; title?: string; text?: string } | undefined;
  for (const line of out.split(/\r?\n/)) {
    const rec = /NotificationRecord\(.*?pkg=([\w.]+)/.exec(line);
    if (rec) {
      cur = { packageName: rec[1]! };
      res.push(cur);
      continue;
    }
    if (!cur) continue;
    const title = /android\.title=(?:String|SpannableString) \((.*)\)\s*$/.exec(line);
    if (title && cur.title === undefined) cur.title = title[1]!;
    const text = /android\.text=(?:String|SpannableString) \((.*)\)\s*$/.exec(line);
    if (text && cur.text === undefined) cur.text = text[1]!;
  }
  return res;
}

/** `input text` 的参数：空格要写成 %s，shell 特殊字符转义 */
export function adbTextArg(text: string): string {
  const esc = text.replace(/([\\"'`$&|;<>()*?\[\]{}~#])/g, "\\$1").replace(/ /g, "%s");
  return `"${esc}"`;
}

function num(v: unknown): number | undefined {
  return v === undefined || v === null || v === "" ? undefined : Number(v);
}

function need(args: Record<string, unknown>, k: string): number {
  const v = num(args[k]);
  if (v === undefined || !Number.isFinite(v)) throw new Error(`缺少参数 ${k}`);
  return Math.round(v);
}
