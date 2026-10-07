package io.cuaremote.daemon

import io.cuaremote.protocol.*
import okhttp3.*
import okio.ByteString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class HubConnection(
    private val url: String,
    private val deviceId: String,
    private val deviceName: String,
    private val identity: HubIdentity,
    private val execute: (ToolsCall) -> ToolsResult,
    private val brainId: String? = null,
    private val phoneId: String? = null,
    private val phoneSigningPublicKey: String? = null,
    private val onState: (String) -> Unit = {},
    private val client: OkHttpClient = OkHttpClient(),
) : WebSocketListener() {
    private var socket: WebSocket? = null
    private val cipher = PeerCipher(deviceId, identity.kemKeys)
    private val begun = ConcurrentHashMap.newKeySet<String>()
    private val approvals = ApprovalVerifier()
    private val outbound = Executors.newSingleThreadExecutor()
    private val connectionGeneration = AtomicLong()
    private val peerGenerations = ConcurrentHashMap<String, AtomicLong>()

    fun connect() { socket = client.newWebSocket(Request.Builder().url(url).build(), this) }
    fun close() {
        socket?.close(1000, "用户停止")
        disconnected("连接已关闭")
        outbound.shutdownNow()
    }
    override fun onOpen(webSocket: WebSocket, response: Response) {
        onState("正在认证")
        send(Hello(id = id(), role = "device", deviceId = deviceId, platform = "android", name = deviceName, pubKeys = identity.publicKeys))
    }
    override fun onMessage(webSocket: WebSocket, text: String) {
        if (socket !== webSocket) return
        try {
            when (val message = ProtocolJson.decode(text)) {
                is AuthChallenge -> send(AuthResponse(id = id(), nonce = message.nonce, signature = identity.sign(hubAuthPayload(deviceId, message.nonce).toByteArray())))
                is AuthOk -> onState("已连接")
                is PeerKeys -> cipher.putPeer(message.deviceId, message.pubKeys)
                is Presence -> if (!message.online) {
                    synchronized(this) {
                        peerGenerations.getOrPut(message.deviceId) { AtomicLong() }.incrementAndGet()
                        begun.remove(message.deviceId)
                        cipher.drop(message.deviceId)
                    }
                }
                else -> Unit
            }
        } catch (e: Exception) { onState("消息错误：${e.message}") }
    }
    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (socket !== webSocket) return
        try {
            val envelope = RelayEnvelope.decode(bytes.toByteArray()); val frame = cipher.open(envelope)
            if (frame == null) {
                sendHandshake(envelope.from)
                return
            }
            if (frame.kind != FrameKind.CONTROL) return
            val text = frame.payload.toString(Charsets.UTF_8)
            val type = ProtocolJson.value.parseToJsonElement(text).jsonObject["type"]?.jsonPrimitive?.content ?: error("控制消息没有 type")
            if (type !in setOf("tools.list", "tools.call", "intent.submit", "step.approval_required", "approval.decision")) {
                val destination = if (envelope.from == brainId) phoneId else brainId
                destination?.let { sendPeer(it, frame) } ?: error("未配置转发目标")
                return
            }
            when (val message = ProtocolJson.decode(text)) {
                is ToolsList -> sendPeer(envelope.from, Frame.control(ToolsListResult(id = id(), tools = ToolCatalog.tools)))
                is ToolsCall -> sendPeer(envelope.from, Frame.control(execute(message)))
                is IntentSubmit -> brainId?.let { sendPeer(it, frame) } ?: error("未配置云端大脑")
                is ApprovalRequired -> { approvals.observe(message); phoneId?.let { sendPeer(it, frame) } ?: error("未配置控制端") }
                is ApprovalDecision -> {
                    val key = phoneSigningPublicKey ?: error("没有已配对控制端的签名公钥")
                    check(approvals.verify(message, key)) { "审批签名已过期、重放或不正确" }
                    brainId?.let { sendPeer(it, frame) } ?: error("未配置云端大脑")
                }
                else -> Unit
            }
        } catch (e: Exception) { onState("端到端消息错误：${e.message}") }
    }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (socket === webSocket) disconnected("连接已关闭") }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (socket === webSocket) disconnected("连接失败：${t.message}") }
    private fun send(message: WireMessage) { check(socket?.send(ProtocolJson.encode(message)) == true) { "WebSocket 未连接" } }
    private fun sendPeer(to: String, frame: Frame) {
        val generation = connectionGeneration.get()
        val peerGeneration = peerGenerations.getOrPut(to) { AtomicLong() }.get()
        fun checkConnection() {
            check(generation == connectionGeneration.get() && peerGeneration == peerGenerations[to]?.get()) { "连接已断开" }
        }
        outbound.execute {
            try {
                synchronized(this) {
                    checkConnection()
                    sendHandshake(to)
                }
                val sealed = cipher.seal(to, frame)
                synchronized(this) {
                    checkConnection()
                    check(socket?.send(ByteString.of(*sealed.encode())) == true) { "WebSocket 未连接" }
                }
            } catch (e: Exception) { onState("端到端发送错误：${e.cause?.message ?: e.message}") }
        }
    }
    @Synchronized private fun sendHandshake(to: String) {
        if (begun.add(to)) check(socket?.send(ByteString.of(*cipher.begin(to).encode())) == true) { "WebSocket 未连接" }
    }
    @Synchronized private fun disconnected(message: String) {
        socket = null
        connectionGeneration.incrementAndGet()
        begun.clear()
        cipher.reset()
        onState(message)
    }
    companion object { private fun id() = UUID.randomUUID().toString() }
}
