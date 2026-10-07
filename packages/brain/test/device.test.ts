import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnyMessage, b64, controlFrame, decodeFrame, encodeFrame, generateKemKeyPair, generateSigningKeyPair,
  hubAuthPayload, mkMsg, pairHmac, parseControl, signApproval, signPayload, signTerminalOpen,
  type Frame, type MsgBody,
} from "@cuaremote/protocol";
import { createHubServer } from "../../../apps/hub/src/server.js";
import { HubStore } from "../../../apps/hub/src/db.js";
import { signJwt } from "../../../apps/hub/src/auth.js";
import { PeerLinks } from "../src/cloud/peer-links.js";
import { startDevice } from "../src/device.js";
import { loadDeviceIdentity } from "../src/device-identity.js";

test("加密设备连接：快捷指令持久化、任务去重、历史恢复和真实PTY；模型为本地测试服务器", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-device-test-"));
  const hubStore = new HubStore(":memory:");
  const jwtSecret = crypto.randomUUID();
  const token = signJwt({ sub: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 }, jwtSecret);
  const { server, url } = createHubServer({ port: 0, hostname: "127.0.0.1", store: hubStore, jwtSecret });
  let modelCalls = 0;
  let shellCommand: string | undefined;
  const statusPath = join(dir, "state/status.json");
  const statusDuringCalls: { activeRunId?: string }[] = [];
  // 仅测试消息和去重。真实模型验收另跑 scripts/e2e/live-device.ts。
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    modelCalls++;
    statusDuringCalls.push(JSON.parse(await readFile(statusPath, "utf8")));
    const body = await request.json() as { tool_choice?: unknown };
    if (shellCommand && body.tool_choice === "auto") {
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
        id: "write-before-disconnect", type: "function", function: { name: "shell.run", arguments: JSON.stringify({ cmd: shellCommand, cwd: dir }) },
      }] } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "测试响应，不代表真实模型" } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
  } });
  const provider = `openai-compat:fixture@http://127.0.0.1:${model.port}`;
  let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  let socket: WebSocket | undefined;
  let allowPair = false;
  let confirmationCalls = 0;
  const confirmationPeers: string[][] = [];
  const refreshDuringConfirmation: string[] = [];
  try {
    device = await startDevice({ hubURL: url, provider, token, stateDir: join(dir, "state"), allowedDirs: [dir], confirmPair: async () => {
      confirmationCalls++;
      confirmationPeers.push(Object.keys((await loadDeviceIdentity(join(dir, "state"))).identity.peers));
      refreshDuringConfirmation.push(await device!.refreshPairing().then(() => "不应成功", (e) => e.message));
      return allowPair;
    } });
    expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({ connection: "authenticated" });
    expect((await stat(statusPath)).mode & 0o777).toBe(0o600);
    const phone = crypto.randomUUID();
    const kem = await generateKemKeyPair();
    const sig = generateSigningKeyPair("ES256");
    const pubKeys = { kem: b64.to(kem.publicKey), sig: b64.to(sig.publicKey), sigAlg: "ES256" as const };
    const target = device.deviceId;
    const inbox: AnyMessage[] = [];
    const frames: Frame[] = [];
    let error: unknown;
    let receive = Promise.resolve();
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const ws = socket;
    const links = new PeerLinks(phone, kem, () => device!.offer.pubKeys, (bytes) => { ws.send(bytes); });
    ws.onmessage = (event) => {
      receive = receive.then(async () => {
        if (typeof event.data === "string") inbox.push(AnyMessage.parse(JSON.parse(event.data)));
        else {
          const result = await links.receive(new Uint8Array(event.data as ArrayBuffer));
          if (result) {
            const frame = decodeFrame(result.frame);
            if (frame.kind === 0) inbox.push(AnyMessage.parse(parseControl(frame)));
            else frames.push(frame);
          }
        }
      }).catch((e) => { error = e; });
    };
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("连接失败")); });
    const hub = (body: MsgBody) => ws.send(JSON.stringify(mkMsg(body)));
    const send = (body: MsgBody, id?: string) => links.send(target, controlFrame({ ...mkMsg(body), ...(id ? { id } : {}) }));
    async function wait<T extends AnyMessage["type"]>(type: T) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        if (error) throw error;
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0] as Extract<AnyMessage, { type: T }>;
        if (type !== "error" && inbox.some((m) => m.type === "error")) throw new Error(JSON.stringify(inbox.find((m) => m.type === "error")));
        await Bun.sleep(10);
      }
      throw new Error(`等待 ${type} 超时：${inbox.map((m) => m.type)}`);
    }
    hub({ type: "hello", role: "phone", deviceId: phone, platform: "ios", name: "测试手机", pubKeys, protocolVersion: 1, token });
    const challenge = await wait("auth.challenge");
    hub({ type: "auth.response", nonce: challenge.nonce, signature: signPayload(new TextEncoder().encode(hubAuthPayload(phone, challenge.nonce)), sig.privateKey, "ES256") });
    await wait("auth.ok");
    const oldCode = device.code, oldOffer = device.offer;
    const regenerated = await device.refreshPairing();
    expect(regenerated.offer.pubKeys).toEqual(oldOffer.pubKeys);
    expect(regenerated.offer.secret).not.toBe(oldOffer.secret);
    expect(regenerated.code).not.toBe(oldCode);
    hub({ type: "pair.code.claim", code: oldCode, phoneId: phone, phonePubKeys: pubKeys });
    expect((await wait("error")).code).toBe("bad_code");
    hub({ type: "pair.request", deviceId: target, phoneId: phone, phoneName: "测试手机", phonePubKeys: pubKeys, hmac: pairHmac(oldOffer.secret, oldOffer.pubKeys.kem, pubKeys.kem) });
    expect((await wait("pair.result")).ok).toBe(false);
    expect(confirmationCalls).toBe(0);
    hub({ type: "pair.code.claim", code: regenerated.code, phoneId: phone, phonePubKeys: pubKeys });
    expect((await wait("pair.offer")).secret).toBe(regenerated.offer.secret);
    expect(JSON.parse(await readFile(join(dir, "state/pairing.json"), "utf8")).code).toBe(regenerated.code);
    hub({ type: "pair.request", deviceId: target, phoneId: phone, phoneName: "测试手机", phonePubKeys: pubKeys, hmac: pairHmac(device.offer.secret, device.offer.pubKeys.kem, pubKeys.kem) });
    expect((await wait("pair.result")).ok).toBe(false);
    expect(confirmationCalls).toBe(1);
    allowPair = true;
    hub({ type: "pair.request", deviceId: target, phoneId: phone, phoneName: "测试手机", phonePubKeys: pubKeys, hmac: pairHmac(device.offer.secret, device.offer.pubKeys.kem, pubKeys.kem) });
    expect((await wait("pair.result")).ok).toBe(true);
    expect(confirmationCalls).toBe(2);
    expect(confirmationPeers).toEqual([[], []]);
    expect(refreshDuringConfirmation).toEqual(["正在等待本机配对确认，请先处理当前请求", "正在等待本机配对确认，请先处理当前请求"]);
    await wait("peer.keys");

    await send({ type: "capabilities.get" }, "capabilities-request");
    expect(await wait("capabilities")).toMatchObject({ deviceId: target, ref: "capabilities-request" });
    await send({ type: "shortcuts.get" }, "shortcuts-read");
    expect(await wait("shortcuts.list")).toMatchObject({ shortcuts: [], ref: "shortcuts-read" });
    await send({ type: "app.cards.get" }, "cards-read");
    expect(await wait("app.cards")).toMatchObject({ cards: [], ref: "cards-read" });
    await send({ type: "app.learn.start", bundleId: "test.app", explore: true }, "learn-request");
    expect(await wait("app.learn.progress")).toMatchObject({ phase: "failed", ref: "learn-request" });
    const shortcut = { id: "saved", name: "第一版", body: "测试指令", runIn: "agent" as const, level: 1 as const };
    await send({ type: "shortcut.put", shortcut }, "shortcuts-save");
    expect(await wait("shortcuts.list")).toMatchObject({ shortcuts: [shortcut], ref: "shortcuts-save" });
    await send({ type: "shortcut.put", shortcut: { ...shortcut, name: "修改后" } });
    expect((await wait("shortcuts.list")).shortcuts).toEqual([{ ...shortcut, name: "修改后" }]);
    const alpha = { ...shortcut, id: "alpha", body: "另一条指令" };
    const zulu = { ...shortcut, id: "zulu", name: "第三条" };
    for (const item of [alpha, zulu]) {
      await send({ type: "shortcut.put", shortcut: item });
      await wait("shortcuts.list");
    }
    const reordered = [zulu, { ...shortcut, name: "修改后" }, alpha];
    await send({ type: "shortcuts.reorder", shortcutIds: ["zulu", "saved", "alpha"] }, "reorder-save");
    expect(await wait("shortcuts.list")).toMatchObject({ ref: "reorder-save", shortcuts: reordered });
    // 重复、漏项和已删除/未知 ID 都不能覆盖原列表或复活旧内容。
    for (const shortcutIds of [["saved", "saved", "alpha"], ["alpha", "saved"], ["zulu", "saved", "deleted"], []]) {
      await send({ type: "shortcuts.reorder", shortcutIds }, "reorder-stale");
      expect(await wait("error")).toMatchObject({ ref: "reorder-stale", code: "request_failed" });
      await send({ type: "shortcuts.get" });
      expect((await wait("shortcuts.list")).shortcuts).toEqual(reordered);
    }
    await send({ type: "privacy.get" }, "privacy-read");
    const privacy = await wait("privacy.state");
    expect(privacy.ref).toBe("privacy-read");
    await send({ type: "models.list" }, "models-read");
    const models = await wait("models.catalog");
    expect(models.ref).toBe("models-read");
    expect(models.defaultModel).toBe(provider);
    expect(models.models.find((m) => m.id === provider)).toMatchObject({ available: true, tier: "byok", unknownPrice: true });
    await send({ type: "privacy.set", settings: { ...privacy.settings, autonomy: "balanced" } }, "privacy-save");
    expect(await wait("privacy.state")).toMatchObject({ ref: "privacy-save", settings: { autonomy: "balanced" } });
    await send({ type: "privacy.set", settings: { ...privacy.settings, modelTier: "local" } });
    expect((await wait("error")).code).toBe("request_failed");
    await send({ type: "privacy.get" });
    expect((await wait("privacy.state")).settings.autonomy).toBe("balanced");

    await send({ type: "shortcut.run", shortcutId: "saved", params: {} }, "same-submit");
    const finished = await wait("run.finished");
    expect(finished.ok).toBe(true);
    expect(finished.status).toBe("succeeded");
    expect(finished.cost).toMatchObject({ inputTokens: 22, outputTokens: 6, unknownPrice: true });
    expect(modelCalls).toBe(2);
    expect(statusDuringCalls.map((s) => s.activeRunId)).toEqual([finished.runId, finished.runId]);
    expect(JSON.parse(await readFile(statusPath, "utf8")).activeRunId).toBeUndefined();
    await send({ type: "shortcut.run", shortcutId: "saved", params: {} }, "same-submit");
    expect(await wait("history.detail")).toMatchObject({ ref: "same-submit", item: { runId: finished.runId } });
    expect(modelCalls).toBe(2);
    await send({ type: "history.get", runId: finished.runId }, "history-detail");
    const detail = await wait("history.detail");
    expect(detail.ref).toBe("history-detail");
    expect(detail.item.status).toBe("succeeded");
    expect(detail.events.map((e) => e.type)).toEqual(["run.created", "plan.updated", "run.finished"]);
    await send({ type: "history.list", limit: 1 }, "history-page");
    const page = await wait("history.page");
    expect(page.ref).toBe("history-page");
    expect(page.items[0]?.runId).toBe(finished.runId);

    const signature = signTerminalOpen({ sessionId: "session1", deviceId: target, privateKey: sig.privateKey, alg: "ES256", keyId: phone, nonce: crypto.randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 300 });
    await send({ type: "terminal.open", sessionId: "session1", cols: 80, rows: 24 });
    expect((await wait("error")).code).toBe("approval_invalid");
    await send({ type: "terminal.open", sessionId: "session1", cols: 80, rows: 24, signature });
    const terminal = await wait("terminal.opened");
    await links.send(target, encodeFrame({ kind: 1, streamId: terminal.streamId, payload: new TextEncoder().encode("printf 'PTY-%s\\n' '实际输出'; exit 7\r") }));
    expect((await wait("terminal.exit")).code).toBe(7);
    expect(new TextDecoder().decode(Buffer.concat(frames.map((f) => f.payload)))).toContain("PTY-实际输出");

    // 已签好的旧确认在设备重连后也不能执行；重发提交只返回已停止的历史。
    const interruptedPath = join(dir, "must-not-be-written.txt");
    shellCommand = `printf forbidden > '${interruptedPath}'`;
    await send({ type: "intent.submit", deviceId: target, text: "断线边界测试", mode: "agent" }, "interrupted-submit");
    const approval = await wait("step.approval_required");
    expect(await Bun.file(interruptedPath).exists()).toBe(false);
    const oldDecision = { type: "approval.decision" as const, runId: approval.runId, stepId: approval.stepId,
      allow: true, remember: "once" as const, signature: signApproval({ challenge: approval.challenge, allow: true,
        privateKey: sig.privateKey, alg: "ES256", keyId: phone, nonce: approval.challenge.split("\n")[4]!, expiresAt: approval.expiresAt }) };
    expect(modelCalls).toBe(4);
    device.close();
    await device.finished;
    const stopped = JSON.parse(await readFile(statusPath, "utf8"));
    expect(stopped.connection).toBe("disconnected");
    expect(stopped.reconnectable).toBe(false);
    expect(Object.keys(stopped).sort()).toEqual(["connection", "reconnectable", "updatedAt"]);
    await wait("presence");
    links.drop(target);
    device = await startDevice({ hubURL: url, provider, token, stateDir: join(dir, "state"), allowedDirs: [dir] });
    expect(device.deviceId).toBe(target);
    await send({ type: "shortcuts.get" });
    expect((await wait("shortcuts.list")).shortcuts).toEqual(reordered);
    await send({ type: "privacy.get" });
    expect((await wait("privacy.state")).settings.autonomy).toBe("balanced");
    await send({ type: "terminal.open", sessionId: "session1", cols: 80, rows: 24, signature });
    expect((await wait("error")).code).toBe("approval_invalid");
    await send({ type: "shortcut.run", shortcutId: "saved", params: {} }, "same-submit");
    expect((await wait("history.detail")).item.runId).toBe(finished.runId);
    await send(oldDecision);
    expect((await wait("error")).code).toBe("approval_unknown_step");
    await send({ type: "intent.submit", deviceId: target, text: "断线边界测试", mode: "agent" }, "interrupted-submit");
    const interrupted = await wait("history.detail");
    expect(interrupted.item).toMatchObject({ runId: approval.runId, ok: false, status: "cancelled" });
    expect(interrupted.events.at(-1)).toMatchObject({ type: "run.finished", cancelled: true });
    expect(await Bun.file(interruptedPath).exists()).toBe(false);
    expect(modelCalls).toBe(4);

    // ack 只确认收到取消请求。错误 runId 不得影响当前任务，最终状态必须另行回读。
    const cancelledPath = join(dir, "cancelled-write.txt");
    shellCommand = `printf forbidden > '${cancelledPath}'`;
    await send({ type: "intent.submit", deviceId: target, text: "取消等待批准的任务", mode: "agent" }, "cancel-submit");
    const cancellingApproval = await wait("step.approval_required");
    expect(await Bun.file(cancelledPath).exists()).toBe(false);
    await send({ type: "run.cancel", runId: finished.runId }, "cancel-other-run");
    expect(await wait("ack")).toMatchObject({ ref: "cancel-other-run" });
    await send({ type: "history.get", runId: cancellingApproval.runId }, "still-running");
    const stillRunning = await wait("history.detail");
    expect(stillRunning.ref).toBe("still-running");
    expect(stillRunning.item.finishedAt).toBeUndefined();
    expect(stillRunning.events.at(-1)?.type).toBe("step.approval_required");

    await send({ type: "run.cancel", runId: cancellingApproval.runId }, "cancel-current");
    expect(await wait("ack")).toMatchObject({ ref: "cancel-current" });
    expect(await wait("run.finished")).toMatchObject({
      runId: cancellingApproval.runId, requestId: "cancel-submit", status: "cancelled", cancelled: true, ok: false,
    });
    await send({ type: "run.cancel", runId: cancellingApproval.runId }, "cancel-again");
    expect(await wait("ack")).toMatchObject({ ref: "cancel-again" });
    await send({ type: "history.get", runId: cancellingApproval.runId }, "cancelled-history");
    const cancelled = await wait("history.detail");
    expect(cancelled.ref).toBe("cancelled-history");
    expect(cancelled.item).toMatchObject({ runId: cancellingApproval.runId, status: "cancelled", ok: false });
    expect(cancelled.events.filter((event) => event.type === "run.finished")).toHaveLength(1);
    await send({ type: "approval.decision", runId: cancellingApproval.runId, stepId: cancellingApproval.stepId,
      allow: true, remember: "once", signature: signApproval({ challenge: cancellingApproval.challenge, allow: true,
        privateKey: sig.privateKey, alg: "ES256", keyId: phone, nonce: cancellingApproval.challenge.split("\n")[4]!, expiresAt: cancellingApproval.expiresAt }) }, "approve-after-cancel");
    expect(await wait("error")).toMatchObject({ ref: "approve-after-cancel", code: "approval_unknown_step" });
    await send({ type: "intent.submit", deviceId: target, text: "取消等待批准的任务", mode: "agent" }, "cancel-submit");
    expect(await wait("history.detail")).toMatchObject({ ref: "cancel-submit", item: { runId: cancellingApproval.runId, status: "cancelled" } });
    expect(await Bun.file(cancelledPath).exists()).toBe(false);
    expect(modelCalls).toBe(6);

    await send({ type: "shortcut.delete", shortcutId: "saved" });
    expect((await wait("shortcuts.list")).shortcuts).toEqual([zulu, alpha]);
    await send({ type: "shortcut.put", shortcut: { ...zulu, name: "更名不改顺序" } });
    expect((await wait("shortcuts.list")).shortcuts).toEqual([{ ...zulu, name: "更名不改顺序" }, alpha]);
    await send({ type: "shortcut.delete", shortcutId: "zulu" });
    expect((await wait("shortcuts.list")).shortcuts).toEqual([alpha]);
    await send({ type: "shortcut.delete", shortcutId: "alpha" });
    expect((await wait("shortcuts.list")).shortcuts).toEqual([]);
    await send({ type: "shortcuts.reorder", shortcutIds: [] }, "reorder-empty");
    expect(await wait("shortcuts.list")).toMatchObject({ ref: "reorder-empty", shortcuts: [] });

    // 解绑不能只从列表隐藏：已打开的真实 shell 必须退出，持久身份也要撤销。
    const revokeSignature = signTerminalOpen({ sessionId: "revoked-shell", deviceId: target, privateKey: sig.privateKey, alg: "ES256", keyId: phone, nonce: crypto.randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 300 });
    await send({ type: "terminal.open", sessionId: "revoked-shell", cols: 80, rows: 24, signature: revokeSignature });
    const revoking = await wait("terminal.opened");
    frames.length = 0;
    await links.send(target, encodeFrame({ kind: 1, streamId: revoking.streamId, payload: new TextEncoder().encode('printf "CUA_PID_%s_END\\n" "$$"\r') }));
    let shellPID: number | undefined;
    for (let i = 0; i < 100 && !shellPID; i++) {
      const text = new TextDecoder().decode(Buffer.concat(frames.map((f) => f.payload)));
      const match = text.match(/CUA_PID_(\d+)_END/);
      if (match) shellPID = Number(match[1]);
      else await Bun.sleep(20);
    }
    expect(shellPID).toBeGreaterThan(1);
    const shellAlive = () => { try { process.kill(shellPID!, 0); return true; } catch { return false; } };
    expect(shellAlive()).toBe(true);
    hub({ type: "device.unpair", deviceId: target });
    expect(await wait("pair.removed")).toMatchObject({ deviceId: target, phoneId: phone });
    await wait("ack");
    for (let i = 0; i < 150 && shellAlive(); i++) await Bun.sleep(20);
    expect(shellAlive()).toBe(false);
    const removalDeadline = Date.now() + 5000;
    let storedPeers = (await loadDeviceIdentity(join(dir, "state"))).identity.peers;
    while (storedPeers[phone] && Date.now() < removalDeadline) {
      await Bun.sleep(20);
      storedPeers = (await loadDeviceIdentity(join(dir, "state"))).identity.peers;
    }
    expect(Object.keys(storedPeers)).not.toContain(phone);
    await send({ type: "shortcuts.get" });
    expect((await wait("error")).code).toBe("not_paired");
  } finally {
    socket?.close();
    device?.close();
    if (device) await device.finished;
    server.stop(true);
    hubStore.close();
    model.stop(true);
    if (process.platform === "darwin") {
      const cleanup = Bun.spawn(["/usr/bin/security", "delete-generic-password", "-s", "io.cuaremote.device.identity", "-a", join(await realpath(dir), "state")], { stdout: "ignore", stderr: "ignore" });
      expect(device ? [0] : [0, 44]).toContain(await cleanup.exited);
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
