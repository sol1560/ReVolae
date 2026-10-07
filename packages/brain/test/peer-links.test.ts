import { expect, test } from "bun:test";
import { b64, controlFrame, decodeFrame, decodeRelay, generateKemKeyPair, parseControl } from "@cuaremote/protocol";
import { PeerLinks } from "../src/cloud/peer-links.js";

test("并发首次发送只有一次握手；活跃链路重复握手不回包；离线后旧密文被拒绝", async () => {
  const ak = await generateKemKeyPair(), bk = await generateKemKeyPair();
  const atA: unknown[] = [], atB: unknown[] = [];
  const sentA: Uint8Array[] = [], sentB: Uint8Array[] = [];
  const keys = (kem: Uint8Array) => ({ kem: b64.to(kem), sig: "unused", sigAlg: "ES256" as const });
  let a: PeerLinks, b: PeerLinks;
  a = new PeerLinks("a", ak, () => keys(bk.publicKey), async (bytes) => {
    sentA.push(bytes);
    const got = await b.receive(bytes);
    if (got) atB.push(parseControl(decodeFrame(got.frame)));
  });
  b = new PeerLinks("b", bk, () => keys(ak.publicKey), async (bytes) => {
    sentB.push(bytes);
    const got = await a.receive(bytes);
    if (got) atA.push(parseControl(decodeFrame(got.frame)));
  });
  await Promise.all([a.send("b", controlFrame({ n: 1 })), a.send("b", controlFrame({ n: 2 }))]);
  expect(atB).toEqual([{ n: 1 }, { n: 2 }]);
  expect(sentA.filter((packet) => !decodeRelay(packet).encrypted)).toHaveLength(1);
  expect(sentB.filter((packet) => !decodeRelay(packet).encrypted)).toHaveLength(1);
  const count = sentB.length;
  await expect(b.receive(sentA[0]!)).rejects.toThrow("重复握手");
  expect(sentB).toHaveLength(count);
  a.drop("b"); b.drop("a");
  await a.send("b", controlFrame({ n: 3 }));
  expect(atB).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  a.drop("b"); b.drop("a");
  const restarted = new PeerLinks("b", bk, () => keys(ak.publicKey), () => {});
  await restarted.receive(sentA[0]!);
  await expect(restarted.receive(sentA[1]!)).rejects.toThrow("随机值");
  restarted.drop("a");
});
