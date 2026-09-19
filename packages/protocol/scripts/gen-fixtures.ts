import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalChallenge, controlFrame, encodeRelay } from "../src/index.js";
const dir = join(import.meta.dir, "..", "swift", "Tests", "CuaRemoteProtocolTests", "fixtures");
mkdirSync(dir, { recursive: true });
const messages = [
  { v: 1, id: "m1", type: "intent.submit", text: "列出桌面上的 pdf", deviceId: "mac-1", mode: "agent" },
  { v: 1, id: "m2", type: "step.precheck", runId: "r1", stepId: "s1", staticLevel: 1, level: 2, verdict: "confirm", source: "jev", risk: 0.7, jevMs: 120 },
  { v: 1, id: "m3", type: "step.approval_required", runId: "r1", stepId: "s1", level: 2, action: { channel: "shell", summary: "删除文件", detail: "rm -rf ~/x" }, reason: "L2", expiresAt: 1700000000, challenge: "c" },
  { v: 1, id: "m4", type: "hello", role: "device", deviceId: "mac-1", platform: "macos", name: "Sol's Mac", pubKeys: { kem: "a", sig: "b", sigAlg: "ES256" }, protocolVersion: 1 },
  { v: 1, id: "m5", type: "tools.call", callId: "c1", tool: "shell.run", args: { cmd: "ls", nested: { a: [1, "x", true, null] } }, timeoutMs: 60000 },
  { v: 1, id: "m6", type: "privacy.state", deviceId: "mac-1", settings: { brainLocation: "local", sync: { history: false, screenshots: false, logs: false, shortcuts: false }, modelTier: "zdr", jevEnabled: true, autonomy: "balanced" }, dataFlow: [{ data: "意图", destination: "本机", reason: "本地大脑" }] },
  { v: 1, id: "m7", type: "capabilities", deviceId: "mac-1", platform: "macos", name: "Mac", tools: [{ name: "shell.run", description: "d", channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object" } }], scope: { allowedDirs: ["~"], allowedApps: [], deniedCommands: [] }, brainAvailable: true, daemonVersion: "0.1.0" },
];
writeFileSync(join(dir, "messages.json"), JSON.stringify(messages, null, 2));
const frame = controlFrame(messages[0], 42);
const relay = encodeRelay({ to: "phone-α", from: "mac-1", encrypted: true, body: frame });
writeFileSync(join(dir, "binary.json"), JSON.stringify({
  frameHex: Buffer.from(frame).toString("hex"),
  relayHex: Buffer.from(relay).toString("hex"),
  challenge: approvalChallenge({ runId: "r1", stepId: "s1", actionDetail: "rm -rf ~/x", nonce: "n0", expiresAt: 1700000000 }),
}, null, 2));
console.log("fixtures written");
