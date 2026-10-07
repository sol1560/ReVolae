import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../src/device-store.js";

const dirs: string[] = [];
const stores: DeviceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(path = ":memory:") {
  const store = new DeviceStore(path);
  stores.push(store);
  return store;
}
const item = (runId: string) => ({ runId, deviceId: "mac", intent: `任务 ${runId}`, startedAt: 100 });

test("按手机隔离历史和提交ID；分页用序号，不会漏掉相同时间的记录", () => {
  const store = open();
  store.begin("A", "same", item("a1"));
  store.begin("B", "same", item("b1"));
  store.begin("A", "next", item("a2"));
  store.begin("A", "last", item("a3"));
  expect(store.request("A", "same")).toBe("a1");
  expect(store.request("B", "same")).toBe("b1");
  expect(() => store.begin("A", "same", item("duplicate"))).toThrow();
  const first = store.list("A", 2);
  expect(first.items.map((i) => i.runId)).toEqual(["a3", "a2"]);
  expect(first.nextCursor).toBeDefined();
  expect(store.list("A", 2, first.nextCursor)).toEqual({ items: [item("a1")] });
  expect(store.detail("B", "a1")).toBeUndefined();
  expect(() => store.list("A", 2, "bad")).toThrow();
});

test("重启保留设置、事件、nonce；只结束未完成任务且不再次执行", () => {
  const dir = mkdtempSync(join(tmpdir(), "cua-store-"));
  dirs.push(dir);
  const path = join(dir, "device.sqlite");
  let store = open(path);
  store.set("privacy", { modelTier: "local" });
  store.begin("A", "one", item("done"));
  store.begin("A", "two", item("interrupted"));
  store.append({ type: "step.finished", runId: "done", stepId: "s1", ok: true, ms: 3, dataLeftDevice: false, output: "实际内容" });
  store.append({ type: "run.finished", runId: "done", ok: true, summary: "成功", cancelled: false, stepCount: 1, cost: { inputTokens: 13, outputTokens: 5, jevTokens: 0, usd: 0.1 } });
  store.consumeNonce("fresh", Math.floor(Date.now() / 1000) + 300);
  store.consumeNonce("expired", 1);
  store.close();
  stores.pop();
  store = open(path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(store.get<{ modelTier: string }>("privacy")).toEqual({ modelTier: "local" });
  expect([...store.nonces().keys()]).toEqual(["fresh"]);
  expect(() => store.consumeNonce("fresh", Math.floor(Date.now() / 1000) + 300)).toThrow();
  store.interruptUnfinished();
  store.interruptUnfinished();
  const done = store.detail("A", "done")!;
  expect(done.item).toMatchObject({ ok: true, summary: "成功", stepCount: 1 });
  expect(done.events.map((e) => e.type)).toEqual(["step.finished", "run.finished"]);
  expect(done.events[0]).toMatchObject({ output: "实际内容" });
  const interrupted = store.detail("A", "interrupted")!;
  expect(interrupted.events).toHaveLength(1);
  expect(interrupted.events[0]).toMatchObject({ type: "run.finished", ok: false, cancelled: true });
  expect(interrupted.item).toMatchObject({ status: "cancelled" });
  expect(store.request("A", "two")).toBe("interrupted");
});

test("历史列表保留明确结果，不用摘要猜拒绝；旧结果兼容成功/失败/取消", () => {
  const store = open();
  for (const [id, ok, cancelled, status, expected] of [
    ["denied", false, false, "denied", "denied"],
    ["failed", false, false, "failed", "failed"],
    ["old-success", true, false, undefined, "succeeded"],
    ["old-failure", false, false, undefined, "failed"],
    ["old-cancel", false, true, undefined, "cancelled"],
  ] as const) {
    store.begin("A", id, item(id));
    store.append({ type: "run.finished", runId: id, ok, cancelled, status, summary: "同一摘要不能用来猜结果",
      stepCount: 1, cost: { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0 } });
    expect(store.list("A", 1).items[0]).toMatchObject({ runId: id, status: expected });
    expect(store.detail("A", id)?.item.status).toBe(expected);
  }
});
