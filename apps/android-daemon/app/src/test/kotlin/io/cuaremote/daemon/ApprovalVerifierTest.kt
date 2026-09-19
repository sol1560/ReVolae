package io.cuaremote.daemon

import io.cuaremote.protocol.*
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.*
import org.junit.Test

class ApprovalVerifierTest {
    @Test fun `checks expiry signature challenge and replay`() {
        val keys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val verifier = ApprovalVerifier(); val expires = 2_000_000_100L; val challenge = approvalChallenge("run", "step", "打开系统设置", "request-nonce", expires)
        verifier.observe(ApprovalRequired(id = "a", runId = "run", stepId = "step", level = 2, action = ConcreteAction("android", "打开设置", "打开系统设置"), reason = "L2", expiresAt = expires, challenge = challenge))
        val der = Signature.getInstance("SHA256withECDSA").run { initSign(keys.private); update(approvalSignedPayload(challenge, true).toByteArray()); sign() }
        val decision = ApprovalDecision(id = "d", runId = "run", stepId = "step", allow = true, signature = ApprovalSignature(keyId = "phone", sig = Base64.getEncoder().encodeToString(derToRaw(der)), expiresAt = 2_000_000_050, nonce = "unique"))
        val publicKey = Base64.getEncoder().encodeToString(keys.public.encoded)
        assertTrue(verifier.verify(decision, publicKey, 2_000_000_000))
        assertFalse(verifier.verify(decision, publicKey, 2_000_000_000), "nonce/request replay must fail")
    }
    private fun derToRaw(der: ByteArray): ByteArray {
        var p = 2; val rl = der[++p].toInt() and 255; val r = der.copyOfRange(++p, p + rl); p += rl; val sl = der[++p].toInt() and 255; val s = der.copyOfRange(++p, p + sl)
        fun fixed(v: ByteArray): ByteArray { val x = v.dropWhile { it == 0.toByte() }.takeLast(32); return ByteArray(32 - x.size) + x }
        return fixed(r) + fixed(s)
    }
}
