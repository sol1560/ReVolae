#!/usr/bin/env bun
/**
 * 最小 TS 宿主：spawn mock-brain，扮演「宿主 + 手机」两个角色，验证 stdio 契约。
 * 也是 Swift 宿主实现者的参考行为（tools.list.result 的内容、tools.result 的格式、审批的回法）。
 *
 * 用法： bun run packages/brain/mock/run-mock-host.ts [--deny]
 * 退出码 0 = 剧本按预期走完。
 */
import { spawn } from "node:child_process";
import { AnyMessage, mkMsg, type MsgBody, type ToolDescriptor } from "@cuaremote/protocol";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const deny = process.argv.includes("--deny");
const here = dirname(fileURLToPath(import.meta.url));
const brain = spawn("bun", ["run", join(here, "mock-brain.ts")], { stdio: ["pipe", "pipe", "inherit"] });

const hostTools: ToolDescriptor[] = [
  { name: "shell.run", description: "在 /bin/sh 里跑命令", channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  { name: "fs.list", description: "列目录", channel: "fs", staticLevel: 0, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];

function write(m: MsgBody) {
  brain.stdin.write(JSON.stringify(mkMsg(m)) + "\n");
}

const seen: string[] = [];
let buf = "";
brain.stdout.setEncoding("utf8");
brain.stdout.on("data", async (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) await onMessage(AnyMessage.parse(JSON.parse(line)));
  }
});

async function onMessage(m: AnyMessage) {
  seen.push(m.type);
  switch (m.type) {
    case "tools.list":
      write({ type: "tools.list.result", tools: hostTools, scope: { allowedDirs: [process.cwd()], allowedApps: [], deniedCommands: ["sudo", "rm -rf"] } });
      break;
    case "tools.call": {
      const t0 = Date.now();
      if (m.tool === "shell.run") {
        const p = Bun.spawn(["/bin/sh", "-c", String(m.args.cmd)], { stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        write({ type: "tools.result", callId: m.callId, ok: code === 0, output: out + err, attachments: [], ms: Date.now() - t0, ...(code === 0 ? {} : { error: `exit ${code}` }) });
      } else {
        write({ type: "tools.result", callId: m.callId, ok: false, error: `没有工具 ${m.tool}`, attachments: [], ms: 0 });
      }
      break;
    }
    case "step.approval_required":
      // 真实宿主：转手机；这里直接扮演手机回决定
      console.log(`  [手机] 审批卡片: ${m.action.summary} / ${m.action.detail}  → ${deny ? "拒绝" : "允许"}`);
      write({ type: "approval.decision", runId: m.runId, stepId: m.stepId, allow: !deny, remember: "once" });
      break;
    case "step.finished":
      console.log(`  ${m.stepId} ${m.ok ? "ok" : "fail"} ${m.ms}ms ${(m.output ?? m.error ?? "").trim().slice(0, 60)}`);
      break;
    case "run.finished": {
      console.log(`run.finished ok=${m.ok} ${m.summary}`);
      const expected = ["tools.list", "run.created", "step.started", "step.precheck", "step.finished", "step.approval_required", "run.finished"];
      const missing = expected.filter((t) => !seen.includes(t));
      brain.stdin.end();
      if (missing.length) {
        console.error("缺少消息:", missing);
        process.exit(1);
      }
      process.exit(m.ok ? 0 : 3);
    }
    case "error":
      console.error("brain error:", m.code, m.message);
      break;
    default:
      console.log(`  ← ${m.type}`);
  }
}

write({ type: "intent.submit", text: "跑一下 mock 剧本", deviceId: "dev-local", mode: "agent" });
setTimeout(() => { console.error("超时"); process.exit(4); }, 30_000);
