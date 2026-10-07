import type { MsgBody, PhoneToDevice } from "@cuaremote/protocol";
import type { Host } from "../host/types.js";
import type { PtyFactory } from "../terminal/pty.js";

/** 手机发给云端大脑、要由云电脑处理的请求 */
export type CloudRequest = Extract<PhoneToDevice, { type: `cloud.${string}` }>;
export const CLOUD_REQUEST_TYPES = new Set<CloudRequest["type"]>(["cloud.status.get", "cloud.wake", "cloud.files.list", "cloud.upload.begin", "cloud.download.get", "cloud.pick", "cloud.undo"]);

export interface CloudRunContext {
  runId: string;
  phoneId: string;
  intent: string;
  /** 给人看的标题（手机给的），没有时用意图 */
  title: string;
  /** 推给发起任务的手机（预览链接、下载按钮等） */
  emit: (body: MsgBody) => void;
}

/**
 * 云电脑挂到云端大脑上的钩子。大脑不知道沙箱是谁家的，只按这里给的宿主跑任务；
 * 沙箱的创建、唤醒、快照、分叉、计价都在 hub 那一侧实现。
 */
export interface CloudHooks {
  /** 云电脑在设备列表里的 id（cloud:<account>） */
  deviceId: string;
  /** 这次任务用的宿主 */
  host(ctx: CloudRunContext): Host;
  /** 手机开终端时在云电脑里建 PTY */
  spawnPty: PtyFactory;
  /** 状态、文件、上传下载、撤销、挑选分叉 */
  handle(m: CloudRequest, ctx: { phoneId: string; reply: (body: MsgBody) => Promise<void> }): Promise<void>;
  /** 任务开始前（存快照，供整机撤销）；失败不挡任务 */
  beforeRun?(ctx: CloudRunContext): Promise<void>;
  /** 任务结束后：返回这次沙箱运行的费用（美元），并进结算 */
  afterRun?(ctx: CloudRunContext, wallMs: number): number;
  /** 这个账号一次最多分几份（1 = 不能分叉）；不实现按 1 算 */
  variantsAllowed?(): Promise<number>;
  /**
   * 分叉：把机器复制成 count 份，每份按不同思路跑 run(host, approach)，全部结束后把结果推给手机让它挑。
   * 不实现就当作不支持分叉，按普通任务跑。
   */
  runVariants?(
    ctx: CloudRunContext,
    count: number,
    run: (host: Host, approach: string, variantRunId: string) => Promise<{ ok: boolean; summary: string; costUsd: number }>,
  ): Promise<{ costUsd: number }>;
}
