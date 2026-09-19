package io.cuaremote.daemon

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.cuaremote.protocol.HpkeSuite
import io.cuaremote.protocol.PublicKeys
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

interface HubIdentity { val publicKeys: PublicKeys; val kemKeys: AsymmetricCipherKeyPair; fun sign(bytes: ByteArray): String }

class AndroidIdentity(context: Context) : HubIdentity {
    private val prefs = context.getSharedPreferences("identity", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    override val kemKeys: AsymmetricCipherKeyPair by lazy {
        val private = prefs.getString("kem.private", null)?.let(Base64.getDecoder()::decode)
        val public = prefs.getString("kem.public", null)?.let(Base64.getDecoder()::decode)
        if (private != null && public != null) HpkeSuite.privateKey(private, public) else HpkeSuite.generateKeyPair().also {
            prefs.edit().putString("kem.private", Base64.getEncoder().encodeToString(HpkeSuite.privateBytes(it))).putString("kem.public", Base64.getEncoder().encodeToString(HpkeSuite.publicBytes(it))).apply()
        }
    }
    private val signing by lazy {
        if (!keyStore.containsAlias(ALIAS)) KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
        }.generateKeyPair() else keyStore.getCertificate(ALIAS).publicKey.let { java.security.KeyPair(it, keyStore.getKey(ALIAS, null) as java.security.PrivateKey) }
    }
    override val publicKeys: PublicKeys get() = PublicKeys(Base64.getEncoder().encodeToString(HpkeSuite.publicBytes(kemKeys)), Base64.getEncoder().encodeToString(signing.public.encoded))
    override fun sign(bytes: ByteArray): String = Base64.getEncoder().encodeToString(Signature.getInstance("SHA256withECDSA").run { initSign(signing.private); update(bytes); sign() })
    companion object { private const val ALIAS = "cuaremote-daemon-signing" }
}
