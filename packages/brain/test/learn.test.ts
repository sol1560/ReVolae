import { describe, expect, test } from "bun:test";
import type { AppInventory, CapabilityCard, InventoryItem, Scope, ToolDescriptor } from "@cuaremote/protocol";
import type { ApprovalGate } from "../src/agent/loop.js";
import type { Host, ToolResult } from "../src/host/types.js";
import { PolicyEngine } from "../src/jev/policy.js";
import { escapeFor, renderTemplate, toolArgs, validateCards } from "../src/learn/cards.js";
import { fetchCard, learnApp, runCard, type LearnEvent } from "../src/learn/learn.js";
import { MockProvider } from "../src/llm/mock.js";

const tool = (name: string, channel: ToolDescriptor["channel"], staticLevel: 0 | 1 | 2 = 1): ToolDescriptor => ({ name, description: name, channel, staticLevel, costClass: 0, dataLeavesDevice: false, inputSchema: {} });
const TOOLS: ToolDescriptor[] = [
  tool("app.inventory", "shell", 0),
  tool("app.card.get", "shell", 0),
  tool("applescript.run", "applescript", 1),
  tool("jxa.run", "applescript", 1),
  tool("shortcuts.run", "shortcuts", 1),
  tool("shell.run", "shell", 1),
];
const SCOPE: Scope = { allowedDirs: ["/tmp"], allowedApps: [], deniedCommands: ["sudo"] };

const ITEMS: Record<string, InventoryItem[]> = {
  sdef: [
    { source: "sdef", id: "Standard Suite/count", name: "count", description: "数一下", params: [], meta: {} },
    { source: "sdef", id: "Notes Suite/make note", name: "make note", description: "新建备忘录", params: [{ name: "body", type: "text", required: true }], meta: {} },
    { source: "sdef", id: "Notes Suite/delete note", name: "delete note", description: "删除备忘录", params: [{ name: "title", type: "text", required: true }], meta: {} },
  ],
  menu: [],
  window: [],
  shortcuts: [{ source: "shortcuts", id: "整理桌面", name: "整理桌面", params: [], meta: {} }],
};

/** 假设备：app.inventory 按阶段回 AppInventory；其它工具记下调用并回 ok */
function fakeHost(o: { items?: Record<string, InventoryItem[]>; cards?: Record<string, CapabilityCard>; withInventory?: boolean } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const items = o.items ?? ITEMS;
  const tools = o.withInventory === false ? TOOLS.filter((t) => t.name !== "app.inventory") : TOOLS;
  const host: Host = {
    listTools: async () => ({ tools, scope: SCOPE }),
    call: async (name, args): Promise<ToolResult> => {
      calls.push({ tool: name, args });
      if (name === "app.inventory") {
        const phase = String(args.phase) as AppInventory["phase"];
        if (phase === "window") return { ok: false, error: "窗口没开", attachments: [], ms: 1 };
        const inv: AppInventory = { bundleId: String(args.bundleId), appName: "备忘录", phase, items: items[phase] ?? [], truncated: false };
        return { ok: true, output: JSON.stringify(inv), attachments: [], ms: 1 };
      }
      if (name === "app.card.get") {
        const c = o.cards?.[String(args.cardId)];
        return c ? { ok: true, output: JSON.stringify(c), attachments: [], ms: 1 } : { ok: false, error: "没有这张卡", attachments: [], ms: 1 };
      }
      return { ok: true, output: `ran ${name}`, attachments: [], ms: 1 };
    },
  };
  return { host, calls };
}

const card = (over: Partial<CapabilityCard>): CapabilityCard => ({
  id: "com.apple.Notes:x",
  appBundleId: "com.apple.Notes",
  appName: "备忘录",
  name: "x",
  description: "x",
  control: "button",
  fields: [],
  action: { kind: "applescript", template: 'tell application "Notes" to count notes' },
  staticLevel: 1,
  source: "sdef",
  hidden: false,
  ...over,
});

describe("learnApp（假设备 + mock 模型）", () => {
  test("四阶段扒清单 → 卡片：id 带 bundleId 前缀、快捷指令出 shortcut 动作、删除类卡是 L2", async () => {
    const { host, calls } = fakeHost();
    const events: LearnEvent[] = [];
    const out = await learnApp({ host, provider: new MockProvider(), emit: (e) => events.push(e) }, { bundleId: "com.apple.Notes", explore: false });

    expect(calls.filter((c) => c.tool === "app.inventory").map((c) => c.args.phase)).toEqual(["sdef", "menu", "window", "shortcuts"]);
    expect(out.inventory).toHaveLength(4);
    expect(out.rejected).toEqual([]);
    expect(out.cards.map((c) => c.id)).toEqual(["com.apple.Notes:count", "com.apple.Notes:make-note", "com.apple.Notes:delete-note", "com.apple.Notes:整理桌面"]);
    expect(out.cards.every((c) => c.appName === "备忘录" && c.appBundleId === "com.apple.Notes")).toBe(true);

    const make = out.cards.find((c) => c.id === "com.apple.Notes:make-note")!;
    expect(make.control).toBe("input_button");
    expect(make.fields.map((f) => f.key)).toEqual(["body"]);
    expect(make.staticLevel).toBe(1);
    const del = out.cards.find((c) => c.id === "com.apple.Notes:delete-note")!;
    expect(del.staticLevel).toBe(2);
    const sc = out.cards.find((c) => c.id === "com.apple.Notes:整理桌面")!;
    expect(sc.action).toEqual({ kind: "shortcut", template: "整理桌面" });
    expect(sc.control).toBe("button");

    // 进度：window 阶段失败要如实汇报，最后 done + app.cards
    const progress = events.filter((e) => e.type === "app.learn.progress") as Extract<LearnEvent, { type: "app.learn.progress" }>[];
    expect(progress.map((p) => p.phase)).toEqual(["sdef", "sdef", "menu", "menu", "window", "window", "shortcuts", "shortcuts", "summarize", "done"]);
    expect(progress.find((p) => p.phase === "window" && p.message)!.message).toContain("窗口没开");
    expect(progress.at(-1)!.found).toBe(4);
    const cardsEv = events.find((e) => e.type === "app.cards") as Extract<LearnEvent, { type: "app.cards" }>;
    expect(cardsEv.cards).toHaveLength(4);
    expect(out.cost.usd).toBe(0);
  });

  test("设备没有 app.inventory：直接 failed，不调模型", async () => {
    const { host, calls } = fakeHost({ withInventory: false });
    const events: LearnEvent[] = [];
    const out = await learnApp({ host, provider: new MockProvider(), emit: (e) => events.push(e) }, { bundleId: "com.x", explore: false });
    expect(out.cards).toEqual([]);
    expect(calls).toHaveLength(0);
    const p = events[0] as Extract<LearnEvent, { type: "app.learn.progress" }>;
    expect(p.phase).toBe("failed");
    expect(p.message).toContain("app.inventory");
  });

  test("什么都没扒到：failed，不发 app.cards", async () => {
    const { host } = fakeHost({ items: { sdef: [], menu: [], window: [], shortcuts: [] } });
    const events: LearnEvent[] = [];
    const out = await learnApp({ host, provider: new MockProvider(), emit: (e) => events.push(e) }, { bundleId: "com.x", explore: false });
    expect(out.cards).toEqual([]);
    expect(events.some((e) => e.type === "app.cards")).toBe(false);
    expect((events.at(-1) as Extract<LearnEvent, { type: "app.learn.progress" }>).phase).toBe("failed");
  });
});

describe("validateCards：模型胡说的卡要丢掉", () => {
  const base = { bundleId: "com.apple.Notes", appName: "备忘录", inventory: ITEMS.sdef!, tools: TOOLS };
  const ok = { name: "数备忘录", description: "d", control: "button", fields: [], action: { kind: "applescript", template: 'tell application "Notes" to count notes' }, staticLevel: 0, source: "sdef" };

  test("模板占位符没在 fields 里声明 → 丢", () => {
    const bad = { ...ok, name: "新建", control: "input_button", fields: [{ key: "body", label: "内容", kind: "text" }], action: { kind: "applescript", template: 'make note with properties {body:"{{body}}", name:"{{title}}"}' } };
    const v = validateCards({ ...base, proposed: [ok, bad] });
    expect(v.cards.map((c) => c.name)).toEqual(["数备忘录"]);
    expect(v.rejected).toEqual([{ name: "新建", reason: "模板用了没定义的字段：title" }]);
  });

  test("来源 / 动作不配、fromItem 不在清单、控件结构错 → 各自的理由", () => {
    const shellFromSdef = { ...ok, name: "a", action: { kind: "shell", template: "ls" } };
    const ghost = { ...ok, name: "b", fromItem: "不存在" };
    const badToggle = { ...ok, name: "c", control: "toggle", fields: [{ key: "on", label: "开", kind: "text" }], action: { kind: "applescript", template: "set x to {{on}}" } };
    const buttonWithField = { ...ok, name: "d", fields: [{ key: "k", label: "k", kind: "text" }] };
    const listNoSource = { ...ok, name: "e", control: "list" };
    const v = validateCards({ ...base, proposed: [shellFromSdef, ghost, badToggle, buttonWithField, listNoSource] });
    expect(v.cards).toEqual([]);
    expect(v.rejected.map((r) => r.reason)).toEqual(["来源 sdef 不允许 shell 动作", "fromItem 不存在 不在能力清单里", "toggle 必须恰好一个 bool 字段", "button 不能带字段", "list 必须有 dataSource"]);
  });

  test("staticLevel 只升不降：模型标 0 但模板是 rm -rf → 升到 2；同名卡 id 加序号", () => {
    const rm = { ...ok, name: "清理", source: "adapter", action: { kind: "shell", template: "rm -rf /tmp/cache" }, staticLevel: 0 };
    const v = validateCards({ ...base, proposed: [rm, { ...rm, staticLevel: 1 }] });
    expect(v.cards.map((c) => c.staticLevel)).toEqual([2, 2]);
    expect(v.cards.map((c) => c.id)).toEqual(["com.apple.Notes:清理", "com.apple.Notes:清理-2"]);
  });

  test("格式不对（缺 action）→ 丢，并保留名字方便排查", () => {
    const v = validateCards({ ...base, proposed: [{ name: "残缺", description: "d", control: "button", staticLevel: 0, source: "sdef" }, 42] });
    expect(v.cards).toEqual([]);
    expect(v.rejected[0]!.name).toBe("残缺");
    expect(v.rejected[0]!.reason).toContain("格式不对");
    expect(v.rejected[1]!.name).toBe("(无名)");
  });
});

describe("renderTemplate / escapeFor：用户填的值不能拼成代码", () => {
  const c = card({ control: "input_button", fields: [{ key: "t", label: "t", kind: "text", required: true }] });

  test("applescript：双引号和反斜杠转义，换行变 \\n", () => {
    const r = renderTemplate({ ...c, action: { kind: "applescript", template: 'make note "{{t}}"' } }, { t: 'a"b\\c\nd' });
    expect(r.text).toBe('make note "a\\"b\\\\c\\nd"');
    expect(r.missing).toEqual([]);
  });

  test("jxa：按 JS 字符串字面量转义", () => {
    const r = renderTemplate({ ...c, action: { kind: "jxa", template: 'Notes.make({body:"{{t}}"})' } }, { t: 'x"y\n\u0001' });
    expect(r.text).toBe('Notes.make({body:"x\\"y\\n\\u0001"})');
  });

  test("shell：自动单引号包裹，单引号用 '\"'\"' 拼接", () => {
    const r = renderTemplate({ ...c, action: { kind: "shell", template: "echo {{t}}" } }, { t: "it's; rm -rf /" });
    expect(r.text).toBe(`echo 'it'"'"'s; rm -rf /'`);
    expect(escapeFor("shell", "plain")).toBe("'plain'");
  });

  test("bool / number 不转义，bool 归一为 true/false，number 非数字算 invalid", () => {
    const f = card({ control: "form", fields: [{ key: "on", label: "on", kind: "bool", required: false }, { key: "n", label: "n", kind: "number", required: false }], action: { kind: "shell", template: "cmd --on={{on}} --n={{n}}" } });
    expect(renderTemplate(f, { on: "是", n: "3" }).text).toBe("cmd --on=true --n=3");
    expect(renderTemplate(f, { on: "nope", n: "3" }).text).toBe("cmd --on=false --n=3");
    const bad = renderTemplate(f, { on: "1", n: "3; ls" });
    expect(bad.invalid).toEqual(["n"]);
  });

  test("缺必填 / 非法 choice 记入结果；strict=false 时缺必填不算", () => {
    const p = card({ control: "picker", fields: [{ key: "fmt", label: "格式", kind: "choice", choices: ["pdf", "png"], required: true }], action: { kind: "applescript", template: 'export as "{{fmt}}"' } });
    expect(renderTemplate(p, {})).toEqual({ text: 'export as ""', missing: ["fmt"], invalid: [] });
    expect(renderTemplate(p, { fmt: "exe" }).invalid).toEqual(["fmt"]);
    expect(renderTemplate(p, {}, { strict: false }).missing).toEqual([]);
  });

  test("toolArgs：shortcut 模板第一行是名字、其余是输入；gui 带应用名", () => {
    expect(toolArgs("shortcut", "整理桌面", c)).toEqual({ name: "整理桌面" });
    expect(toolArgs("shortcut", "发送\n你好\n第二行", c)).toEqual({ name: "发送", input: "你好\n第二行" });
    expect(toolArgs("gui", "点导出", { appName: "备忘录", name: "x" })).toEqual({ app: "备忘录", goal: "点导出" });
    expect(toolArgs("shell", "ls", c)).toEqual({ cmd: "ls" });
  });
});

describe("runCard：每张卡都过策略引擎", () => {
  function deps(autonomy: "cautious" | "balanced" | "handsoff", gate?: ApprovalGate) {
    const { host, calls } = fakeHost();
    const events: LearnEvent[] = [];
    const asked: { level: number; detail: string }[] = [];
    const approvals: ApprovalGate = gate ?? { request: async (r) => { asked.push({ level: r.level, detail: r.action.detail }); return { allow: true, remember: "once" }; } };
    return { d: { host, policy: new PolicyEngine({ jevEnabled: false, autonomy }), approvals, emit: (e: LearnEvent) => events.push(e), deviceId: "mac-1" }, calls, events, asked };
  }
  const types = (events: LearnEvent[]) => events.map((e) => e.type);

  test("平衡档 L1 卡：先确认再执行，工具收到渲染后的脚本", async () => {
    const { d, calls, events, asked } = deps("balanced");
    const c = card({ control: "input_button", fields: [{ key: "body", label: "内容", kind: "text", required: true }], action: { kind: "applescript", template: 'tell application "Notes" to make new note with properties {body:"{{body}}"}' } });
    const out = await runCard(d, c, { body: 'hi "there"' });
    expect(out.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.level).toBe(1);
    expect(asked[0]!.detail).toContain('{body:"hi \\"there\\""}');
    expect(types(events)).toEqual(["run.created", "step.started", "step.precheck", "step.approval_required", "step.finished", "run.finished"]);
    expect(calls.filter((x) => x.tool === "applescript.run")).toHaveLength(1);
    expect(calls.find((x) => x.tool === "applescript.run")!.args.script).toBe('tell application "Notes" to make new note with properties {body:"hi \\"there\\""}');
    const created = events[0] as Extract<LearnEvent, { type: "run.created" }>;
    expect(created.deviceId).toBe("mac-1");
    expect(created.plan[0]!.channel).toBe("applescript");
  });

  test("用户拒绝：不调用工具，run 失败", async () => {
    const { d, calls, events } = deps("balanced", { request: async () => ({ allow: false, remember: "once" }) });
    const out = await runCard(d, card({}), {});
    expect(out.ok).toBe(false);
    expect(calls.filter((x) => x.tool === "applescript.run")).toHaveLength(0);
    const fin = events.find((e) => e.type === "step.finished") as Extract<LearnEvent, { type: "step.finished" }>;
    expect(fin.ok).toBe(false);
    expect(fin.error).toContain("拒绝");
  });

  test("放手档 L1 卡直接跑；但卡片自带 L2 时即使静态放行也必须确认", async () => {
    const a = deps("handsoff");
    await runCard(a.d, card({}), {});
    expect(a.asked).toHaveLength(0);
    expect(a.calls.filter((x) => x.tool === "applescript.run")).toHaveLength(1);

    const b = deps("handsoff");
    const out = await runCard(b.d, card({ staticLevel: 2 }), {});
    expect(out.ok).toBe(true);
    expect(b.asked).toEqual([{ level: 2, detail: 'tell application "Notes" to count notes' }]);
    const pre = b.events.find((e) => e.type === "step.precheck") as Extract<LearnEvent, { type: "step.precheck" }>;
    expect(pre.level).toBe(2);
    expect(pre.verdict).toBe("confirm");
  });

  test("缺必填参数：不进策略、不调工具，报 card_params", async () => {
    const { d, calls, events } = deps("handsoff");
    const c = card({ control: "input_button", fields: [{ key: "body", label: "内容", kind: "text", required: true }], action: { kind: "applescript", template: 'x "{{body}}"' } });
    const out = await runCard(d, c, {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("body");
    expect(types(events)).toEqual(["run.created", "error", "run.finished"]);
    expect(calls).toHaveLength(0);
  });

  test("deniedCommands 命中 → 策略直接拒绝，不问用户", async () => {
    const { d, asked, events } = deps("handsoff");
    const out = await runCard(d, card({ source: "adapter", action: { kind: "shell", template: "sudo rm x" } }), {});
    expect(out.ok).toBe(false);
    expect(asked).toHaveLength(0);
    const pre = events.find((e) => e.type === "step.precheck") as Extract<LearnEvent, { type: "step.precheck" }>;
    expect(pre.verdict).toBe("deny");
  });

  test("设备缺工具：run.created 后立刻失败", async () => {
    const { d, events } = deps("handsoff");
    const out = await runCard(d, card({ action: { kind: "gui", template: "点导出" }, source: "window" }), {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("gui.act");
    expect(types(events)).toEqual(["run.created", "run.finished"]);
  });
});

describe("fetchCard", () => {
  test("有卡回卡，没卡回原因，内容不合法也拒", async () => {
    const good = card({ id: "com.apple.Notes:count" });
    const { host } = fakeHost({ cards: { "com.apple.Notes:count": good, broken: { nope: true } as unknown as CapabilityCard } });
    expect(await fetchCard(host, "com.apple.Notes:count")).toEqual({ card: good });
    expect(await fetchCard(host, "missing")).toEqual({ error: "没有这张卡" });
    expect((await fetchCard(host, "broken") as { error: string }).error).toContain("不合法");
    const { host: noTool } = fakeHost();
    (noTool as { listTools: Host["listTools"] }).listTools = async () => ({ tools: TOOLS.filter((t) => t.name !== "app.card.get"), scope: SCOPE });
    expect((await fetchCard(noTool, "x") as { error: string }).error).toContain("app.card.get");
  });
});
