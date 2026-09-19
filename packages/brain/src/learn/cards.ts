import { CapabilityCard, type InventoryItem, type Level, type ToolDescriptor } from "@cuaremote/protocol";
import { z } from "zod";
import { describe } from "../agent/loop.js";
import { staticLevel } from "../jev/policy.js";

/**
 * 能力卡片：模型从能力清单里总结出来，手机按 control 渲染成 6 种控件。
 * 这里管三件事：模型输出的校验 / 补齐、模板渲染（按通道转义）、卡片 → 工具调用。
 */

/** 卡片动作类型 → 设备上的工具名 */
export const CARD_TOOL: Record<CapabilityCard["action"]["kind"], string> = {
  applescript: "applescript.run",
  jxa: "jxa.run",
  shortcut: "shortcuts.run",
  shell: "shell.run",
  gui: "gui.act",
};

/** 每种来源允许的动作类型（模型给了不合理的组合直接丢弃） */
const ALLOWED_KIND: Record<CapabilityCard["source"], Set<CapabilityCard["action"]["kind"]>> = {
  sdef: new Set(["applescript", "jxa"]),
  menu: new Set(["applescript", "gui"]),
  window: new Set(["gui", "applescript"]),
  shortcuts: new Set(["shortcut"]),
  explored: new Set(["gui", "applescript", "jxa"]),
  adapter: new Set(["applescript", "jxa", "shortcut", "shell", "gui"]),
};

/** 模型 propose_cards 的参数：比 CapabilityCard 宽松，id / appBundleId / appName 由我们补 */
export const ProposedCard = CapabilityCard.omit({ id: true, appBundleId: true, appName: true, hidden: true }).extend({
  /** 对应能力清单里的条目 id，用来核对来源 */
  fromItem: z.string().optional(),
});
export type ProposedCard = z.infer<typeof ProposedCard>;

export const PROPOSE_CARDS_TOOL = {
  name: "propose_cards",
  description: "把应用的能力清单总结成用户在手机上一键能用的能力卡片。",
  inputSchema: {
    type: "object",
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "卡片标题，动词开头，≤ 12 个字" },
            description: { type: "string", description: "一句话说明这张卡做什么" },
            control: { type: "string", enum: ["button", "input_button", "list", "toggle", "picker", "form"] },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  label: { type: "string" },
                  kind: { type: "string", enum: ["text", "number", "bool", "choice", "date"] },
                  choices: { type: "array", items: { type: "string" } },
                  required: { type: "boolean" },
                },
                required: ["key", "label", "kind"],
              },
            },
            action: {
              type: "object",
              properties: { kind: { type: "string", enum: ["applescript", "jxa", "shortcut", "gui", "shell"] }, template: { type: "string", description: "脚本 / 命令模板，字段用 {{key}} 占位" } },
              required: ["kind", "template"],
            },
            dataSource: {
              type: "object",
              properties: { kind: { type: "string", enum: ["applescript", "jxa", "shortcut", "gui", "shell"] }, template: { type: "string" } },
              required: ["kind", "template"],
            },
            staticLevel: { type: "integer", enum: [0, 1, 2] },
            source: { type: "string", enum: ["sdef", "menu", "window", "shortcuts", "explored"] },
            fromItem: { type: "string" },
          },
          required: ["name", "description", "control", "action", "staticLevel", "source"],
        },
      },
    },
    required: ["cards"],
  },
};

export const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "card";

export interface ValidateResult {
  cards: CapabilityCard[];
  /** 被丢掉的卡和原因 */
  rejected: { name: string; reason: string }[];
}

/**
 * 模型输出 → 合法卡片。规则：
 *   - 模板里的每个 {{key}} 必须在 fields 里；fields 里的 key 不能重复
 *   - control 和 fields 要配：button 无字段；input_button / form 至少一个；toggle 恰好一个 bool；picker 恰好一个 choice；list 必须有 dataSource
 *   - action.kind 要和 source 匹配（sdef 不能出 shell）
 *   - fromItem 给了就必须在清单里
 *   - staticLevel 取 max(模型说的, 我们按样例参数渲染后静态分级的结果)，只能升不能降
 */
export function validateCards(p: { bundleId: string; appName: string; proposed: unknown[]; inventory: InventoryItem[]; tools: ToolDescriptor[] }): ValidateResult {
  const itemIds = new Set(p.inventory.map((i) => i.id));
  const byName = new Map(p.tools.map((t) => [t.name, t]));
  const out: CapabilityCard[] = [];
  const rejected: ValidateResult["rejected"] = [];
  const usedIds = new Set<string>();

  for (const raw of p.proposed) {
    const parsed = ProposedCard.safeParse(raw);
    const name = typeof raw === "object" && raw && "name" in raw ? String((raw as { name: unknown }).name) : "(无名)";
    if (!parsed.success) {
      rejected.push({ name, reason: `格式不对：${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}` });
      continue;
    }
    const c = parsed.data;
    const reason = structuralProblem(c) ?? (c.fromItem && !itemIds.has(c.fromItem) ? `fromItem ${c.fromItem} 不在能力清单里` : null) ?? (!ALLOWED_KIND[c.source].has(c.action.kind) ? `来源 ${c.source} 不允许 ${c.action.kind} 动作` : null);
    if (reason) {
      rejected.push({ name: c.name, reason });
      continue;
    }
    let id = `${p.bundleId}:${slug(c.name)}`;
    for (let n = 2; usedIds.has(id); n++) id = `${p.bundleId}:${slug(c.name)}-${n}`;
    usedIds.add(id);

    const { fromItem: _drop, ...rest } = c;
    const card: CapabilityCard = { ...rest, id, appBundleId: p.bundleId, appName: p.appName, hidden: false };
    // 静态分级只能往上调
    const tool = byName.get(CARD_TOOL[card.action.kind]);
    if (tool) {
      const sample = renderTemplate(card, sampleParams(card), { strict: false });
      const args = toolArgs(card.action.kind, sample.text, card);
      const lvl = staticLevel(tool, args, describe(tool, args));
      if (lvl > card.staticLevel) card.staticLevel = lvl;
    }
    out.push(card);
  }
  return { cards: out, rejected };
}

function structuralProblem(c: ProposedCard): string | null {
  const keys = c.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) return "字段 key 重复";
  const holes = placeholders(c.action.template);
  const missing = holes.filter((h) => !keys.includes(h));
  if (missing.length) return `模板用了没定义的字段：${missing.join(", ")}`;
  if (c.dataSource) {
    const dsMissing = placeholders(c.dataSource.template).filter((h) => !keys.includes(h));
    if (dsMissing.length) return `dataSource 模板用了没定义的字段：${dsMissing.join(", ")}`;
  }
  switch (c.control) {
    case "button":
      if (c.fields.length) return "button 不能带字段";
      break;
    case "input_button":
    case "form":
      if (!c.fields.length) return `${c.control} 至少要一个字段`;
      break;
    case "toggle":
      if (c.fields.length !== 1 || c.fields[0]!.kind !== "bool") return "toggle 必须恰好一个 bool 字段";
      break;
    case "picker":
      if (c.fields.length !== 1 || c.fields[0]!.kind !== "choice" || !c.fields[0]!.choices?.length) return "picker 必须恰好一个带 choices 的 choice 字段";
      break;
    case "list":
      if (!c.dataSource) return "list 必须有 dataSource";
      break;
  }
  for (const f of c.fields) if (f.kind === "choice" && !f.choices?.length) return `choice 字段 ${f.key} 缺 choices`;
  return null;
}

/** 给静态分级用的样例参数：填个无害占位值 */
function sampleParams(card: CapabilityCard): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of card.fields) o[f.key] = f.kind === "bool" ? "true" : f.kind === "number" ? "1" : f.kind === "choice" ? (f.choices?.[0] ?? "") : f.kind === "date" ? "2026-01-01" : "sample";
  return o;
}

// ───────────────────────── 渲染 ─────────────────────────

/** 按通道转义用户填的值，防止把参数拼成代码 */
export function escapeFor(kind: CapabilityCard["action"]["kind"], value: string): string {
  switch (kind) {
    case "applescript":
      // 放在 "..." 里：反斜杠和双引号
      return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
    case "jxa":
      // 放在 JS 字符串字面量里
      return JSON.stringify(value).slice(1, -1);
    case "shell":
      // 单引号包裹：'It'"'"'s'
      return `'${value.replace(/'/g, `'"'"'`)}'`;
    case "shortcut":
    case "gui":
      return value;
  }
}

export interface RenderResult {
  text: string;
  /** 用户没填、也没默认值的必填字段 */
  missing: string[];
  /** choice 字段填了不在 choices 里的值 */
  invalid: string[];
}

/**
 * 模板 + 用户参数 → 可执行文本。strict=true 时缺必填 / 非法 choice 记进结果但不抛，调用方决定。
 * 类型规整：bool 归一成 true/false；number 只允许数字。
 */
export function renderTemplate(card: CapabilityCard, params: Record<string, string>, o: { strict: boolean } = { strict: true }): RenderResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const values = new Map<string, string>();
  for (const f of card.fields) {
    const raw = params[f.key];
    if (raw === undefined || raw === "") {
      if (f.required && o.strict) missing.push(f.key);
      values.set(f.key, "");
      continue;
    }
    let v = raw;
    if (f.kind === "bool") v = /^(true|1|yes|on|是)$/i.test(raw) ? "true" : "false";
    if (f.kind === "number" && !/^-?\d+(\.\d+)?$/.test(raw)) invalid.push(f.key);
    if (f.kind === "choice" && f.choices && !f.choices.includes(raw)) invalid.push(f.key);
    values.set(f.key, v);
  }
  const text = card.action.template.replace(PLACEHOLDER, (_m, key: string) => {
    const f = card.fields.find((x) => x.key === key);
    const v = values.get(key) ?? "";
    // bool / number 不需要转义（不会拼进字符串字面量），其它按通道转义
    return f && (f.kind === "bool" || f.kind === "number") ? v : escapeFor(card.action.kind, v);
  });
  return { text, missing, invalid };
}

/** 渲染好的文本 → 设备工具参数 */
export function toolArgs(kind: CapabilityCard["action"]["kind"], text: string, card: Pick<CapabilityCard, "appName" | "name">): Record<string, unknown> {
  switch (kind) {
    case "applescript":
    case "jxa":
      return { script: text };
    case "shell":
      return { cmd: text };
    case "shortcut":
      // 模板 = 快捷指令名字；带输入用 "名字\n输入"
      return text.includes("\n") ? { name: text.slice(0, text.indexOf("\n")), input: text.slice(text.indexOf("\n") + 1) } : { name: text };
    case "gui":
      return { app: card.appName, goal: text };
  }
}

export function cardLevel(card: CapabilityCard): Level {
  return card.staticLevel;
}
