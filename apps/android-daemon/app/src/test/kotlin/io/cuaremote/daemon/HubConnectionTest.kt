package io.cuaremote.daemon

import io.cuaremote.protocol.*
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.*
import org.junit.Test

class HubConnectionTest {
    @Test fun `auth intent forwarding and tool call run through encrypted websocket`() {
        val daemonKeys = HpkeSuite.deriveKeyPair(ByteArray(32) { it.toByte() })
        val phoneKeys = HpkeSuite.deriveKeyPair(ByteArray(32) { (it + 32).toByte() })
        val brainKeys = HpkeSuite.deriveKeyPair(ByteArray(32) { (it + 64).toByte() })
        val daemonPublic = publicKeys(daemonKeys); val phonePublic = publicKeys(phoneKeys); val brainPublic = publicKeys(brainKeys)
        val done = CountDownLatch(1); var failure: Throwable? = null
        val server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            private lateinit var peer: WebSocket
            private val phoneSender = HpkeSuite.sender("phone", "daemon", daemonKeys.public, phoneKeys)
            private val brainSender = HpkeSuite.sender("brain", "daemon", daemonKeys.public, brainKeys)
            private var brainRecipient: HpkeSuite.Recipient? = null
            override fun onOpen(webSocket: WebSocket, response: Response) { peer = webSocket }
            override fun onMessage(webSocket: WebSocket, text: String) = runCatching {
                when (val message = ProtocolJson.decode(text)) {
                    is Hello -> { assertEquals("daemon", message.deviceId); peer.send(ProtocolJson.encode(AuthChallenge(id = "c", nonce = "nonce"))) }
                    is AuthResponse -> {
                        assertEquals("nonce", message.nonce)
                        peer.send(ProtocolJson.encode(AuthOk(id = "ok", sessionToken = "session", expiresAt = Long.MAX_VALUE)))
                        peer.send(ProtocolJson.encode(PeerKeys(id = "pk1", deviceId = "phone", pubKeys = phonePublic)))
                        peer.send(ProtocolJson.encode(PeerKeys(id = "pk2", deviceId = "brain", pubKeys = brainPublic)))
                        sendEncrypted(phoneSender, "phone", Frame.control(IntentSubmit(id = "intent", text = "打开设置", deviceId = "daemon")), sendEnc = true)
                    }
                    else -> Unit
                }
            }.onFailure { failure = it; done.countDown() }.let { Unit }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = runCatching {
                val envelope = RelayEnvelope.decode(bytes.toByteArray()); assertEquals("brain", envelope.to)
                if (brainRecipient == null) {
                    assertEquals(32, envelope.body.size)
                    brainRecipient = HpkeSuite.recipient("daemon", "brain", envelope.body, brainKeys, daemonKeys.public)
                } else {
                    val frame = Frame.decode(brainRecipient!!.open(envelope.copy(body = byteArrayOf()).header(), envelope.body))
                    when (val message = ProtocolJson.decode(frame.payload.toString(Charsets.UTF_8))) {
                        is IntentSubmit -> { assertEquals("打开设置", message.text); sendEncrypted(brainSender, "brain", Frame.control(ToolsCall(id = "tool", callId = "call", tool = "android.apps", args = buildJsonObject { })), sendEnc = true) }
                        is ToolsResult -> { assertEquals("call", message.callId); assertTrue(message.ok); peer.close(1000, "done"); done.countDown() }
                        else -> Unit
                    }
                }
            }.onFailure { failure = it; done.countDown() }.let { Unit }
            private fun sendEncrypted(sender: HpkeSuite.Sender, from: String, frame: Frame, sendEnc: Boolean) {
                if (sendEnc) peer.send(ByteString.of(*RelayEnvelope("daemon", from, true, sender.encapsulation).encode()))
                val shell = RelayEnvelope("daemon", from, true, byteArrayOf()); peer.send(ByteString.of(*shell.copy(body = sender.seal(shell.header(), frame.encode())).encode()))
            }
        }))
        server.start()
        val identity = object : HubIdentity { override val publicKeys = daemonPublic; override val kemKeys = daemonKeys; override fun sign(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes) }
        val connection = HubConnection(server.url("/ws").toString(), "daemon", "Test", identity, { call -> ToolsResult(id = "result", callId = call.callId, ok = true, output = "[]", ms = 1.0) }, brainId = "brain")
        connection.connect()
        assertTrue(done.await(8, TimeUnit.SECONDS), "websocket scenario timed out")
        connection.close(); Thread.sleep(200); server.shutdown(); failure?.let { throw it }
    }
    private fun publicKeys(pair: AsymmetricCipherKeyPair) = PublicKeys(Base64.getEncoder().encodeToString(HpkeSuite.publicBytes(pair)), Base64.getEncoder().encodeToString(byteArrayOf(1)))
}
