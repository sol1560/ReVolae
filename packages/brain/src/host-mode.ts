import type { AnyMessage } from "@cuaremote/protocol";
import { runIntent, type ApprovalGate } from "./agent/loop.js";
import { CuaDriver } from "./gui/cua-driver.js";
import { StdioHost } from "./host/stdio-host.js";
import { JevClient } from "./jev/client.js";
import { PolicyEngine } from "./jev/policy.js";
import { createProvider } from "./llm/providers.js";
import { JsonlLog } from "./log.js";

/**
 * `brain --mode host`：被 Swift/Kotlin daemon 或 hub spawn。
 * 手机消息从 stdin 进来，事件从 stdout 出去，工具经宿主执行。
 */
export async function runHostMode(opts: { defaultProvider: string; logPath?: string; cuaArgv?: string[] }) {
  const host = new StdioHost();
  const jev = new JevClient();
  const log = opts.logPath ? new JsonlLog(opts.logPath) : undefined;
  const gui = new CuaDriver({ argv: opts.cuaArgv });
  const guiUp = await gui.start();
  process.stderr.write(`brain: host 模式就绪，provider=${opts.defaultProvider} jev=${jev.enabled ? "on" : "off"} cua-driver=${guiUp ? "on" : "off"}\n`);

  const runs = new Map<string, AbortController>();

  const approvals: ApprovalGate = {
    request: async (req) => {
      // step.approval_required 已由 loop 发出；这里只等手机的决定（宿主已验签）
      const d = await host.waitFor(
        (m): m is Extract<AnyMessage, { type: "approval.decision" }> => m.type === "approval.decision" && m.runId === req.runId && m.stepId === req.stepId,
        (req.expiresAt - Math.floor(Date.now() / 1000)) * 1000,
      ).catch(() => null);
      return d ? { allow: d.allow, remember: d.remember } : { allow: false, remember: "once" };
    },
  };

  host.onMessage(async (m) => {
    switch (m.type) {
      case "intent.submit": {
        const settings = host.privacy;
        const providerId = m.provider ?? settings?.localBrainModel ?? opts.defaultProvider;
        let provider;
        try {
          provider = createProvider(providerId);
        } catch (e) {
          host.send({ type: "error", code: "provider", message: String(e instanceof Error ? e.message : e), ref: m.id });
          return;
        }
        const ctrl = new AbortController();
        const runId = crypto.randomUUID();
        runs.set(runId, ctrl);
        const policy = new PolicyEngine({ jev, jevEnabled: settings?.jevEnabled ?? jev.enabled, autonomy: settings?.autonomy ?? "balanced" });
        try {
          await runIntent(
            { host, provider, policy, approvals, gui: guiUp ? gui : undefined, jev, emit: (e) => host.send(e), log: (r) => log?.write(r), signal: ctrl.signal, platform: process.platform },
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
      case "privacy.state":
        host.invalidateTools();
        break;
      default:
        break; // approval.decision 由 waitFor 消费；其他消息暂不处理
    }
  });
}
