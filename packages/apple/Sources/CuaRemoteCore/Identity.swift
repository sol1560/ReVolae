import CryptoKit
import Foundation
import CuaRemoteProtocol

public struct DeviceIdentity: Codable, Equatable, Sendable {
    public let deviceId: String
    public let kemPrivateKey: Data
    public let signingPrivateKey: Data

    public init(deviceId: String, kemPrivateKey: Data, signingPrivateKey: Data) {
        self.deviceId = deviceId
        self.kemPrivateKey = kemPrivateKey
        self.signingPrivateKey = signingPrivateKey
    }

    public var publicKeys: PublicKeys {
        get throws {
            let kem = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: kemPrivateKey)
            let signing = try P256.Signing.PrivateKey(rawRepresentation: signingPrivateKey)
            return PublicKeys(
                kem: kem.publicKey.rawRepresentation.base64EncodedString(),
                sig: signing.publicKey.x963Representation.base64EncodedString(),
                sigAlg: .eS256
            )
        }
    }

    public func sign(_ payload: Data) throws -> String {
        let privateKey = try P256.Signing.PrivateKey(rawRepresentation: signingPrivateKey)
        return try privateKey.signature(for: payload).rawRepresentation.base64EncodedString()
    }

    static func generate() -> DeviceIdentity {
        DeviceIdentity(
            deviceId: UUID().uuidString.lowercased(),
            kemPrivateKey: Curve25519.KeyAgreement.PrivateKey().rawRepresentation,
            signingPrivateKey: P256.Signing.PrivateKey().rawRepresentation
        )
    }
}

public struct DeviceIdentityRepository {
    private let store: any SecureValueStore
    private let key = "identity.v1"

    public init(store: any SecureValueStore) {
        self.store = store
    }

    public func loadOrCreate() throws -> DeviceIdentity {
        if let data = try store.data(forKey: key) {
            return try JSONDecoder().decode(DeviceIdentity.self, from: data)
        }
        let identity = DeviceIdentity.generate()
        try store.set(JSONEncoder().encode(identity), forKey: key)
        return identity
    }
}
