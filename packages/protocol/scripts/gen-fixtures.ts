import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { approvalChallenge, approvalSignedPayload, controlFrame, encodeMediaFrame, encodeRelay, terminalOpenChallenge } from "../src/index.js";
import { E2ELink, SealContext, deriveKemKeyPair, hex, relayHeader, sessionInfo } from "../src/hpke.js";
import { signApproval } from "../src/approval.js";
import { p256 } from "@noble/curves/nist.js";
import { ed25519 } from "@noble/curves/ed25519.js";

const swiftDir = join(import.meta.dir, "..", "swift", "Tests", "CuaRemoteProtocolTests", "fixtures");
const tsDir = join(import.meta.dir, "..", "fixtures");
mkdirSync(swiftDir, { recursive: true });
mkdirSync(tsDir, { recursive: true });

const messages = [
  { v: 1, id: "m1", type: "intent.submit", text: "列出桌面上的 pdf", deviceId: "mac-1", mode: "agent" },
  { v: 1, id: "m2", type: "step.precheck", runId: "r1", stepId: "s1", staticLevel: 1, level: 2, verdict: "confirm", source: "jev", risk: 0.7, jevMs: 120 },
  { v: 1, id: "m3", type: "step.approval_required", runId: "r1", stepId: "s1", level: 2, action: { channel: "shell", summary: "删除文件", detail: "rm -rf ~/x" }, reason: "L2", expiresAt: 1700000000, challenge: "c" },
  { v: 1, id: "m4", type: "hello", role: "device", deviceId: "mac-1", platform: "macos", name: "Sol's Mac", pubKeys: { kem: "a", sig: "b", sigAlg: "ES256" }, protocolVersion: 1 },
  { v: 1, id: "m5", type: "tools.call", callId: "c1", tool: "shell.run", args: { cmd: "ls", nested: { a: [1, "x", true, null] } }, timeoutMs: 60000 },
  { v: 1, id: "m6", type: "privacy.state", deviceId: "mac-1", settings: { brainLocation: "local", sync: { history: false, screenshots: false, logs: false, shortcuts: false }, modelTier: "zdr", jevEnabled: true, autonomy: "balanced" }, dataFlow: [{ data: "意图", destination: "本机", reason: "本地大脑" }] },
  { v: 1, id: "m7", type: "capabilities", deviceId: "mac-1", platform: "macos", name: "Mac", tools: [{ name: "shell.run", description: "d", channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: true, inputSchema: { type: "object" } }], scope: { allowedDirs: ["~"], allowedApps: [], deniedCommands: [] }, brainAvailable: true, daemonVersion: "0.1.0" },
];
writeFileSync(join(swiftDir, "messages.json"), JSON.stringify(messages, null, 2));
const frame = controlFrame(messages[0], 42);
const relay = encodeRelay({ to: "phone-α", from: "mac-1", encrypted: true, body: frame });
writeFileSync(join(swiftDir, "binary.json"), JSON.stringify({
  frameHex: Buffer.from(frame).toString("hex"),
  relayHex: Buffer.from(relay).toString("hex"),
  challenge: approvalChallenge({ runId: "r1", stepId: "s1", actionDetail: "rm -rf ~/x", nonce: "n0", expiresAt: 1700000000 }),
  terminalOpenChallenge: terminalOpenChallenge({ sessionId: "sess-1", deviceId: "mac-1", nonce: "n1", expiresAt: 1700000300 }),
  mediaFrameHex: Buffer.from(encodeMediaFrame({ keyframe: true, hasParameterSets: true, pts: 0x01020304, width: 1440, height: 900, data: new Uint8Array([0, 0, 0, 1, 0x67, 0xaa]) })).toString("hex"),
}, null, 2));

// ---- HPKE 互通向量（确定性：密钥由固定种子派生，临时密钥由固定 ekm 派生） ----
const seed = (tag: string) => hex.from(tag.repeat(64).slice(0, 64));
const phoneId = "phone-α";
const macId = "mac-1";
const phone = await deriveKemKeyPair(seed("01"));
const mac = await deriveKemKeyPair(seed("02"));
const ekmPhone = seed("a1");
const ekmMac = seed("b2");

const frames = [
  controlFrame(messages[0], 1),
  controlFrame({ v: 1, id: "m8", type: "run.cancel", runId: "r1" }, 2),
];
const phoneLink = await E2ELink.create({ selfId: phoneId, self: phone, peerId: macId, peerPublicKey: mac.publicKey, ekm: ekmPhone });
const macLink = await E2ELink.create({ selfId: macId, self: mac, peerId: phoneId, peerPublicKey: phone.publicKey, ekm: ekmMac });
const phoneHandshake = phoneLink.handshake();
const macHandshake = macLink.handshake();
await macLink.openRelay(phoneHandshake);
await phoneLink.openRelay(macHandshake);
const phoneToMac = [] as string[];
for (const f of frames) phoneToMac.push(hex.to(await phoneLink.sealFrame(f)));
const macToPhone = hex.to(await macLink.sealFrame(controlFrame({ v: 1, id: "m9", type: "run.finished", runId: "r1", ok: true, summary: "done", cost: { inputTokens: 10, outputTokens: 5, jevTokens: 0, usd: 0.001 }, stepCount: 1, cancelled: false }, 3)));

// 单独的 export 向量（同 ekm、同 info，独立上下文避免 seq 干扰）
const exporterCtx = await SealContext.create({ self: phone, peerPublicKey: mac.publicKey, from: phoneId, to: macId, ekm: ekmPhone });
const exported = await exporterCtx.export(new TextEncoder().encode("cuaremote-export-test"), 32);

writeFileSync(join(tsDir, "hpke.json"), JSON.stringify({
  note: "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20-Poly1305，Auth 模式。密钥由 RFC 9180 DeriveKeyPair(ikm) 派生；enc 由固定 ekm 派生。aad = RelayEnvelope 头部字节（encrypted=1，body 为空时的编码）。",
  phone: { id: phoneId, ikm: hex.to(seed("01")), pk: hex.to(phone.publicKey), sk: hex.to(phone.privateKey), ekm: hex.to(ekmPhone) },
  mac: { id: macId, ikm: hex.to(seed("02")), pk: hex.to(mac.publicKey), sk: hex.to(mac.privateKey), ekm: hex.to(ekmMac) },
  infoPhoneToMac: hex.to(sessionInfo(phoneId, macId)),
  infoMacToPhone: hex.to(sessionInfo(macId, phoneId)),
  aadPhoneToMac: hex.to(relayHeader({ to: macId, from: phoneId, encrypted: true })),
  aadMacToPhone: hex.to(relayHeader({ to: phoneId, from: macId, encrypted: true })),
  phoneHandshake: hex.to(phoneHandshake),
  macHandshake: hex.to(macHandshake),
  plaintexts: frames.map(hex.to),
  phoneToMac,
  macToPhonePlaintext: hex.to(controlFrame({ v: 1, id: "m9", type: "run.finished", runId: "r1", ok: true, summary: "done", cost: { inputTokens: 10, outputTokens: 5, jevTokens: 0, usd: 0.001 }, stepCount: 1, cancelled: false }, 3)),
  macToPhone,
  exporter: { context: hex.to(new TextEncoder().encode("cuaremote-export-test")), length: 32, value: hex.to(exported) },
}, null, 2));

// ---- 审批签名向量 ----
const challenge = approvalChallenge({ runId: "r1", stepId: "s1", actionDetail: "rm -rf ~/x", nonce: "n0", expiresAt: 1700000000 });
const es256Priv = seed("c3");
const edPriv = seed("d4");
const approvals = [
  { alg: "ES256" as const, priv: es256Priv, pub: p256.getPublicKey(es256Priv, false) },
  { alg: "Ed25519" as const, priv: edPriv, pub: ed25519.getPublicKey(edPriv) },
].map(({ alg, priv, pub }) => ({
  alg,
  privateKey: hex.to(priv),
  publicKey: hex.to(pub),
  challenge,
  allow: true,
  signedPayload: approvalSignedPayload(challenge, true),
  signature: signApproval({ challenge, allow: true, privateKey: priv, alg, keyId: `k-${alg}`, nonce: "n0", expiresAt: 1700000000 }),
  denySignature: signApproval({ challenge, allow: false, privateKey: priv, alg, keyId: `k-${alg}`, nonce: "n0", expiresAt: 1700000000 }),
}));
writeFileSync(join(tsDir, "approval.json"), JSON.stringify({ note: "ES256 签名为 64 字节 raw r||s（RFC 6979 确定性 k，lowS）；Ed25519 为 64 字节。签名消息 = signedPayload 的 UTF-8。", vectors: approvals }, null, 2));

for (const f of ["hpke.json", "approval.json", "rfc9180-a2-3.json"]) copyFileSync(join(tsDir, f), join(swiftDir, f));
console.log("fixtures written");
