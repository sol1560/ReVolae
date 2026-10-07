import XCTest
import CryptoKit
@testable import CuaRemoteProtocol

final class FreshLinkTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Identity: Decodable {
            let id: String
            let publicKey: String
            let privateKey: String
        }

        let phone: Identity
        let mac: Identity
        let phoneNonce: String
        let macNonce: String
        let info: String
        let aad: String
        let hello: String
        let key: String
        let plaintext: String
        let ciphertext: String
    }

    private func fixture() throws -> Fixture {
        let url = Bundle.module.url(forResource: "fresh-link", withExtension: "json", subdirectory: "fixtures")!
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func receiver(_ value: Fixture, nonce: Data? = nil) throws -> FreshLink {
        try FreshLink(
            selfId: value.mac.id,
            selfPrivateKey: Data(hex: value.mac.privateKey),
            peerId: value.phone.id,
            peerPublicKey: Data(hex: value.phone.publicKey),
            testNonce: nonce ?? Data(hex: value.macNonce)
        )
    }

    private func makeReady(_ value: Fixture) async throws -> FreshLink {
        let link = try receiver(value)
        _ = try await link.hello()
        _ = try await link.receive(Data(hex: value.hello))
        _ = try await link.receive(Data(hex: value.key))
        let ready = await link.ready
        XCTAssertTrue(ready)
        return link
    }

    func testDecryptsTypeScriptFreshLinkFixtureAndBindsInfo() async throws {
        let value = try fixture()
        XCTAssertEqual(try freshLinkInfo(from: value.phone.id, to: value.mac.id, senderNonce: value.phoneNonce, receiverNonce: value.macNonce), Data(hex: value.info))
        let link = try await makeReady(value)
        let result = try await link.receive(Data(hex: value.ciphertext))
        XCTAssertEqual(result.frame, Data(hex: value.plaintext))
    }

    func testFreshNonceRejectsOldHandshakeAndCiphertextStream() async throws {
        let value = try fixture()
        let link = try receiver(value, nonce: Data(repeating: 0x55, count: 32))
        _ = try await link.hello()
        _ = try await link.receive(Data(hex: value.hello))
        do {
            _ = try await link.receive(Data(hex: value.key))
            XCTFail("stale key was accepted")
        } catch {}
        let ready = await link.ready
        XCTAssertFalse(ready)
        do {
            _ = try await link.receive(Data(hex: value.ciphertext))
            XCTFail("old ciphertext was accepted")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }
    }

    func testDuplicateAndReorderedHandshakePoisonGeneration() async throws {
        let value = try fixture()
        let noLocalHello = try receiver(value)
        do {
            _ = try await noLocalHello.receive(Data(hex: value.hello))
            XCTFail("remote hello before local hello was accepted")
        } catch {}
        do {
            _ = try await noLocalHello.hello()
            XCTFail("link recovered after an out-of-order hello")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }

        let duplicate = try receiver(value)
        _ = try await duplicate.hello()
        _ = try await duplicate.receive(Data(hex: value.hello))
        do {
            _ = try await duplicate.receive(Data(hex: value.hello))
            XCTFail("duplicate hello was accepted")
        } catch {}
        do {
            _ = try await duplicate.seal(Data([1]))
            XCTFail("poisoned link was reusable")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }

        let duplicateKey = try receiver(value)
        _ = try await duplicateKey.hello()
        _ = try await duplicateKey.receive(Data(hex: value.hello))
        _ = try await duplicateKey.receive(Data(hex: value.key))
        do {
            _ = try await duplicateKey.receive(Data(hex: value.key))
            XCTFail("duplicate key was accepted")
        } catch {}
        do {
            _ = try await duplicateKey.seal(Data([1]))
            XCTFail("duplicate key did not poison the generation")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }

        let reordered = try receiver(value)
        _ = try await reordered.hello()
        do {
            _ = try await reordered.receive(Data(hex: value.key))
            XCTFail("key before hello was accepted")
        } catch {}
        do {
            _ = try await reordered.receive(Data(hex: value.hello))
            XCTFail("reordered link recovered")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }
    }

    func testTamperedAndReplayedCiphertextPoisonGeneration() async throws {
        let value = try fixture()
        let tamperedLink = try await makeReady(value)
        var tampered = Data(hex: value.ciphertext)
        tampered[tampered.count - 1] ^= 1
        do {
            _ = try await tamperedLink.receive(tampered)
            XCTFail("tampered ciphertext was accepted")
        } catch {}
        do {
            _ = try await tamperedLink.seal(Data([1]))
            XCTFail("tampered stream remained usable")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }

        let replayedLink = try await makeReady(value)
        _ = try await replayedLink.receive(Data(hex: value.ciphertext))
        do {
            _ = try await replayedLink.receive(Data(hex: value.ciphertext))
            XCTFail("replayed ciphertext was accepted")
        } catch {}
        do {
            _ = try await replayedLink.seal(Data([1]))
            XCTFail("replayed stream remained usable")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }
    }

    func testRejectsLegacyVersionAndUnsupportedRelayFlags() async throws {
        let value = try fixture()
        let link = try receiver(value)
        _ = try await link.hello()
        let legacy = try RelayEnvelope(
            to: value.mac.id,
            from: value.phone.id,
            encrypted: false,
            body: Data(#"{"v":1,"type":"hello","nonce":"3131313131313131313131313131313131313131313131313131313131313131"}"#.utf8)
        ).encode()
        do {
            _ = try await link.receive(legacy)
            XCTFail("legacy FreshLink was accepted")
        } catch {}

        let strict = try receiver(value)
        _ = try await strict.hello()
        let extraHello = try RelayEnvelope(
            to: value.mac.id,
            from: value.phone.id,
            encrypted: false,
            body: Data(#"{"v":2,"type":"hello","nonce":"3131313131313131313131313131313131313131313131313131313131313131","extra":true}"#.utf8)
        ).encode()
        do {
            _ = try await strict.receive(extraHello)
            XCTFail("extra handshake field was accepted")
        } catch {}
        do {
            _ = try await strict.hello()
            XCTFail("strict-field error did not poison the generation")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }

        XCTAssertThrowsError(try RelayEnvelope.decode(Data([1, 1, 0xff, 1, 66, 0])))
        var flagFrame = try RelayEnvelope(to: value.mac.id, from: value.phone.id, encrypted: false, body: Data("{}".utf8)).encode()
        flagFrame[flagFrame.count - 3] = 2
        XCTAssertThrowsError(try RelayEnvelope.decode(flagFrame))
    }

    func testFreshLinkIdentifiersUseUtf8ByteLimitsAndRejectControls() throws {
        XCTAssertThrowsError(try freshLinkInfo(from: String(repeating: "é", count: 128), to: "peer", senderNonce: String(repeating: "11", count: 32), receiverNonce: String(repeating: "22", count: 32)))
        XCTAssertThrowsError(try freshLinkInfo(from: "peer\nid", to: "peer", senderNonce: String(repeating: "11", count: 32), receiverNonce: String(repeating: "22", count: 32)))
        XCTAssertThrowsError(try freshLinkInfo(from: "", to: "peer", senderNonce: String(repeating: "11", count: 32), receiverNonce: String(repeating: "22", count: 32)))
    }

    func testRoutingMismatchPoisonsGeneration() async throws {
        let value = try fixture()
        let link = try receiver(value)
        _ = try await link.hello()
        let wrongRoute = try RelayEnvelope(
            to: value.mac.id,
            from: "other-peer",
            encrypted: false,
            body: Data(#"{"v":2,"type":"hello","nonce":"3131313131313131313131313131313131313131313131313131313131313131"}"#.utf8)
        ).encode()
        do {
            _ = try await link.receive(wrongRoute)
            XCTFail("routing mismatch was accepted")
        } catch {}
        do {
            _ = try await link.seal(Data([1]))
            XCTFail("routing mismatch did not poison the generation")
        } catch let error as FreshLinkError {
            XCTAssertEqual(error, .failed)
        }
    }

    func testRejectsTypeScriptHubAuthSignature() throws {
        struct AuthFixture: Decodable {
            struct Auth: Decodable {
                let payload: String
                let publicKey: String
                let signature: String
            }
            let hubAuth: Auth
        }
        let url = Bundle.module.url(forResource: "approval", withExtension: "json", subdirectory: "fixtures")!
        let value = try JSONDecoder().decode(AuthFixture.self, from: Data(contentsOf: url)).hubAuth
        let key = try P256.Signing.PublicKey(x963Representation: Data(hex: value.publicKey))
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: Data(base64Encoded: value.signature)!)
        XCTAssertTrue(key.isValidSignature(signature, for: Data(value.payload.utf8)))
    }
}
