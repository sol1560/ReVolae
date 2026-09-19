package io.cuaremote.daemon

import io.cuaremote.protocol.ApprovalDecision
import io.cuaremote.protocol.ApprovalRequired
import io.cuaremote.protocol.approvalSignedPayload
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.LinkedHashSet

class ApprovalVerifier {
    private data class Pending(val challenge: String, val expiresAt: Long)
    private val pending = mutableMapOf<Pair<String, String>, Pending>()
    private val usedNonces = object : LinkedHashSet<String>() { override fun add(element: String): Boolean { val added = super.add(element); if (size > 1000) remove(first()); return added } }

    fun observe(request: ApprovalRequired) { pending[request.runId to request.stepId] = Pending(request.challenge, request.expiresAt) }

    fun verify(decision: ApprovalDecision, phonePublicKeyBase64: String, nowSeconds: Long = System.currentTimeMillis() / 1000): Boolean {
        val signature = decision.signature ?: return false
        val request = pending[decision.runId to decision.stepId] ?: return false
        if (signature.expiresAt < nowSeconds || signature.expiresAt > request.expiresAt || usedNonces.contains(signature.nonce)) return false
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(phonePublicKeyBase64)))
        val verifier = Signature.getInstance("SHA256withECDSA").apply { initVerify(key); update(approvalSignedPayload(request.challenge, decision.allow).toByteArray()) }
        if (!verifier.verify(rawToDer(Base64.getDecoder().decode(signature.sig)))) return false
        usedNonces += signature.nonce; pending.remove(decision.runId to decision.stepId)
        return true
    }

    private fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "ES256 signature must be raw r||s" }
        fun integer(part: ByteArray): ByteArray {
            val withoutZeroes = part.dropWhile { it == 0.toByte() }.toByteArray()
            val stripped = if (withoutZeroes.isEmpty()) byteArrayOf(0) else withoutZeroes
            val value = if (stripped[0].toInt() and 0x80 != 0) byteArrayOf(0) + stripped else stripped
            return byteArrayOf(0x02, value.size.toByte()) + value
        }
        val r = integer(raw.copyOfRange(0, 32)); val s = integer(raw.copyOfRange(32, 64)); return byteArrayOf(0x30, (r.size + s.size).toByte()) + r + s
    }
}
