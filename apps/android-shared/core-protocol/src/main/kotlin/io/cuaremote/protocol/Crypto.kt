package io.cuaremote.protocol

import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import org.bouncycastle.crypto.hpke.HPKE
import org.bouncycastle.crypto.hpke.HPKEContext
import org.bouncycastle.crypto.hpke.HPKEContextWithEncapsulation
import org.bouncycastle.crypto.params.AsymmetricKeyParameter
import java.util.Base64
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object HpkeSuite {
    private fun engine() = HPKE(HPKE.mode_auth, HPKE.kem_X25519_SHA256, HPKE.kdf_HKDF_SHA256, HPKE.aead_CHACHA20_POLY1305)
    fun generateKeyPair(): AsymmetricCipherKeyPair = engine().generatePrivateKey()
    fun deriveKeyPair(ikm: ByteArray): AsymmetricCipherKeyPair = engine().deriveKeyPair(ikm)
    fun publicKey(bytes: ByteArray): AsymmetricKeyParameter = engine().deserializePublicKey(bytes)
    fun privateKey(privateBytes: ByteArray, publicBytes: ByteArray): AsymmetricCipherKeyPair = engine().deserializePrivateKey(privateBytes, publicBytes)
    fun publicBytes(pair: AsymmetricCipherKeyPair): ByteArray = engine().serializePublicKey(pair.public)
    fun privateBytes(pair: AsymmetricCipherKeyPair): ByteArray = engine().serializePrivateKey(pair.private)
    fun sender(from: String, to: String, recipientPublic: AsymmetricKeyParameter, senderKeys: AsymmetricCipherKeyPair) = Sender(engine().setupAuthS(recipientPublic, info(from, to), senderKeys))
    fun recipient(from: String, to: String, encapsulation: ByteArray, recipientKeys: AsymmetricCipherKeyPair, senderPublic: AsymmetricKeyParameter) = Recipient(engine().setupAuthR(encapsulation, recipientKeys, info(from, to), senderPublic))
    private fun info(from: String, to: String) = "cuaremote-v1|$from|$to".toByteArray()
    class Sender internal constructor(private val context: HPKEContextWithEncapsulation) {
        val encapsulation: ByteArray get() = context.encapsulation
        fun seal(aad: ByteArray, plaintext: ByteArray): ByteArray = context.seal(aad, plaintext)
    }
    class Recipient internal constructor(private val context: HPKEContext) {
        fun open(aad: ByteArray, ciphertext: ByteArray): ByteArray = context.open(aad, ciphertext)
    }
}

fun pairingHmac(secretBase64: String, deviceKemBase64: String, phoneKemBase64: String): String {
    val decoder = Base64.getDecoder(); val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(decoder.decode(secretBase64), "HmacSHA256"))
    return Base64.getEncoder().encodeToString(mac.doFinal(decoder.decode(deviceKemBase64) + decoder.decode(phoneKemBase64)))
}

fun pairRequest(offer: PairOffer, id: String, phoneId: String, phoneName: String, phoneKeys: PublicKeys) =
    PairRequest(id = id, deviceId = offer.deviceId, phoneId = phoneId, phoneName = phoneName, phonePubKeys = phoneKeys, hmac = pairingHmac(offer.secret, offer.pubKeys.kem, phoneKeys.kem))

fun verifyPairRequest(offer: PairOffer, request: PairRequest, nowSeconds: Long = System.currentTimeMillis() / 1000): Boolean {
    if (offer.expiresAt < nowSeconds || request.deviceId != offer.deviceId) return false
    val expected = Base64.getDecoder().decode(pairingHmac(offer.secret, offer.pubKeys.kem, request.phonePubKeys.kem))
    return runCatching { MessageDigest.isEqual(expected, Base64.getDecoder().decode(request.hmac)) }.getOrDefault(false)
}
