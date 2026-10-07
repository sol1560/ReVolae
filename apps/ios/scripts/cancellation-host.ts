/** iOS取消专项：真实既有配对/Hub/设备，仅模型为明确的本地固定响应。不是真实模型验收。 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { signJwt } from "../../../apps/hub/src/auth.js";
import { HubStore } from "../../../apps/hub/src/db.js";
import { createHubServer } from "../../../apps/hub/src/server.js";
import { startDevice } from "../../../packages/brain/src/device.js";
import { restorePairing } from "../../../scripts/e2e/resume.js";

const [command, input, previous] = process.argv.slice(2);
assert(input, "cancellation-host.ts start <新目录> <local-10> | verify|stop|cleanup <本轮目录>");
const directory = resolve(input);
const configPath = join(directory, "connection.json");
const markerPath = join(directory, "ownership.json");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const originals = ["device/identity.json", "hub.db", "device/device.sqlite"];
async function hashes(root: string) {
  return Object.fromEntries(await Promise.all(originals.map(async (p) => [p, hash(await readFile(join(root, p)))])));
}
async function owned() {
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.kind, "ios-cancellation-existing-pairing");
  assert.equal(marker.directory, await realpath(directory));
  assert.equal(basename(directory), `cancel-live-${marker.id}`);
  return marker;
}

if (command === "start") {
  assert(previous, "必须指定保留真实配对的local-10源目录");
  const id = basename(directory).replace(/^cancel-live-/, "");
  assert(/^[0-9a-f-]{36}$/i.test(id) && basename(directory) === `cancel-live-${id}`, "目录名必须包含本轮UUID");
  const source = await realpath(previous);
  assert.equal(basename(source), "local-10", "此专项只复用已确认的local-10，不猜其它身份");
  const before = await hashes(source);
  await mkdir(directory, { mode: 0o700 }); // 不重用现有测试目录。
  const canonical = await realpath(directory);
  await writeFile(markerPath, JSON.stringify({ kind: "ios-cancellation-existing-pairing", id, directory: canonical, source, before }), { mode: 0o600 });
  const restored = await restorePairing(source, directory);
  assert.deepEqual(await hashes(source), before);
  const deviceDir = join(canonical, "device");
  const identity = JSON.parse(await readFile(join(deviceDir, "identity.json"), "utf8"));
  const work = join(canonical, "work");
  await mkdir(work, { mode: 0o700 });
  const target = join(work, `never-created-${randomUUID()}.txt`);
  const intent = `取消专项 · 本地固定响应模型 · ${id.slice(0, 8)}。请求写入随机文件，等待审批后取消，不批准。`;
  const control = randomBytes(32).toString("base64url");
  let modelCalls = 0, beforeCancel: Record<string, unknown> | undefined;
  let everExisted = false, targetEvents = 0;
  const observed = () => { everExisted ||= existsSync(target); };
  const watcher = watch(work, (_event, filename) => { if (filename?.toString() === basename(target)) targetEvents++; observed(); });
  const observer = setInterval(observed, 20);
  let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  const db = new Database(join(deviceDir, "device.sqlite"), { readonly: true });
  const baselineSeq = (db.query("SELECT COALESCE(MAX(seq),0) AS n FROM runs").get() as { n: number }).n;
  function state() {
    observed();
    const rows = db.query("SELECT run_id,request_id,item FROM runs WHERE seq>? ORDER BY seq").all(baselineSeq) as { run_id: string; request_id: string; item: string }[];
    const row = rows[0], item = row ? JSON.parse(row.item) : undefined;
    const events = row ? (db.query("SELECT body FROM events WHERE run_id=? ORDER BY seq").all(row.run_id) as { body: string }[]).map((x) => JSON.parse(x.body)) : [];
    return { kind: "existing-pairing-local-fixed-model", runCount: rows.length, runId: row?.run_id, requestId: row?.request_id,
      intentMatches: item?.intent === intent, status: item?.status, ok: item?.ok,
      approvalEvents: events.filter((x) => x.type === "step.approval_required").length,
      finishedEvents: events.filter((x) => x.type === "run.finished").length,
      completedToolEvents: events.filter((x) => x.type === "step.finished").length,
      targetExists: existsSync(target), everExisted, targetEvents, modelCalls,
      beforeCancelChecked: beforeCancel !== undefined, finalRequestMatches: events.filter((x) => x.type === "run.finished").every((x) => x.requestId === row?.request_id) };
  }
  const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/control/")) {
      if (request.headers.get("authorization") !== `Bearer ${control}`) return new Response("denied", { status: 403 });
      if (path === "/control/state" && request.method === "GET") return Response.json(state());
      if (path === "/control/before-cancel" && request.method === "POST") {
        const current = state();
        if (current.runCount !== 1 || current.approvalEvents !== 1 || current.finishedEvents !== 0 || current.targetExists || current.everExisted || current.targetEvents !== 0) {
          return new Response("没有符合条件的待审批任务，不能算取消前检查通过", { status: 409 });
        }
        beforeCancel = { ...current, checkedAt: Date.now() };
        await writeFile(join(directory, "before-cancel.json"), JSON.stringify(beforeCancel, null, 2), { mode: 0o600 });
        return Response.json(state());
      }
      if (path === "/control/stop" && request.method === "POST") {
        setTimeout(() => device?.close(), 50);
        return Response.json({ stopping: true });
      }
      return new Response("not found", { status: 404 });
    }
    if (path !== "/v1/chat/completions" || request.method !== "POST") return new Response("not found", { status: 404 });
    modelCalls++;
    const body = await request.json() as { tool_choice?: string };
    const message = body.tool_choice === "auto"
      ? { tool_calls: [{ id: "cancel-fixed-model-write", type: "function", function: { name: "shell.run",
        arguments: JSON.stringify({ cmd: `printf '%s' 'SHOULD-NOT-EXIST' > '${target}'`, cwd: work }) } }] }
      : { content: "本地固定响应测试模型：准备写入随机文件，必须由设备请求批准；不代表真实模型。" };
    return Response.json({ choices: [{ finish_reason: body.tool_choice === "auto" ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 11, completion_tokens: 3 } });
  } });
  const jwtSecret = randomBytes(32).toString("base64url");
  const token = signJwt({ sub: restored.accountId, exp: Math.floor(Date.now() / 1000) + 1800 }, jwtSecret);
  const hubStore = new HubStore(join(directory, "hub.db"));
  const { server, url } = createHubServer({ port: 0, hostname: "127.0.0.1", store: hubStore, jwtSecret });
  const privateEvents: Record<string, unknown>[] = [];
  try {
    device = await startDevice({ hubURL: url, token, provider: `openai-compat:local-cancel-fixture@http://127.0.0.1:${local.port}/v1`,
      stateDir: deviceDir, allowedDirs: [work], name: "取消专项 Mac · 本地固定响应模型",
      // 不注入confirmPair，不插入配对、不生成手机pin；只接受已有身份。
      log: (event) => { if (event.t === "step.approval_required") observed(); privateEvents.push(event); },
    });
    assert.equal(device.deviceId, restored.deviceId);
    await writeFile(join(directory, "started.json"), JSON.stringify({ deviceDir, startedAt: Date.now() }), { mode: 0o600 });
    await writeFile(configPath, JSON.stringify({
      E2E_HUB_URL: url, E2E_TOKEN: token, E2E_CONNECTION_MODE: "existing-pairing",
      E2E_DEVICE_ID: restored.deviceId, E2E_PHONE_ID: restored.phoneId, E2E_HISTORY_BASELINE: String(restored.historyBaseline),
      E2E_DEVICE_KEM: identity.kem.publicKey, E2E_DEVICE_SIG: identity.sig.publicKey,
      E2E_CANCEL_ID: id, E2E_CANCEL_TARGET: target, E2E_CANCEL_INTENT: intent,
      E2E_CANCEL_CONTROL_URL: `http://127.0.0.1:${local.port}`, E2E_CANCEL_CONTROL: control,
    }), { mode: 0o600 });
    console.log("CANCEL_HOST_READY existing-pairing; local-fixed-model; no-new-pairing");
    process.on("SIGTERM", () => device?.close());
    process.on("SIGINT", () => device?.close());
    await device.finished;
    await writeFile(join(directory, "stopped-state.json"), JSON.stringify(state(), null, 2), { mode: 0o600 });
  } finally {
    device?.close(); clearInterval(observer); watcher.close();
    await writeFile(join(directory, "events.json"), JSON.stringify(privateEvents), { mode: 0o600 });
    local.stop(true); server.stop(true); db.close(); hubStore.close();
    assert.deepEqual(await hashes(source), before, "原local-10三份持久文件不得改变");
  }
} else if (command === "verify" || command === "stop") {
  const marker = await owned();
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const response = await fetch(config.E2E_CANCEL_CONTROL_URL + (command === "stop" ? "/control/stop" : "/control/state"), {
    method: command === "stop" ? "POST" : "GET", headers: { authorization: `Bearer ${config.E2E_CANCEL_CONTROL}` },
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  assert(response.ok);
  if (command === "verify") {
    const report = await response.json() as Record<string, unknown>;
    assert.equal(report.runCount, 1); assert.equal(report.status, "cancelled"); assert.equal(report.ok, false);
    assert.equal(report.approvalEvents, 1); assert.equal(report.finishedEvents, 1); assert.equal(report.completedToolEvents, 0);
    assert.equal(report.targetExists, false); assert.equal(report.everExisted, false); assert.equal(report.targetEvents, 0);
    assert.equal(report.beforeCancelChecked, true); assert.equal(report.finalRequestMatches, true); assert.equal(report.modelCalls, 2);
    assert.deepEqual(await hashes(marker.source), marker.before);
    // 独立进程直接读设备SQLite，不仅信任活宿主的HTTP报告。
    const db = new Database(join(directory, "device/device.sqlite"), { readonly: true });
    const row = db.query("SELECT item FROM runs WHERE run_id=? AND phone=?").get(report.runId as string, config.E2E_PHONE_ID) as { item: string };
    assert.equal(JSON.parse(row.item).status, "cancelled");
    const events = (db.query("SELECT body FROM events WHERE run_id=?").all(report.runId as string) as { body: string }[]).map((x) => JSON.parse(x.body));
    assert.equal(events.filter((e) => e.type === "run.finished").length, 1); db.close();
    await writeFile(join(directory, "verification.json"), JSON.stringify({ ...report, independentSQLite: true, originalFilesUnchanged: true, originalHashes: marker.before }, null, 2), { mode: 0o600 });
    console.log("CANCEL_INDEPENDENT_SQLITE_AND_FILE_CHECK_PASS");
  } else console.log("CANCEL_HOST_STOP_REQUESTED");
} else if (command === "cleanup") {
  const marker = await owned();
  assert(existsSync(join(directory, "stopped-state.json")), "宿主未正式停止，不清理运行中身份");
  assert.deepEqual(await hashes(marker.source), marker.before);
  const account = await realpath(join(directory, "device"));
  const result = Bun.spawnSync(["security", "delete-generic-password", "-s", "io.cuaremote.device.identity", "-a", account]);
  assert.equal(result.exitCode, 0, "删除本轮独立Keychain条目失败；不输出身份内容");
  await rm(directory, { recursive: true });
  console.log("CANCEL_PRIVATE_COPY_AND_OWN_KEYCHAIN_REMOVED original-files-unchanged");
} else throw new Error("未知取消专项命令");
