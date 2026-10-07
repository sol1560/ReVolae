/** 双 runner 的短期连接信息只以密文保存在 Actions artifacts。 */
import { createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [command, directory, input, output] = process.argv.slice(2);
if (!directory) throw new Error("需要目录参数");
await mkdir(directory, { recursive: true, mode: 0o700 });
switch (command) {
  case "keys": {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(join(directory, "private.pem"), pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await writeFile(join(directory, "public.pem"), pair.publicKey.export({ type: "spki", format: "pem" }));
    break;
  }
  case "seal": {
    if (!input || !output) throw new Error("seal <公钥目录> <明文文件> <密文文件>");
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(await readFile(input)), cipher.final()]);
    const encryptedKey = publicEncrypt({ key: await readFile(join(directory, "public.pem")), oaepHash: "sha256" }, key);
    await writeFile(output, JSON.stringify({ key: encryptedKey.toString("base64"), nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }));
    break;
  }
  case "open": {
    if (!input || !output) throw new Error("open <私钥目录> <密文文件> <明文文件>");
    const data = JSON.parse(await readFile(input, "utf8"));
    const key = privateDecrypt({ key: await readFile(join(directory, "private.pem")), oaepHash: "sha256" }, Buffer.from(data.key, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(data.nonce, "base64"));
    cipher.setAuthTag(Buffer.from(data.tag, "base64"));
    const plaintext = Buffer.concat([cipher.update(Buffer.from(data.ciphertext, "base64")), cipher.final()]);
    await writeFile(output, plaintext, { mode: 0o600 });
    break;
  }
  case "wait": {
    if (!input) throw new Error("wait <下载目录> <artifact名称>");
    const run = process.env.GITHUB_RUN_ID;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!run || !repo) throw new Error("wait 仅用于 Actions 当前运行");
    const deadline = Date.now() + 25 * 60_000;
    while (true) {
      const list = Bun.spawn(["gh", "api", `repos/${repo}/actions/runs/${run}/artifacts?per_page=100`], { stdout: "pipe", stderr: "pipe" });
      const [text, error, code] = await Promise.all([new Response(list.stdout).text(), new Response(list.stderr).text(), list.exited]);
      if (code !== 0) throw new Error(`读取 Actions artifacts 失败：${error}`);
      const artifacts = JSON.parse(text).artifacts as { name: string; expired: boolean }[];
      if (artifacts.some((a) => a.name === input && !a.expired)) {
        const download = Bun.spawn(["gh", "run", "download", run, "--repo", repo, "--name", input, "--dir", directory], { stdout: "inherit", stderr: "inherit" });
        if (await download.exited !== 0) throw new Error(`下载 ${input} 失败`);
        break;
      }
      const attempt = process.env.GITHUB_RUN_ATTEMPT;
      const otherEnded = input === `connection-${attempt}` ? `host-stopped-${attempt}` : input === `phone-key-${attempt}` ? `phone-result-${attempt}` : undefined;
      if (otherEnded && artifacts.some((artifact) => artifact.name === otherEnded && !artifact.expired)) {
        throw new Error(`另一 runner 提前结束，未提供 ${input}`);
      }
      if (Date.now() >= deadline) throw new Error(`另一 runner 未及时提供 ${input}`);
      await Bun.sleep(10_000);
    }
    break;
  }
  default:
    throw new Error("命令：keys / seal / open / wait");
}
