package io.cuaremote.protocol

import kotlinx.serialization.json.*
import java.io.File
import java.util.Base64
import kotlin.test.*

class ProtocolTest {
    @Test fun `frame relay and approval match reference fixture`() {
        val message = IntentSubmit(id = "m1", text = "列出桌面上的 pdf", deviceId = "mac-1")
        val decoded = Frame.decode(Frame.control(message, 42).encode())
        assertEquals(FrameKind.CONTROL, decoded.kind); assertEquals(42, decoded.streamId)
        assertEquals(message, ProtocolJson.decode(decoded.payload.toString(Charsets.UTF_8)))
        val relay = RelayEnvelope("phone-α", "mac-1", true, decoded.encode())
        assertEquals("phone-α", RelayEnvelope.decode(relay.encode()).to)
        assertEquals("cuaremote-approval-v1\nr1\ns1\n58604c173dfae125a489b913a367f6d5eae80c1820066efc27b5c92ad74b67b0\nn0\n1700000000", approvalChallenge("r1", "s1", "rm -rf ~/x", "n0", 1_700_000_000))
        assertEquals("challenge\ndeny", approvalSignedPayload("challenge", false))
        assertEquals("cuaremote-hub-auth-v1\nmac-1\nn0", hubAuthPayload("mac-1", "n0"))
    }

    @Test fun `pairing hmac is stable`() {
        val b64 = Base64.getEncoder()
        val secret = b64.encodeToString(ByteArray(16) { it.toByte() }); val device = b64.encodeToString(ByteArray(32) { (it + 1).toByte() }); val phone = b64.encodeToString(ByteArray(32) { (it + 33).toByte() })
        assertEquals("YuVUGvchMkA0IlkZzNtnXFvfpnCwIBreHPmR54ABolw=", pairingHmac(secret, device, phone))
        val offer = PairOffer("wss://hub.example/ws", "device", "Pixel", PublicKeys(device, "sig"), secret, 2_000_000_100)
        val request = pairRequest(offer, "request", "phone", "控制端", PublicKeys(phone, "phone-sig"))
        assertTrue(verifyPairRequest(offer, request, 2_000_000_000))
        assertFalse(verifyPairRequest(offer, request.copy(hmac = Base64.getEncoder().encodeToString(ByteArray(32))), 2_000_000_000))
        assertFalse(verifyPairRequest(offer, request, 2_000_000_101), "expired offers must fail")
    }

    @Test fun `hpke auth seals multiple frames and exports json vector`() {
        val senderKeys = HpkeSuite.deriveKeyPair(ByteArray(32) { it.toByte() })
        val recipientKeys = HpkeSuite.deriveKeyPair(ByteArray(32) { (it + 32).toByte() })
        val from = "android-phone"; val to = "android-host"
        val sender = HpkeSuite.sender(from, to, recipientKeys.public, senderKeys)
        val recipient = HpkeSuite.recipient(from, to, sender.encapsulation, recipientKeys, senderKeys.public)
        val aad = RelayEnvelope(to, from, true, byteArrayOf()).header(); val plain1 = "first-frame".toByteArray(); val plain2 = "second-frame".toByteArray()
        val cipher1 = sender.seal(aad, plain1); val cipher2 = sender.seal(aad, plain2)
        assertContentEquals(plain1, recipient.open(aad, cipher1)); assertContentEquals(plain2, recipient.open(aad, cipher2))
        val b64 = Base64.getEncoder()
        val vector = buildJsonObject {
            put("suite", "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20-Poly1305"); put("mode", "auth")
            put("from", from); put("to", to); put("info", b64.encodeToString("cuaremote-v1|$from|$to".toByteArray()))
            put("senderPrivate", b64.encodeToString(HpkeSuite.privateBytes(senderKeys))); put("senderPublic", b64.encodeToString(HpkeSuite.publicBytes(senderKeys)))
            put("recipientPrivate", b64.encodeToString(HpkeSuite.privateBytes(recipientKeys))); put("recipientPublic", b64.encodeToString(HpkeSuite.publicBytes(recipientKeys)))
            put("enc", b64.encodeToString(sender.encapsulation)); put("aad", b64.encodeToString(aad)); put("plaintext", b64.encodeToString(plain1)); put("ciphertext", b64.encodeToString(cipher1))
        }
        val output = File("build/test-vectors/hpke-auth.json"); output.parentFile.mkdirs(); output.writeText(Json { prettyPrint = true }.encodeToString(JsonObject.serializer(), vector))
        assertTrue(output.length() > 300)
    }
}
