import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubServer } from "../../../apps/hub/src/server.js";
import { HubStore } from "../../../apps/hub/src/db.js";
import { signJwt } from "../../../apps/hub/src/auth.js";

test("真实CLI子进程通过stdin更新配对码，不重启也不输出配对secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-device-cli-"));
  const store = new HubStore(":memory:");
  const jwtSecret = crypto.randomUUID();
  const token = signJwt({ sub: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 300 }, jwtSecret);
  const { server, url } = createHubServer({ port: 0, hostname: "127.0.0.1", store, jwtSecret });
  const stateDir = join(dir, "state");
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "device", "--hub", url,
    "--state-dir", stateDir, "--allow-dir", dir, "--provider", "ollama:test", "--log", join(dir, "events.jsonl")], {
    env: { ...process.env, CUAREMOTE_HUB_TOKEN: token, OLLAMA_HOST: "http://127.0.0.1:11434" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let output = "", errors = "";
  const consume = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
    append(decoder.decode());
  };
  const stdout = consume(proc.stdout, (text) => { output += text; });
  const stderr = consume(proc.stderr, (text) => { errors += text; });
  let started = false;
  async function event(type: string, source = () => output) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      for (const line of source().split("\n").slice(0, -1)) {
        const value = JSON.parse(line);
        if (value.type === type) return value;
      }
      await Bun.sleep(10);
    }
    throw new Error(`CLI没有返回${type}，退出码${proc.exitCode}`);
  }
  try {
    const ready = await event("device.ready"); started = true;
    proc.stdin.write('{"type":"pairing.refresh"}\n'); proc.stdin.flush();
    const refreshed = await event("device.pairing_updated");
    expect(refreshed.deviceId).toBe(ready.deviceId);
    expect(refreshed.code).not.toBe(ready.code);
    expect(Object.keys(refreshed).sort()).toEqual(["code", "deviceId", "expiresAt", "type"]);
    const saved = JSON.parse(await readFile(join(stateDir, "pairing.json"), "utf8"));
    expect(saved.code).toBe(refreshed.code);
    expect(output).not.toContain(saved.secret);
    proc.stdin.write('not-json\n'); proc.stdin.flush();
    expect((await event("device.command_failed", () => errors)).message).toBe("本机控制命令格式无效");
    expect(proc.exitCode).toBeNull();
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
    await Promise.all([stdout, stderr]);
    server.stop(true); store.close();
    if (process.platform === "darwin") {
      const cleanup = Bun.spawn(["/usr/bin/security", "delete-generic-password", "-s", "io.cuaremote.device.identity", "-a", join(await realpath(dir), "state")], { stdout: "ignore", stderr: "ignore" });
      expect(started ? [0] : [0, 44]).toContain(await cleanup.exited);
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
