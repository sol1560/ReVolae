package io.cuaremote.daemon

import io.cuaremote.protocol.*
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class PeerCipher(private val selfId: String, private val keys: AsymmetricCipherKeyPair, private val newNonce: () -> ByteArray = { ByteArray(32).also(SecureRandom()::nextBytes) }) {
    private data class Link(
        val sender: HpkeSuite.Sender,
        val nonce: ByteArray,
        var recipient: HpkeSuite.Recipient? = null,
        var peerNonce: ByteArray? = null,
        val ready: CompletableFuture<Unit> = CompletableFuture(),
    )
    private val links = mutableMapOf<String, Link>()
    private val peerKeys = mutableMapOf<String, PublicKeys>()
    @Synchronized fun putPeer(id: String, keys: PublicKeys) { peerKeys[id] = keys }
    @Synchronized fun begin(to: String): RelayEnvelope {
        val link = link(to)
        return RelayEnvelope(to, selfId, false, byteArrayOf(2) + link.sender.encapsulation + link.nonce)
    }
    fun seal(to: String, frame: Frame): RelayEnvelope {
        val link = synchronized(this) { link(to) }
        link.ready.get(10, TimeUnit.SECONDS)
        return synchronized(this) {
            check(links[to] === link) { "peer connection was replaced" }
            val shell = RelayEnvelope(to, selfId, true, byteArrayOf())
            shell.copy(body = link.sender.seal(shell.header(), link.peerNonce!! + frame.encode()))
        }
    }
    @Synchronized fun open(envelope: RelayEnvelope): Frame? {
        require(envelope.to == selfId) { "relay is not addressed to $selfId" }
        val link = link(envelope.from)
        if (!envelope.encrypted) {
            check(link.recipient == null) { "peer sent a second online handshake" }
            require(envelope.body.size == 65 && envelope.body[0] == 2.toByte()) { "unsupported HPKE handshake" }
            link.recipient = HpkeSuite.recipient(envelope.from, selfId, envelope.body.copyOfRange(1, 33), keys, peerPublic(envelope.from))
            link.peerNonce = envelope.body.copyOfRange(33, 65)
            link.ready.complete(Unit)
            return null
        }
        val recipient = link.recipient ?: error("ciphertext arrived before peer handshake")
        val plaintext = recipient.open(envelope.copy(body = byteArrayOf()).header(), envelope.body)
        require(plaintext.size >= 32 && MessageDigest.isEqual(link.nonce, plaintext.copyOfRange(0, 32))) { "ciphertext belongs to another connection" }
        return Frame.decode(plaintext.copyOfRange(32, plaintext.size))
    }
    @Synchronized fun drop(id: String, cause: Throwable = IllegalStateException("peer went offline")) {
        links.remove(id)?.ready?.completeExceptionally(cause)
    }
    @Synchronized fun reset(cause: Throwable = IllegalStateException("hub disconnected")) {
        links.values.forEach { it.ready.completeExceptionally(cause) }
        links.clear()
    }
    @Synchronized private fun link(id: String) = links.getOrPut(id) {
        val nonce = newNonce()
        require(nonce.size == 32) { "connection nonce must be 32 bytes" }
        Link(HpkeSuite.sender(selfId, id, peerPublic(id), keys), nonce.copyOf())
    }
    private fun peerPublic(id: String) = HpkeSuite.publicKey(Base64.getDecoder().decode(peerKeys[id]?.kem ?: error("没有 $id 的公钥")))
}
