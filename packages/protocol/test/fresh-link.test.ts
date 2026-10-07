import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeRelay, encodeRelay, FreshLink, freshLinkInfo, generateKemKeyPair, E2ELink, hex, OpenContext, verifySignedPayload } from "../src/index.js";

async function pair() {
  const aKey = await generateKemKeyPair();
  const bKey = await generateKemKeyPair();
  const aOptions = { selfId: "phone", self: aKey, peerId: "mac", peerPublicKey: bKey.publicKey };
  const bOptions = { selfId: "mac", self: bKey, peerId: "phone", peerPublicKey: aKey.publicKey };
  return { a: new FreshLink(aOptions), b: new FreshLink(bOptions), aOptions, bOptions };
}

async function connect(a: FreshLink, b: FreshLink) {
  const aHello = a.hello();
  const bHello = b.hello();
  const aKey = (await a.receive(bHello)).reply!;
  const bKey = (await b.receive(aHello)).reply!;
  await a.receive(bKey);
  await b.receive(aKey);
  return { aHello, aKey, bHello, bKey };
}

test("fresh link exchanges ordered authenticated frames in both directions", async () => {
  const { a, b } = await pair();
  await connect(a, b);
  expect(a.ready && b.ready).toBe(true);
  const frames = await Promise.all([1, 2, 3].map(n => a.seal(new Uint8Array([n]))));
  for (let n = 0; n < frames.length; n++) expect((await b.receive(frames[n]!)).frame).toEqual(new Uint8Array([n + 1]));
  expect((await a.receive(await b.seal(new Uint8Array([7])))).frame).toEqual(new Uint8Array([7]));
});

test("new receiver rejects an entire recorded handshake and ciphertext stream", async () => {
  const { a, b, bOptions } = await pair();
  const old = await connect(a, b);
  const ciphertext = await a.seal(new Uint8Array([42]));
  const restarted = new FreshLink(bOptions);
  restarted.hello();
  await restarted.receive(old.aHello);
  await expect(restarted.receive(old.aKey)).rejects.toThrow("stale");
  await expect(restarted.receive(ciphertext)).rejects.toThrow("failed");
  expect(restarted.ready).toBe(false);
});

test("replayed frames fail closed and cannot reset a live session", async () => {
  const { a, b } = await pair();
  const established = await connect(a, b);
  const ciphertext = await a.seal(new Uint8Array([42]));
  await b.receive(ciphertext);
  await expect(b.receive(ciphertext)).rejects.toThrow();
  await expect(b.receive(established.aHello)).rejects.toThrow("failed");
});

test("legacy handshake cannot downgrade fresh links", async () => {
  const { b, aOptions } = await pair();
  const legacy = await E2ELink.create(aOptions);
  await expect(b.receive(legacy.handshake())).rejects.toThrow();
  expect(b.ready).toBe(false);
});

test("relay routes are strict UTF-8, bounded, and reject unsupported flag bits", () => {
  expect(() => encodeRelay({ to: "", from: "phone", encrypted: false, body: new Uint8Array() })).toThrow("invalid device id");
  expect(() => encodeRelay({ to: "a".repeat(256), from: "phone", encrypted: false, body: new Uint8Array() })).toThrow("too long");
  expect(() => freshLinkInfo("a".repeat(256), "phone", "0".repeat(64), "1".repeat(64))).toThrow("invalid link identity");
  expect(() => decodeRelay(new Uint8Array([1, 1, 0xff, 1, 66, 0]))).toThrow();
  expect(() => decodeRelay(new Uint8Array([1, 1, 65, 1, 66, 0x80]))).toThrow("flags");
  expect(() => decodeRelay(new Uint8Array([1, 1, 0xef, 1, 66, 0]))).toThrow();
});

test("any FreshLink protocol error poisons the transport generation", async () => {
  const { b } = await pair();
  b.hello();
  const unsupportedFlags = new Uint8Array([1, 3, 109, 97, 99, 5, 112, 104, 111, 110, 101, 0x80]);
  await expect(b.receive(unsupportedFlags)).rejects.toThrow("flags");
  await expect(b.receive(unsupportedFlags)).rejects.toThrow("failed");
  expect(b.ready).toBe(false);
});

test("repeated local hello poisons the generation", async () => {
  const { a } = await pair();
  a.hello();
  expect(() => a.hello()).toThrow("already sent");
  await expect(a.seal(new Uint8Array([1]))).rejects.toThrow("failed");
});

test("FreshLink poisons a generation on a routing mismatch", async () => {
  const { a } = await pair();
  a.hello();
  const wrongRoute = encodeRelay({
    to: "phone",
    from: "other-peer",
    encrypted: false,
    body: new TextEncoder().encode(JSON.stringify({ v: 2, type: "hello", nonce: "11".repeat(32) })),
  });
  await expect(a.receive(wrongRoute)).rejects.toThrow("wrong link identity");
  await expect(a.seal(new Uint8Array([1]))).rejects.toThrow("failed");
});

test("FreshLink rejects extra handshake fields and duplicate key frames", async () => {
  const { a: strictLink } = await pair();
  strictLink.hello();
  const extraHello = encodeRelay({
    to: "phone",
    from: "mac",
    encrypted: false,
    body: new TextEncoder().encode(JSON.stringify({ v: 2, type: "hello", nonce: "11".repeat(32), extra: true })),
  });
  await expect(strictLink.receive(extraHello)).rejects.toThrow();

  const { a, b } = await pair();
  const aHello = a.hello();
  const bHello = b.hello();
  const aKey = (await a.receive(bHello)).reply!;
  const bKey = (await b.receive(aHello)).reply!;
  await a.receive(bKey);
  await expect(a.receive(bKey)).rejects.toThrow();
  expect(a.ready).toBe(false);
});

test("Swift FreshLink ciphertext and ES256 signatures interoperate with TypeScript", async () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const result = spawnSync("swift", ["run", "--package-path", "packages/protocol/swift", "FreshLinkInteropFixture"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `Swift fixture exited ${result.status}`);
  const swift = JSON.parse(result.stdout) as {
    phoneId: string;
    macId: string;
    phonePrivate: string;
    phonePublic: string;
    macPublic: string;
    macEnc: string;
    macNonce: string;
    phoneNonce: string;
    ciphertext: string;
    authPayload: string;
    authPublicKey: string;
    authSignature: string;
  };
  const envelopeBytes = hex.from(swift.ciphertext);
  const envelope = decodeRelay(envelopeBytes);
  const opener = await OpenContext.create({
    self: { publicKey: hex.from(swift.phonePublic), privateKey: hex.from(swift.phonePrivate) },
    peerPublicKey: hex.from(swift.macPublic),
    enc: hex.from(swift.macEnc),
    from: swift.macId,
    to: swift.phoneId,
    info: freshLinkInfo(swift.macId, swift.phoneId, swift.macNonce, swift.phoneNonce),
  });
  const header = envelopeBytes.subarray(0, envelopeBytes.byteLength - envelope.body.byteLength);
  expect(await opener.open(header, envelope.body)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0x42]));
  expect(verifySignedPayload({
    payload: new TextEncoder().encode(swift.authPayload),
    alg: "ES256",
    sig: swift.authSignature,
    publicKey: { sig: swift.authPublicKey, sigAlg: "ES256" },
  })).toEqual({ ok: true });
}, 180_000);
