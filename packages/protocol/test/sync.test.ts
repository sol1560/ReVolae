import { describe, expect, test } from "bun:test";
import { generateSyncKey, sealSync, openSync, exportSyncKey, importSyncKey, SYNC_BLOB_MAX_BYTES, type HistoryItem } from "../src/index.js";

const item: HistoryItem = { runId: "r1", deviceId: "mac", intent: "跑 deploy", startedAt: 1000, finishedAt: 2000, ok: true, summary: "完成", stepCount: 3 };

describe("同步密文块", () => {
  test("封 → 开还原；密文里没有明文", async () => {
    const k = generateSyncKey();
    const blob = await sealSync(k, { kind: "history", id: item.runId, deviceId: "mac", ts: 2000 }, item);
    expect(blob.alg).toBe("aes-256-gcm");
    expect(Buffer.from(blob.nonce, "base64").length).toBe(12);
    expect(Buffer.from(blob.ct, "base64").toString("utf8")).not.toContain("deploy");
    expect(await openSync<HistoryItem>(k, blob)).toEqual(item);
  });

  test("改 hub 可见的任何明文字段（id / deviceId / ts / kind）都解不开", async () => {
    const k = generateSyncKey();
    const blob = await sealSync(k, { kind: "history", id: "r1", deviceId: "mac", ts: 2000 }, item);
    await expect(openSync(k, { ...blob, id: "r2" })).rejects.toThrow(/被改过/);
    await expect(openSync(k, { ...blob, deviceId: "other" })).rejects.toThrow(/被改过/);
    await expect(openSync(k, { ...blob, ts: 2001 })).rejects.toThrow(/被改过/);
    await expect(openSync(k, { ...blob, kind: "shortcuts" })).rejects.toThrow(/被改过/);
  });

  test("密文翻一位 / 换密钥 / keyId 不匹配", async () => {
    const k = generateSyncKey();
    const blob = await sealSync(k, { kind: "history", id: "r1", deviceId: "mac", ts: 2000 }, item);
    const ct = Buffer.from(blob.ct, "base64");
    ct[0] = ct[0]! ^ 1;
    await expect(openSync(k, { ...blob, ct: ct.toString("base64") })).rejects.toThrow(/解密失败/);
    const k2 = { keyId: k.keyId, key: generateSyncKey().key };
    await expect(openSync(k2, blob)).rejects.toThrow(/解密失败/);
    await expect(openSync(generateSyncKey(), blob)).rejects.toThrow(/别的密钥/);
  });

  test("两次封同一内容 nonce 不同；导出 / 导入 key 往返", async () => {
    const k = generateSyncKey();
    const a = await sealSync(k, { kind: "history", id: "r1", deviceId: "mac", ts: 1 }, item);
    const b = await sealSync(k, { kind: "history", id: "r1", deviceId: "mac", ts: 1 }, item);
    expect(a.nonce).not.toBe(b.nonce);
    const k2 = importSyncKey(exportSyncKey(k));
    expect(await openSync<HistoryItem>(k2, a)).toEqual(item);
    expect(() => importSyncKey({ keyId: "x", key: Buffer.alloc(16).toString("base64") })).toThrow(/32/);
  });

  test("超过 64 KiB 拒封", async () => {
    const k = generateSyncKey();
    await expect(sealSync(k, { kind: "logs", id: "big", deviceId: "mac", ts: 1 }, { s: "x".repeat(SYNC_BLOB_MAX_BYTES) })).rejects.toThrow(/太大/);
  });
});
