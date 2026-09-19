package io.cuaremote.daemon

import io.cuaremote.protocol.*
import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import java.util.Base64

class PeerCipher(private val selfId: String, private val keys: AsymmetricCipherKeyPair) {
    private val senders = mutableMapOf<String, HpkeSuite.Sender>()
    private val recipients = mutableMapOf<String, HpkeSuite.Recipient>()
    private val peerKeys = mutableMapOf<String, PublicKeys>()
    fun putPeer(id: String, keys: PublicKeys) { peerKeys[id] = keys; senders.remove(id); recipients.remove(id) }
    fun begin(to: String): RelayEnvelope {
        val sender = senders.getOrPut(to) { HpkeSuite.sender(selfId, to, peerPublic(to), keys) }
        return RelayEnvelope(to, selfId, true, sender.encapsulation)
    }
    fun seal(to: String, frame: Frame): RelayEnvelope {
        val sender = senders.getOrPut(to) { HpkeSuite.sender(selfId, to, peerPublic(to), keys) }
        val shell = RelayEnvelope(to, selfId, true, byteArrayOf())
        return shell.copy(body = sender.seal(shell.header(), frame.encode()))
    }
    fun open(envelope: RelayEnvelope): Frame? {
        var recipient = recipients[envelope.from]
        if (recipient == null) {
            require(envelope.body.size == 32) { "first HPKE body must be enc" }
            recipient = HpkeSuite.recipient(envelope.from, selfId, envelope.body, keys, peerPublic(envelope.from)); recipients[envelope.from] = recipient
            return null
        }
        return Frame.decode(recipient.open(envelope.copy(body = byteArrayOf()).header(), envelope.body))
    }
    private fun peerPublic(id: String) = HpkeSuite.publicKey(Base64.getDecoder().decode(peerKeys[id]?.kem ?: error("没有 $id 的公钥")))
}
