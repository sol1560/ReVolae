import { fitCalibration, homeAndMove, toDeltas, type CalibrationModel, type CalibrationSample, type Delta, type Point } from "@cuaremote/ipad-pointer-calibration";
import type { Scope, ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "../host/types.js";

/**
 * iPad 被控端（platform ipados）的大脑侧适配。
 *
 * dongle 只收相对 HID 增量，且只有 iPad 自己能通过 USB 子网访问它（firmware/dongle/protocol.md），
 * 所以 iPad app 作为设备端提供一组**底层**工具（见 IPAD_DEVICE_TOOLS），大脑在这里把它们包装成
 * 模型能用的**绝对坐标**工具（IPAD_TOOLS）：截图 → 模型看图给 (x,y) → 校准曲线反解成一串增量 → 一次 /macro。
 * 指针位置由大脑预测跟踪；截图带回真实指针位置时以真实为准；不可信时用 homeAndMove 撞左上角归零。
 */

/** iPad app 要实现的底层工具（docs/protocol.md「iPad 被控」） */
export const IPAD_DEVICE_TOOLS = {
  /** 截屏：output 是 JSON {width,height,pointer?:{x,y}}，附件一张 JPEG；坐标系和 pointer 必须一致 */
  screen: "ipad.screen",
  /** 只取指针位置（校准页里靠 UIPointerInteraction 拿，不截图）：output JSON {x,y,width,height} */
  pointer: "ipad.pointer",
  /** 转发 dongle /macro 并轮询 /status 直到 busy=false */
  macro: "ipad.hid.macro",
  /** 把 UTF-8 文本写进 iPad 剪贴板（非 ASCII 输入走 Cmd+V） */
  clipboard: "ipad.clipboard.write",
  /** 读 / 存校准模型 JSON（换设备或重启后大脑不用重新校准） */
  calGet: "ipad.calibration.get",
  calPut: "ipad.calibration.put",
} as const;
const DEVICE_TOOL_NAMES = new Set<string>(Object.values(IPAD_DEVICE_TOOLS));

/** 模型看到的工具 */
export const IPAD_TOOLS: ToolDescriptor[] = [
  {
    name: "ipad.screenshot",
    description: "截取 iPad 屏幕，返回 JPEG 和屏幕尺寸。之后用截图里的像素坐标点击。很贵，每次动作后只在需要确认结果时截。",
    channel: "ipad", staticLevel: 0, costClass: 2, dataLeavesDevice: true,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ipad.tap",
    description: "在截图坐标 (x,y) 点击。count=2 双击。需要先校准过一次（ipad.calibrate）。",
    channel: "ipad", staticLevel: 1, costClass: 0, dataLeavesDevice: false,
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, count: { type: "integer", minimum: 1, maximum: 3 } }, required: ["x", "y"] },
  },
  {
    name: "ipad.scroll",
    description: "在 (x,y) 处滚动。dy 正数向下、负数向上，单位是滚轮格（±1..±30）。不给 x,y 就在当前指针位置滚。",
    channel: "ipad", staticLevel: 1, costClass: 0, dataLeavesDevice: false,
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, dx: { type: "integer" }, dy: { type: "integer" } } },
  },
  {
    name: "ipad.type",
    description: "在当前焦点处输入文本。ASCII 直接敲键盘；中文 / emoji 会经剪贴板粘贴。",
    channel: "ipad", staticLevel: 1, costClass: 0, dataLeavesDevice: false,
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "ipad.key",
    description: "按一个键，可带修饰键。key 是单个字符或 enter/escape/backspace/tab/space/delete/left/right/up/down/home/end；modifiers 可选 cmd/shift/ctrl/alt。回主屏幕用 key=h + cmd。",
    channel: "ipad", staticLevel: 1, costClass: 0, dataLeavesDevice: false,
    inputSchema: { type: "object", properties: { key: { type: "string" }, modifiers: { type: "array", items: { type: "string", enum: ["cmd", "shift", "ctrl", "alt"] } } }, required: ["key"] },
  },
  {
    name: "ipad.calibrate",
    description: "校准指针（约 10 秒，指针会在屏幕中间来回动）。首次使用、换了指针速度 / 显示缩放 / 横竖屏后要跑。",
    channel: "ipad", staticLevel: 1, costClass: 0, dataLeavesDevice: false,
    inputSchema: { type: "object", properties: {} },
  },
];

const KEYS = new Set(["enter", "escape", "backspace", "tab", "space", "delete", "left", "right", "up", "down", "home", "end"]);
const MODS = new Set(["cmd", "shift", "ctrl", "alt"]);
/** 固件能直接敲的美式键盘字符（firmware/dongle/protocol.py `_ascii_key`） */
const TYPEABLE = /^[A-Za-z0-9 \n\t\-=[\]\\;'`,./_+{}|:"~<>?!@#$%^&*()]*$/;
const MACRO_MAX_STEPS = 128;
const TYPE_CHUNK = 1024;
/** 校准用的增量幅度（firmware/dongle/calibration/README.md） */
export const CALIBRATION_MAGNITUDES = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 80];

type MacroStep = { action: "mouse.move"; dx: number; dy: number } | { action: "mouse.click"; button: "left"; count: number } | { action: "mouse.scroll"; dx: number; dy: number } | { action: "key.press"; key: string; modifiers: string[] } | { action: "key.type"; text: string } | { delayMs: number };

export interface IpadHostOptions {
  log?: (rec: Record<string, unknown>) => void;
  /** 预先给的校准模型（测试 / 已缓存）；不给则启动时向设备要 */
  model?: CalibrationModel;
}

/** 这台设备是不是 iPad 被控端：有截屏和宏两个底层工具就算 */
export function hasIpadTools(tools: ToolDescriptor[]): boolean {
  const names = new Set(tools.map((t) => t.name));
  return names.has(IPAD_DEVICE_TOOLS.screen) && names.has(IPAD_DEVICE_TOOLS.macro);
}

/** 内层是 iPad 设备就包一层，否则原样返回 */
export async function wrapIfIpad(host: Host, opts: IpadHostOptions = {}): Promise<Host> {
  const { tools } = await host.listTools();
  return hasIpadTools(tools) ? new IpadHost(host, opts) : host;
}

export class IpadHost implements Host {
  private model?: CalibrationModel;
  private modelLoaded = false;
  /** 大脑预测的当前指针位置；undefined = 不可信，下次点击先归零 */
  private pointer?: Point;
  private screen?: { width: number; height: number };

  constructor(private readonly inner: Host, private readonly opts: IpadHostOptions = {}) {
    if (opts.model) {
      this.model = opts.model;
      this.modelLoaded = true;
    }
  }

  get calibrated(): boolean {
    return Boolean(this.model);
  }

  async listTools(): Promise<{ tools: ToolDescriptor[]; scope: Scope }> {
    const { tools, scope } = await this.inner.listTools();
    const names = new Set(tools.map((t) => t.name));
    const exposed = IPAD_TOOLS.filter((t) => {
      if (t.name === "ipad.type") return names.has(IPAD_DEVICE_TOOLS.macro);
      if (t.name === "ipad.calibrate") return names.has(IPAD_DEVICE_TOOLS.pointer);
      return true;
    });
    return { tools: [...tools.filter((t) => !DEVICE_TOOL_NAMES.has(t.name)), ...exposed], scope };
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult> {
    if (!tool.startsWith("ipad.") || DEVICE_TOOL_NAMES.has(tool)) return this.inner.call(tool, args, timeoutMs);
    const t0 = Date.now();
    try {
      const r = await this.dispatch(tool, args);
      return { ...r, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), attachments: [], ms: Date.now() - t0 };
    }
  }

  async close() {
    await this.inner.close?.();
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<Omit<ToolResult, "ms">> {
    switch (tool) {
      case "ipad.screenshot":
        return this.screenshot();
      case "ipad.tap":
        return this.tap(num(args.x, "x"), num(args.y, "y"), clampInt(args.count ?? 1, 1, 3, "count"));
      case "ipad.scroll":
        return this.scroll(args);
      case "ipad.type":
        return this.type(String(args.text ?? ""));
      case "ipad.key":
        return this.key(String(args.key ?? ""), Array.isArray(args.modifiers) ? args.modifiers.map(String) : []);
      case "ipad.calibrate":
        return this.calibrate();
      default:
        return { ok: false, error: `iPad 没有 ${tool} 这个工具`, attachments: [] };
    }
  }

  // ───────────── 工具实现 ─────────────

  private async screenshot(): Promise<Omit<ToolResult, "ms">> {
    const r = await this.inner.call(IPAD_DEVICE_TOOLS.screen, {}, 20_000);
    if (!r.ok) return r;
    const info = parseJson<{ width?: number; height?: number; pointer?: Point }>(r.output);
    if (info?.width && info.height) this.screen = { width: info.width, height: info.height };
    if (info?.pointer) this.pointer = info.pointer;
    const lines = [`屏幕 ${this.screen?.width ?? "?"}×${this.screen?.height ?? "?"}`, this.pointer ? `指针在 (${Math.round(this.pointer.x)}, ${Math.round(this.pointer.y)})` : "指针位置未知", this.model ? "" : "还没校准，点击前先 ipad.calibrate"].filter(Boolean);
    return { ok: true, output: lines.join("；"), attachments: r.attachments };
  }

  private async tap(x: number, y: number, count: number): Promise<Omit<ToolResult, "ms">> {
    const model = await this.requireModel();
    if ("error" in model) return { ok: false, error: model.error, attachments: [] };
    const target = { x, y };
    const homed = !this.pointer;
    const moves = this.pointer ? toDeltas(this.pointer, target, model.model) : homeAndMove(target, model.model);
    const steps: MacroStep[] = [...moves.map(mv), { delayMs: 30 }, { action: "mouse.click", button: "left", count }];
    const r = await this.runMacro(steps);
    if (!r.ok) {
      // 宏没完整跑完，指针在哪不知道了
      this.pointer = undefined;
      return r;
    }
    this.pointer = clampToScreen(target, model.model);
    return { ok: true, output: `已在 (${Math.round(x)}, ${Math.round(y)}) 点击${count > 1 ? ` ${count} 次` : ""}（${moves.length} 个增量${homed ? "，先撞左上角归零" : ""}）`, attachments: [] };
  }

  private async scroll(args: Record<string, unknown>): Promise<Omit<ToolResult, "ms">> {
    const dx = args.dx === undefined ? 0 : clampInt(args.dx, -30, 30, "dx");
    const dy = args.dy === undefined ? 0 : clampInt(args.dy, -30, 30, "dy");
    if (!dx && !dy) return { ok: false, error: "dx / dy 至少给一个非零值", attachments: [] };
    const steps: MacroStep[] = [];
    if (args.x !== undefined && args.y !== undefined) {
      const model = await this.requireModel();
      if ("error" in model) return { ok: false, error: model.error, attachments: [] };
      const target = { x: num(args.x, "x"), y: num(args.y, "y") };
      steps.push(...(this.pointer ? toDeltas(this.pointer, target, model.model) : homeAndMove(target, model.model)).map(mv), { delayMs: 30 });
      this.pointer = clampToScreen(target, model.model);
    }
    // 滚轮方向：HID wheel 正数是「向上」，模型语义 dy 正数是「向下」，这里翻转
    for (let i = 0; i < Math.max(Math.abs(dx), Math.abs(dy)); i++) steps.push({ action: "mouse.scroll", dx: Math.sign(dx) * (i < Math.abs(dx) ? 1 : 0), dy: -Math.sign(dy) * (i < Math.abs(dy) ? 1 : 0) }, { delayMs: 20 });
    const r = await this.runMacro(steps);
    if (!r.ok) this.pointer = undefined;
    return r.ok ? { ok: true, output: `已滚动 dx=${dx} dy=${dy}`, attachments: [] } : r;
  }

  private async type(text: string): Promise<Omit<ToolResult, "ms">> {
    if (!text) return { ok: false, error: "text 为空", attachments: [] };
    if (TYPEABLE.test(text)) {
      const steps: MacroStep[] = [];
      for (let i = 0; i < text.length; i += TYPE_CHUNK) steps.push({ action: "key.type", text: text.slice(i, i + TYPE_CHUNK) });
      const r = await this.runMacro(steps);
      return r.ok ? { ok: true, output: `已输入 ${text.length} 个字符`, attachments: [] } : r;
    }
    const { tools } = await this.inner.listTools();
    if (!tools.some((t) => t.name === IPAD_DEVICE_TOOLS.clipboard)) return { ok: false, error: "文本含非 ASCII 字符，但 iPad app 没有剪贴板工具，敲不了", attachments: [] };
    const w = await this.inner.call(IPAD_DEVICE_TOOLS.clipboard, { text }, 10_000);
    if (!w.ok) return w;
    const r = await this.runMacro([{ action: "key.press", key: "v", modifiers: ["cmd"] }]);
    return r.ok ? { ok: true, output: `已通过剪贴板粘贴 ${text.length} 个字符`, attachments: [] } : r;
  }

  private async key(key: string, modifiers: string[]): Promise<Omit<ToolResult, "ms">> {
    const k = key.length === 1 ? key : key.toLowerCase();
    if (!(k.length === 1 ? TYPEABLE.test(k) : KEYS.has(k))) return { ok: false, error: `不认识的键 ${key}`, attachments: [] };
    const bad = modifiers.filter((m) => !MODS.has(m));
    if (bad.length) return { ok: false, error: `不认识的修饰键 ${bad.join(",")}`, attachments: [] };
    const r = await this.runMacro([{ action: "key.press", key: k, modifiers }]);
    return r.ok ? { ok: true, output: `已按 ${[...modifiers, key].join("+")}`, attachments: [] } : r;
  }

  /**
   * 校准：以当前位置为起点，对每个幅度依次发 +x / -x / +y / -y 四个单报文增量，每发一个就问设备指针在哪。
   * 四个方向一圈回到起点，所以不会越走越偏；撞墙样本由 fitCalibration 自己剔除。
   */
  private async calibrate(): Promise<Omit<ToolResult, "ms">> {
    const start = await this.readPointer();
    if ("error" in start) return { ok: false, error: start.error, attachments: [] };
    this.screen = { width: start.width, height: start.height };
    // 先把指针挪到屏幕中间附近，避免一开始就撞墙（用未校准的粗略增量，撞了也无所谓）
    let cur: Point = start;
    const center = { x: start.width / 2, y: start.height / 2 };
    for (let i = 0; i < 40 && Math.hypot(center.x - cur.x, center.y - cur.y) > start.width * 0.1; i++) {
      const r = await this.runMacro([{ action: "mouse.move", dx: Math.sign(center.x - cur.x) * 20, dy: Math.sign(center.y - cur.y) * 20 }]);
      if (!r.ok) return r;
      const p = await this.readPointer();
      if ("error" in p) return { ok: false, error: p.error, attachments: [] };
      if (Math.hypot(p.x - cur.x, p.y - cur.y) < 0.5) break; // 动不了了（撞墙 / 指针不动），别死循环
      cur = p;
    }
    const samples: CalibrationSample[] = [];
    for (const m of CALIBRATION_MAGNITUDES) {
      for (const delta of [{ x: m, y: 0 }, { x: -m, y: 0 }, { x: 0, y: m }, { x: 0, y: -m }]) {
        const from = cur;
        const r = await this.runMacro([{ action: "mouse.move", dx: delta.x, dy: delta.y }]);
        if (!r.ok) return r;
        const p = await this.readPointer();
        if ("error" in p) return { ok: false, error: p.error, attachments: [] };
        cur = p;
        samples.push({ delta, from, to: { x: p.x, y: p.y } });
      }
    }
    let model: CalibrationModel;
    try {
      model = fitCalibration(samples, this.screen);
    } catch (e) {
      return { ok: false, error: `校准失败：${e instanceof Error ? e.message : String(e)}。确认指针没被隐藏、iPad app 在前台。`, attachments: [] };
    }
    this.model = model;
    this.modelLoaded = true;
    this.pointer = cur;
    const { tools } = await this.inner.listTools();
    let saved = false;
    if (tools.some((t) => t.name === IPAD_DEVICE_TOOLS.calPut)) saved = (await this.inner.call(IPAD_DEVICE_TOOLS.calPut, { model }, 10_000)).ok;
    this.opts.log?.({ t: "ipad.calibrated", samples: samples.length, curve: model.curve.length, maxReport: model.maxReport, saved });
    return { ok: true, output: `校准完成：${samples.length} 个样本，曲线 ${model.curve.length} 段，最大单报文 ${model.maxReport}${saved ? "，已存到设备" : ""}`, attachments: [] };
  }

  // ───────────── 内部 ─────────────

  private async requireModel(): Promise<{ model: CalibrationModel } | { error: string }> {
    if (!this.model && !this.modelLoaded) {
      this.modelLoaded = true;
      const { tools } = await this.inner.listTools();
      if (tools.some((t) => t.name === IPAD_DEVICE_TOOLS.calGet)) {
        const r = await this.inner.call(IPAD_DEVICE_TOOLS.calGet, {}, 10_000);
        const m = r.ok ? parseJson<CalibrationModel>(r.output) : null;
        if (m && Array.isArray(m.curve) && m.curve.length >= 3 && m.width > 0 && m.height > 0 && m.maxReport > 0) {
          this.model = m;
          this.screen ??= { width: m.width, height: m.height };
        }
      }
    }
    return this.model ? { model: this.model } : { error: "iPad 指针还没校准，先调用 ipad.calibrate" };
  }

  private async readPointer(): Promise<(Point & { width: number; height: number }) | { error: string }> {
    const r = await this.inner.call(IPAD_DEVICE_TOOLS.pointer, {}, 10_000);
    if (!r.ok) return { error: r.error ?? "读不到指针位置" };
    const p = parseJson<{ x?: number; y?: number; width?: number; height?: number }>(r.output);
    if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !p.width || !p.height) return { error: `${IPAD_DEVICE_TOOLS.pointer} 返回的不是 {x,y,width,height}` };
    return { x: p.x, y: p.y, width: p.width, height: p.height };
  }

  /** 宏分批（≤128 步），设备端负责轮询 /status 到 busy=false 再返回 */
  private async runMacro(steps: MacroStep[]): Promise<Omit<ToolResult, "ms">> {
    for (let i = 0; i < steps.length; i += MACRO_MAX_STEPS) {
      const r = await this.inner.call(IPAD_DEVICE_TOOLS.macro, { steps: steps.slice(i, i + MACRO_MAX_STEPS) }, 30_000);
      if (!r.ok) return { ok: false, error: r.error ?? "dongle 宏执行失败", attachments: [], output: r.output };
    }
    return { ok: true, attachments: [] };
  }
}

const mv = (d: Delta): MacroStep => ({ action: "mouse.move", dx: d.dx, dy: d.dy });

function clampToScreen(p: Point, m: CalibrationModel): Point {
  return { x: Math.max(0, Math.min(m.width - 1, p.x)), y: Math.max(0, Math.min(m.height - 1, p.y)) };
}

function num(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, name: string): number {
  const n = Math.round(num(v, name));
  if (n < lo || n > hi) throw new Error(`${name} 必须在 ${lo}..${hi}`);
  return n;
}

function parseJson<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
