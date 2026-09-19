package io.cuaremote.controller

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.os.Build
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import io.cuaremote.protocol.approvalSignedPayload
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class ApprovalSigner(private val activity: FragmentActivity) {
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    fun publicKeyBase64(): String { ensureKey(); return Base64.getEncoder().encodeToString(store.getCertificate(ALIAS).publicKey.encoded) }
    fun sign(challenge: String, allow: Boolean, onResult: (Result<String>) -> Unit) {
        ensureKey()
        val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(store.getKey(ALIAS, null) as java.security.PrivateKey) }
        val prompt = BiometricPrompt(activity, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                try { val s = result.cryptoObject!!.signature!!; s.update(approvalSignedPayload(challenge, allow).toByteArray()); onResult(Result.success(Base64.getEncoder().encodeToString(derToRaw(s.sign())))) } catch (e: Exception) { onResult(Result.failure(e)) }
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { onResult(Result.failure(IllegalStateException(errString.toString()))) }
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(if (allow) "确认执行操作" else "确认拒绝操作").setSubtitle("使用指纹确认本次决定").setNegativeButtonText("取消").build(), BiometricPrompt.CryptoObject(signature))
    }
    private fun ensureKey() {
        if (store.containsAlias(ALIAS)) return
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            val builder = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true)
            if (Build.VERSION.SDK_INT >= 30) builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG) else builder.setUserAuthenticationValidityDurationSeconds(-1)
            initialize(builder.build())
        }.generateKeyPair()
    }
    private fun derToRaw(der: ByteArray): ByteArray {
        var p = 2; if (der[1].toInt() and 0x80 != 0) p = 2 + (der[1].toInt() and 0x7f)
        check(der[p++].toInt() == 2); val rl = der[p++].toInt() and 255; val r = der.copyOfRange(p, p + rl); p += rl
        check(der[p++].toInt() == 2); val sl = der[p++].toInt() and 255; val s = der.copyOfRange(p, p + sl)
        fun fixed(v: ByteArray): ByteArray { val unsigned = v.dropWhile { it == 0.toByte() }.takeLast(32); return ByteArray(32 - unsigned.size) + unsigned }
        return fixed(r) + fixed(s)
    }
    companion object { const val ALIAS = "cuaremote-approval-p256" }
}
