import { describe, expect, test } from "bun:test";
import type { AnyMessage } from "@cuaremote/protocol";
import { foldMessage, initialState } from "../src/store";
const msg = (body: object) => ({ v: 1, id: crypto.randomUUID(), ...body }) as AnyMessage;
describe("mobile store", () => {
  test("按 runId 和 stepId 隔离步骤", () => {
    let s = foldMessage(
      initialState,
      msg({ type: "run.created", runId: "a", deviceId: "d", intent: "A", provider: "p", plan: [{ id: "s1", title: "one", status: "pending" }] }),
    );
    s = foldMessage(
      s,
      msg({ type: "run.created", runId: "b", deviceId: "d", intent: "B", provider: "p", plan: [{ id: "s1", title: "other", status: "pending" }] }),
    );
    s = foldMessage(s, msg({ type: "step.started", runId: "a", stepId: "s1", title: "one" }));
    expect(s.runs.a?.plan[0]?.status).toBe("running");
    expect(s.runs.b?.plan[0]?.status).toBe("pending");
  });
  test("收集审批并在完成后清除", () => {
    let s = foldMessage(
      initialState,
      msg({ type: "run.created", runId: "a", deviceId: "d", intent: "A", provider: "p", plan: [{ id: "s1", title: "one", status: "pending" }] }),
    );
    s = foldMessage(
      s,
      msg({
        type: "step.approval_required",
        runId: "a",
        stepId: "s1",
        level: 2,
        action: { channel: "shell", summary: "推送", detail: "git push" },
        reason: "对外发送",
        expiresAt: 99,
        challenge: "x",
      }),
    );
    expect(s.runs.a?.approvals.s1?.level).toBe(2);
    s = foldMessage(s, msg({ type: "step.finished", runId: "a", stepId: "s1", ok: true, ms: 1, dataLeftDevice: true, output: "ok" }));
    expect(s.runs.a?.approvals.s1).toBeUndefined();
    expect(s.runs.a?.outputs.s1).toBe("ok");
  });
  test("目录总是文件夹优先", () => {
    const s = foldMessage(
      initialState,
      msg({
        type: "cloud.files",
        path: "/work",
        entries: [
          { name: "a", path: "/a", type: "file", size: 1 },
          { name: "z", path: "/z", type: "dir", size: 0 },
        ],
      }),
    );
    expect(s.files?.entries.map((x) => x.type)).toEqual(["dir", "file"]);
  });
});
