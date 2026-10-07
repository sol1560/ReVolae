/**
 * 真实 E2B 冒烟：bun run scripts/smoke.ts
 * 用 cuaremote-cloud 模板建一台机器，走一遍云电脑的关键路径，最后把建出来的机器全部删掉。
 * 检查：模板里的工具齐全 / 暂停恢复 3 次文件还在（E2B issue #884）/ fork 3 份互不影响 / 预览链接公网可开 /
 * Chromium 截图 / PTY 终端 / 快照 + 整机撤销。
 */
import { Sandbox } from "e2b";
import { CLOUD_TEMPLATE, CloudComputers, E2bHost, E2bProvider, E2bPty, MemoryCloudStore, WORK_DIR, e2bApiKey, type SandboxHandle } from "../src/index.js";

const apiKey = e2bApiKey();
if (!apiKey) throw new Error("缺少 E2B_API_KEY / E2B_KEY");

const provider = new E2bProvider(apiKey);
const store = new MemoryCloudStore();
const cc = new CloudComputers({ provider, store, template: CLOUD_TEMPLATE, idleMs: 5 * 60_000 });
const acct = `smoke-${Date.now()}`;
const created = new Set<string>();
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
}
const timed = async <T>(fn: () => Promise<T>) => {
  const t0 = Date.now();
  const v = await fn();
  return [v, Date.now() - t0] as const;
};

try {
  const [main, createMs] = await timed(() => cc.handle(acct));
  created.add(main.id);
  check("建机器", true, `${main.id} ${createMs}ms`);

  const host = new E2bHost({ sandbox: () => cc.handle(acct) });
  const tools = await host.call("shell.run", { cmd: "for t in python3 node bun git ffmpeg pandoc soffice convert pdftotext chromium jq rg; do command -v $t >/dev/null || echo MISSING:$t; done; python3 -c 'import faster_whisper, docx, pdf2docx; print(\"py ok\")'; pwd" });
  check("模板工具齐全", tools.ok && !tools.output?.includes("MISSING") && tools.output!.includes("py ok"), tools.output?.replace(/\n/g, " | "));
  check("默认目录是工作目录", tools.output!.trim().endsWith(WORK_DIR));

  await host.call("fs.write", { path: "keep/a.txt", content: "round-0" });
  for (let i = 1; i <= 3; i++) {
    const [, pauseMs] = await timed(() => Sandbox.pause(main.id, { apiKey }));
    const [h, resumeMs] = await timed(() => provider.connect(main.id, 5 * 60_000));
    const got = new TextDecoder().decode(await h.read(`${WORK_DIR}/keep/a.txt`));
    check(`暂停恢复第 ${i} 次文件还在`, got === `round-${i - 1}`, `pause ${pauseMs}ms resume ${resumeMs}ms`);
    await h.write(`${WORK_DIR}/keep/a.txt`, `round-${i}`);
  }

  // 快照 → 改坏 → 撤销
  const [snapId, snapMs] = await timed(() => cc.snapshot(acct, "run-undo"));
  check("存快照", !!snapId, `${snapId} ${snapMs}ms`);
  await host.call("shell.run", { cmd: "rm -rf keep && echo broken > broken.txt" });
  const [restored, undoMs] = await timed(() => cc.undo(acct, "run-undo"));
  created.add(restored.id);
  const afterUndo = await host.call("shell.run", { cmd: "cat keep/a.txt; ls broken.txt 2>&1 || true" });
  check("整机撤销", afterUndo.output!.startsWith("round-3") && afterUndo.output!.includes("No such file"), `${undoMs}ms → ${restored.id}`);

  // fork ×3
  const [forks, forkMs] = await timed(() => cc.fork(acct, 3));
  const ok = forks.filter((f): f is SandboxHandle => !(f instanceof Error));
  ok.forEach((f) => created.add(f.id));
  check("fork 3 份", ok.length === 3, `${forkMs}ms ${forks.filter((f) => f instanceof Error).map(String).join(";")}`);
  await Promise.all(ok.map((f, i) => f.write(`${WORK_DIR}/keep/a.txt`, `variant-${i}`)));
  const seen = await Promise.all(ok.map(async (f) => new TextDecoder().decode(await f.read(`${WORK_DIR}/keep/a.txt`))));
  const mainNow = new TextDecoder().decode(await (await cc.handle(acct)).read(`${WORK_DIR}/keep/a.txt`));
  check("分叉互不影响", seen.join(",") === "variant-0,variant-1,variant-2" && mainNow === "round-3", `${seen.join(",")} / 主机器 ${mainNow}`);
  if (ok.length) {
    cc.adopt(acct, ok[1]!, ok.filter((_, i) => i !== 1));
    const adopted = new TextDecoder().decode(await (await cc.handle(acct)).read(`${WORK_DIR}/keep/a.txt`));
    check("选中分叉成为主机器", adopted === "variant-1");
  }

  // 预览 + 截图
  const previews: string[] = [];
  const h2 = new E2bHost({ sandbox: () => cc.handle(acct), onPreview: (e) => previews.push(e.url) });
  await h2.call("fs.write", { path: "site/index.html", content: "<!doctype html><meta charset=utf-8><h1 style='font:48px sans-serif'>云电脑 ☁️ hello</h1>" });
  await h2.call("shell.run", { cmd: "python3 -m http.server 8080", cwd: "site", background: true });
  const pv = await h2.call("cloud.preview", { port: 8080 });
  const res = previews[0] ? await fetch(previews[0]).then(async (r) => `${r.status} ${(await r.text()).includes("hello")}`).catch((e) => String(e)) : "no url";
  check("预览链接公网可开", pv.ok && res === "200 true", `${previews[0]} → ${res}`);
  const [shot, shotMs] = await timed(() => h2.call("browser.screenshot", { url: "http://localhost:8080" }));
  const png = shot.attachments[0]?.inline ? Buffer.from(shot.attachments[0].inline, "base64") : undefined;
  check("Chromium 截图", !!png && png.subarray(1, 4).toString() === "PNG", `${shot.output ?? shot.error} ${shotMs}ms`);
  if (png) await Bun.write("/tmp/cuaremote-smoke-shot.png", png);

  // 下载链接
  const dls: string[] = [];
  const h3 = new E2bHost({ sandbox: () => cc.handle(acct), onDownload: (e) => dls.push(e.url) });
  await h3.call("shell.run", { cmd: "printf '# hi\\n\\n中文段落' > doc.md && pandoc doc.md -o doc.docx" });
  const dl = await h3.call("cloud.download", { path: "doc.docx" });
  const dlRes = dls[0] ? await fetch(dls[0]).then(async (r) => `${r.status} ${(await r.arrayBuffer()).byteLength}B`) : "no url";
  check("下载链接", dl.ok && dlRes.startsWith("200"), dlRes);

  // PTY
  const pty = new E2bPty(() => cc.handle(acct), { cols: 80, rows: 24 });
  let out = "";
  pty.onData((c) => (out += new TextDecoder().decode(c)));
  await pty.ready;
  pty.write("echo cuaremote-$((6*7)); tput cols\n");
  pty.resize(120, 40);
  pty.write("tput cols\n");
  const deadline = Date.now() + 10_000;
  while (!(out.includes("cuaremote-42") && out.includes("120")) && Date.now() < deadline) await Bun.sleep(100);
  check("PTY 终端", out.includes("cuaremote-42") && out.includes("120"), JSON.stringify(out.slice(-120)));
  pty.close();
} catch (e) {
  failed++;
  console.error("✗ 异常", e);
} finally {
  const row = store.getComputer(acct);
  if (row) created.add(row.sandboxId);
  await Promise.all([...created].map((id) => Sandbox.kill(id, { apiKey }).catch(() => false)));
  console.log(`清理 ${created.size} 台机器`);
  console.log(failed ? `失败 ${failed} 项` : "全部通过");
  process.exit(failed ? 1 : 0);
}
