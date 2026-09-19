/**
 * 推送：hub 只投递「密文信封」。sealed 是设备用手机 push.register 时给的 HPKE 公钥封好的，
 * hub 和 Apple/Google 都只看到一段 base64；手机的 Notification Service Extension 解开后再显示。
 *
 * 没有 APNs 证书 / 密钥时用 DryRunPush：只记账不外发，方便本地跑通整条链路。
 */
import type { PushTokenRow } from "./db.js";

export interface PushPayload {
  sealed: string;
  category: string;
}

export type PushOutcome = { ok: true; detail?: string } | { ok: false; detail: string };

export interface PushSender {
  readonly kind: "dry-run" | "apns" | "fcm";
  send(target: PushTokenRow, payload: PushPayload): Promise<PushOutcome>;
}

export class DryRunPush implements PushSender {
  readonly kind = "dry-run" as const;
  readonly sent: { target: PushTokenRow; payload: PushPayload }[] = [];
  async send(target: PushTokenRow, payload: PushPayload): Promise<PushOutcome> {
    this.sent.push({ target, payload });
    return { ok: true, detail: `dry-run ${target.platform}:${target.token.slice(0, 8)}… ${payload.category}` };
  }
}

export interface ApnsOptions {
  /** 10 位 Team ID */
  teamId: string;
  /** .p8 的 Key ID */
  keyId: string;
  /** .p8 文件内容（PEM，PKCS#8） */
  privateKeyPem: string;
  /** app bundle id */
  topic: string;
  sandbox?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * APNs token 认证（ES256 JWT，缓存 50 分钟）。
 * 注意：APNs 只接受 HTTP/2。Bun 的 fetch 对 https 目标走 ALPN 协商 HTTP/2；
 * 这段没在真实 APNs 上验证过（没有证书），失败会记进 outbox 的 detail 里。
 */
export class ApnsPush implements PushSender {
  readonly kind = "apns" as const;
  private jwt?: { token: string; issuedAt: number };
  private key?: CryptoKey;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: ApnsOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private async providerToken(nowSec: number): Promise<string> {
    if (this.jwt && nowSec - this.jwt.issuedAt < 50 * 60) return this.jwt.token;
    if (!this.key) {
      const pem = this.o.privateKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
      this.key = await crypto.subtle.importKey("pkcs8", Buffer.from(pem, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    }
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = enc({ alg: "ES256", kid: this.o.keyId });
    const body = enc({ iss: this.o.teamId, iat: nowSec });
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key, Buffer.from(`${head}.${body}`));
    const token = `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
    this.jwt = { token, issuedAt: nowSec };
    return token;
  }

  async send(target: PushTokenRow, payload: PushPayload): Promise<PushOutcome> {
    if (target.platform !== "apns") return { ok: false, detail: `ApnsPush 不处理 ${target.platform}` };
    const host = this.o.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    try {
      const auth = await this.providerToken(Math.floor(Date.now() / 1000));
      const res = await this.fetchImpl(`${host}/3/device/${target.token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${auth}`,
          "apns-topic": this.o.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          aps: { alert: { title: "CuaRemote", body: "有一步操作等你确认" }, "mutable-content": 1, category: payload.category, sound: "default" },
          sealed: payload.sealed,
        }),
      });
      if (res.ok) return { ok: true, detail: `apns ${res.status} ${res.headers.get("apns-id") ?? ""}`.trim() };
      return { ok: false, detail: `apns ${res.status} ${await res.text().catch(() => "")}`.trim() };
    } catch (e) {
      return { ok: false, detail: `apns 请求失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/** 从环境变量装配：有完整 APNs 配置就用 APNs，否则 dry-run */
export function pushFromEnv(env: Record<string, string | undefined> = process.env): PushSender {
  const { APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_PEM, APNS_TOPIC, APNS_SANDBOX } = env;
  if (APNS_TEAM_ID && APNS_KEY_ID && APNS_KEY_PEM && APNS_TOPIC) {
    return new ApnsPush({ teamId: APNS_TEAM_ID, keyId: APNS_KEY_ID, privateKeyPem: APNS_KEY_PEM.replace(/\\n/g, "\n"), topic: APNS_TOPIC, sandbox: APNS_SANDBOX === "1" });
  }
  return new DryRunPush();
}
