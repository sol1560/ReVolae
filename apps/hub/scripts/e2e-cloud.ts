/**
 * 真实端到端：真 E2B + 真模型，手机端用测试里的假手机。
 *   bun run apps/hub/scripts/e2e-cloud.ts [--model zenmux:anthropic/claude-sonnet-5] [--skip-variants]
 * 走两个任务：上传 PDF → 转 Word → 下载校验；做网页试 3 种 → 预览 + 截图 → 挑一份。最后删掉云电脑。
 * 截图存到 /tmp/cuaremote-e2e-*.png。
 */
import { CLOUD_TEMPLATE, CloudComputers, E2bProvider, e2bApiKey } from "@cuaremote/cloud-computer";
import { brainIdOf } from "../src/cloud-brain.js";
import { CloudComputerService, cloudDeviceIdOf } from "../src/cloud-computer.js";
import { HubStore } from "../src/db.js";
import { createHubServer } from "../src/server.js";
import { Endpoint } from "../test/helpers.js";
import { PhoneLink } from "../test/phone-link.js";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1] && args.includes("--model") ? args[args.indexOf("--model") + 1]! : "zenmux:anthropic/claude-sonnet-5";
const apiKey = e2bApiKey();
if (!apiKey) throw new Error("缺少 E2B key");

const store = new HubStore(":memory:");
const computers = new CloudComputers({ provider: new E2bProvider(apiKey), store, template: CLOUD_TEMPLATE, log: (r) => console.log("  [cc]", JSON.stringify(r)) });
const cloud = new CloudComputerService({ computers, variantsAllowed: async () => 3 });
const srv = createHubServer({ port: 0, store, cloudBrain: { defaultProvider: model, cloud, log: (r) => (/fail|error|clamp/.test(String(r.t)) ? console.log("  [brain]", JSON.stringify(r).slice(0, 400)) : undefined) } });
const deviceId = cloudDeviceIdOf("local");
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};

const phone = await Endpoint.make("phone-e2e", "phone", "Ed25519");
await phone.login(srv.url, { platform: "ios" });
const link = await new PhoneLink(phone, brainIdOf("local")).open();
// 把步骤打出来，方便看模型在干什么
const trace = setInterval(() => {
  for (const m of link.inbox.splice(0)) {
    if (m.type === "step.started") console.log(`   · ${m.runId.slice(-6)} ${m.title}`);
    else if (m.type === "step.finished") console.log(`     ${m.ok ? "ok" : "失败"} ${(m.output ?? m.error ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
    else if (m.type === "cloud.preview" || m.type === "cloud.download") pending.push(m);
    else if (m.type === "error") console.log(`   ! 错误 ${m.code}: ${m.message}`);
    else if (m.type === "run.finished" || m.type === "cloud.variants" || m.type === "run.created") pending.push(m);
  }
}, 200);
const pending: typeof link.inbox = [];
async function waitFor<T extends (typeof link.inbox)[number]["type"]>(type: T, pred: (m: Extract<(typeof link.inbox)[number], { type: T }>) => boolean = () => true, ms = 8 * 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const i = pending.findIndex((m) => m.type === type && pred(m as Extract<(typeof link.inbox)[number], { type: T }>));
    if (i >= 0) return pending.splice(i, 1)[0] as Extract<(typeof link.inbox)[number], { type: T }>;
    if (Date.now() > end) throw new Error(`等 ${type} 超时；待处理 ${pending.map((m) => m.type).join(",")}`);
    await Bun.sleep(200);
  }
}

try {
  // ── 1. 上传 PDF → 转 Word → 下载 ──
  const t0 = Date.now();
  await link.send({ type: "cloud.wake" });
  await link.expect("cloud.status", undefined, 60_000);
  check("唤醒/创建云电脑", true, `${Date.now() - t0}ms`);

  const pdf = Bun.spawnSync(["magick", "-size", "1240x1754", "xc:white", "-font", "DejaVu-Sans", "-pointsize", "48", "-annotate", "+120+200", "Quarterly Report", "-pointsize", "28", "-annotate", "+120+300", "Revenue grew 42% year over year.\nNext step: ship the cloud computer.", "pdf:-"]).stdout;
  await link.send({ type: "cloud.upload.begin", name: "report.pdf", size: pdf.length });
  const up = await link.expect("cloud.upload.url");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "report.pdf");
  const upRes = await fetch(up.url, { method: "POST", body: form });
  check("直传上传", upRes.ok, `${upRes.status} → ${up.path}`);

  await link.send({ type: "intent.submit", text: `把 ${up.path} 转成 Word（.docx），做好后给我下载。`, deviceId, mode: "agent" });
  const run1 = await waitFor("run.created", (m) => !m.parentRunId);
  const dl = await waitFor("cloud.download", (m) => m.runId === run1.runId);
  const fin1 = await waitFor("run.finished", (m) => m.runId === run1.runId);
  const docx = new Uint8Array(await (await fetch(dl.url)).arrayBuffer());
  check("PDF 转 Word 并下载", fin1.ok && dl.name.endsWith(".docx") && docx[0] === 0x50 && docx[1] === 0x4b, `${dl.name} ${docx.length}B，${fin1.stepCount} 步，$${fin1.cost.usd.toFixed(4)}，${Math.round((Date.now() - t0) / 1000)}s；${fin1.summary.slice(0, 80)}`);

  // ── 2. 网页试 3 种 → 挑 ──
  if (!args.includes("--skip-variants")) {
    const t1 = Date.now();
    await link.send({ type: "intent.submit", text: "在 /home/user/work/site 做一个单页个人主页：主人叫 Sol，是做 AI 工具的学生开发者，页面要适合手机看。用纯 HTML/CSS，在 8080 端口起服务并给我预览链接。", deviceId, mode: "agent", variants: 3 });
    const parent = await waitFor("run.created", (m) => !m.parentRunId);
    const v = await waitFor("cloud.variants", (m) => m.runId === parent.runId, 12 * 60_000);
    const withShots = v.items.filter((it) => it.screenshot);
    for (const [i, it] of v.items.entries()) {
      if (it.screenshot) await Bun.write(`/tmp/cuaremote-e2e-${i + 1}.png`, Buffer.from(it.screenshot, "base64"));
      console.log(`   [${i + 1}] ${it.ok ? "ok" : "失败"} ${it.approach} | ${it.summary.replace(/\s+/g, " ").slice(0, 100)} | ${it.previewUrl ?? "无预览"}`);
    }
    const previewOk = await Promise.all(v.items.filter((it) => it.previewUrl).map((it) => fetch(it.previewUrl!).then((r) => r.ok).catch(() => false)));
    check("试 3 种", v.items.filter((it) => it.ok).length === 3, `${Math.round((Date.now() - t1) / 1000)}s，截图 ${withShots.length} 张，预览可开 ${previewOk.filter(Boolean).length}/${previewOk.length}`);
    const fin = await waitFor("run.finished", (m) => m.runId === parent.runId);
    console.log(`   合计 $${fin.cost.usd.toFixed(4)}`);
    const choice = v.items.find((it) => it.ok) ?? v.items[0]!;
    await link.send({ type: "cloud.pick", runId: parent.runId, forkId: choice.forkId });
    await link.expect("cloud.status", undefined, 30_000).catch(() => undefined);
    check("挑中的成为主机器", store.getComputer("local")?.sandboxId === choice.forkId);
  }
} catch (e) {
  failed++;
  console.error("✗ 异常", e);
} finally {
  clearInterval(trace);
  link.stop();
  phone.close();
  await computers.destroy("local").catch(() => {});
  srv.cloudBrain?.stopAll();
  void srv.server.stop(true);
  console.log(failed ? `失败 ${failed} 项` : "全部通过");
  process.exit(failed ? 1 : 0);
}
