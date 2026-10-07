package io.cuaremote.daemon

import io.cuaremote.protocol.*
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import org.junit.Test
import kotlinx.serialization.json.*
import java.io.File
import java.util.Base64
import java.util.concurrent.Executors
import kotlin.test.*

class PeerCipherTest {
    private val aKeys = HpkeSuite.deriveKeyPair(ByteArray(32) { 1 })
    private val bKeys = HpkeSuite.deriveKeyPair(ByteArray(32) { 2 })
    private fun keys(pair: AsymmetricCipherKeyPair) = PublicKeys(Base64.getEncoder().encodeToString(HpkeSuite.publicBytes(pair)), "sig")
    private fun pair(aNonce: Byte = 3, bNonce: Byte = 4): Pair<PeerCipher, PeerCipher> {
        val a = PeerCipher("a", aKeys) { ByteArray(32) { aNonce } }
        val b = PeerCipher("b", bKeys) { ByteArray(32) { bNonce } }
        a.putPeer("b", keys(bKeys)); b.putPeer("a", keys(aKeys))
        assertNull(a.open(b.begin("a"))); assertNull(b.open(a.begin("b")))
        return a to b
    }

    @Test fun `v2 handshake is plaintext 65 bytes and both directions interoperate`() {
        val (a, b) = pair()
        val handshake = a.begin("b")
        assertFalse(handshake.encrypted); assertEquals(65, handshake.body.size); assertEquals(2, handshake.body[0].toInt())
        val one = Frame(FrameKind.PTY, 7, "one".toByteArray())
        val two = Frame(FrameKind.MEDIA, 8, "two".toByteArray())
        assertContentEquals(one.encode(), b.open(a.seal("b", one))!!.encode())
        assertContentEquals(two.encode(), a.open(b.seal("a", two))!!.encode())
    }

    @Test fun `tamper old formats duplicate handshake and cross connection replay are rejected`() {
        val (a, b) = pair()
        assertFails { b.open(RelayEnvelope("b", "a", false, ByteArray(32))) }
        assertFails { b.open(a.begin("b")) }
        val cipher = a.seal("b", Frame.control(ToolsList(id = "x")))
        val damaged = cipher.copy(body = cipher.body.copyOf().also { it[it.lastIndex] = (it.last() xor 1) })
        assertFails { b.open(damaged) }

        b.drop("a"); a.drop("b")
        assertNull(a.open(b.begin("a"))); assertNull(b.open(a.begin("b")))
        assertFails { b.open(cipher) }
    }

    @Test fun `replaying the complete old handshake and ciphertext after restart fails nonce binding`() {
        val (a, _) = pair()
        val oldHandshake = a.begin("b")
        val oldCiphertext = a.seal("b", Frame.control(ToolsList(id = "old")))
        val restarted = PeerCipher("b", bKeys) { ByteArray(32) { 99 } }
        restarted.putPeer("a", keys(aKeys))
        assertNull(restarted.open(oldHandshake))
        val error = assertFails { restarted.open(oldCiphertext) }
        assertEquals("ciphertext belongs to another connection", error.message)
        val fresh = PeerCipher("b", bKeys)
        fresh.putPeer("a", keys(aKeys))
        assertFails { fresh.open(oldHandshake.copy(body = oldHandshake.body.copyOfRange(1, 33))) }
    }

    @Test fun `seal waits for peer handshake then queued calls preserve order and drop cancels wait`() {
        val a = PeerCipher("a", aKeys) { ByteArray(32) { 9 } }
        val b = PeerCipher("b", bKeys) { ByteArray(32) { 8 } }
        a.putPeer("b", keys(bKeys)); b.putPeer("a", keys(aKeys))
        val pool = Executors.newSingleThreadExecutor()
        val first = pool.submit<RelayEnvelope> { a.seal("b", Frame(FrameKind.PTY, 1, byteArrayOf(1))) }
        Thread.sleep(50); assertFalse(first.isDone)
        a.open(b.begin("a")); b.open(a.begin("b"))
        assertEquals(1, b.open(first.get())!!.payload.single())
        val second = a.seal("b", Frame(FrameKind.PTY, 2, byteArrayOf(2)))
        assertEquals(2, b.open(second)!!.payload.single())
        a.drop("b"); val waiting = pool.submit<RelayEnvelope> { a.seal("b", Frame.control(ToolsList(id = "wait"))) }
        Thread.sleep(50); a.drop("b")
        assertFails { waiting.get() }
        pool.shutdownNow()
    }

    @Test fun `opens TypeScript v2 fixture`() {
        val fixture = Json.parseToJsonElement(File("../../../packages/protocol/fixtures/hpke.json").readText()).jsonObject
        val phone = fixture.getValue("phone").jsonObject
        val mac = fixture.getValue("mac").jsonObject
        fun JsonObject.hex(name: String) = getValue(name).jsonPrimitive.content.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val macKeys = HpkeSuite.privateKey(mac.hex("sk"), mac.hex("pk"))
        val cipher = PeerCipher(mac.getValue("id").jsonPrimitive.content, macKeys) { mac.hex("nonce") }
        cipher.putPeer(phone.getValue("id").jsonPrimitive.content, PublicKeys(Base64.getEncoder().encodeToString(phone.hex("pk")), "sig"))
        fun decodeRelayHex(value: String) = RelayEnvelope.decode(value.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        fun relay(name: String) = decodeRelayHex(fixture.getValue(name).jsonPrimitive.content)
        assertNull(cipher.open(relay("phoneHandshake")))
        val expected = fixture.getValue("plaintexts").jsonArray.first().jsonPrimitive.content
        val encrypted = decodeRelayHex(fixture.getValue("phoneToMac").jsonArray.first().jsonPrimitive.content)
        assertEquals(expected, cipher.open(encrypted)?.encode()?.joinToString("") { "%02x".format(it) })
    }

    private infix fun Byte.xor(other: Int) = (toInt() xor other).toByte()
}
