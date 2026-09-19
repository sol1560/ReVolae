#!/usr/bin/env bun
/**
 * cuaremote 大脑 CLI
 *   brain run "<意图>" [--provider anthropic:claude-fable-5.1] [--mode terminal] [--yes] [--autonomy cautious|balanced|handsoff]
 *   brain --mode host [--provider ...]        被 daemon spawn，stdio 协议
 *   brain tools                               列出本机宿主工具
 */
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runIntent, type ApprovalGate, type BrainEvent } from "./agent/loop.js";
import { CuaDriver } from "./gui/cua-driver.js";
import { LocalBunHost } from "./host/local-bun-host.js";
import { runHostMode } from "./host-mode.js";
import { JevClient } from "./jev/client.js";
import { PolicyEngine, type Autonomy } from "./jev/policy.js";
import { createProvider } from "./llm/providers.js";
import { JsonlLog } from "./log.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const defaultProvider = flag("provider") ?? process.env.CUAREMOTE_PROVIDER ?? "anthropic:claude-fable-5.1";
const logPath = flag("log") ?? join(homedir(), ".cuaremote", "logs", `brain-${new Date().toISOString().slice(0, 10)}.jsonl`);

if (flag("mode") === "host") {
  await runHostMode({ defaultProvider, logPath, cuaArgv: flag("cua")?.split(" ") });
} else if (argv[0] === "tools") {
  const host = new LocalBunHost();
  const { tools, scope } = await host.listTools();
  console.log(JSON.stringify({ tools: tools.map((t) => `${t.name} L${t.staticLevel}`), scope }, null, 2));
} else if (argv[0] === "run") {
  const intent = argv.slice(1).filter((a) => !a.startsWith("--") && a !== flag("provider") && a !== flag("mode") && a !== flag("autonomy") && a !== flag("log") && a !== flag("cua")).join(" ");
  if (!intent) {
    console.error("用法：brain run \"<意图>\"");
    process.exit(1);
  }
  const provider = createProvider(defaultProvider);
  const host = new LocalBunHost();
  const jev = new JevClient();
  const policy = new PolicyEngine({ jev, autonomy: (flag("autonomy") as Autonomy | undefined) ?? "balanced" });
  const gui = new CuaDriver({ argv: flag("cua")?.split(" ") });
  const guiUp = has("no-gui") ? false : await gui.start();
  const log = new JsonlLog(logPath);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const approvals: ApprovalGate = {
    request: async (req) => {
      if (has("yes")) return { allow: true, remember: "once" };
      console.error(`\n⚠️  需要确认（L${req.level}）：${req.action.summary}\n    ${req.action.detail.split("\n")[0]}\n    原因：${req.reason}`);
      const a = (await rl.question("    允许？[y]是 / [a]以后都允许 / [n]拒绝: ")).trim().toLowerCase();
      return { allow: a === "y" || a === "a", remember: a === "a" ? "always" : "once" };
    },
  };
  const emit = (e: BrainEvent) => {
    switch (e.type) {
      case "run.created": console.error(`计划（${e.provider}）：\n${e.plan.map((s, i) => `  ${i + 1}. ${s.title} [${s.channel}]`).join("\n")}`); break;
      case "step.started": console.error(`→ ${e.title}`); break;
      case "step.precheck": console.error(`   预检 L${e.level} ${e.verdict} (${e.source}${e.jevMs ? ` ${e.jevMs}ms` : ""})`); break;
      case "step.finished": console.error(`   ${e.ok ? "✓" : "✗"} ${e.ms}ms${e.error ? ` ${e.error}` : ""}`); if (e.output) console.error(indent(e.output.slice(0, 600))); break;
      case "terminal.suggestion": console.log(e.command); console.error(`   ${e.explanation}`); break;
      case "run.finished": console.error(`\n${e.ok ? "完成" : "失败"}：${e.summary}\n成本：$${e.cost.usd.toFixed(4)}（in ${e.cost.inputTokens} / out ${e.cost.outputTokens} / jev ${e.cost.jevTokens}），${e.stepCount} 步`); break;
      case "error": console.error(`错误 ${e.code}: ${e.message}`); break;
    }
  };
  const out = await runIntent({ host, provider, policy, approvals, gui: guiUp ? gui : undefined, jev, emit, log: (r) => log.write(r) }, { deviceId: "local", intent, mode: (flag("mode") as "agent" | "terminal" | undefined) ?? "agent" });
  await gui.close();
  rl.close();
  process.exit(out.ok ? 0 : 2);
} else {
  console.error("用法：brain run \"<意图>\" | brain tools | brain --mode host");
  process.exit(1);
}

function indent(s: string) {
  return s.split("\n").map((l) => "     " + l).join("\n");
}
