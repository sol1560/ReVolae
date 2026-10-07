import { afterAll, describe, expect, test } from "bun:test";
import { Billing, RevenueCatLedger } from "../src/billing.js";
import { HubStore } from "../src/db.js";
import { createHubServer } from "../src/server.js";
import { Endpoint } from "./helpers.js";

/** 模拟 RevenueCat Developer API v2：一个账号一份 CRD 余额 + 权益 */
function fakeRevenueCat() {
  const balances = new Map<string, number>();
  const pro = new Set<string>();
  const calls: { method: string; path: string; body?: unknown; auth: string | null }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    const m = /^\/v2\/projects\/proj1\/(.+)$/.exec(url.pathname);
    if (!m) return Response.json({ error: "nope" }, { status: 404 });
    const rest = m[1]!;
    if (rest === "entitlements") return Response.json({ items: [{ id: "entlPRO", lookup_key: "pro" }, { id: "entlX", lookup_key: "other" }] });
    const c = /^customers\/([^/]+)\/(.+)$/.exec(rest);
    if (!c) return Response.json({}, { status: 404 });
    const acct = decodeURIComponent(c[1]!);
    if (!balances.has(acct)) return Response.json({ type: "resource_missing" }, { status: 404 });
    const list = () => Response.json({ object: "list", items: [{ object: "virtual_currency_balance", currency_code: "CRD", balance: balances.get(acct)! }] });
    if (c[2] === "virtual_currencies" && method === "GET") return list();
    if (c[2] === "virtual_currencies/transactions" && method === "POST") {
      const d = (body as { adjustments: Record<string, number> }).adjustments.CRD!;
      if (balances.get(acct)! + d < 0) return Response.json({ type: "invalid_request" }, { status: 422 });
      balances.set(acct, balances.get(acct)! + d);
      return list();
    }
    if (c[2] === "active_entitlements") return Response.json({ object: "list", items: pro.has(acct) ? [{ object: "customer.active_entitlement", entitlement_id: "entlPRO", expires_at: Date.now() + 3600_000 }] : [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return { balances, pro, calls, fetch: f };
}

describe("RevenueCatLedger", () => {
  test("查余额（没出现过的用户算 0）、扣款向上取整带 reference、余额不足报错、缓存与清缓存", async () => {
    const rc = fakeRevenueCat();
    let now = 1000;
    const ledger = new RevenueCatLedger({ secretKey: "sk_test", projectId: "proj1", fetch: rc.fetch, now: () => now });
    expect(await ledger.balance("nobody")).toBe(0);

    rc.balances.set("acct", 10);
    expect(await ledger.balance("acct")).toBe(10);
    expect(rc.calls.at(-1)).toMatchObject({ method: "GET", path: "/v2/projects/proj1/customers/acct/virtual_currencies", auth: "Bearer sk_test" });

    expect(await ledger.charge("acct", 2.3, "run-1", "m")).toBe(7);
    expect(rc.calls.at(-1)!.body).toEqual({ adjustments: { CRD: -3 }, reference: "run-1" });
    expect(await ledger.charge("acct", 0.01, "run-2", "m")).toBe(6); // 最少扣 1

    // 余额走缓存；RevenueCat 那边加了余额，清缓存后才看得到
    rc.balances.set("acct", 100);
    expect(await ledger.balance("acct")).toBe(6);
    ledger.invalidate("acct");
    expect(await ledger.balance("acct")).toBe(100);
    now += 31;
    rc.balances.set("acct", 2);
    expect(await ledger.balance("acct")).toBe(2); // 缓存过期

    await expect(ledger.charge("acct", 5, "run-3", "m")).rejects.toThrow("余额不足");
  });

  test("pro 权益：按 lookup key 找到内部 id 再看 active_entitlements", async () => {
    const rc = fakeRevenueCat();
    rc.balances.set("a", 0);
    rc.balances.set("b", 0);
    rc.pro.add("b");
    const ledger = new RevenueCatLedger({ secretKey: "sk", projectId: "proj1", fetch: rc.fetch });
    expect(await ledger.hasPro("a")).toBe(false);
    expect(await ledger.hasPro("b")).toBe(true);
    expect(rc.calls.filter((c) => c.path.endsWith("/entitlements")).length).toBe(1); // 权益 id 只查一次
  });

  test("接进 Billing：免费次数用完后按 RevenueCat 余额放行，结算时扣 CRD", async () => {
    const rc = fakeRevenueCat();
    rc.balances.set("acct", 5);
    const store = new HubStore(":memory:");
    const ledger = new RevenueCatLedger({ secretKey: "sk", projectId: "proj1", fetch: rc.fetch });
    const billing = new Billing(store, { ledger, freeRunsPerMonth: 0, margin: 0, creditsPerUsd: 100 });
    expect(await billing.reserve("acct", "r1")).toEqual({ ok: true, kind: "credits" });
    await billing.settle("acct", "r1", { inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0.021 });
    expect(rc.balances.get("acct")).toBe(2); // 2.1 → 3
    expect((await billing.status("acct")).credits).toBe(2);
    rc.balances.set("broke", 0);
    expect((await billing.reserve("broke", "r2")).ok).toBe(false);
  });
});

describe("RevenueCat webhook", () => {
  const rc = fakeRevenueCat();
  rc.balances.set("local", 7);
  const store = new HubStore(":memory:");
  const ledger = new RevenueCatLedger({ secretKey: "sk", projectId: "proj1", fetch: rc.fetch });
  const billing = new Billing(store, { ledger });
  const srv = createHubServer({ port: 0, store, billing, revenueCatWebhook: { authorization: "Bearer whsec", ledger } });
  const http = () => `http://127.0.0.1:${srv.server.port}/webhooks/revenuecat`;
  afterAll(() => void srv.server.stop(true));

  test("鉴权不对 401；购买事件清缓存并把新余额推给在线手机", async () => {
    const phone = await Endpoint.make("phone-rc", "phone");
    await phone.login(srv.url);
    expect(await ledger.balance("local")).toBe(7);
    rc.balances.set("local", 107); // 用户刚买了 100 CRD

    const bad = await fetch(http(), { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(bad.status).toBe(401);

    const ok = await fetch(http(), {
      method: "POST",
      headers: { authorization: "Bearer whsec", "content-type": "application/json" },
      body: JSON.stringify({ api_version: "1.0", event: { type: "VIRTUAL_CURRENCY_TRANSACTION", app_user_id: "local", aliases: ["$RCAnonymousID:abc", "local"], environment: "SANDBOX" } }),
    });
    expect(ok.status).toBe(200);
    const st = await phone.expect("billing.status");
    expect(st.credits).toBe(107);
    phone.close();
  });
});

import { selfAccountId } from "../src/hub.js";
describe("自助账号", () => {
  test("多账号模式下手机不带 JWT 也能登录，账号由公钥派生、稳定；设备不带 JWT 仍是未认领", async () => {
    const srv = createHubServer({ port: 0, jwtSecret: "s3cret", selfAccounts: true });
    try {
      const phone = await Endpoint.make("phone-self", "phone", "Ed25519");
      await phone.login(srv.url);
      const acct = srv.hub.store.getDevice("phone-self")!.accountId;
      expect(acct).toBe(selfAccountId(phone.pubKeys.sig));
      expect(acct).toMatch(/^u_[0-9a-f]{16}$/);
      phone.close();
      const again = await Endpoint.make("phone-self-2", "phone", "Ed25519");
      await again.login(srv.url);
      expect(srv.hub.store.getDevice("phone-self-2")!.accountId).not.toBe(acct);
      again.close();
    } finally {
      void srv.server.stop(true);
    }
  });
});
