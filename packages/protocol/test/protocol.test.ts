import { describe, expect, test } from "bun:test";
import {
  AllMessages,
  AnyMessage,
  PeerMessage,
  HubMessage,
  approvalChallenge,
  approvalSignedPayload,
  controlFrame,
  decodeFrame,
  decodeRelay,
  encodeFrame,
  encodeRelay,
  parseControl,
} from "../src/index.js";

const samples: Record<string, unknown> = {
  "intent.submit": { text: "列出桌面上的 pdf", deviceId: "mac-1", mode: "agent" },
  "approval.decision": { runId: "r1", stepId: "s1", allow: true },
  "step.precheck": { runId: "r1", stepId: "s1", staticLevel: 1, level: 2, verdict: "confirm", source: "jev", risk: 0.7, jevMs: 120 },
  "step.approval_required": { runId: "r1", stepId: "s1", level: 2, action: { channel: "shell", summary: "删除文件", detail: "rm -rf ~/x" }, reason: "L2", expiresAt: 1, challenge: "c" },
  "run.finished": { runId: "r1", ok: true, summary: "done", cost: { inputTokens: 1, outputTokens: 2, usd: 0.001 }, stepCount: 3 },
  hello: { role: "device", deviceId: "mac-1", platform: "macos", name: "Sol's Mac", pubKeys: { kem: "a", sig: "b", sigAlg: "ES256" }, protocolVersion: 1 },
  "tools.call": { callId: "c1", tool: "shell.run", args: { cmd: "ls" } },
  "privacy.set": { settings: { brainLocation: "local", sync: { history: false, screenshots: false, logs: false, shortcuts: false }, modelTier: "zdr", jevEnabled: true, autonomy: "balanced" } },
};

describe("messages", () => {
  test("every message type is unique and parses its own sample or a minimal object", () => {
    const types = new Set<string>();
    for (const [name, schema] of Object.entries(AllMessages)) {
      const t = schema.shape.type.value;
      expect(types.has(t)).toBe(false);
      types.add(t);
      const body = samples[t];
      if (body) {
        const parsed = AnyMessage.parse({ v: 1, id: name, type: t, ...body });
        expect(parsed.type).toBe(t);
      }
    }
    expect(types.size).toBe(Object.keys(AllMessages).length);
  });

  test("rejects wrong version and unknown type", () => {
    expect(AnyMessage.safeParse({ v: 2, id: "x", type: "stats.get" }).success).toBe(false);
    expect(AnyMessage.safeParse({ v: 1, id: "x", type: "nope" }).success).toBe(false);
  });

  test("defaults are applied (approval.remember, history.limit)", () => {
    const a = AnyMessage.parse({ v: 1, id: "1", type: "approval.decision", ...samples["approval.decision"] as object });
    expect(a.type === "approval.decision" && a.remember).toBe("once");
    const h = PeerMessage.parse({ v: 1, id: "2", type: "history.list" });
    expect(h.type === "history.list" && h.limit).toBe(50);
  });

  test("hub union does not accept peer-only messages", () => {
    expect(HubMessage.safeParse({ v: 1, id: "x", type: "intent.submit", ...samples["intent.submit"] as object }).success).toBe(false);
  });

  test("level must be 0/1/2 and risk within [0,1]", () => {
    expect(AnyMessage.safeParse({ v: 1, id: "x", type: "step.precheck", ...samples["step.precheck"] as object, level: 3 }).success).toBe(false);
    expect(AnyMessage.safeParse({ v: 1, id: "x", type: "step.precheck", ...samples["step.precheck"] as object, risk: 1.2 }).success).toBe(false);
  });
});

describe("frame", () => {
  test("round trip for each kind and streamId boundaries", () => {
    for (const kind of [0, 1, 2] as const) {
      for (const streamId of [0, 1, 0x7fff_ffff, 0xffff_ffff]) {
        const payload = new Uint8Array([1, 2, 3, kind]);
        const f = decodeFrame(encodeFrame({ kind, streamId, payload }));
        expect(f.kind).toBe(kind);
        expect(f.streamId).toBe(streamId);
        expect(Array.from(f.payload)).toEqual([1, 2, 3, kind]);
      }
    }
  });
  test("rejects bad kind, out-of-range stream, short buffer", () => {
    expect(() => encodeFrame({ kind: 3 as never, streamId: 0, payload: new Uint8Array() })).toThrow();
    expect(() => encodeFrame({ kind: 0, streamId: 0x1_0000_0000, payload: new Uint8Array() })).toThrow();
    expect(() => decodeFrame(new Uint8Array([0, 0]))).toThrow();
  });
  test("control frame carries JSON", () => {
    const m = { v: 1, id: "1", type: "stats.get" };
    const f = decodeFrame(controlFrame(m, 7));
    expect(f.streamId).toBe(7);
    expect(parseControl(f)).toEqual(m);
  });
  test("relay envelope round trip preserves route and flags; body is opaque", () => {
    const body = encodeFrame({ kind: 1, streamId: 9, payload: new Uint8Array([0xde, 0xad]) });
    const e = decodeRelay(encodeRelay({ to: "phone-α", from: "mac-1", encrypted: true, body }));
    expect(e.to).toBe("phone-α");
    expect(e.from).toBe("mac-1");
    expect(e.encrypted).toBe(true);
    expect(Array.from(e.body)).toEqual(Array.from(body));
  });
});

describe("approval challenge", () => {
  test("is deterministic and differs when action detail changes", () => {
    const a = approvalChallenge({ runId: "r", stepId: "s", actionDetail: "rm a", nonce: "n", expiresAt: 10 });
    const b = approvalChallenge({ runId: "r", stepId: "s", actionDetail: "rm b", nonce: "n", expiresAt: 10 });
    expect(a).not.toBe(b);
    expect(a).toBe(approvalChallenge({ runId: "r", stepId: "s", actionDetail: "rm a", nonce: "n", expiresAt: 10 }));
    expect(approvalSignedPayload(a, true).endsWith("\nallow")).toBe(true);
    expect(approvalSignedPayload(a, false).endsWith("\ndeny")).toBe(true);
  });
});
