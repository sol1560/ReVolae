import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64, controlFrame, decodeFrame, E2ELink, mkMsg, parseControl } from "@cuaremote/protocol";
import { HubStore } from "../../../apps/hub/src/db.js";
import { Endpoint } from "../../../apps/hub/test/helpers.js";
import { restorePairing } from "../../../scripts/e2e/resume.js";
import { loadDeviceIdentity } from "../src/device-identity.js";
import { DeviceStore } from "../src/device-store.js";

test("隔离恢复脚本保留身份/配对/历史；新宿主只用原密钥重连，不配对或复用旧结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "cua-resume-test-"));
  const previous = join(root, "previous"), restored = join(root, "restored"), current = join(root, "current");
  const phone = await Endpoint.make("isolated-phone", "phone");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let ready = false;
  try {
    // 单测造隔离存储，不算真人配对；恢复函数本身不能生成任何身份或配对行。
    const original = await loadDeviceIdentity(join(previous, "device"), null);
    original.identity.peers[phone.id] = phone.pubKeys;
    await original.save();
    const { identity } = original;
    const hub = new HubStore(join(previous, "hub.db"));
    hub.upsertDevice({ deviceId: identity.deviceId, role: "device", accountId: "isolated-account", platform: "macos", name: "test",
      kem: identity.kem.publicKey, sig: identity.sig.publicKey, sigAlg: "ES256" }, 1);
    hub.upsertDevice({ deviceId: phone.id, role: "phone", accountId: "isolated-account", platform: "ios", name: "test", ...phone.pubKeys }, 2);
    hub.addPairing(identity.deviceId, phone.id, 3);
    hub.close();
    const history = new DeviceStore(join(previous, "device/device.sqlite"));
    history.begin(phone.id, "old-request", { runId: "old-run", deviceId: identity.deviceId, intent: "旧测试", startedAt: 1 });
    history.append({ type: "run.finished", runId: "old-run", ok: true, summary: "旧结果", cancelled: false, stepCount: 0,
      cost: { inputTokens: 1, outputTokens: 1, jevTokens: 0, usd: 0 } });
    history.close();
    await writeFile(join(previous, "events.jsonl"), "old-events");
    await mkdir(join(previous, "work"));
    await writeFile(join(previous, "work/source.txt"), "old-content");
    const oldIdentity = await readFile(join(previous, "device/identity.json"));
    const oldHub = await readFile(join(previous, "hub.db"));
    const oldHistory = await readFile(join(previous, "device/device.sqlite"));
    await mkdir(restored);
    await writeFile(join(previous, "host.pid"), "1");
    await expect(restorePairing(previous, restored)).rejects.toThrow("先正式停止");
    await rm(join(previous, "host.pid"));
    const result = await restorePairing(previous, restored);
    expect(result).toEqual({ accountId: "isolated-account", deviceId: identity.deviceId, phoneId: phone.id, historyBaseline: 1 });
    expect((await readFile(join(restored, "device/identity.json"))).equals(oldIdentity)).toBe(true);
    for (const path of ["hub.db", "device/identity.json", "device/device.sqlite"]) expect((await stat(join(restored, path))).mode & 0o777).toBe(0o600);
    expect(await Bun.file(join(restored, "events.jsonl")).exists()).toBe(false);
    expect(await Bun.file(join(restored, "work/source.txt")).exists()).toBe(false);
    await expect(restorePairing(previous, restored)).rejects.toThrow();
    const changed = new HubStore(join(restored, "hub.db"));
    changed.removePairing(identity.deviceId, phone.id); changed.close();
    await expect(restorePairing(restored, join(root, "invalid"))).rejects.toThrow("不会补建");
    await writeFile(join(restored, "device/identity.json"), JSON.stringify({ ...identity, kem: { ...identity.kem, publicKey: phone.pubKeys.kem } }));
    await expect(restorePairing(restored, join(root, "invalid"))).rejects.toThrow("公钥不符");
    await writeFile(join(restored, "device/identity.json"), "not-json-private-marker");
    await expect(restorePairing(restored, join(root, "invalid"))).rejects.toThrow("原测试身份格式无效");

    const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = reservation.port!; reservation.stop(true);
    const script = join(import.meta.dir, "../../../scripts/e2e/host.ts");
    child = Bun.spawn([process.execPath, script, "start", current], { env: { ...process.env,
      E2E_RESUME_FROM: previous, E2E_HUB_PORT: String(port), E2E_HUB_URL: `ws://127.0.0.1:${port}/ws`, CUAREMOTE_PROVIDER: "ollama:fixture" },
      stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 200 && !await Bun.file(join(current, "connection.json")).exists(); i++) await Bun.sleep(25);
    ready = await Bun.file(join(current, "connection.json")).exists();
    expect(ready).toBe(true);
    const config = JSON.parse(await readFile(join(current, "connection.json"), "utf8"));
    expect([config.E2E_CONNECTION_MODE, config.E2E_DEVICE_ID, config.E2E_PHONE_ID, config.E2E_HISTORY_BASELINE])
      .toEqual(["existing-pairing", identity.deviceId, phone.id, "1"]);
    expect(config.E2E_READ_EXPECTED).not.toBe("old-content");
    expect(await readFile(config.E2E_READ_PATH, "utf8")).toBe(config.E2E_READ_EXPECTED);
    expect(await readFile(join(current, "events.jsonl"), "utf8")).not.toContain("old-events");
    await phone.login(config.E2E_HUB_URL, { token: config.E2E_TOKEN });
    expect((await phone.expect("peer.keys")).deviceId).toBe(identity.deviceId);
    const link = await E2ELink.create({ selfId: phone.id, self: phone.kem, peerId: identity.deviceId, peerPublicKey: b64.from(identity.kem.publicKey) });
    phone.sendBin(link.handshake());
    expect(await link.openRelay(await phone.expectBin())).toBeNull();
    phone.sendBin(await link.sealFrame(controlFrame(mkMsg({ type: "history.list", limit: 20 }))));
    expect(parseControl(decodeFrame((await link.openRelay(await phone.expectBin()))!))).toMatchObject({
      type: "history.page", items: [{ runId: "old-run", summary: "旧结果" }],
    });
    expect(phone.inbox.some((m) => !("bin" in m) && m.type === "pair.result")).toBe(false);
    const stop = Bun.spawn([process.execPath, script, "stop", current], { stdout: "ignore", stderr: "ignore" });
    expect(await stop.exited).toBe(0);
    expect(await child.exited).toBe(0);
    expect((await readFile(join(previous, "device/identity.json"))).equals(oldIdentity)).toBe(true);
    expect((await readFile(join(previous, "hub.db"))).equals(oldHub)).toBe(true);
    expect((await readFile(join(previous, "device/device.sqlite"))).equals(oldHistory)).toBe(true);
  } finally {
    phone.ws?.close();
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    if (process.platform === "darwin" && await Bun.file(join(current, "hub.db")).exists()) {
      const cleanup = Bun.spawn(["/usr/bin/security", "delete-generic-password", "-s", "io.cuaremote.device.identity", "-a", join(await realpath(current), "device")], { stdout: "ignore", stderr: "ignore" });
      expect(ready ? [0] : [0, 44]).toContain(await cleanup.exited);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
