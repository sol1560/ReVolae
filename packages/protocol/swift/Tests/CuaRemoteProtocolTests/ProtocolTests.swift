import XCTest
@testable import CuaRemoteProtocol

final class ProtocolTests: XCTestCase {
    func fixture(_ name: String) throws -> Data {
        let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "fixtures")!
        return try Data(contentsOf: url)
    }

    func testDecodesAllTSFixturesAndRoundTrips() throws {
        let arr = try JSONSerialization.jsonObject(with: fixture("messages")) as! [Any]
        for obj in arr {
            let data = try JSONSerialization.data(withJSONObject: obj)
            let m = try JSONDecoder().decode(AnyMessage.self, from: data)
            let re = try JSONEncoder().encode(m)
            let again = try JSONDecoder().decode(AnyMessage.self, from: re)
            XCTAssertEqual(m.typeName, again.typeName)
            XCTAssertEqual(m.typeName, (obj as! [String: Any])["type"] as! String)
        }
    }

    func testFrameAndRelayMatchTS() throws {
        struct Bin: Decodable { let frameHex: String; let relayHex: String; let challenge: String }
        let b = try JSONDecoder().decode(Bin.self, from: fixture("binary"))
        let frame = try Frame.decode(Data(hex: b.frameHex))
        XCTAssertEqual(frame.kind, .control)
        XCTAssertEqual(frame.streamId, 42)
        if case .intentSubmit(let m) = try frame.controlMessage() { XCTAssertEqual(m.text, "列出桌面上的 pdf") } else { XCTFail() }
        XCTAssertEqual(frame.encode().hexString, b.frameHex)
        let relay = try RelayEnvelope.decode(Data(hex: b.relayHex))
        XCTAssertEqual(relay.to, "phone-α"); XCTAssertEqual(relay.from, "mac-1"); XCTAssertTrue(relay.encrypted)
        XCTAssertEqual(try relay.encode().hexString, b.relayHex)
        XCTAssertEqual(approvalChallenge(runId: "r1", stepId: "s1", actionDetail: "rm -rf ~/x", nonce: "n0", expiresAt: 1700000000), b.challenge)
    }

    func testLevelComparable() {
        XCTAssertTrue(Level.l0 < Level.l2)
        XCTAssertEqual(max(Level.l1, Level.l0), .l1)
    }
}

extension Data {
    init(hex: String) {
        var d = Data(); var i = hex.startIndex
        while i < hex.endIndex { let j = hex.index(i, offsetBy: 2); d.append(UInt8(hex[i..<j], radix: 16)!); i = j }
        self = d
    }
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
