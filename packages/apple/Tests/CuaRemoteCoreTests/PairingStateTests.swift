import XCTest
import CryptoKit
@testable import CuaRemoteCore
import CuaRemoteProtocol

final class PairingStateTests: XCTestCase {
    private final class MemoryStore: SecureValueStore {
        private var values: [String: Data] = [:]

        func data(forKey key: String) throws -> Data? { values[key] }
        func set(_ data: Data, forKey key: String) throws { values[key] = data }
        func removeValue(forKey key: String) throws { values[key] = nil }
    }

    private struct PairingFixture: Decodable {
        let secret: String
        let deviceKem: String
        let phoneKem: String
        let hmac: String
    }

    private func fixture() throws -> PairingFixture {
        let url = Bundle.module.url(forResource: "pairing", withExtension: "json", subdirectory: "fixtures")!
        return try JSONDecoder().decode(PairingFixture.self, from: Data(contentsOf: url))
    }

    private func newIdentity(_ store: any SecureValueStore) throws -> DeviceIdentity {
        try DeviceIdentityRepository(store: store).loadOrCreate()
    }

    private func coordinator(
        role: RemoteRole,
        identity: DeviceIdentity,
        hubURL: String,
        store: any SecureValueStore
    ) -> PairingCoordinator {
        PairingCoordinator(
            role: role,
            identity: identity,
            trust: PeerTrustStore(identityId: identity.deviceId, hubURL: hubURL, store: store)
        )
    }

    func testPairingHmacMatchesTypeScriptVector() throws {
        let value = try fixture()
        XCTAssertEqual(
            try PairingCrypto.hmacBase64(secret: value.secret, deviceKem: value.deviceKem, phoneKem: value.phoneKem),
            value.hmac
        )
    }

    func testIdentityRepositoryLoadsThePersistedKeyMaterial() throws {
        let store = MemoryStore()
        let repository = DeviceIdentityRepository(store: store)
        let original = try repository.loadOrCreate()
        XCTAssertEqual(try repository.loadOrCreate(), original)
    }

    func testPairOfferRequiresSecureOrExplicitLocalDevelopmentURL() throws {
        let store = MemoryStore()
        let identity = try newIdentity(store)
        let device = coordinator(role: .device, identity: identity, hubURL: "ws://192.168.1.4:8788/ws", store: store)
        XCTAssertThrowsError(try device.createOffer(
            hubURL: URL(string: "ws://192.168.1.4:8788/ws")!,
            name: "Mac",
            now: 100,
            allowInsecureLocalDevelopment: false
        )) { XCTAssertEqual($0 as? PairingError, .insecureHubURL) }
        let json = try device.createOffer(
            hubURL: URL(string: "ws://192.168.1.4:8788/ws")!,
            name: "Mac",
            now: 100,
            lifetime: 600,
            allowInsecureLocalDevelopment: true
        )
        let offer = try JSONDecoder().decode(PairOffer.self, from: Data(json.utf8))
        XCTAssertEqual(offer.expiresAt, 400)
        XCTAssertEqual(try XCTUnwrap(Data(base64Encoded: offer.secret)).count, 16)
        XCTAssertThrowsError(try device.createOffer(
            hubURL: URL(string: "wss://hub.example/ws")!,
            name: "Mac",
            now: Int.max,
            lifetime: 1,
            allowInsecureLocalDevelopment: false
        ))
        XCTAssertNoThrow(try HubURLPolicy.validate(URL(string: "ws://[fd00::1]/ws")!, allowInsecureLocalDevelopment: true))
        XCTAssertNoThrow(try HubURLPolicy.validate(URL(string: "ws://[0:0:0:0:0:0:0:1]/ws")!, allowInsecureLocalDevelopment: true))
        XCTAssertThrowsError(try HubURLPolicy.validate(URL(string: "ws://[::2]/ws")!, allowInsecureLocalDevelopment: true))
        XCTAssertThrowsError(try HubURLPolicy.validate(URL(string: "ws://example.com/ws")!, allowInsecureLocalDevelopment: true))
        XCTAssertThrowsError(try HubURLPolicy.validate(URL(string: "ws://127.0.0.1.attacker.example/ws")!, allowInsecureLocalDevelopment: true))
    }

    func testSuccessfulPairCommitsExactPendingTrustAndUnpairClearsIt() throws {
        let deviceStorage = MemoryStore()
        let phoneStorage = MemoryStore()
        let deviceIdentity = try newIdentity(deviceStorage)
        let phoneIdentity = try newIdentity(phoneStorage)
        let hubURL = URL(string: "wss://hub.example/ws")!
        let device = coordinator(role: .device, identity: deviceIdentity, hubURL: hubURL.absoluteString, store: deviceStorage)
        let phone = coordinator(role: .phone, identity: phoneIdentity, hubURL: hubURL.absoluteString, store: phoneStorage)
        let deviceTrust = PeerTrustStore(identityId: deviceIdentity.deviceId, hubURL: hubURL.absoluteString, store: deviceStorage)
        let phoneTrust = PeerTrustStore(identityId: phoneIdentity.deviceId, hubURL: hubURL.absoluteString, store: phoneStorage)

        let json = try device.createOffer(hubURL: hubURL, name: "Mac", now: 100, allowInsecureLocalDevelopment: false)
        let request = try phone.acceptOffer(json: json, currentHubURL: hubURL, phoneName: "Phone", now: 101, allowInsecureLocalDevelopment: false)
        let review = try device.stageDeviceRequest(request, now: 102)
        XCTAssertEqual(review.phoneId, phoneIdentity.deviceId)
        XCTAssertNil(try deviceTrust.peer(phoneIdentity.deviceId))
        _ = try device.confirmPair(deviceId: deviceIdentity.deviceId, phoneId: phoneIdentity.deviceId, now: 102)

        let result = PairResult(id: "result", deviceId: deviceIdentity.deviceId, phoneId: phoneIdentity.deviceId, ok: true)
        XCTAssertEqual(try device.apply(result, now: 103), .committed)
        XCTAssertEqual(try phone.apply(result, now: 103), .committed)
        let phoneKeys = try phoneIdentity.publicKeys
        let deviceKeys = try deviceIdentity.publicKeys
        XCTAssertEqual(try deviceTrust.peer(phoneIdentity.deviceId)?.pubKeys.kem, phoneKeys.kem)
        XCTAssertEqual(try phoneTrust.peer(deviceIdentity.deviceId)?.pubKeys.kem, deviceKeys.kem)

        try device.removePeer(phoneIdentity.deviceId)
        try phone.removePeer(deviceIdentity.deviceId)
        XCTAssertNil(try deviceTrust.peer(phoneIdentity.deviceId))
        XCTAssertNil(try phoneTrust.peer(deviceIdentity.deviceId))
    }

    func testExpiredOfferCannotBeConfirmedAfterUserDelay() throws {
        let deviceStorage = MemoryStore()
        let phoneStorage = MemoryStore()
        let deviceIdentity = try newIdentity(deviceStorage)
        let phoneIdentity = try newIdentity(phoneStorage)
        let hubURL = URL(string: "wss://hub.example/ws")!
        let device = coordinator(role: .device, identity: deviceIdentity, hubURL: hubURL.absoluteString, store: deviceStorage)
        let phone = coordinator(role: .phone, identity: phoneIdentity, hubURL: hubURL.absoluteString, store: phoneStorage)
        let offer = try device.createOffer(hubURL: hubURL, name: "Mac", now: 100, lifetime: 1, allowInsecureLocalDevelopment: false)
        let request = try phone.acceptOffer(json: offer, currentHubURL: hubURL, phoneName: "Phone", now: 100, allowInsecureLocalDevelopment: false)
        _ = try device.stageDeviceRequest(request, now: 100)
        XCTAssertThrowsError(try device.confirmPair(deviceId: deviceIdentity.deviceId, phoneId: phoneIdentity.deviceId, now: 101)) {
            XCTAssertEqual($0 as? PairingError, .expiredOffer)
        }
        XCTAssertNil(device.pendingReview)
    }

    func testExpiredPairResultDoesNotCommitStagedTrust() throws {
        let deviceStorage = MemoryStore()
        let phoneStorage = MemoryStore()
        let deviceIdentity = try newIdentity(deviceStorage)
        let phoneIdentity = try newIdentity(phoneStorage)
        let hubURL = URL(string: "wss://hub.example/ws")!
        let device = coordinator(role: .device, identity: deviceIdentity, hubURL: hubURL.absoluteString, store: deviceStorage)
        let offer = try device.createOffer(hubURL: hubURL, name: "Mac", now: 100, lifetime: 1, allowInsecureLocalDevelopment: false)
        let phone = coordinator(role: .phone, identity: phoneIdentity, hubURL: hubURL.absoluteString, store: phoneStorage)
        let request = try phone.acceptOffer(json: offer, currentHubURL: hubURL, phoneName: "Phone", now: 100, allowInsecureLocalDevelopment: false)
        _ = try device.stageDeviceRequest(request, now: 100)
        _ = try device.confirmPair(deviceId: deviceIdentity.deviceId, phoneId: phoneIdentity.deviceId, now: 100)

        let result = PairResult(id: "late", deviceId: deviceIdentity.deviceId, phoneId: phoneIdentity.deviceId, ok: true)
        XCTAssertEqual(try device.apply(result, now: 101), .rejected)
        let trust = PeerTrustStore(identityId: deviceIdentity.deviceId, hubURL: hubURL.absoluteString, store: deviceStorage)
        XCTAssertNil(try trust.peer(phoneIdentity.deviceId))
    }

    func testUnsolicitedPairResultDoesNotCreateTrust() throws {
        let storage = MemoryStore()
        let identity = try newIdentity(storage)
        let hubURL = "wss://hub.example/ws"
        let phone = coordinator(role: .phone, identity: identity, hubURL: hubURL, store: storage)
        let result = PairResult(id: "unsolicited", deviceId: "unknown-device", phoneId: identity.deviceId, ok: true)
        XCTAssertEqual(try phone.apply(result, now: 100), .ignored)
        XCTAssertNil(try PeerTrustStore(identityId: identity.deviceId, hubURL: hubURL, store: storage).peer("unknown-device"))
    }

    func testPinnedKeySubstitutionIsRejectedWithoutReplacingTrust() throws {
        let storage = MemoryStore()
        let identity = try newIdentity(storage)
        let attacker = try newIdentity(MemoryStore())
        let trust = PeerTrustStore(identityId: identity.deviceId, hubURL: "wss://hub.example/ws", store: storage)
        let pinned = TrustedPeer(deviceId: "peer", name: "Mac", pubKeys: try identity.publicKeys)
        XCTAssertTrue(try trust.pin(pinned))
        XCTAssertEqual(try trust.assess(deviceId: "peer", keys: attacker.publicKeys), .mismatch)
        XCTAssertFalse(try trust.pin(TrustedPeer(deviceId: "peer", name: "Substitute", pubKeys: try attacker.publicKeys)))
        let originalKeys = try identity.publicKeys
        XCTAssertEqual(try trust.peer("peer")?.pubKeys.kem, originalKeys.kem)
    }

    func testTrustIsNamespacedByIdentityAndHubURL() throws {
        let storage = MemoryStore()
        let identity = try newIdentity(storage)
        let peerIdentity = try newIdentity(MemoryStore())
        let hubURL = "wss://hub.example/ws"
        let trust = PeerTrustStore(identityId: identity.deviceId, hubURL: hubURL, store: storage)
        try trust.pin(TrustedPeer(deviceId: peerIdentity.deviceId, name: "Mac", pubKeys: peerIdentity.publicKeys))

        XCTAssertNotNil(try PeerTrustStore(identityId: identity.deviceId, hubURL: hubURL, store: storage).peer(peerIdentity.deviceId))
        XCTAssertNil(try PeerTrustStore(identityId: identity.deviceId, hubURL: "wss://other.example/ws", store: storage).peer(peerIdentity.deviceId))
        XCTAssertNil(try PeerTrustStore(identityId: peerIdentity.deviceId, hubURL: hubURL, store: storage).peer(peerIdentity.deviceId))
    }

    func testIdentitySignsHubPayloadWithRawES256Signature() throws {
        let identity = try newIdentity(MemoryStore())
        let payload = Data("cuaremote-hub-auth-v1\n\(identity.deviceId)\nnonce".utf8)
        let signature = try XCTUnwrap(Data(base64Encoded: identity.sign(payload)))
        let keys = try identity.publicKeys
        let publicKey = try XCTUnwrap(Data(base64Encoded: keys.sig))
        XCTAssertEqual(signature.count, 64)
        XCTAssertEqual(publicKey.count, 65)
        let key = try P256.Signing.PublicKey(x963Representation: publicKey)
        XCTAssertTrue(key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: signature), for: payload))
    }
}
