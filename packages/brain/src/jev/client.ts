/**
 * TypeSafe System One（Jev）客户端。
 * POST https://api.typesafe.ai/v1/systemone  { state, model, questions }
 * 问题类型：choice（criteria 为 {id: 描述}）、noul（是/否，返回 0-1 概率）、score（criteria 为有序数组）。
 * 价格：约 $0.042 / M 输入 token（用于成本记账，可用 JEV_PRICE_IN 覆盖）。
 */

export type JevQuestion =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "noul"; instructions: unknown; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions: unknown; criteria: string[] };

export type JevAnswer =
  | { type?: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type?: "noul"; noul: number }
  | { type?: "score"; score: number; confidence: number; probabilities?: Record<string, number> };

export interface JevResult<Q extends Record<string, JevQuestion>> {
  answers: { [K in keyof Q]: Extract<JevAnswer, { type?: Q[K]["type"] }> };
  usage: { input_tokens?: number; output_tokens?: number };
  model: string;
  latencyMs: number;
  usd: number;
}

export interface JevClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class JevClient {
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly priceIn: number;

  constructor(o: JevClientOptions = {}) {
    this.apiKey = o.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.endpoint = o.endpoint ?? process.env.TYPESAFE_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone";
    this.model = o.model ?? process.env.TYPESAFE_MODEL ?? "jev-latest";
    this.timeoutMs = o.timeoutMs ?? 1_500;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.priceIn = Number(process.env.JEV_PRICE_IN ?? 0.042);
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async ask<Q extends Record<string, JevQuestion>>(state: unknown, questions: Q): Promise<JevResult<Q>> {
    if (!this.apiKey) throw new Error("没有 TYPESAFE_API_KEY");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: ctrl.signal,
      });
      const latencyMs = Date.now() - t0;
      const body = (await res.json().catch(() => null)) as { answers?: unknown; usage?: JevResult<Q>["usage"]; model?: string; error?: unknown } | null;
      if (!res.ok || !body?.answers) throw new Error(`Jev HTTP ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
      const answers = body.answers as JevResult<Q>["answers"];
      validate(questions, answers);
      const inTok = body.usage?.input_tokens ?? 0;
      return { answers, usage: body.usage ?? {}, model: body.model ?? this.model, latencyMs, usd: (inTok / 1e6) * this.priceIn };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 照 jev-ultrafast 的做法校验：choice 必须在候选里、概率合法且和为 1。校验不过就当 Jev 没回答。 */
function validate(questions: Record<string, JevQuestion>, answers: Record<string, JevAnswer>) {
  for (const [k, q] of Object.entries(questions)) {
    const a = answers[k];
    if (!a) throw new Error(`Jev 没回答问题 ${k}`);
    if (q.type === "choice") {
      const ids = Object.keys(q.criteria);
      const c = a as { choice?: string; probabilities?: Record<string, number>; confidence?: number };
      const probs = c.probabilities ?? {};
      const nums = [...Object.values(probs), c.confidence ?? NaN];
      const ok =
        typeof c.choice === "string" &&
        ids.includes(c.choice) &&
        nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
        Math.abs(Object.values(probs).reduce((s, n) => s + n, 0) - 1) < 0.02;
      if (!ok) throw new Error(`Jev 对 ${k} 的 choice 回答不合法`);
    } else if (q.type === "noul") {
      const n = (a as { noul?: number }).noul;
      if (typeof n !== "number" || n < 0 || n > 1) throw new Error(`Jev 对 ${k} 的 noul 回答不合法`);
    } else if (q.type === "score") {
      const n = (a as { score?: number }).score;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`Jev 对 ${k} 的 score 回答不合法`);
    }
  }
}
