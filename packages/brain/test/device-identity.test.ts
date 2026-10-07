import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeviceIdentity, type DeviceIdentity, type IdentityStore } from "../src/device-identity.js";

function memoryStore() {
  let value: DeviceIdentity | null = null;
  const store: IdentityStore = {
    load: async () => structuredClone(value),
    save: async (identity) => { value = structuredClone(identity); },
  };
  return store;
}

test("迁移保留身份及已配对手机，读回成功后才删除旧文件，后续保存不再写明文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-identity-"));
  try {
    const original = await loadDeviceIdentity(dir, null);
    original.identity.peers.phone = { kem: original.identity.kem.publicKey, sig: original.identity.sig.publicKey, sigAlg: "ES256" };
    await original.save();
    expect((await stat(join(dir, "identity.json"))).mode & 0o777).toBe(0o600);
    const storage = memoryStore();
    const migrated = await loadDeviceIdentity(dir, storage);
    expect(migrated.identity).toEqual(original.identity);
    expect(await storage.load()).toEqual(original.identity);
    expect(await Bun.file(join(dir, "identity.json")).exists()).toBe(false);
    delete migrated.identity.peers.phone;
    await migrated.save();
    expect((await loadDeviceIdentity(dir, storage)).identity).toEqual(migrated.identity);
    expect(await Bun.file(join(dir, "identity.json")).exists()).toBe(false);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("保存失败、读回错误、存储冲突不删除或替换旧身份", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-identity-fail-"));
  try {
    const original = await loadDeviceIdentity(dir, null);
    const old = await readFile(join(dir, "identity.json"), "utf8");
    const failed: IdentityStore = { load: async () => null, save: async () => { throw new Error("存储已锁定"); } };
    await expect(loadDeviceIdentity(dir, failed)).rejects.toThrow("存储已锁定");
    const dropped: IdentityStore = { load: async () => null, save: async () => {} };
    await expect(loadDeviceIdentity(dir, dropped)).rejects.toThrow("读回核对失败");
    let saves = 0;
    const conflict: IdentityStore = { load: async () => ({ ...original.identity, deviceId: "another-device" }), save: async () => { saves++; } };
    await expect(loadDeviceIdentity(dir, conflict)).rejects.toThrow("不一致");
    expect(saves).toBe(0);
    expect(await readFile(join(dir, "identity.json"), "utf8")).toBe(old);
    // 两边身份ID相同但手机列表不同也不能丢弃旧记录。
    const peerConflict = { ...original.identity, peers: { other: { kem: original.identity.kem.publicKey, sig: original.identity.sig.publicKey, sigAlg: "ES256" as const } } };
    await expect(loadDeviceIdentity(dir, { ...conflict, load: async () => peerConflict })).rejects.toThrow("不一致");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("存储不可读或旧身份损坏不自动重建，错误不回显内容；全新安全存储不落私钥文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-identity-empty-"));
  try {
    const locked: IdentityStore = { load: async () => { throw new Error("存储已锁定"); }, save: async () => { throw new Error("不得调用保存"); } };
    await expect(loadDeviceIdentity(dir, locked)).rejects.toThrow("存储已锁定");
    expect(await Bun.file(join(dir, "identity.json")).exists()).toBe(false);
    const store = memoryStore();
    const generated = await loadDeviceIdentity(dir, store);
    expect(generated.identity.deviceId).toBeTruthy();
    expect((await loadDeviceIdentity(dir, store)).identity).toEqual(generated.identity);
    expect(await Bun.file(join(dir, "identity.json")).exists()).toBe(false);
    const invalid = '{"privateKey":"SHOULD-NOT-APPEAR"';
    await writeFile(join(dir, "identity.json"), invalid, { mode: 0o600 });
    await expect(loadDeviceIdentity(dir, store)).rejects.toThrow("设备身份格式无效");
    expect(await readFile(join(dir, "identity.json"), "utf8")).toBe(invalid);
    expect(await store.load()).toEqual(generated.identity);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
