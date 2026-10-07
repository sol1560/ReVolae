import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkMsg } from "@cuaremote/protocol";
import { startDevice } from "../src/device.js";

test.each([
  ["主动停止", "manual", false],
  ["普通关闭", 1000, false],
  ["服务离开", 1001, true],
  ["网络中断", "network", true],
  ["服务重启", 1012, true],
  ["暂时不可用", 1013, true],
  ["认证拒绝", 4001, false],
  ["消息损坏", "invalid", false],
  ["首次认证前断线", "initial", false],
] as const)("重连状态：%s", async (_, action, expected) => {
  const dir = await mkdtemp(join(tmpdir(), "cua-reconnect-test-"));
  let socket: Bun.ServerWebSocket<undefined> | undefined;
  // 只测试关闭原因分类；中继响应是明确的测试数据，不作为真实认证/配对验收。
  const server = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return Response.json({ code: "123456", expiresAt: Math.floor(Date.now() / 1000) + 300 });
    },
    websocket: { open(ws) { socket = ws; }, message(ws, data) {
      if (JSON.parse(String(data)).type !== "hello") return;
      if (action === "initial") ws.close(1001, "fixture initial disconnect");
      else ws.send(JSON.stringify(mkMsg({ type: "auth.ok", sessionToken: "fixture-session", expiresAt: Math.floor(Date.now() / 1000) + 300 })));
    } },
  });
  let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  try {
    let expectedForEvent = expected;
    if (action === 1001) {
      // Bun 1.3.9/1.3.10 客户端会把收到的1001报告成1000。先用独立客户端测量
      // 实际传给业务的关闭码，不从被测设备的日志/状态反推期望，也不放宽1000。
      const observed = await new Promise<number>((resolve, reject) => {
        const probe = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        probe.onopen = () => socket!.close(1001, "fixture close");
        probe.onclose = (event) => resolve(event.code);
        probe.onerror = () => reject(new Error("独立关闭码探测失败"));
      });
      expect([1000, 1001]).toContain(observed);
      expectedForEvent = observed === 1001;
      if (observed === 1000) console.warn("运行时限制：1001被报告为1000，仅验证保守不重连，未验证1001自动恢复");
    }
    const starting = startDevice({ hubURL: `ws://127.0.0.1:${server.port}/ws`, stateDir: join(dir, "state"),
      provider: "ollama:fixture", allowedDirs: [dir] });
    if (action === "initial") await expect(starting).rejects.toThrow("连接已关闭");
    else {
      device = await starting;
      expect(JSON.parse(await readFile(join(dir, "state/status.json"), "utf8")).reconnectable).toBeUndefined();
      if (action === "manual") device.close();
      else if (action === "network") socket!.terminate();
      else if (action === "invalid") socket!.send("invalid JSON");
      else socket!.close(action, "fixture close");
      await device.finished;
    }
    const status = JSON.parse(await readFile(join(dir, "state/status.json"), "utf8"));
    expect(status).toMatchObject({ connection: "disconnected", reconnectable: expectedForEvent });
    expect(Object.keys(status).sort()).toEqual(["connection", "reconnectable", "updatedAt"]);
  } finally {
    device?.close();
    if (device) await device.finished;
    server.stop(true);
    if (process.platform === "darwin") {
      const cleanup = Bun.spawn(["/usr/bin/security", "delete-generic-password", "-s", "io.cuaremote.device.identity", "-a", join(await realpath(dir), "state")], { stdout: "ignore", stderr: "ignore" });
      expect(await cleanup.exited).toBe(0);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
