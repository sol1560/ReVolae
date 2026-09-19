import type { JevClient } from "../jev/client.js";
import type { AxElement } from "./cua-driver.js";

/**
 * jev-ax：GUI 一步的「选元素 + 选动作 + 是否已完成」交给 Jev，一次请求三问并行。
 * 文本 / 按键 / 坐标由规划模型事先给出（planner 参数），Jev 只选不生成。
 * 吸收 Sac-Y/Jev-cu 的做法，但顺序上 done 只用于「跳过动作」，风险与等级在 PolicyEngine 里单独判，先于执行。
 */

export const AX_ACTIONS = ["click", "set_value", "type_text", "press_key", "scroll", "wait", "ask_user"] as const;
export type AxAction = (typeof AX_ACTIONS)[number];

export interface JevAxInput {
  goal: string;
  app: string;
  elements: AxElement[];
  /** 规划模型预先给的参数 */
  planner: { text?: string; key?: string; scrollDirection?: "up" | "down" | "left" | "right" };
  recent: string[];
}

export interface JevAxDecision {
  target?: AxElement;
  targetConfidence: number;
  action: AxAction;
  done: number;
  /** 目标置信度低于门槛 → 升级到视觉模型 */
  escalate: boolean;
  /** 需要停下来问用户 */
  askUser: boolean;
  latencyMs: number;
  usd: number;
  tokens: number;
}

export const TARGET_CONFIDENCE_FLOOR = 0.5;

export async function jevAxDecide(jev: JevClient, input: JevAxInput): Promise<JevAxDecision> {
  const criteria: Record<string, string> = {};
  for (const e of input.elements) {
    if (!e.enabled) continue;
    criteria[`i${e.index}`] = `[${e.role}] ${e.label}${e.value ? ` = "${e.value}"` : ""}`;
  }
  criteria.none = "候选里没有合适的元素";

  const actionCriteria: Record<AxAction, string> = {
    click: "点击选中的元素",
    set_value: `把选中输入框的值整个替换为规划给的文本${input.planner.text ? `「${input.planner.text}」` : ""}`,
    type_text: `在选中元素里输入规划给的文本${input.planner.text ? `「${input.planner.text}」` : ""}`,
    press_key: `按规划给的键${input.planner.key ? `「${input.planner.key}」` : ""}`,
    scroll: `滚动${input.planner.scrollDirection ? `（${input.planner.scrollDirection}）` : ""}`,
    wait: "等界面更新",
    ask_user: "停下来问用户",
  };

  const r = await jev.ask(
    {
      app: input.app,
      goal: input.goal,
      elements: criteria,
      planner_params: input.planner,
      recent_actions: input.recent.slice(-6),
    },
    {
      target: { type: "choice", instructions: `为了完成目标「${input.goal}」，下一步应该操作哪个元素？`, criteria },
      action: { type: "choice", instructions: "下一步动作类型是什么？", criteria: actionCriteria },
      done: { type: "noul", instructions: "目标是否已经在当前界面状态里明显达成？", criteria: { true: "已经达成，无需再操作", false: "还没达成" } },
    },
  );

  const t = r.answers.target;
  const target = t.choice === "none" ? undefined : input.elements.find((e) => `i${e.index}` === t.choice);
  const action = r.answers.action.choice as AxAction;
  const done = r.answers.done.noul;
  const needsTarget = ["click", "set_value", "type_text"].includes(action);
  return {
    target,
    targetConfidence: t.confidence,
    action,
    done,
    escalate: needsTarget && (!target || t.confidence < TARGET_CONFIDENCE_FLOOR),
    askUser: action === "ask_user",
    latencyMs: r.latencyMs,
    usd: r.usd,
    tokens: r.usage.input_tokens ?? 0,
  };
}

/** 把 jev-ax 决定翻译成 cua-driver 的调用 */
export function toCuaCall(d: JevAxDecision, planner: JevAxInput["planner"], win: { pid: number; windowId: number }): { name: string; args: Record<string, unknown> } | null {
  const base = { pid: win.pid, window_id: win.windowId };
  switch (d.action) {
    case "click":
      return d.target ? { name: "click", args: { ...base, element_token: d.target.token } } : null;
    case "set_value":
      return d.target && planner.text !== undefined ? { name: "set_value", args: { ...base, element_token: d.target.token, value: planner.text } } : null;
    case "type_text":
      return planner.text !== undefined ? { name: "type_text", args: { ...base, ...(d.target ? { element_token: d.target.token } : {}), text: planner.text } } : null;
    case "press_key":
      return planner.key ? { name: "press_key", args: { ...base, key: planner.key } } : null;
    case "scroll":
      return { name: "scroll", args: { ...base, direction: planner.scrollDirection ?? "down", amount: 3 } };
    case "wait":
    case "ask_user":
      return null;
  }
}
