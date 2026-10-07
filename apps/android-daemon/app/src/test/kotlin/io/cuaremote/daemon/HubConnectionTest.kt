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
            private val phoneCipher = PeerCipher("phone", phoneKeys) { ByteArray(32) { 11 } }.also { it.putPeer("daemon", daemonPublic) }
            private val brainCipher = PeerCipher("brain", brainKeys) { ByteArray(32) { 12 } }.also { it.putPeer("daemon", daemonPublic) }
            override fun onOpen(webSocket: WebSocket, response: Response) { peer = webSocket }
            override fun onMessage(webSocket: WebSocket, text: String) = runCatching {
                when (val message = ProtocolJson.decode(text)) {
                    is Hello -> { assertEquals("daemon", message.deviceId); peer.send(ProtocolJson.encode(AuthChallenge(id = "c", nonce = "nonce"))) }
                    is AuthResponse -> {
                        assertEquals("nonce", message.nonce)
                        peer.send(ProtocolJson.encode(AuthOk(id = "ok", sessionToken = "session", expiresAt = Long.MAX_VALUE)))
                        peer.send(ProtocolJson.encode(PeerKeys(id = "pk1", deviceId = "phone", pubKeys = phonePublic)))
                        peer.send(ProtocolJson.encode(PeerKeys(id = "pk2", deviceId = "brain", pubKeys = brainPublic)))
                        peer.send(ByteString.of(*phoneCipher.begin("daemon").encode()))
                    }
                    else -> Unit
                }
            }.onFailure { failure = it; done.countDown() }.let { Unit }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = runCatching {
                val envelope = RelayEnvelope.decode(bytes.toByteArray())
                when (envelope.to) {
                    "phone" -> {
                        val frame = phoneCipher.open(envelope)
                        if (frame == null) peer.send(ByteString.of(*phoneCipher.seal("daemon", Frame.control(IntentSubmit(id = "intent", text = "打开设置", deviceId = "daemon"))).encode()))
                    }
                    "brain" -> {
                        val frame = brainCipher.open(envelope)
                        if (frame == null) {
                            peer.send(ByteString.of(*brainCipher.begin("daemon").encode()))
                            return@runCatching
                        }
                    when (val message = ProtocolJson.decode(frame.payload.toString(Charsets.UTF_8))) {
                        is IntentSubmit -> { assertEquals("打开设置", message.text); peer.send(ByteString.of(*brainCipher.seal("daemon", Frame.control(ToolsCall(id = "tool", callId = "call", tool = "android.apps", args = buildJsonObject { }))).encode())) }
                        is ToolsResult -> { assertEquals("call", message.callId); assertTrue(message.ok); peer.close(1000, "done"); done.countDown() }
                        else -> Unit
                    }
                    }
                    else -> error("unexpected relay destination ${envelope.to}")
                }
            }.onFailure { failure = it; done.countDown() }.let { Unit }
        }))
        server.start()
        val identity = object : HubIdentity { override val publicKeys = daemonPublic; override val kemKeys = daemonKeys; override fun sign(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes) }
        val connection = HubConnection(server.url("/ws").toString(), "daemon", "Test", identity, { call -> ToolsResult(id = "result", callId = call.callId, ok = true, output = "[]", ms = 1.0) }, brainId = "brain")
        connection.connect()
        assertTrue(done.await(8, TimeUnit.SECONDS), "websocket scenario timed out")
        connection.close(); Thread.sleep(200); server.shutdown(); failure?.let { throw it }
    }

    @Test fun `peer offline discards queued commands instead of sending them after reconnect`() {
        val daemonKeys = HpkeSuite.generateKeyPair()
        val phoneKeys = HpkeSuite.generateKeyPair()
        val brainKeys = HpkeSuite.generateKeyPair()
        val phoneCipher = PeerCipher("phone", phoneKeys).also { it.putPeer("daemon", publicKeys(daemonKeys)) }
        val brainCipher = PeerCipher("brain", brainKeys).also { it.putPeer("daemon", publicKeys(daemonKeys)) }
        val done = CountDownLatch(1)
        var failure: Throwable? = null
        val received = mutableListOf<String>()
        val server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            var brainHandshakes = 0
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (ProtocolJson.decode(text) is Hello) {
                    webSocket.send(ProtocolJson.encode(PeerKeys(id = "p", deviceId = "phone", pubKeys = publicKeys(phoneKeys))))
                    webSocket.send(ProtocolJson.encode(PeerKeys(id = "b", deviceId = "brain", pubKeys = publicKeys(brainKeys))))
                    webSocket.send(ByteString.of(*phoneCipher.begin("daemon").encode()))
                }
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                try {
                    val envelope = RelayEnvelope.decode(bytes.toByteArray())
                    if (envelope.to == "phone") {
                        phoneCipher.open(envelope)
                        sendIntent(webSocket, "old-first")
                        sendIntent(webSocket, "old-queued")
                    } else if (!envelope.encrypted && ++brainHandshakes == 1) {
                        // 不回复首次握手，让首条发送停在等待处，第二条留在队列。
                        webSocket.send(ProtocolJson.encode(Presence(id = "off", deviceId = "brain", online = false, lastSeen = 1)))
                        webSocket.send(ProtocolJson.encode(Presence(id = "on", deviceId = "brain", online = true, lastSeen = 2)))
                        sendIntent(webSocket, "new-after-reconnect")
                    } else {
                        val frame = brainCipher.open(envelope)
                        if (frame == null) webSocket.send(ByteString.of(*brainCipher.begin("daemon").encode()))
                        else {
                            val intent = ProtocolJson.decode(frame.payload.toString(Charsets.UTF_8)) as IntentSubmit
                            received.add(intent.id)
                            if (intent.id == "new-after-reconnect") done.countDown()
                        }
                    }
                } catch (error: Throwable) { failure = error; done.countDown() }
            }
            private fun sendIntent(socket: WebSocket, id: String) {
                socket.send(ByteString.of(*phoneCipher.seal("daemon", Frame.control(IntentSubmit(id = id, text = id, deviceId = "daemon"))).encode()))
            }
        }))
        server.start()
        val identity = object : HubIdentity {
            override val publicKeys = publicKeys(daemonKeys)
            override val kemKeys = daemonKeys
            override fun sign(bytes: ByteArray) = "unused"
        }
        val connection = HubConnection(server.url("/ws").toString(), "daemon", "Test", identity, { error("no tool execution expected") }, brainId = "brain")
        try {
            connection.connect()
            assertTrue(done.await(8, TimeUnit.SECONDS), "reconnect scenario timed out")
            failure?.let { throw it }
            assertEquals(listOf("new-after-reconnect"), received)
        } finally { connection.close(); server.shutdown() }
    }

    private fun publicKeys(pair: AsymmetricCipherKeyPair) = PublicKeys(Base64.getEncoder().encodeToString(HpkeSuite.publicBytes(pair)), Base64.getEncoder().encodeToString(byteArrayOf(1)))
}
