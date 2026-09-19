package io.cuaremote.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

enum class FrameKind(val code: Byte) { CONTROL(0), PTY(1), MEDIA(2) }

data class Frame(val kind: FrameKind, val streamId: Long, val payload: ByteArray) {
    fun encode(): ByteArray {
        require(streamId in 0..0xffffffffL)
        return ByteBuffer.allocate(5 + payload.size).order(ByteOrder.BIG_ENDIAN).put(kind.code).putInt(streamId.toInt()).put(payload).array()
    }
    companion object {
        fun decode(bytes: ByteArray): Frame {
            require(bytes.size >= 5) { "frame too short" }
            val b = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
            val kind = FrameKind.entries.firstOrNull { it.code == b.get() } ?: error("bad frame kind")
            return Frame(kind, b.int.toLong() and 0xffffffffL, ByteArray(b.remaining()).also(b::get))
        }
        fun control(message: WireMessage, streamId: Long = 0) = Frame(FrameKind.CONTROL, streamId, ProtocolJson.encode(message).toByteArray(StandardCharsets.UTF_8))
    }
}

data class RelayEnvelope(val to: String, val from: String, val encrypted: Boolean, val body: ByteArray) {
    fun header(): ByteArray {
        val t = to.toByteArray(); val f = from.toByteArray()
        require(t.size <= 255 && f.size <= 255) { "device id too long" }
        return ByteBuffer.allocate(4 + t.size + f.size).put(1).put(t.size.toByte()).put(t).put(f.size.toByte()).put(f).put(if (encrypted) 1 else 0).array()
    }
    fun encode() = header() + body
    companion object {
        fun decode(bytes: ByteArray): RelayEnvelope {
            val b = ByteBuffer.wrap(bytes)
            require(b.remaining() >= 4 && b.get().toInt() == 1) { "bad relay" }
            fun string(): String { val n = b.get().toInt() and 255; require(b.remaining() >= n + 1) { "relay too short" }; return ByteArray(n).also(b::get).toString(StandardCharsets.UTF_8) }
            val to = string(); val from = string(); val encrypted = b.get().toInt() and 1 == 1
            return RelayEnvelope(to, from, encrypted, ByteArray(b.remaining()).also(b::get))
        }
    }
}

fun approvalChallenge(runId: String, stepId: String, actionDetail: String, nonce: String, expiresAt: Long): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(actionDetail.toByteArray()).joinToString("") { "%02x".format(it) }
    return listOf("cuaremote-approval-v1", runId, stepId, digest, nonce, expiresAt.toString()).joinToString("\n")
}
fun approvalSignedPayload(challenge: String, allow: Boolean) = "$challenge\n${if (allow) "allow" else "deny"}"

/** hub 登录挑战应答要签的串（和 TS `hubAuthPayload` 一致） */
fun hubAuthPayload(deviceId: String, nonce: String) = listOf("cuaremote-hub-auth-v1", deviceId, nonce).joinToString("\n")
