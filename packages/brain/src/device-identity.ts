import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { b64, generateKemKeyPair, generateSigningKeyPair, PublicKeys, z } from "@cuaremote/protocol";
import { nativeHelper } from "./host/native-helper.js";

export const Identity = z.object({
  deviceId: z.string().min(1),
  kem: z.object({ publicKey: z.string(), privateKey: z.string() }),
  sig: z.object({ publicKey: z.string(), privateKey: z.string() }),
  peers: z.record(z.string(), PublicKeys),
});

export type DeviceIdentity = z.infer<typeof Identity>;
export interface IdentityStore {
  load(): Promise<DeviceIdentity | null>;
  save(identity: DeviceIdentity): Promise<void>;
}

function keychainStore(stateDir: string): IdentityStore {
  return {
    async load() {
      try { return (await nativeHelper(["identity-load", stateDir], z.object({ identity: Identity.nullable() }))).identity; }
      catch { throw new Error("无法读取 Mac 设备身份，请检查原生服务和钥匙串状态；不会生成替代身份"); }
    },
    async save(identity) {
      try { await nativeHelper(["identity-save", stateDir], z.object({ saved: z.literal(true) }), 15_000, undefined, JSON.stringify(identity)); }
      catch { throw new Error("无法保存 Mac 设备身份，请检查原生服务和钥匙串状态；原身份文件仍保留"); }
    },
  };
}

/** Mac 必须使用钥匙串；非 Mac 及显式传 null 的隔离测试使用受限文件。 */
export async function loadDeviceIdentity(stateDir: string, secureStore?: IdentityStore | null) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  stateDir = await realpath(stateDir);
  await chmod(stateDir, 0o700);
  const identityPath = join(stateDir, "identity.json");
  const storage = secureStore === undefined ? process.platform === "darwin" ? keychainStore(stateDir) : null : secureStore;
  let legacy: DeviceIdentity | undefined;
  try {
    const data = await readFile(identityPath, "utf8");
    try { legacy = Identity.parse(JSON.parse(data)); }
    catch { throw new Error("设备身份格式无效；保留原文件，不会自动重建"); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const stored = await storage?.load();
  if (stored && legacy && !isDeepStrictEqual(stored, legacy)) throw new Error("钥匙串与旧设备身份不一致；保留两份记录，请先核查");
  let identity = stored ?? legacy;
  if (!identity) {
    const kem = await generateKemKeyPair();
    const sig = generateSigningKeyPair("ES256");
    identity = {
      deviceId: randomUUID(),
      kem: { publicKey: b64.to(kem.publicKey), privateKey: b64.to(kem.privateKey) },
      sig: { publicKey: b64.to(sig.publicKey), privateKey: b64.to(sig.privateKey) },
      peers: {},
    };
  }
  async function save() {
    if (storage) {
      await storage.save(identity!);
      if (!isDeepStrictEqual(await storage.load(), identity)) throw new Error("设备身份读回核对失败；保留原文件");
    } else {
      const temp = `${identityPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
        await rename(temp, identityPath);
      } finally { await rm(temp, { force: true }); }
    }
  }
  if (!stored && (storage || !legacy)) await save();
  // 只有完整身份与已配对手机均核对成功，才能删除旧私钥文件。
  if (storage && legacy) await unlink(identityPath);
  else if (legacy && !storage) await chmod(identityPath, 0o600);
  return { identity, save };
}
