/**
 * 清理没人用的云电脑沙箱（中途放弃的分叉、hub 重启前没来得及删的机器）。
 *   bun run packages/cloud-computer/scripts/gc.ts --db .amp/data/hub.db          # 只列出，不删
 *   bun run packages/cloud-computer/scripts/gc.ts --db .amp/data/hub.db --delete # 真删
 * 只碰本项目建的机器：metadata 里有 accountId（CloudComputers 建机器时写的）。
 * hub 库里登记为某个账号当前机器的一律保留。同一个 E2B key 下别的项目的沙箱不会被动。
 */
import { Database } from "bun:sqlite";
import { Sandbox, type SandboxInfo } from "e2b";
import { e2bApiKey } from "../src/e2b.js";

const args = process.argv.slice(2);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1]! : "hub.db";
const really = args.includes("--delete");
const apiKey = e2bApiKey();
if (!apiKey) throw new Error("缺少 E2B_API_KEY / E2B_KEY");

const keep = new Set(new Database(dbPath, { readonly: true }).query<{ sandbox_id: string }, []>("select sandbox_id from cloud_computers").all().map((r) => r.sandbox_id));
const all: SandboxInfo[] = [];
const pager = Sandbox.list({ apiKey });
while (pager.hasNext) all.push(...(await pager.nextItems()));

const ours = all.filter((s) => typeof s.metadata?.accountId === "string");
const drop = ours.filter((s) => !keep.has(s.sandboxId));
console.log(`E2B 上共 ${all.length} 台；本项目 ${ours.length} 台；在用 ${ours.length - drop.length} 台；可清理 ${drop.length} 台；别的项目 ${all.length - ours.length} 台（不动）`);
for (const s of drop) console.log(`  ${s.sandboxId}  ${s.state}  账号 ${s.metadata.accountId}  建于 ${s.startedAt.toISOString()}`);
if (!really) {
  console.log(drop.length ? "只列出，没删。确认后加 --delete。" : "没有要清理的。");
} else {
  const res = await Promise.all(drop.map((s) => Sandbox.kill(s.sandboxId, { apiKey }).catch(() => false)));
  console.log(`已删除 ${res.filter(Boolean).length} / ${drop.length}`);
}
