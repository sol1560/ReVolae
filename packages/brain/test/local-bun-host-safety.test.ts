import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBunHost } from "../src/host/local-bun-host.js";

function host(allowedDir: string) {
  return new LocalBunHost({
    scope: { allowedDirs: [allowedDir], allowedApps: [], deniedCommands: [] },
    shell: "/bin/sh",
    loginShell: false,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

describe("LocalBunHost safety", () => {
  test("publishes canonical default cwd and normalizes relative cwd; direct calls use the same safe default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-cwd-"));
    try {
      const nested = join(dir, "nested");
      await mkdir(nested);
      const canonical = await realpath(dir);
      const canonicalNested = await realpath(nested);
      const local = host(dir);
      const { tools } = await local.listTools();
      const shell = tools.find((item) => item.name === "shell.run")!;
      expect(shell.inputSchema).toMatchObject({
        properties: { cwd: { type: "string", default: canonical } },
        required: ["cmd", "cwd"],
      });
      const preparedDefault = await local.prepareCall!("shell.run", { cmd: "pwd" });
      expect(preparedDefault).toEqual({ cmd: "pwd", cwd: canonical, timeoutMs: 60_000 });
      const preparedRelative = await local.prepareCall!("shell.run", { cmd: "pwd", cwd: "nested" });
      expect(preparedRelative).toEqual({ cmd: "pwd", cwd: canonicalNested, timeoutMs: 60_000 });
      preparedDefault.cwd = canonicalNested;
      const changedPreparedTarget = await local.call("shell.run", preparedDefault);
      const malformedDirectCall = await local.call("shell.run", { cmd: "pwd", unexpected: true });
      expect(changedPreparedTarget.ok).toBe(false);
      expect(changedPreparedTarget.error).toContain("已审批的工作目录已改变");
      expect(malformedDirectCall.ok).toBe(false);
      expect(malformedDirectCall.error).toContain("不支持参数");

      const direct = await local.call("shell.run", { cmd: "pwd" });
      const relative = await local.call("shell.run", preparedRelative);
      expect(direct.ok).toBe(true);
      expect(direct.output?.trim()).toBe(canonical);
      expect(relative.ok).toBe(true);
      expect(relative.output?.trim()).toBe(canonicalNested);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects existing symlink escapes for shell cwd and filesystem access", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-host-scope-"));
    const outside = await mkdtemp(join(tmpdir(), "local-host-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "outside");
      const link = join(root, "outside-link");
      await symlink(outside, link);
      const local = host(root);

      await expect(local.prepareCall!("shell.run", { cmd: "pwd", cwd: link })).rejects.toThrow("不在允许的目录");
      const read = await local.call("fs.read", { path: join(link, "secret.txt") });
      const list = await local.call("fs.list", { path: link });
      expect(read.ok).toBe(false);
      expect(read.error).toContain("不在允许的目录");
      expect(list.ok).toBe(false);
      expect(list.error).toContain("不在允许的目录");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("validates shell arguments and reads only the requested bounded prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-read-"));
    try {
      const local = host(dir);
      await expect(local.prepareCall!("shell.run", { cmd: 3 })).rejects.toThrow("cmd 必须是字符串");
      await expect(local.prepareCall!("shell.run", { cmd: "pwd", stdin: 3 })).rejects.toThrow("stdin 必须是字符串");
      await expect(local.prepareCall!("shell.run", { cmd: "pwd", cwd: 3 })).rejects.toThrow("cwd 必须是字符串");
      await expect(local.prepareCall!("shell.run", { cmd: "pwd", timeoutMs: 0 })).rejects.toThrow("timeoutMs");
      await expect(local.prepareCall!("shell.run", { cmd: "pwd", timeoutMs: 1.5 })).rejects.toThrow("timeoutMs");
      await expect(local.prepareCall!("shell.run", { cmd: "pwd", timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow("timeoutMs");
      await expect(local.prepareCall!("shell.run", { cmd: "pwd", timeoutMs: 120_001 })).rejects.toThrow("timeoutMs");
      await expect(local.prepareCall!("shell.run", { cmd: "pwd", unexpected: true })).rejects.toThrow("不支持参数");

      const file = join(dir, "large.txt");
      await writeFile(file, "x".repeat(500_000));
      const result = await local.call("fs.read", { path: file, maxBytes: 64 });
      expect(result.ok).toBe(true);
      expect(result.output?.startsWith("x".repeat(64))).toBe(true);
      expect(result.output).toContain("截断");
      expect(result.output?.length).toBeLessThan(128);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honors direct-call timeout without overriding a prepared approval timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-timeout-argument-"));
    try {
      const local = host(dir);
      const direct = await local.call("shell.run", { cmd: "sleep 1" }, 100);
      const prepared = await local.prepareCall!("shell.run", { cmd: "sleep 0.25", timeoutMs: 5_000 });
      const approved = await local.call("shell.run", prepared, 100);
      expect(direct.ok).toBe(false);
      expect(direct.error).toContain("超时");
      expect(approved.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cancellation kills a running shell and its ordinary descendant before a delayed write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-cancel-"));
    try {
      const marker = join(dir, "late-marker");
      const local = host(dir);
      const controller = new AbortController();
      const pending = local.call("shell.run", {
        cmd: `(sleep 0.6; printf late > ${shQuote(marker)}) & wait`,
        cwd: dir,
        timeoutMs: 5_000,
      }, undefined, controller.signal);
      setTimeout(() => controller.abort(), 75);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("取消");
      await delay(750);
      expect(await exists(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("timeout kills a running shell and its ordinary descendant before a delayed write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-timeout-"));
    try {
      const marker = join(dir, "late-marker");
      const local = host(dir);
      const result = await local.call("shell.run", {
        cmd: `(sleep 0.6; printf late > ${shQuote(marker)}) & wait`,
        cwd: dir,
        timeoutMs: 100,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("超时");
      await delay(750);
      expect(await exists(marker)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("combined subprocess output is capped at one MiB and fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-output-"));
    try {
      const result = await host(dir).call("shell.run", { cmd: "yes x | head -c 600000; yes x | head -c 600000 >&2", cwd: dir, timeoutMs: 5_000 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("1048576");
      expect(result.output?.length).toBeLessThanOrEqual(32_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports an early stdin close rather than claiming input was delivered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-stdin-"));
    try {
      const result = await host(dir).call("shell.run", {
        cmd: "exit 0",
        cwd: dir,
        stdin: "x".repeat(1_000_000),
        timeoutMs: 5_000,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("标准输入");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounds inherited stdin and output pipes after the leader exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-host-inherited-pipes-"));
    const pidFile = join(dir, "child.pid");
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const startedAt = Date.now();
      const result = await Promise.race([
        host(dir).call("shell.run", {
          cmd: `sleep 30 <&0 & echo $! > ${shQuote(pidFile)}; exit 0`,
          cwd: dir,
          stdin: "x".repeat(1_048_576),
          timeoutMs: 5_000,
        }),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("进程管道排空超时")), 3_000);
        }),
      ]);
      const childPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      const childPid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
      if (Number.isSafeInteger(childPid) && childPid > 1) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
