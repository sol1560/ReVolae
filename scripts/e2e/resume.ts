import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Identity } from "../../packages/brain/src/device-identity.js";

/** 只恢复已停止的隔离联测身份，不创建配对，也不复制上轮任务结果为新证据。 */
export async function restorePairing(previous: string, destination: string) {
  previous = resolve(previous); destination = resolve(destination);
  assert(previous !== destination, "恢复必须使用全新的结果目录");
  assert(!existsSync(join(previous, "host.pid")), "请先正式停止原测试宿主，再恢复既有配对");
  const identityBytes = await readFile(join(previous, "device/identity.json"));
  let raw: unknown;
  try { raw = JSON.parse(identityBytes.toString()); }
  catch { throw new Error("原测试身份格式无效；不会输出身份内容或生成替代身份"); }
  const parsed = Identity.safeParse(raw);
  assert(parsed.success, "原测试身份无效；不会生成替代身份");
  const identity = parsed.data;
  const phones = Object.keys(identity.peers);
  assert(phones.length === 1, "此恢复入口只接受已核对的单手机隔离测试记录");
  const phoneId = phones[0]!;
  const hub = new Database(join(previous, "hub.db"), { readonly: true });
  let history: Database | undefined;
  try {
    history = new Database(join(previous, "device/device.sqlite"), { readonly: true });
    type Device = { role: string; account_id: string; kem: string; sig: string; sig_alg: string };
    const device = hub.query<Device, [string]>("SELECT role,account_id,kem,sig,sig_alg FROM devices WHERE device_id=?").get(identity.deviceId);
    const phone = hub.query<Device, [string]>("SELECT role,account_id,kem,sig,sig_alg FROM devices WHERE device_id=?").get(phoneId);
    assert(device?.role === "device" && phone?.role === "phone", "原中继没有对应的设备和手机身份");
    assert(device.account_id === phone.account_id && !["local", "unclaimed", ""].includes(device.account_id), "原配对必须属于同一个真实测试账号");
    assert(device.kem === identity.kem.publicKey && device.sig === identity.sig.publicKey && device.sig_alg === "ES256", "原设备身份与中继公钥不符");
    const pinned = identity.peers[phoneId]!;
    assert(phone.kem === pinned.kem && phone.sig === pinned.sig && phone.sig_alg === pinned.sigAlg, "原手机固定公钥与中继不符");
    assert(hub.query("SELECT 1 FROM pairings WHERE device_id=? AND phone_id=?").get(identity.deviceId, phoneId), "原中继没有真实持久配对；不会补建");
    const baseline = history.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM runs WHERE phone=?").get(phoneId)!.count;
    await mkdir(join(destination, "device"), { mode: 0o700 });
    await writeFile(join(destination, "device/identity.json"), identityBytes, { mode: 0o600, flag: "wx" });
    // serialize 包含已提交的 WAL 内容；只读打开原库，后续认证/解绑只修改副本。
    await writeFile(join(destination, "hub.db"), hub.serialize(), { mode: 0o600, flag: "wx" });
    await writeFile(join(destination, "device/device.sqlite"), history.serialize(), { mode: 0o600, flag: "wx" });
    return { accountId: device.account_id, deviceId: identity.deviceId, phoneId, historyBaseline: baseline };
  } finally {
    history?.close(); hub.close();
  }
}
