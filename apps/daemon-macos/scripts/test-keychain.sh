#!/bin/bash
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
export REPO_ROOT="$ROOT"
export CUAREMOTE_NATIVE_HELPER="$ROOT/apps/daemon-macos/.build/debug/cuaremote-native-helper"
bun -e '
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
const modulePath=join(process.env.REPO_ROOT,"packages/brain/src/device-identity.ts");
const {loadDeviceIdentity}=await import(modulePath);
const dir=await realpath(await mkdtemp(join(tmpdir(),"cuaremote-real-keychain-")));
const check=(ok,reason)=>{if(!ok)throw new Error(reason)};
let stored=false;
try {
  const original=await loadDeviceIdentity(dir,null);
  original.identity.peers["isolated-storage-test"]={kem:original.identity.kem.publicKey,sig:original.identity.sig.publicKey,sigAlg:"ES256"};
  await original.save();
  const first=await loadDeviceIdentity(dir); stored=true;
  check(isDeepStrictEqual(first.identity,original.identity),"migration identity mismatch");
  check(!await Bun.file(join(dir,"identity.json")).exists(),"legacy file remains");
  const child=Bun.spawn([process.execPath,"--eval",`import {loadDeviceIdentity} from ${JSON.stringify(modulePath)}; const {identity}=await loadDeviceIdentity(process.argv[1]); if(identity.deviceId!==process.argv[2] || !identity.peers["isolated-storage-test"])throw new Error("restart mismatch");`,dir,first.identity.deviceId],{stdout:"ignore",stderr:"ignore"});
  check(await child.exited===0,"fresh-process reload failed");
  delete first.identity.peers["isolated-storage-test"];
  await first.save();
  check(isDeepStrictEqual((await loadDeviceIdentity(dir)).identity,first.identity),"peer deletion not saved");
  await writeFile(join(dir,"identity.json"),JSON.stringify(original.identity),{mode:0o600});
  let rejected=false; try { await loadDeviceIdentity(dir); } catch { rejected=true; }
  check(rejected,"conflicting peer list accepted");
  check(await Bun.file(join(dir,"identity.json")).exists(),"conflict legacy file removed");
  await rm(join(dir,"identity.json"));
  check(isDeepStrictEqual((await loadDeviceIdentity(dir)).identity,first.identity),"conflict overwrote keychain");
  console.log("PASS actual Mac Keychain migration, fresh-process identity, peer update, conflict preservation; no identity data printed");
} finally {
  const cleanup=Bun.spawn(["/usr/bin/security","delete-generic-password","-s","io.cuaremote.device.identity","-a",dir],{stdout:"ignore",stderr:"ignore"});
  const status=await cleanup.exited;
  check(status===0 || (!stored && status===44),"isolated Keychain cleanup failed");
  await rm(dir,{recursive:true,force:true});
  console.log("PASS isolated Keychain entry and temporary directory removed");
}
'
