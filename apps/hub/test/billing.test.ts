import { afterAll, describe, expect, test } from "bun:test";
import { pairHmac } from "@cuaremote/protocol";
import { Billing, JocLedger, LocalLedger, monthWindow, type CreditLedger } from "../src/billing.js";
import { HubStore } from "../src/db.js";
import { createHubServer } from "../src/server.js";
import { Endpoint, b64, pair } from "./helpers.js";

// 2026-09-19 12:00 UTC
const SEP19 = Date.UTC(2026, 8, 19, 12) / 1000;
const cost = (usd: number) => ({ inputTokens: 1000, outputTokens: 100, jevTokens: 0, usd });

describe("Billing（本地账本）", () => {
  test("免费次数按自然月算；用完后没余额就拒；充值后按成本 × 加成扣 credit；结算幂等", async () => {
    let now = SEP19;
    const store = new HubStore(":memory:");
    const b = new Billing(store, { ledger: new LocalLedger(store, () => now), freeRunsPerMonth: 2, margin: 0.3, creditsPerUsd: 100, now: () => now });

    expect(await b.reserve("acc", "r1")).toEqual({ ok: true, kind: "free" });
    expect(await b.reserve("acc", "r1")).toEqual({ ok: true, kind: "free" }); // 重复预占不多占
    expect(await b.reserve("acc", "r2")).toEqual({ ok: true, kind: "free" });
    const denied = await b.reserve("acc", "r3");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("credits_exhausted");
    expect(store.getRunBilling("r3")).toBeUndefined(); // 被拒的不留记录

    // 免费 run 结算：记账不扣款
    expect(await b.settle("acc", "r1", cost(0.5))).toEqual({ credits: 0, balance: undefined });
    expect(store.getRunBilling("r1")!.usd).toBe(0.5);

    // 另一个账号不受影响
    expect(await b.reserve("other", "o1")).toEqual({ ok: true, kind: "free" });

    // 充值 10 credit 后可以继续，按 credits 结算
    store.addCredits("acc", 10, now);
    expect(await b.reserve("acc", "r3")).toEqual({ ok: true, kind: "credits" });
    // 0.0123 美元 × 1.3 × 100 = 1.599 → 向上取两位 = 1.60
    const s = await b.settle("acc", "r3", cost(0.0123));
    expect(s.credits).toBe(1.6);
    expect(s.balance).toBeCloseTo(8.4, 6);
    // 再结算一次不重复扣
    expect(await b.settle("acc", "r3", cost(0.0123))).toEqual({ credits: 1.6 });
    expect(store.getCredits("acc")).toBeCloseTo(8.4, 6);

    const st = await b.status("acc");
    expect(st).toMatchObject({ type: "billing.status", plan: "paid", freeRunsTotal: 2, freeRunsUsed: 2, creditsPerUsd: 100, freeDeviceLimit: 1 });
    expect(st.credits).toBeCloseTo(8.4, 6);
    expect(st.periodEndsAt).toBe(Date.UTC(2026, 9, 1) / 1000);

    // 余额扣到 0 以下后又没免费次数 → 拒
    store.addCredits("acc", -8.4, now);
    expect((await b.reserve("acc", "r4")).ok).toBe(false);

    // 下个月 1 号：免费次数重置
    now = Date.UTC(2026, 9, 1, 0, 0, 1) / 1000;
    expect(await b.reserve("acc", "r5")).toEqual({ ok: true, kind: "free" });
    expect((await b.status("acc")).freeRunsUsed).toBe(1);
  });

  test("monthWindow：月末最后一秒和下月第一秒分属两个窗口", () => {
    const lastSec = Date.UTC(2026, 8, 30, 23, 59, 59) / 1000;
    const firstSec = Date.UTC(2026, 9, 1) / 1000;
    expect(monthWindow(lastSec).end).toBe(firstSec);
    expect(monthWindow(firstSec).start).toBe(firstSec);
    expect(monthWindow(Date.UTC(2026, 11, 31) / 1000).end).toBe(Date.UTC(2027, 0, 1) / 1000);
  });

  test("外部账本查余额失败：拒绝开跑而不是放行；扣款失败不标 settled，下次重试", async () => {
    const store = new HubStore(":memory:");
    let failBalance = true;
    let failCharge = true;
    let charged = 0;
    const ledger: CreditLedger = {
      kind: "flaky",
      balance: async () => {
        if (failBalance) throw new Error("down");
        return 100;
      },
      charge: async (_a, c) => {
        if (failCharge) throw new Error("down");
        charged += c;
        return 100 - charged;
      },
    };
    const b = new Billing(store, { ledger, freeRunsPerMonth: 0, now: () => SEP19 });
    expect((await b.reserve("acc", "r1")).ok).toBe(false);
    failBalance = false;
    expect(await b.reserve("acc", "r1")).toEqual({ ok: true, kind: "credits" });
    await expect(b.settle("acc", "r1", cost(1))).rejects.toThrow("down");
    expect(store.getRunBilling("r1")!.settled).toBe(false);
    failCharge = false;
    expect((await b.settle("acc", "r1", cost(1))).credits).toBe(130);
    expect(charged).toBe(130);
    await b.settle("acc", "r1", cost(1));
    expect(charged).toBe(130);
  });
});

describe("JocLedger（假 JOC 服务）", () => {
  const seen: { path: string; auth: string | null; body: unknown }[] = [];
  const balances = new Map<string, number>([["u1", 42.5]]);
  const refs = new Set<string>();
  const joc = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json() : undefined;
      seen.push({ path: url.pathname + url.search, auth: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== "Bearer k-1") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/v1/bal") return Response.json({ credits: balances.get(url.searchParams.get("account")!) ?? 0 });
      if (url.pathname === "/v1/charge") {
        const { account, credits, ref } = body as { account: string; credits: number; ref: string };
        if (refs.has(ref)) return Response.json({ error: "duplicate" }, { status: 409 });
        refs.add(ref);
        balances.set(account, (balances.get(account) ?? 0) - credits);
        return Response.json({ credits: balances.get(account) });
      }
      return new Response("nope", { status: 404 });
    },
  });
  afterAll(() => void joc.stop(true));

  test("带 Bearer 查余额、扣款；同 ref 409 当作已扣成功并回真实余额；坏 key 报错", async () => {
    const l = new JocLedger({ baseURL: `http://localhost:${joc.port}/`, apiKey: "k-1", balancePath: "/v1/bal", chargePath: "/v1/charge", topUpURL: "https://joc.test/topup" });
    expect(await l.balance("u1")).toBe(42.5);
    expect(seen[0]).toMatchObject({ path: "/v1/bal?account=u1", auth: "Bearer k-1" });
    expect(await l.charge("u1", 2.5, "run-1", "test")).toBe(40);
    expect(seen[1]!.body).toEqual({ account: "u1", credits: 2.5, ref: "run-1", memo: "test" });
    expect(await l.charge("u1", 2.5, "run-1", "test")).toBe(40); // 重复 ref
    expect(balances.get("u1")).toBe(40);
    expect(l.topUpURL()).toBe("https://joc.test/topup");
    const bad = new JocLedger({ baseURL: `http://localhost:${joc.port}`, apiKey: "wrong", balancePath: "/v1/bal" });
    await expect(bad.balance("u1")).rejects.toThrow("401");
  });
});

describe("hub 接计费", () => {
  const store = new HubStore(":memory:");
  const now = SEP19;
  const billing = new Billing(store, { ledger: new LocalLedger(store, () => now), freeRunsPerMonth: 50, freeDeviceLimit: 1, now: () => now });
  const srv = createHubServer({ port: 0, store, billing, now: () => now, publicURL: "ws://hub.test/ws" });
  const url = srv.url;
  const http = url.replace(/^ws/, "http").replace(/\/ws$/, "");
  afterAll(() => void srv.server.stop(true));

  test("billing.get 回 billing.status；HTTP /api/billing 同一份；免费层第二台被控设备被拒，充值后放行", async () => {
    const phone = await Endpoint.make("ph-1", "phone");
    const mac1 = await Endpoint.make("mac-1", "device");
    const mac2 = await Endpoint.make("mac-2", "device");
    await Promise.all([phone.login(url), mac1.login(url), mac2.login(url)]);

    phone.send({ type: "billing.get" });
    const st = await phone.expect("billing.status");
    expect(st).toMatchObject({ plan: "free", freeRunsTotal: 50, freeRunsUsed: 0, credits: 0, freeDeviceLimit: 1 });
    const viaHttp = await (await fetch(`${http}/api/billing`, { headers: { authorization: `Bearer ${phone.sessionToken}` } })).json();
    expect(viaHttp).toMatchObject({ plan: "free", freeRunsUsed: 0 });

    const secret = b64(new Uint8Array(16).fill(7));
    expect((await pair(phone, mac1, secret)).rp.ok).toBe(true);

    phone.send({ type: "pair.request", deviceId: mac2.id, phoneId: phone.id, phoneName: "iPhone", phonePubKeys: phone.pubKeys, hmac: pairHmac(secret, mac2.pubKeys.kem, phone.pubKeys.kem) });
    expect((await phone.expect("error")).code).toBe("device_limit");

    store.addCredits("local", 5, now);
    expect((await pair(phone, mac2, secret)).rp.ok).toBe(true);
    // 已经属于本账号的设备再配一台手机不受设备数限制
    const phone2 = await Endpoint.make("ph-2", "phone");
    await phone2.login(url);
    store.addCredits("local", -5, now);
    expect((await pair(phone2, mac1, secret)).rp.ok).toBe(true);
    for (const e of [phone, phone2, mac1, mac2]) e.close();
  });
});
