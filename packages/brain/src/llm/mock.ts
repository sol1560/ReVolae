import type { ChatRequest, ChatResponse, ModelInfo, Provider } from "./types.js";

/**
 * 不联网的假模型，用来测 agent loop / 策略 / 宿主。
 * 意图文本约定：
 *   "shell: <cmd>"                → 计划一步，调用 shell.run
 *   "shell: <cmd1> && then: <cmd2>" → 两步
 *   "gui: <goal>"                 → 计划一步 gui（用来测 jev-ax 路径）
 *   其他                           → 直接回答文本，不调工具
 */
export class MockProvider implements Provider {
  readonly info: ModelInfo;
  private calls = 0;

  /** `mock:paid` 按每百万 token 1 美元计价，用来测计费链路；其它 id 免费 */
  constructor(id = "mock") {
    const price = id === "mock:paid" ? 1 : 0;
    this.info = { id, tier: "local", zdr: true, vision: false, priceIn: price, priceOut: price };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    const usage = { inputTokens: 100 * req.messages.length, outputTokens: 30 };
    const intent = firstUserText(req);
    const cmds = parseShell(intent);

    if (req.forceTool === "propose_cards") {
      // 从用户消息里把能力清单 JSON 抠出来，一条一张卡：有参数 → input_button，否则 button
      const m = /能力清单[^\n]*\n(\[.*\])/s.exec(intent);
      const items = m ? (JSON.parse(m[1]!) as { id: string; name: string; description?: string; source: string; params: { name: string; type: string }[] }[]) : [];
      const cards = items.map((it) => {
        const fields = it.params.map((p) => ({ key: p.name, label: p.name, kind: p.type === "number" ? "number" : p.type === "bool" ? "bool" : "text", required: true }));
        const kind = it.source === "shortcuts" ? "shortcut" : "applescript";
        const template = kind === "shortcut" ? it.name : `tell application "App" to ${it.name}${fields.map((f) => ` "{{${f.key}}}"`).join("")}`;
        return { name: it.name, description: it.description ?? it.name, control: fields.length ? "input_button" : "button", fields, action: { kind, template }, staticLevel: /delete|remove|清空|删除/i.test(it.name) ? 2 : 1, source: it.source, fromItem: it.id };
      });
      return { text: "", toolCalls: [{ id: `m${this.calls}`, name: "propose_cards", args: { cards } }], usage, stopReason: "tool_use" };
    }
    if (req.forceTool === "propose_plan") {
      const steps = cmds.length
        ? cmds.map((c, i) => ({ title: `运行 ${c}`, channel: "shell" as const }))
        : intent.startsWith("gui:")
          ? [{ title: intent.slice(4).trim(), channel: "gui" as const }]
          : [{ title: "回答问题", channel: "shell" as const }];
      return { text: "", toolCalls: [{ id: `m${this.calls}`, name: "propose_plan", args: { steps } }], usage, stopReason: "tool_use" };
    }

    const doneCmds = req.messages.filter((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.name === "shell.run" || c.name === "gui.act")).length;
    if (cmds.length && doneCmds < cmds.length) {
      return { text: "", toolCalls: [{ id: `m${this.calls}`, name: "shell.run", args: { cmd: cmds[doneCmds] } }], usage, stopReason: "tool_use" };
    }
    if (intent.startsWith("gui:") && doneCmds === 0) {
      return { text: "", toolCalls: [{ id: `m${this.calls}`, name: "gui.act", args: { goal: intent.slice(4).trim(), app: "Calculator" } }], usage, stopReason: "tool_use" };
    }
    const lastTool = [...req.messages].reverse().find((m) => m.role === "tool");
    const out = lastTool && lastTool.role === "tool" ? lastTool.content.map((p) => (p.type === "text" ? p.text : "[图片]")).join("") : "";
    return { text: out ? `完成。输出：${out.trim().slice(0, 200)}` : `（mock）你说的是「${intent}」`, toolCalls: [], usage, stopReason: "end" };
  }
}

function firstUserText(req: ChatRequest): string {
  const u = req.messages.find((m) => m.role === "user");
  if (!u || u.role !== "user") return "";
  return u.content.map((p) => (p.type === "text" ? p.text : "")).join("").replace(/^意图[:：]\s*/, "").trim();
}

function parseShell(intent: string): string[] {
  if (!intent.startsWith("shell:")) return [];
  return intent.slice(6).split(/\s*&&\s*then:\s*/).map((s) => s.trim()).filter(Boolean);
}
