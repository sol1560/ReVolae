/** 真实网络/模型/文件系统预检；不能替代 iPhone 模拟器的 XCUITest。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnyMessage, b64, controlFrame, decodeFrame, generateKemKeyPair, generateSigningKeyPair,
  hubAuthPayload, mkMsg, pairHmac, parseControl, signApproval, signPayload, type MsgBody,
} from "../../packages/protocol/src/index.js";
import { startDevice } from "../../packages/brain/src/device.js";
import { PeerLinks } from "../../packages/brain/src/cloud/peer-links.js";
import { createHubServer } from "../../apps/hub/src/server.js";
import { HubStore } from "../../apps/hub/src/db.js";
import { signJwt } from "../../apps/hub/src/auth.js";

const provider = process.env.CUAREMOTE_PROVIDER;
assert(provider && !provider.startsWith("mock"), "必须设置真实 CUAREMOTE_PROVIDER");
const dir = await mkdtemp(join(tmpdir(), "revolae-live-"));
const store = new HubStore(":memory:");
const jwtSecret = crypto.randomUUID();
const token = signJwt({ sub: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 }, jwtSecret);
const { server, url } = createHubServer({ port: 0, hostname: "127.0.0.1", store, jwtSecret });
let device: Awaited<ReturnType<typeof startDevice>> | undefined;
let ws: WebSocket | undefined;
try {
  const nonce = crypto.randomUUID();
  const input = join(dir, "source.txt");
  const approved = join(dir, "approved.txt");
  const denied = join(dir, "denied.txt");
  await writeFile(input, nonce);
  // 无桌面的网络预检只验证加密与执行；不作为 Mac 人工配对确认的验收。
  device = await startDevice({ hubURL: url, provider, token, stateDir: join(dir, "state"), allowedDirs: [dir], confirmPair: async () => true });
  if (process.platform === "darwin") assert.equal(await Bun.file(join(dir, "state/identity.json")).exists(), false);
  else assert.equal((await stat(join(dir, "state/identity.json"))).mode & 0o777, 0o600);

  const phone = crypto.randomUUID();
  const kem = await generateKemKeyPair();
  const sig = generateSigningKeyPair("ES256");
  const pubKeys = { kem: b64.to(kem.publicKey), sig: b64.to(sig.publicKey), sigAlg: "ES256" as const };
  const inbox: AnyMessage[] = [];
  let connectionError: unknown;
  let receive = Promise.resolve();
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const socket = ws;
  const target = device.deviceId;
  const links = new PeerLinks(phone, kem, (peer) => peer === target ? device!.offer.pubKeys : undefined, (bytes) => { socket.send(bytes); });
  socket.onmessage = (event) => {
    receive = receive.then(async () => {
      if (typeof event.data === "string") inbox.push(AnyMessage.parse(JSON.parse(event.data)));
      else {
        const result = await links.receive(new Uint8Array(event.data as ArrayBuffer));
        if (result) inbox.push(AnyMessage.parse(parseControl(decodeFrame(result.frame))));
      }
    }).catch((e) => { connectionError = e; });
  };
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("连接失败")); });
  const hub = (body: MsgBody) => socket.send(JSON.stringify(mkMsg(body)));
  const send = (body: MsgBody) => links.send(target, controlFrame(mkMsg(body), 0));
  async function wait<T extends AnyMessage["type"]>(type: T, timeout = 90_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (connectionError) throw connectionError;
      const index = inbox.findIndex((m) => m.type === type);
      if (index >= 0) return inbox.splice(index, 1)[0] as Extract<AnyMessage, { type: T }>;
      const error = inbox.find((m) => m.type === "error");
      if (error) throw new Error(JSON.stringify(error));
      await Bun.sleep(25);
    }
    throw new Error(`等待 ${type} 超时，收到了 ${inbox.map((m) => m.type).join(",")}`);
  }
  hub({ type: "hello", role: "phone", deviceId: phone, platform: "ios", name: "真实网络预检客户端", pubKeys, protocolVersion: 1, token });
  const challenge = await wait("auth.challenge");
  hub({ type: "auth.response", nonce: challenge.nonce, signature: signPayload(new TextEncoder().encode(hubAuthPayload(phone, challenge.nonce)), sig.privateKey, "ES256") });
  await wait("auth.ok");
  hub({ type: "pair.request", deviceId: target, phoneId: phone, phoneName: "真实网络预检客户端", phonePubKeys: pubKeys, hmac: pairHmac(device.offer.secret, device.offer.pubKeys.kem, pubKeys.kem) });
  assert.equal((await wait("pair.result")).ok, true);
  await wait("peer.keys");

  await send({ type: "intent.submit", deviceId: target, text: `只用 fs.read 读取 ${input}，完整报告内容，不要用 shell 或写文件。`, mode: "agent" });
  const readStep = await wait("step.finished");
  assert.equal(readStep.ok, true);
  assert.equal(readStep.output, nonce, "必须来自真实文件，不可由模型猜测");
  const readRun = await wait("run.finished");
  assert.equal(readRun.ok, true);
  assert.equal(readRun.status, "succeeded");
  assert(readRun.cost.inputTokens > 0, "必须真实调用模型");
  console.log("PASS 真实模型 → fs.read → HPKE 回传随机文件内容");

  async function writeIntent(path: string) {
    await send({ type: "intent.submit", deviceId: target, text: `只用 shell.run 执行命令 printf '%s' '${nonce}' > '${path}'，cwd 设为 '${dir}'，不要改别的文件。`, mode: "agent" });
    return wait("step.approval_required");
  }
  const approval = await writeIntent(approved);
  assert.equal(await Bun.file(approved).exists(), false, "批准前不得执行");
  await send({ type: "approval.decision", runId: approval.runId, stepId: approval.stepId, allow: true, remember: "once" });
  assert.equal((await wait("error")).code, "approval_bad_signature");
  assert.equal(await Bun.file(approved).exists(), false, "无签名不得执行");
  function decision(req: typeof approval, allow: boolean): MsgBody {
    return { type: "approval.decision", runId: req.runId, stepId: req.stepId, allow, remember: "once", signature: signApproval({ challenge: req.challenge, allow, privateKey: sig.privateKey, alg: "ES256", keyId: phone, nonce: req.challenge.split("\n")[4]!, expiresAt: req.expiresAt }) };
  }
  await send(decision(approval, true));
  assert.equal((await wait("step.finished")).ok, true);
  const approvedRun = await wait("run.finished");
  assert.equal(approvedRun.ok, true);
  assert.equal(approvedRun.status, "succeeded");
  assert.equal(await readFile(approved, "utf8"), nonce);
  await send(decision(approval, true));
  assert.equal((await wait("error")).code, "approval_unknown_step");
  console.log("PASS 批准前无文件、拒绝无签名、签名批准后真实写入、拒绝重放");

  const refusal = await writeIntent(denied);
  assert.equal(await Bun.file(denied).exists(), false);
  await send(decision(refusal, false));
  assert.equal((await wait("step.finished")).ok, false);
  const deniedRun = await wait("run.finished");
  assert.equal(deniedRun.ok, false);
  assert.equal(deniedRun.status, "denied");
  assert.equal(await Bun.file(denied).exists(), false);
  await send({ type: "history.list", limit: 3 });
  assert.deepEqual((await wait("history.page")).items.map((item) => ({ runId: item.runId, status: item.status })), [
    { runId: deniedRun.runId, status: "denied" }, { runId: approvedRun.runId, status: "succeeded" }, { runId: readRun.runId, status: "succeeded" },
  ]);
  console.log("PASS 签名拒绝后结束，未执行写入；真实结果与历史明确区分成功/拒绝");
} finally {
  ws?.close();
  device?.close();
  if (device) await device.finished;
  server.stop(true);
  store.close();
  if (process.platform === "darwin") {
    const cleanup = Bun.spawn(["/usr/bin/security", "delete-generic-password", "-s", "io.cuaremote.device.identity", "-a", join(await realpath(dir), "state")], { stdout: "ignore", stderr: "ignore" });
    assert((device ? [0] : [0, 44]).includes(await cleanup.exited), "清除本次临时钥匙串身份失败");
  }
  await rm(dir, { recursive: true, force: true });
}
