import type { AnyMessage } from "@cuaremote/protocol";
import { runIntent, type ApprovalGate } from "./agent/loop.js";
import { CuaDriver } from "./gui/cua-driver.js";
import { wrapIfIpad } from "./ipad/ipad-host.js";
import type { Host } from "./host/types.js";
import { StdioHost } from "./host/stdio-host.js";
import { JevClient } from "./jev/client.js";
import { PolicyEngine } from "./jev/policy.js";
import { fetchCard, learnApp, runCard } from "./learn/learn.js";
import { catalogMessage, probeLocal, resolveProvider } from "./llm/catalog.js";
import { JsonlLog } from "./log.js";

/**
 * `brain --mode host`：被 Swift/Kotlin daemon 或 hub spawn。
 * 手机消息从 stdin 进来，事件从 stdout 出去，工具经宿主执行。
 */
export async function runHostMode(opts: { defaultProvider: string; logPath?: string; cuaArgv?: string[] }) {
  const stdio = new StdioHost();
  // 宿主如果是 iPad app（提供 ipad.screen / ipad.hid.macro），外面包一层绝对坐标工具。
  // 第一次有活干时才问工具表（启动时宿主可能还没开始读 stdin），之后复用同一个实例，保住校准和指针状态。
  let hostP: Promise<Host> | undefined;
  const agentHost = () => (hostP ??= wrapIfIpad(stdio, { log: (r) => log?.write(r) }));
  const jev = new JevClient();
  const log = opts.logPath ? new JsonlLog(opts.logPath) : undefined;
  const gui = new CuaDriver({ argv: opts.cuaArgv });
  const guiUp = await gui.start();
  process.stderr.write(`brain: host 模式就绪，provider=${opts.defaultProvider} jev=${jev.enabled ? "on" : "off"} cua-driver=${guiUp ? "on" : "off"}\n`);

  const runs = new Map<string, AbortController>();
  const learns = new Map<string, AbortController>();

  const approvals: ApprovalGate = {
    request: async (req) => {
      // step.approval_required 已由 loop 发出；这里只等手机的决定（宿主已验签）
      const d = await stdio.waitFor(
        (m): m is Extract<AnyMessage, { type: "approval.decision" }> => m.type === "approval.decision" && m.runId === req.runId && m.stepId === req.stepId,
        (req.expiresAt - Math.floor(Date.now() / 1000)) * 1000,
      ).catch(() => null);
      return d ? { allow: d.allow, remember: d.remember } : { allow: false, remember: "once" };
    },
  };

  stdio.onMessage(async (m) => {
    switch (m.type) {
      case "intent.submit": {
        const settings = stdio.privacy;
        let provider;
        try {
          provider = resolveProvider({ settings, requested: m.provider, defaultModel: opts.defaultProvider });
        } catch (e) {
          stdio.send({ type: "error", code: "provider", message: String(e instanceof Error ? e.message : e), ref: m.id });
          return;
        }
        const ctrl = new AbortController();
        const runId = crypto.randomUUID();
        runs.set(runId, ctrl);
        const policy = new PolicyEngine({ jev, jevEnabled: settings?.jevEnabled ?? jev.enabled, autonomy: settings?.autonomy ?? "balanced" });
        try {
          await runIntent(
            { host: await agentHost(), provider, policy, approvals, gui: guiUp ? gui : undefined, jev, emit: (e) => stdio.send(e), log: (r) => log?.write(r), signal: ctrl.signal, platform: process.platform },
            { runId, deviceId: m.deviceId, intent: m.text, mode: m.mode, terminalSessionId: m.terminalSessionId },
          );
        } finally {
          runs.delete(runId);
        }
        break;
      }
      case "run.cancel":
        runs.get(m.runId)?.abort();
        break;
      case "app.learn.start": {
        const settings = stdio.privacy;
        let provider;
        try {
          provider = resolveProvider({ settings, defaultModel: opts.defaultProvider });
        } catch (e) {
          stdio.send({ type: "error", code: "provider", message: String(e instanceof Error ? e.message : e), ref: m.id });
          return;
        }
        const ctrl = new AbortController();
        learns.set(m.bundleId, ctrl);
        try {
          await learnApp({ host: await agentHost(), provider, emit: (e) => stdio.send(e), gui: guiUp ? gui : undefined, log: (r) => log?.write(r), signal: ctrl.signal }, { bundleId: m.bundleId, explore: m.explore });
        } finally {
          learns.delete(m.bundleId);
        }
        break;
      }
      case "app.learn.stop":
        learns.get(m.bundleId)?.abort();
        break;
      case "app.card.run": {
        const host = await agentHost();
        const got = await fetchCard(host, m.cardId);
        if ("error" in got) {
          stdio.send({ type: "error", code: "card_not_found", message: got.error, ref: m.id });
          return;
        }
        const settings = stdio.privacy;
        const policy = new PolicyEngine({ jev, jevEnabled: settings?.jevEnabled ?? jev.enabled, autonomy: settings?.autonomy ?? "balanced" });
        await runCard({ host, policy, approvals, emit: (e) => stdio.send(e), log: (r) => log?.write(r), deviceId: m.deviceId ?? stdio.deviceId ?? "local" }, got.card, m.params);
        break;
      }
      case "privacy.state":
        stdio.invalidateTools();
        break;
      case "models.list": {
        const localUp = await probeLocal();
        stdio.send(catalogMessage({ localUp, defaultModel: opts.defaultProvider, brainLocation: "local" }));
        break;
      }
      default:
        break; // approval.decision 由 waitFor 消费；其他消息暂不处理
    }
  });
}
