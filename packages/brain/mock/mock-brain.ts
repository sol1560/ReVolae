#!/usr/bin/env bun
/**
 * Mock 大脑：不调任何模型，按固定剧本走一遍「大脑 ↔ 宿主」stdio 链路，
 * 供 Swift daemon / Android daemon / hub 的宿主实现做集成测试。
 *
 * 用法：  bun run packages/brain/mock/mock-brain.ts   （宿主 spawn 它，stdin/stdout 各一行一个 JSON）
 *
 * 剧本（收到 intent.submit 后）：
 *   1. tools.list                         → 等 tools.list.result
 *   2. run.created（3 步 plan）
 *   3. step.started s1  → tools.call shell.run {cmd:"echo hello from mock-brain"} → step.precheck(allow) → step.finished
 *   4. step.started s2  → step.precheck(confirm) → step.approval_required
 *        等 approval.decision：allow → tools.call shell.run {cmd:"date"} → step.finished
 *                              deny  → step.finished ok=false
 *   5. step.started s3  → tools.call screenshot（若宿主有）→ step.finished（不回传图片内容，只记录字节数）
 *   6. run.finished
 * 其他消息：run.cancel → 立刻 run.finished cancelled；未知 → error。
 */
import { randomUUID } from "node:crypto";
import {
  AnyMessage,
  mkMsg,
  type MsgBody,
  approvalChallenge,
  type ToolDescriptor,
  type ToolsResult,
  type ToolsListResult,
  type ApprovalDecision,
  type Cost,
} from "@cuaremote/protocol";
import { z } from "zod";

type Out = z.infer<typeof AnyMessage>;
type Body = MsgBody;

const zeroCost: Cost = { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 };

function send(m: Body) {
  let full: Out;
  try {
    full = mkMsg(m);
  } catch (e) {
    process.stderr.write(`mock-brain: 自己要发的消息不合法 ${JSON.stringify(m)}\n${String(e)}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(full) + "\n");
}

// ── 等待特定回复的小队列 ──────────────────────────────
type Waiter = { match: (m: Out) => boolean; resolve: (m: Out) => void };
const waiters: Waiter[] = [];
function waitFor<T extends Out>(match: (m: Out) => m is T, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error("等待宿主回复超时"));
    }, timeoutMs);
    const w: Waiter = { match, resolve: (m) => { clearTimeout(t); resolve(m as T); } };
    waiters.push(w);
  });
}

let tools: ToolDescriptor[] = [];
let cancelled = false;

async function callTool(tool: string, args: Record<string, unknown>): Promise<z.infer<typeof ToolsResult>> {
  const callId = randomUUID();
  send({ type: "tools.call", callId, tool, args, timeoutMs: 60_000 });
  return waitFor((m): m is z.infer<typeof ToolsResult> => m.type === "tools.result" && m.callId === callId);
}

async function runScript(intent: { text: string; deviceId: string; provider?: string }) {
  cancelled = false;
  const runId = randomUUID();
  const started = Date.now();

  send({ type: "tools.list" });
  const listed = await waitFor((m): m is z.infer<typeof ToolsListResult> => m.type === "tools.list.result");
  tools = listed.tools;
  const has = (n: string) => tools.some((t) => t.name === n);

  send({
    type: "run.created",
    runId,
    deviceId: intent.deviceId,
    intent: intent.text,
    provider: intent.provider ?? "mock",
    plan: [
      { id: "s1", title: "打个招呼（只读 shell）", channel: "shell", staticLevel: 0, status: "pending" },
      { id: "s2", title: "看一下当前时间（需要你确认）", channel: "shell", staticLevel: 1, status: "pending" },
      { id: "s3", title: "截一张屏", channel: "fs", staticLevel: 0, status: "pending" },
    ],
  });

  const finishStep = (stepId: string, ok: boolean, ms: number, extra: Partial<{ output: string; error: string }> = {}) =>
    send({ type: "step.finished", runId, stepId, ok, ms, channel: "shell", cost: zeroCost, dataLeftDevice: false, ...extra });

  // s1
  {
    const t0 = Date.now();
    send({ type: "step.started", runId, stepId: "s1", title: "打个招呼", channel: "shell" });
    send({ type: "step.precheck", runId, stepId: "s1", staticLevel: 0, level: 0, verdict: "allow", source: "static" });
    const r = await callTool("shell.run", { cmd: "echo hello from mock-brain" });
    finishStep("s1", r.ok, Date.now() - t0, r.ok ? { output: r.output ?? "" } : { error: r.error ?? "unknown" });
    if (cancelled) return finishRun(runId, false, "已取消", 1, true);
  }

  // s2 需要审批
  {
    const t0 = Date.now();
    send({ type: "step.started", runId, stepId: "s2", title: "看一下当前时间", channel: "shell" });
    send({ type: "step.precheck", runId, stepId: "s2", staticLevel: 1, level: 1, intentMatch: true, risk: 0.1, confidence: 0.4, jevMs: 0, verdict: "confirm", source: "static" });
    const nonce = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const detail = "date";
    const challenge = approvalChallenge({ runId, stepId: "s2", actionDetail: detail, nonce, expiresAt });
    send({
      type: "step.approval_required",
      runId,
      stepId: "s2",
      level: 1,
      action: { channel: "shell", summary: "在终端运行 date", detail },
      reason: "mock 剧本：演示一次需要确认的操作",
      expiresAt,
      challenge,
    });
    const decision = await waitFor(
      (m): m is z.infer<typeof ApprovalDecision> => m.type === "approval.decision" && m.runId === runId && m.stepId === "s2",
      300_000,
    );
    if (decision.allow) {
      const r = await callTool("shell.run", { cmd: detail });
      finishStep("s2", r.ok, Date.now() - t0, r.ok ? { output: r.output ?? "" } : { error: r.error ?? "unknown" });
    } else {
      finishStep("s2", false, Date.now() - t0, { error: "用户拒绝" });
    }
    if (cancelled) return finishRun(runId, false, "已取消", 2, true);
  }

  // s3 截图
  {
    const t0 = Date.now();
    send({ type: "step.started", runId, stepId: "s3", title: "截一张屏", channel: "fs" });
    send({ type: "step.precheck", runId, stepId: "s3", staticLevel: 0, level: 0, verdict: "allow", source: "static" });
    if (has("screenshot")) {
      const r = await callTool("screenshot", { maxWidth: 800 });
      const bytes = r.attachments.reduce((n, a) => n + (a.inline ? Math.floor((a.inline.length * 3) / 4) : 0), 0);
      finishStep("s3", r.ok, Date.now() - t0, r.ok ? { output: `收到截图 ${r.attachments.length} 张，约 ${bytes} 字节` } : { error: r.error ?? "unknown" });
    } else {
      finishStep("s3", true, Date.now() - t0, { output: "宿主没有 screenshot 工具，跳过" });
    }
  }

  finishRun(runId, true, `mock 剧本跑完，用时 ${Date.now() - started}ms，宿主工具 ${tools.length} 个`, 3, false);
}

function finishRun(runId: string, ok: boolean, summary: string, stepCount: number, wasCancelled: boolean) {
  send({ type: "run.finished", runId, ok, summary, cost: zeroCost, stepCount, cancelled: wasCancelled });
}

// ── stdin 读循环 ──────────────────────────────
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function handleLine(line: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    send({ type: "error", code: "bad_json", message: `不是 JSON: ${line.slice(0, 80)}` });
    return;
  }
  const parsed = AnyMessage.safeParse(raw);
  if (!parsed.success) {
    send({ type: "error", code: "bad_message", message: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
    return;
  }
  const m = parsed.data;

  const wi = waiters.findIndex((w) => w.match(m));
  if (wi >= 0) {
    const [w] = waiters.splice(wi, 1);
    w!.resolve(m);
    return;
  }

  switch (m.type) {
    case "intent.submit":
      runScript(m).catch((e) => {
        send({ type: "error", code: "mock_failed", message: String(e?.message ?? e) });
      });
      break;
    case "run.cancel":
      cancelled = true;
      break;
    case "privacy.state":
      process.stderr.write(`mock-brain: 收到隐私设置 brain=${m.settings.brainLocation} tier=${m.settings.modelTier}\n`);
      break;
    default:
      send({ type: "error", code: "unhandled", message: `mock 大脑不处理 ${m.type}` });
  }
}

process.stderr.write("mock-brain: 就绪，等 intent.submit\n");
