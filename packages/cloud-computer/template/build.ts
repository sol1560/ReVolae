import { defaultBuildLogger, Template } from "e2b";
import { CLOUD_TEMPLATE } from "../src/constants.js";
import { template } from "./template.js";

// bun run template/build.ts —— 构建（或更新）云电脑模板。需要 E2B_API_KEY 或 E2B_KEY。
const apiKey = process.env.E2B_API_KEY ?? process.env.E2B_KEY;
if (!apiKey) throw new Error("缺少 E2B_API_KEY / E2B_KEY");

const info = await Template.build(template, CLOUD_TEMPLATE, {
  apiKey,
  cpuCount: 2,
  memoryMB: 4096,
  minFreeDiskMb: 4096,
  onBuildLogs: defaultBuildLogger({ minLevel: "info" }),
});
console.log(JSON.stringify(info));
