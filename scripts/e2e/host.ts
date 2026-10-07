/** 原生 E2E 的真实被控端；只创建本轮随机测试目录，不提供假工具或测试后门。 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { signJwt } from "../../apps/hub/src/auth.js";
import { HubStore } from "../../apps/hub/src/db.js";
import { createHubServer } from "../../apps/hub/src/server.js";
import { startDevice } from "../../packages/brain/src/device.js";
import { restorePairing } from "./resume.js";

const [command, path] = process.argv.slice(2);
assert(path, "host.ts start|stop|verify <本轮目录>");
const directory = resolve(path);
const configPath = join(directory, "connection.json");
const pidPath = join(directory, "host.pid");

if (command === "stop") {
  // 兼容第一轮未写 pidfile 的宿主；只匹配本脚本与完全相同的本轮目录。
  const ps = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
  const lines = (await new Response(ps.stdout).text()).split("\n");
  assert.equal(await ps.exited, 0, "无法检查宿主进程");
  const recorded = existsSync(pidPath) ? Number((await readFile(pidPath, "utf8")).trim()) : undefined;
  const matches: number[] = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (recorded && recorded !== pid) continue;
    const command = /^(?:\S*\/)?bun (?:run )?(\S*scripts\/e2e\/host\.ts) start (.+)$/.exec(match[2]!);
    if (!command) continue;
    let cwd: string;
    if (process.platform === "darwin") {
      const info = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const name = info.stdout.toString().split("\n").find((value) => value.startsWith("n"));
      if (info.exitCode !== 0 || !name) continue;
      cwd = name.slice(1);
    } else {
      cwd = await readlink(`/proc/${pid}/cwd`);
    }
    if (resolve(cwd, command[1]!) === import.meta.path && resolve(cwd, command[2]!) === directory) matches.push(pid);
  }
  assert.equal(matches.length, 1, "未找到唯一对应宿主，不会终止其它进程");
  const pid = matches[0]!;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
    assert(Date.now() < deadline, "宿主未及时退出");
    await Bun.sleep(100);
  }
  await rm(pidPath, { force: true });
  console.log("E2E_HOST_STOPPED");
} else if (command === "verify") {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(await readFile(config.E2E_READ_PATH, "utf8"), config.E2E_READ_EXPECTED);
  assert.equal(await readFile(config.E2E_APPROVE_PATH, "utf8"), config.E2E_WRITE_CONTENT);
  assert.equal(await Bun.file(config.E2E_DENY_PATH).exists(), false, "拒绝后不得产生文件");
  const events = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const runs = events.filter((event) => event.t === "run.finished");
  assert.equal(runs.length, 3, "必须完成读取、批准写入、拒绝写入三项任务");
  assert.deepEqual(runs.map((run) => run.ok), [true, true, false]);
  assert(runs.every((run) => run.cost.inputTokens > 0), "三项任务均须调用真实模型");
  const approvals = events.filter((event) => event.t === "e2e.approval_pending");
  assert.deepEqual(approvals.map(({ path, exists }) => ({ path, exists })), [
    { path: config.E2E_APPROVE_PATH, exists: false }, { path: config.E2E_DENY_PATH, exists: false },
  ], "两次显示确认之前，被控 Mac 上均不得已产生目标文件");
  const report = { ok: true, connectionMode: config.E2E_CONNECTION_MODE ?? "new-pairing", read: true, approvedWrite: true, deniedWriteAbsent: true, runs: runs.map(({ runId, ok, stepCount, cost }) => ({ runId, ok, stepCount, inputTokens: cost.inputTokens })) };
  await writeFile(join(directory, "verification.json"), JSON.stringify(report, null, 2));
  console.log("PASS macOS 文件内容、拒绝未写入、3次真实模型调用、成功/成功/拒绝状态");
} else if (command === "start") {
  const provider = process.env.CUAREMOTE_PROVIDER;
  assert(provider && !provider.startsWith("mock"), "必须提供真实 CUAREMOTE_PROVIDER");
  const port = Number(process.env.E2E_HUB_PORT ?? "8788");
  const hubURL = process.env.E2E_HUB_URL ?? `ws://127.0.0.1:${port}/ws`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = join(directory, "work");
  await mkdir(work, { mode: 0o700 }); // 拒绝重用上一次的结果目录
  const readExpected = randomBytes(24).toString("hex");
  const writeContent = randomBytes(24).toString("hex");
  const source = join(work, "source.txt");
  await writeFile(source, readExpected, { mode: 0o600 });
  const restored = process.env.E2E_RESUME_FROM ? await restorePairing(process.env.E2E_RESUME_FROM, directory) : undefined;
  const jwtSecret = randomBytes(32).toString("base64url");
  const token = signJwt({ sub: restored?.accountId ?? crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600 }, jwtSecret);
  const store = new HubStore(join(directory, "hub.db"));
  const { server } = createHubServer({ port, hostname: "127.0.0.1", publicURL: hubURL, store, jwtSecret });
  const events = Bun.file(join(directory, "events.jsonl")).writer();
  await writeFile(pidPath, String(process.pid), { mode: 0o600 });
  const approvedPath = join(work, "approved.txt");
  const deniedPath = join(work, "denied.txt");
  let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  try {
    device = await startDevice({
      hubURL, token, provider, stateDir: join(directory, "device"), allowedDirs: [work], name: "ReVolae E2E Mac",
      log: (event) => {
        events.write(JSON.stringify(event) + "\n");
        if (event.t === "step.approval_required") {
          const detail = (event.action as { detail: string }).detail;
          for (const path of [approvedPath, deniedPath]) if (detail.includes(path)) {
            events.write(JSON.stringify({ t: "e2e.approval_pending", path, exists: existsSync(path) }) + "\n");
          }
        }
        events.flush();
      },
    });
    const config = {
      E2E_HUB_URL: hubURL, E2E_TOKEN: token, E2E_PAIR_CODE: device.code,
      E2E_CONNECTION_MODE: restored ? "existing-pairing" : "new-pairing",
      E2E_DEVICE_ID: device.deviceId,
      E2E_PHONE_ID: restored?.phoneId ?? "",
      E2E_HISTORY_BASELINE: String(restored?.historyBaseline ?? 0),
      E2E_READ_PATH: source, E2E_READ_EXPECTED: readExpected,
      E2E_APPROVE_PATH: approvedPath, E2E_DENY_PATH: deniedPath,
      E2E_WRITE_CONTENT: writeContent,
    };
    await writeFile(`${configPath}.tmp`, JSON.stringify(config), { mode: 0o600 });
    await rename(`${configPath}.tmp`, configPath);
    console.log("E2E_HOST_READY");
    process.on("SIGTERM", () => device?.close());
    process.on("SIGINT", () => device?.close());
    await device.finished;
  } finally {
    device?.close();
    await events.end();
    server.stop(true);
    store.close();
    await rm(pidPath, { force: true });
  }
} else {
  throw new Error("host.ts start|stop|verify <本轮目录>");
}
