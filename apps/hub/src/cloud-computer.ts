import { posix } from "node:path";
import type { CloudHooks, CloudRequest, CloudRunContext } from "@cuaremote/brain";
import { CloudComputers, E2bHost, E2bPty, QUICK_CARDS, WORK_DIR, resolvePath, type SandboxHandle } from "@cuaremote/cloud-computer";
import type { CloudVariant, DeviceSummary, MsgBody } from "@cuaremote/protocol";

/** E2B 默认规格 2 vCPU + 4 GiB 的按秒单价（美元）：0.000028 + 0.000018 */
export const E2B_DEFAULT_USD_PER_SECOND = 0.000046;
const DOWNLOAD_TTL = 3600;
const UPLOAD_TTL = 900;

/** 分叉时每份的思路（按份数取前几个） */
export const VARIANT_APPROACHES = [
  "稳妥：最常见、最不容易出错的做法",
  "大胆：做出风格强烈、让人眼前一亮的版本（有界面就用鲜明的配色和动效）",
  "反着来：刻意选和常见做法不同的思路（有界面就用浅色、极简、以排版和内容为主，不要暗色炫酷风）",
];

interface PendingPick {
  accountId: string;
  forks: Map<string, SandboxHandle>;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface CloudComputerServiceOptions {
  computers: CloudComputers;
  /** 这个账号一次最多分几份（按 RevenueCat 权益算；默认 1 = 不分叉） */
  variantsAllowed?: (accountId: string) => Promise<number>;
  /** 沙箱每秒多少美元，进 run 成本 */
  usdPerSecond?: number;
  now?: () => number;
  log?: (rec: Record<string, unknown>) => void;
}

/** 云电脑在设备列表里的 id */
export function cloudDeviceIdOf(accountId: string) {
  return `cloud:${accountId}`;
}

/**
 * hub 一侧的云电脑：把 CloudComputers（沙箱生命周期）接到云端大脑的钩子上，
 * 并处理手机发来的 cloud.* 请求（状态、文件、上传下载、撤销）。
 */
export class CloudComputerService {
  private readonly now: () => number;
  private readonly usdPerSecond: number;
  /** 跑完等手机挑的分叉，按原任务 runId */
  private readonly picks = new Map<string, PendingPick>();

  constructor(private readonly o: CloudComputerServiceOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.usdPerSecond = o.usdPerSecond ?? E2B_DEFAULT_USD_PER_SECOND;
  }

  get computers() {
    return this.o.computers;
  }

  /** 设备列表里的那一行：永远可用（暂停的机器一调用就醒），所以 online 恒为 true */
  summary(accountId: string): DeviceSummary {
    const st = this.o.computers.status(accountId);
    return {
      deviceId: cloudDeviceIdOf(accountId),
      role: "device",
      platform: "cloud",
      name: "云电脑",
      online: true,
      lastSeen: st.lastActiveAt ?? this.now(),
      paired: true,
      ...(st.createdAt ? { pairedAt: st.createdAt } : {}),
    };
  }

  hooks(accountId: string): CloudHooks {
    const cc = this.o.computers;
    const sandbox = () => cc.handle(accountId);
    return {
      deviceId: cloudDeviceIdOf(accountId),
      host: (ctx) => this.hostFor(accountId, ctx, sandbox),
      spawnPty: (o) => new E2bPty(sandbox, o),
      handle: (m, ctx) => this.handle(accountId, m, ctx.reply),
      beforeRun: async (ctx) => {
        await cc.snapshot(accountId, ctx.runId, ctx.title.slice(0, 60));
      },
      afterRun: (_ctx, wallMs) => (wallMs / 1000) * this.usdPerSecond,
      variantsAllowed: async () => Math.min(Math.max((await this.o.variantsAllowed?.(accountId)) ?? 1, 1), 3),
      runVariants: (ctx, count, run) => this.runVariants(accountId, ctx, count, run),
    };
  }

  /**
   * 分叉挑选：主机器（任务前已存快照）原样复制成 count 份，每份按一种思路同时跑；
   * 跑完每份附上摘要和预览截图推给手机，等 cloud.pick。没挑的分叉到期自动删掉。
   */
  private async runVariants(
    accountId: string,
    ctx: CloudRunContext,
    count: number,
    run: (host: E2bHost, approach: string, variantRunId: string) => Promise<{ ok: boolean; summary: string; costUsd: number }>,
  ): Promise<{ costUsd: number }> {
    const forks = await this.o.computers.fork(accountId, count);
    const alive = new Map<string, SandboxHandle>();
    let sandboxSeconds = 0;
    const items = await Promise.all(
      forks.map(async (fork, i): Promise<CloudVariant> => {
        const approach = VARIANT_APPROACHES[i] ?? `做法 ${i + 1}`;
        if (fork instanceof Error) return { forkId: `failed-${i + 1}`, approach, ok: false, summary: `这一份没能启动：${fork.message}` };
        alive.set(fork.id, fork);
        const variantRunId = `${ctx.runId}.${i + 1}`;
        let previewPort: number | undefined;
        let previewUrl: string | undefined;
        const host = new E2bHost({
          sandbox: async () => fork,
          onPreview: (e) => {
            previewPort = e.port;
            previewUrl = e.url;
            ctx.emit({ type: "cloud.preview", runId: variantRunId, port: e.port, url: e.url });
          },
          onDownload: (e) => ctx.emit({ type: "cloud.download", runId: variantRunId, path: e.path, name: e.name, size: e.size, url: e.url, expiresAt: this.now() + DOWNLOAD_TTL }),
        });
        const t0 = Date.now();
        try {
          const out = await run(host, approach, variantRunId);
          let screenshot: string | undefined;
          if (previewPort) {
            const shot = await host.call("browser.screenshot", { url: `http://localhost:${previewPort}` });
            screenshot = shot.ok ? shot.attachments[0]?.inline : undefined;
          }
          return { forkId: fork.id, approach, ok: out.ok, summary: out.summary, ...(screenshot ? { screenshot } : {}), ...(previewUrl ? { previewUrl } : {}) };
        } catch (e) {
          return { forkId: fork.id, approach, ok: false, summary: `出错了：${e instanceof Error ? e.message : String(e)}` };
        } finally {
          sandboxSeconds += (Date.now() - t0) / 1000;
        }
      }),
    );
    const expiresAt = this.now() + this.o.computers.idleSeconds;
    if (alive.size) {
      const timer = setTimeout(() => this.expirePick(ctx.runId), this.o.computers.idleSeconds * 1000);
      (timer as { unref?: () => void }).unref?.();
      this.picks.set(ctx.runId, { accountId, forks: alive, expiresAt, timer });
    }
    ctx.emit({ type: "cloud.variants", runId: ctx.runId, items, expiresAt });
    return { costUsd: sandboxSeconds * this.usdPerSecond };
  }

  private expirePick(runId: string) {
    const p = this.picks.get(runId);
    if (!p) return;
    this.picks.delete(runId);
    this.o.computers.discard([...p.forks.values()]);
    this.o.log?.({ t: "cloud_variants_expired", runId, accountId: p.accountId });
  }

  /** 挑中一份：它成为主机器；forkId 为空 = 都不要 */
  private pick(accountId: string, runId: string, forkId: string | undefined): string | undefined {
    const p = this.picks.get(runId);
    if (!p || p.accountId !== accountId) return "这个任务没有待挑选的分叉（可能已经过期）";
    const chosen = forkId ? p.forks.get(forkId) : undefined;
    if (forkId && !chosen) return `没有这一份：${forkId}`;
    clearTimeout(p.timer);
    this.picks.delete(runId);
    const rest = [...p.forks.values()].filter((f) => f !== chosen);
    if (chosen) this.o.computers.adopt(accountId, chosen, rest);
    else this.o.computers.discard(rest);
    return undefined;
  }

  /** 这次任务的宿主：预览链接和下载按钮推给发起任务的手机 */
  private hostFor(accountId: string, ctx: CloudRunContext, sandbox: () => ReturnType<CloudComputers["handle"]>) {
    return new E2bHost({
      sandbox,
      onPreview: (e) => ctx.emit({ type: "cloud.preview", runId: ctx.runId, port: e.port, url: e.url }),
      onDownload: (e) => ctx.emit({ type: "cloud.download", runId: ctx.runId, path: e.path, name: e.name, size: e.size, url: e.url, expiresAt: this.now() + DOWNLOAD_TTL }),
    });
  }

  async statusMessage(accountId: string): Promise<MsgBody> {
    const st = this.o.computers.status(accountId);
    return {
      type: "cloud.status",
      deviceId: cloudDeviceIdOf(accountId),
      state: st.state,
      ...(st.lastActiveAt ? { lastActiveAt: st.lastActiveAt } : {}),
      idleSeconds: this.o.computers.idleSeconds,
      cards: QUICK_CARDS,
      snapshots: this.o.computers.snapshots(accountId).map((s) => ({ runId: s.runId, createdAt: s.createdAt, ...(s.title ? { title: s.title } : {}) })),
      variantsAllowed: Math.min(Math.max((await this.o.variantsAllowed?.(accountId)) ?? 1, 1), 3),
    };
  }

  async handle(accountId: string, m: CloudRequest, reply: (body: MsgBody) => Promise<void>): Promise<void> {
    const cc = this.o.computers;
    switch (m.type) {
      case "cloud.status.get":
        return reply(await this.statusMessage(accountId));
      case "cloud.wake":
        await cc.handle(accountId);
        return reply(await this.statusMessage(accountId));
      case "cloud.files.list": {
        const path = resolvePath(m.path);
        const sb = await cc.handle(accountId);
        if (path === WORK_DIR) await sb.run(`mkdir -p ${WORK_DIR}/inbox ${WORK_DIR}/out`);
        const entries = (await sb.list(path, 1)).filter((e) => !e.name.startsWith(".")).sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
        return reply({ type: "cloud.files", path, entries });
      }
      case "cloud.upload.begin": {
        const sb = await cc.handle(accountId);
        const name = safeFileName(m.name);
        const dir = `${WORK_DIR}/inbox`;
        await sb.run(`mkdir -p ${dir}`);
        const taken = new Set((await sb.list(dir, 1)).map((e) => e.name));
        const path = `${dir}/${uniqueName(name, taken)}`;
        const url = await sb.uploadUrl(path, UPLOAD_TTL);
        return reply({ type: "cloud.upload.url", ref: m.id, path, url, expiresAt: this.now() + UPLOAD_TTL });
      }
      case "cloud.download.get": {
        const sb = await cc.handle(accountId);
        const path = resolvePath(m.path);
        const info = (await sb.list(posix.dirname(path), 1)).find((e) => e.path === path);
        if (!info || info.type !== "file") return reply({ type: "error", code: "not_found", message: `找不到文件 ${path}`, ref: m.id });
        const url = await sb.downloadUrl(path, DOWNLOAD_TTL);
        return reply({ type: "cloud.download", path, name: info.name, size: info.size, url, expiresAt: this.now() + DOWNLOAD_TTL });
      }
      case "cloud.undo":
        await cc.undo(accountId, m.runId);
        return reply(await this.statusMessage(accountId));
      case "cloud.pick": {
        const err = this.pick(accountId, m.runId, m.forkId);
        if (err) return reply({ type: "error", code: "no_variants", message: err, ref: m.id });
        return reply(await this.statusMessage(accountId));
      }
    }
  }
}

/** 去掉路径分隔符和控制字符，只留文件名本身 */
export function safeFileName(name: string): string {
  const base = posix.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f/]/g, "").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 200) : "upload";
}

/** 重名时加 (2)、(3)… */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const ext = posix.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!taken.has(cand)) return cand;
  }
}
