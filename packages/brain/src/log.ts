import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 操作日志：本地 JSONL，全量记录，不上传 */
export class JsonlLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  write(rec: Record<string, unknown>) {
    appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  }
}
