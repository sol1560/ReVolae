import type { Level, ToolDescriptor } from "@cuaremote/protocol";
import type { ToolResult } from "../host/types.js";
import { McpStdioClient, type McpCallResult } from "./mcp-stdio-client.js";

/**
 * cua-driver（trycua/cua）MCP 透传 + 白名单。
 * 大脑只暴露下面这些 gui.* 工具给模型；其他 56 个里的浏览器 / 录屏 / 配置类一律不放行。
 * 这个白名单是模型可见性 + 大脑侧硬拦截；真正的权限边界还要靠宿主用 bounded 模式起 cua-driver。
 */
export const GUI_WHITELIST: Record<string, { level: Level; costClass: 0 | 1 | 2; desc: string }> = {
  list_apps: { level: 0, costClass: 0, desc: "列出运行中的应用" },
  list_windows: { level: 0, costClass: 0, desc: "列出窗口（pid、window_id、标题）" },
  get_window_state: { level: 0, costClass: 1, desc: "拿某个窗口的无障碍元素列表（element_token）和可选截图。每次动作前必须重新取。" },
  get_desktop_state: { level: 0, costClass: 2, desc: "整个桌面截图 + 概况" },
  launch_app: { level: 1, costClass: 0, desc: "启动应用（bundle_id 或 name）" },
  bring_to_front: { level: 1, costClass: 0, desc: "把窗口带到前台" },
  click: { level: 1, costClass: 0, desc: "点元素（element_token）或坐标" },
  double_click: { level: 1, costClass: 0, desc: "双击" },
  right_click: { level: 1, costClass: 0, desc: "右键" },
  type_text: { level: 1, costClass: 0, desc: "输入文本" },
  press_key: { level: 1, costClass: 0, desc: "按键（key + modifiers）" },
  hotkey: { level: 1, costClass: 0, desc: "组合键" },
  set_value: { level: 1, costClass: 0, desc: "直接设置输入框的值" },
  scroll: { level: 1, costClass: 0, desc: "滚动" },
  drag: { level: 1, costClass: 0, desc: "拖拽" },
  invoke_menu: { level: 1, costClass: 0, desc: "点菜单路径，如 [\"File\",\"Export\"]" },
  verify_state: { level: 0, costClass: 1, desc: "等待并校验窗口状态" },
  clipboard_read: { level: 0, costClass: 0, desc: "读剪贴板" },
  clipboard_write: { level: 1, costClass: 0, desc: "写剪贴板" },
};

export interface CuaDriverOptions {
  /** 默认 ["cua-driver","mcp"]；宿主已 bounded serve 时传 ["cua-driver","mcp","--socket",path] */
  argv?: string[];
  /** 允许操作的应用（空 = 不限） */
  allowedApps?: string[];
  /** 后台交付：不抢用户焦点 */
  backgroundDelivery?: boolean;
}

export class CuaDriver {
  private client?: McpStdioClient;
  private available: Set<string> = new Set();
  readonly opts: Required<CuaDriverOptions>;

  constructor(opts: CuaDriverOptions = {}) {
    this.opts = { argv: opts.argv ?? ["cua-driver", "mcp"], allowedApps: opts.allowedApps ?? [], backgroundDelivery: opts.backgroundDelivery ?? true };
  }

  /** 起不来（没装 cua-driver）就返回 false，大脑退回 screenshot + 坐标路线 */
  async start(): Promise<boolean> {
    try {
      this.client = new McpStdioClient(this.opts.argv);
      await this.client.start();
      const tools = await this.client.listTools();
      this.available = new Set(tools.map((t) => t.name));
      return true;
    } catch {
      this.client = undefined;
      return false;
    }
  }

  get running(): boolean {
    return Boolean(this.client);
  }

  descriptors(): ToolDescriptor[] {
    if (!this.client) return [];
    return Object.entries(GUI_WHITELIST)
      .filter(([n]) => this.available.has(n))
      .map(([n, w]) => ({
        name: `gui.${n}`,
        description: w.desc,
        channel: "gui",
        staticLevel: w.level,
        costClass: w.costClass,
        dataLeavesDevice: true,
        inputSchema: { type: "object", description: "参数与 cua-driver 同名工具一致（pid/window_id/element_token/x/y/text/key…）" },
      }));
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> {
    const t0 = Date.now();
    const raw = name.replace(/^gui\./, "");
    if (!this.client) return { ok: false, error: "cua-driver 未运行", attachments: [], ms: 0 };
    if (!(raw in GUI_WHITELIST)) return { ok: false, error: `gui 工具 ${raw} 不在白名单`, attachments: [], ms: 0 };
    const a = { ...args };
    if (this.opts.backgroundDelivery && ["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag"].includes(raw) && a.delivery_mode === undefined) a.delivery_mode = "background";
    if (raw === "launch_app" && this.opts.allowedApps.length) {
      const target = String(a.bundle_id ?? a.name ?? "").toLowerCase();
      if (!this.opts.allowedApps.some((x) => x.toLowerCase() === target)) return { ok: false, error: `应用 ${target} 不在允许列表`, attachments: [], ms: 0 };
    }
    try {
      const r = await this.client.callTool(raw, a, timeoutMs);
      return { ...toToolResult(r), ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), attachments: [], ms: Date.now() - t0 };
    }
  }

  /** jev-ax 用：拿窗口元素候选（≤ maxElements，文本截 120 字，去掉 URL） */
  async windowElements(pid: number, windowId: number, maxElements = 40, maxDepth = 12): Promise<{ snapshotId?: string; elements: AxElement[]; treeMarkdown?: string }> {
    if (!this.client) throw new Error("cua-driver 未运行");
    const r = await this.client.callTool("get_window_state", { pid, window_id: windowId, include_accessibility_tree: true, include_screenshot: false, max_elements: maxElements, max_depth: maxDepth });
    const sc = (r.structuredContent ?? {}) as { snapshot_id?: string; elements?: Record<string, unknown>[]; tree_markdown?: string };
    const elements: AxElement[] = (sc.elements ?? []).slice(0, maxElements).map((e, i) => ({
      index: Number(e.element_index ?? i),
      token: String(e.element_token ?? ""),
      role: String(e.role ?? e.kind ?? ""),
      label: String(e.label ?? e.title ?? e.name ?? e.description ?? "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 120),
      value: e.value !== undefined ? String(e.value).slice(0, 60) : undefined,
      enabled: e.enabled === undefined ? true : Boolean(e.enabled),
    }));
    return { snapshotId: sc.snapshot_id, elements, treeMarkdown: sc.tree_markdown };
  }

  async close() {
    await this.client?.close();
    this.client = undefined;
  }
}

export interface AxElement {
  index: number;
  token: string;
  role: string;
  label: string;
  value?: string;
  enabled: boolean;
}

export function toToolResult(r: McpCallResult): Omit<ToolResult, "ms"> {
  const texts: string[] = [];
  const attachments: ToolResult["attachments"] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text" && c.text) texts.push(c.text);
    else if (c.type === "image" && c.data) attachments.push({ kind: c.mimeType === "image/png" ? "image/png" : "image/jpeg", inline: c.data });
  }
  if (r.structuredContent && !texts.length) texts.push(JSON.stringify(r.structuredContent).slice(0, 20_000));
  return { ok: !r.isError, output: texts.join("\n").slice(0, 20_000), attachments, ...(r.isError ? { error: texts.join("\n").slice(0, 500) } : {}) };
}
