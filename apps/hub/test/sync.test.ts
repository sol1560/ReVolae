import { afterAll, describe, expect, test } from "bun:test";
import { generateSyncKey, openSync, sealSync, type HistoryItem, type SyncBlob } from "@cuaremote/protocol";
import { signJwt } from "../src/auth.js";
import { createHubServer } from "../src/server.js";
import { Endpoint, b64, pair } from "./helpers.js";

const hist = (runId: string, ts: number, intent = "跑 deploy"): HistoryItem => ({ runId, deviceId: "mac-s", intent, startedAt: ts - 10, finishedAt: ts, ok: true });

describe("云同步密文块（hub 只存不看）", () => {
  const secret = "sync-secret";
  let now = 1_800_000_000;
  const srv = createHubServer({ port: 0, now: () => now, jwtSecret: secret, syncQuotaPerKind: 5 });
  const url = srv.url;
  const jwt = (sub: string) => signJwt({ sub, exp: now + 3600 }, secret);
  afterAll(() => {
    void srv.server.stop(true);
  });

  test("设备上传 → 同账号手机拉到并解开；覆盖只认更新的 ts；分页游标；hub 数据库里没有明文", async () => {
    const key = generateSyncKey();
    const mac = await Endpoint.make("mac-s", "device");
    const alice = await Endpoint.make("phone-alice-s", "phone");
    await mac.login(url);
    await alice.login(url, { token: jwt("alice") });
    await pair(alice, mac, b64(crypto.getRandomValues(new Uint8Array(16))));

    const blobs: SyncBlob[] = [];
    for (const [id, ts] of [["r1", 1000], ["r2", 2000], ["r3", 3000]] as const) blobs.push(await sealSync(key, { kind: "history", id, deviceId: mac.id, ts }, hist(id, ts)));
    mac.send({ type: "sync.put", items: blobs });
    await mac.expect("ack");

    // 旧于已有的 r2 被忽略；更新的 r1 覆盖并拿到新 seq
    const staleR2 = await sealSync(key, { kind: "history", id: "r2", deviceId: mac.id, ts: 1500 }, hist("r2", 1500, "旧的"));
    const newerR1 = await sealSync(key, { kind: "history", id: "r1", deviceId: mac.id, ts: 5000 }, hist("r1", 5000, "改过的 r1"));
    mac.send({ type: "sync.put", items: [staleR2, newerR1] });
    await mac.expect("ack");

    alice.send({ type: "sync.pull", kind: "history", limit: 2 });
    const p1 = await alice.expect("sync.page");
    expect(p1.items.map((b) => b.id)).toEqual(["r2", "r3"]); // r1 被覆盖后排到最后
    expect(p1.more).toBe(true);
    alice.send({ type: "sync.pull", kind: "history", cursor: p1.cursor, limit: 2 });
    const p2 = await alice.expect("sync.page");
    expect(p2.items.map((b) => b.id)).toEqual(["r1"]);
    expect(p2.more).toBe(false);
    expect(p2.cursor).toBeDefined();
    // 从最后的游标再拉：空页、没游标、more=false
    alice.send({ type: "sync.pull", kind: "history", cursor: p2.cursor, limit: 2 });
    const p3 = await alice.expect("sync.page");
    expect(p3).toMatchObject({ items: [], more: false });
    expect(p3.cursor).toBeUndefined();

    const opened = await Promise.all([...p1.items, ...p2.items].map((b) => openSync<HistoryItem>(key, b)));
    expect(opened.find((h) => h.runId === "r2")!.intent).toBe("跑 deploy");
    expect(opened.find((h) => h.runId === "r1")!.intent).toBe("改过的 r1");

    // 库里只有密文
    const raw = srv.hub.store.db.query<{ ct: string; nonce: string }, []>("SELECT ct, nonce FROM sync_blobs").all();
    expect(raw.length).toBe(3);
    for (const r of raw) expect(Buffer.from(r.ct, "base64").toString("utf8")).not.toContain("deploy");

    // 另一个账号什么也拉不到
    const bob = await Endpoint.make("phone-bob-s", "phone");
    await bob.login(url, { token: jwt("bob") });
    bob.send({ type: "sync.pull", kind: "history", limit: 100 });
    expect((await bob.expect("sync.page")).items).toEqual([]);

    // 删单条，再整类抹掉
    alice.send({ type: "sync.delete", kind: "history", ids: ["r3"] });
    await alice.expect("ack");
    expect(srv.hub.store.countSyncBlobs("alice", "history")).toBe(2);
    alice.send({ type: "sync.delete", kind: "history" });
    await alice.expect("ack");
    expect(srv.hub.store.countSyncBlobs("alice", "history")).toBe(0);
    mac.close();
    alice.close();
    bob.close();
  });

  test("没认领的设备不能同步；超过配额拒；超大块拒；端不能伪造 sync.page", async () => {
    const key = generateSyncKey();
    const orphan = await Endpoint.make("mac-orphan", "device");
    await orphan.login(url);
    orphan.send({ type: "sync.put", items: [await sealSync(key, { kind: "history", id: "x", deviceId: orphan.id, ts: 1 }, hist("x", 1))] });
    expect((await orphan.expect("error")).code).toBe("token_required");
    orphan.send({ type: "sync.pull", kind: "history", limit: 100 });
    expect((await orphan.expect("error")).code).toBe("token_required");
    orphan.close();

    const carol = await Endpoint.make("phone-carol-s", "phone");
    await carol.login(url, { token: jwt("carol") });
    const six: SyncBlob[] = [];
    for (let i = 0; i < 6; i++) six.push(await sealSync(key, { kind: "shortcuts", id: `s${i}`, deviceId: carol.id, ts: i }, { i }));
    carol.send({ type: "sync.put", items: six });
    expect((await carol.expect("error")).code).toBe("sync_quota");
    expect(srv.hub.store.countSyncBlobs("carol", "shortcuts")).toBe(0); // 整批拒，不半写
    carol.send({ type: "sync.put", items: six.slice(0, 5) });
    await carol.expect("ack");
    // 覆盖已有 id 不占新配额
    carol.send({ type: "sync.put", items: [await sealSync(key, { kind: "shortcuts", id: "s0", deviceId: carol.id, ts: 99 }, { i: 99 })] });
    await carol.expect("ack");
    expect(srv.hub.store.countSyncBlobs("carol", "shortcuts")).toBe(5);
    // 再加一条新 id 才顶到配额
    carol.send({ type: "sync.put", items: [await sealSync(key, { kind: "shortcuts", id: "s9", deviceId: carol.id, ts: 1 }, { i: 9 })] });
    expect((await carol.expect("error")).code).toBe("sync_quota");

    const big: SyncBlob = { kind: "logs", id: "big", deviceId: carol.id, ts: 1, keyId: key.keyId, alg: "aes-256-gcm", nonce: b64(new Uint8Array(12)), ct: "A".repeat(100 * 1024) };
    carol.send({ type: "sync.put", items: [big] });
    expect((await carol.expect("error")).code).toBe("sync_too_big");

    carol.send({ type: "sync.page", kind: "history", items: [], more: false });
    expect((await carol.expect("error")).code).toBe("not_allowed");
    carol.close();
  });
});
