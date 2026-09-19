package io.cuaremote.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

const val PROTOCOL_VERSION = 1

@Serializable
sealed interface WireMessage { val v: Int; val id: String }

@Serializable
data class PublicKeys(val kem: String, val sig: String, val sigAlg: String = "ES256")

@Serializable @SerialName("hello")
data class Hello(override val v: Int = 1, override val id: String, val role: String, val deviceId: String, val platform: String, val name: String, val pubKeys: PublicKeys, val protocolVersion: Int = 1, val token: String? = null) : WireMessage
@Serializable @SerialName("auth.challenge")
data class AuthChallenge(override val v: Int = 1, override val id: String, val nonce: String) : WireMessage
@Serializable @SerialName("auth.response")
data class AuthResponse(override val v: Int = 1, override val id: String, val nonce: String, val signature: String) : WireMessage
@Serializable @SerialName("auth.ok")
data class AuthOk(override val v: Int = 1, override val id: String, val sessionToken: String, val expiresAt: Long) : WireMessage
@Serializable @SerialName("peer.keys")
data class PeerKeys(override val v: Int = 1, override val id: String, val deviceId: String, val pubKeys: PublicKeys) : WireMessage

@Serializable
data class PairOffer(val hubURL: String, val deviceId: String, val name: String, val pubKeys: PublicKeys, val secret: String, val expiresAt: Long)
@Serializable @SerialName("pair.request")
data class PairRequest(override val v: Int = 1, override val id: String, val deviceId: String, val phoneId: String, val phoneName: String, val phonePubKeys: PublicKeys, val hmac: String) : WireMessage
@Serializable @SerialName("pair.confirm")
data class PairConfirm(override val v: Int = 1, override val id: String, val deviceId: String, val phoneId: String, val accept: Boolean) : WireMessage
@Serializable @SerialName("pair.result")
data class PairResult(override val v: Int = 1, override val id: String, val deviceId: String, val phoneId: String, val ok: Boolean, val reason: String? = null) : WireMessage

@Serializable @SerialName("intent.submit")
data class IntentSubmit(override val v: Int = 1, override val id: String, val text: String, val deviceId: String, val mode: String = "agent", val provider: String? = null) : WireMessage
@Serializable @SerialName("tools.list")
data class ToolsList(override val v: Int = 1, override val id: String) : WireMessage

@Serializable
data class ToolDescriptor(val name: String, val description: String, val channel: String = "android", val staticLevel: Int, val costClass: Int = 0, val dataLeavesDevice: Boolean = true, val inputSchema: JsonObject)
@Serializable
data class Scope(val allowedDirs: List<String> = emptyList(), val allowedApps: List<String> = emptyList(), val deniedCommands: List<String> = emptyList())
@Serializable @SerialName("tools.list.result")
data class ToolsListResult(override val v: Int = 1, override val id: String, val tools: List<ToolDescriptor>, val scope: Scope = Scope()) : WireMessage
@Serializable @SerialName("tools.call")
data class ToolsCall(override val v: Int = 1, override val id: String, val callId: String, val tool: String, val args: JsonObject, val timeoutMs: Long = 60_000) : WireMessage
@Serializable
data class Attachment(val kind: String, val streamId: Int? = null, val inline: String? = null)
@Serializable @SerialName("tools.result")
data class ToolsResult(override val v: Int = 1, override val id: String, val callId: String, val ok: Boolean, val output: String? = null, val attachments: List<Attachment> = emptyList(), val error: String? = null, val ms: Double) : WireMessage

@Serializable
data class ConcreteAction(val channel: String, val summary: String, val detail: String, val targetApp: String? = null, val targetPath: String? = null)
@Serializable
data class ApprovalSignature(val alg: String = "ES256", val keyId: String, val sig: String, val expiresAt: Long, val nonce: String)
@Serializable @SerialName("step.approval_required")
data class ApprovalRequired(override val v: Int = 1, override val id: String, val runId: String, val stepId: String, val level: Int, val action: ConcreteAction, val reason: String, val expiresAt: Long, val challenge: String) : WireMessage
@Serializable @SerialName("approval.decision")
data class ApprovalDecision(override val v: Int = 1, override val id: String, val runId: String, val stepId: String, val allow: Boolean, val remember: String = "once", val signature: ApprovalSignature? = null) : WireMessage
@Serializable @SerialName("error")
data class ErrorMessage(override val v: Int = 1, override val id: String, val code: String, val message: String, val ref: String? = null) : WireMessage

object ProtocolJson {
    val value = Json { classDiscriminator = "type"; ignoreUnknownKeys = false; encodeDefaults = true; explicitNulls = false }
    fun encode(message: WireMessage): String = value.encodeToString(WireMessage.serializer(), message)
    fun decode(text: String): WireMessage = value.decodeFromString(WireMessage.serializer(), text)
}
