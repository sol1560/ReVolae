import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "@cuaremote/protocol";
import { nativeHelper } from "../src/host/native-helper.js";

test("原生helper将身份内容送入stdin，不放到进程参数", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-helper-stdin-"));
  const previous = process.env.CUAREMOTE_NATIVE_HELPER;
  try {
    const helper = join(dir, "helper");
    await writeFile(helper, '#!/usr/bin/env bun\nconsole.log(JSON.stringify({args:process.argv.slice(2),input:await Bun.stdin.text()}));\n');
    await chmod(helper, 0o700);
    process.env.CUAREMOTE_NATIVE_HELPER = helper;
    const input = JSON.stringify({ privateKey: '仅测试管道："换行\n不是实际密钥' });
    const output = await nativeHelper(["identity-save", "/private/test state"], z.object({ args: z.array(z.string()), input: z.string() }), 5000, undefined, input);
    expect(output.args).toEqual(["identity-save", "/private/test state"]);
    expect(output.input).toBe(input);
    expect((await nativeHelper(["permissions"], z.object({ input: z.string() }))).input).toBe("");
  } finally {
    if (previous === undefined) delete process.env.CUAREMOTE_NATIVE_HELPER;
    else process.env.CUAREMOTE_NATIVE_HELPER = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("原生helper仅为无输入的只读权限调用保留有界stderr诊断", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-helper-diagnostics-"));
  const previous = process.env.CUAREMOTE_NATIVE_HELPER;
  try {
    const helper = join(dir, "helper");
    await writeFile(helper, `#!/usr/bin/env bun
if (process.argv[2] === "permissions") {
  console.error("TCC permission denied");
  console.log("permission stdout must stay hidden");
  process.exitCode = 7;
} else {
  console.error("private diagnostic");
  console.log("private stdout");
  process.exitCode = 9;
}
`);
    await chmod(helper, 0o700);
    process.env.CUAREMOTE_NATIVE_HELPER = helper;

    const permissionError = await nativeHelper(["permissions"], z.object({ ok: z.boolean() }))
      .then(() => "", (error: Error) => error.message);
    const identityError = await nativeHelper(["identity-load", "/private/state"], z.object({ ok: z.boolean() }))
      .then(() => "", (error: Error) => error.message);
    const inputError = await nativeHelper(["inventory", "com.example.app", "window"], z.object({ ok: z.boolean() }), 5000, undefined, "sensitive request")
      .then(() => "", (error: Error) => error.message);

    expect(permissionError).toContain("退出码 7");
    expect(permissionError).toContain("TCC permission denied");
    expect(permissionError).not.toContain("permission stdout");
    expect(identityError).toBe("Mac 原生服务执行失败");
    expect(identityError).not.toContain("private");
    expect(inputError).toBe("Mac 原生服务执行失败");
    expect(inputError).not.toContain("private");
  } finally {
    if (previous === undefined) delete process.env.CUAREMOTE_NATIVE_HELPER;
    else process.env.CUAREMOTE_NATIVE_HELPER = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
