import Darwin
import Foundation
import XCTest
@testable import CuaRemoteCore
import CuaRemoteProtocol

@MainActor
final class RemoteClientTests: XCTestCase {
    private final class MemoryStore: SecureValueStore {
        private var values: [String: Data] = [:]

        func data(forKey key: String) throws -> Data? { values[key] }
        func set(_ data: Data, forKey key: String) throws { values[key] = data }
        func removeValue(forKey key: String) throws { values[key] = nil }
    }

    private enum IntegrationError: Error {
        case hubFailedToStart
        case timedOut
    }

    private final class LocalHubProcess {
        private let process = Process()
        private let stdout = Pipe()
        private final class ReadyLineBox: @unchecked Sendable {
            private let lock = NSLock()
            private var value: String?
            func set(_ value: String?) { lock.lock(); self.value = value; lock.unlock() }
            func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
        }

        init(port: UInt16, repositoryRoot: URL) throws {
            let environment = ProcessInfo.processInfo.environment
            let bunCandidates = [
                environment["BUN_BIN"],
                "/Users/devin/.bun/bin/bun",
                "/opt/homebrew/bin/bun",
                "/usr/local/bin/bun",
            ].compactMap { $0 }
            let bunPath = bunCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
            if let bunPath {
                process.executableURL = URL(fileURLWithPath: bunPath)
                process.arguments = ["run", "apps/hub/test/remote-client-test-server.ts", String(port)]
            } else {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["bun", "run", "apps/hub/test/remote-client-test-server.ts", String(port)]
            }
            process.currentDirectoryURL = repositoryRoot
            process.environment = environment
            process.environment?["HUB_JWT_SECRET"] = nil
            process.environment?["HUB_CLOUD_BRAIN_PROVIDER"] = nil
            process.standardOutput = stdout
            process.standardError = FileHandle.nullDevice
            try process.run()
            guard readReadyLine() == "ready" else {
                stop()
                throw IntegrationError.hubFailedToStart
            }
        }

        func stop() {
            guard process.isRunning else { return }
            process.terminate()
            let deadline = Date().addingTimeInterval(3)
            while process.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
            if process.isRunning {
                _ = Darwin.kill(process.processIdentifier, SIGKILL)
            }
            process.waitUntilExit()
        }

        private func readReadyLine() -> String? {
            let semaphore = DispatchSemaphore(value: 0)
            let result = ReadyLineBox()
            let output = stdout
            DispatchQueue.global().async { [output] in
                result.set(Self.readLine(from: output.fileHandleForReading))
                semaphore.signal()
            }
            guard semaphore.wait(timeout: .now() + 20) == .success else { return nil }
            return result.get()
        }

        private static func readLine(from handle: FileHandle) -> String? {
            var line = Data()
            while line.count < 64 {
                let byte = handle.readData(ofLength: 1)
                guard let value = byte.first else { return nil }
                if value == 10 { return String(data: line, encoding: .utf8) }
                line.append(value)
            }
            return nil
        }
    }

    func testTwoClientsAuthenticatePairExchangeReconnectAndUnpairThroughLiveHub() async throws {
        let port = try await ephemeralPort()
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let hub = try LocalHubProcess(port: port, repositoryRoot: root)
        defer { hub.stop() }

        let hubURL = URL(string: "ws://127.0.0.1:\(port)/ws")!
        let device = try makeClient(role: .device, name: "Mac")
        let phone = try makeClient(role: .phone, name: "iPhone")
        var deviceControlCount = 0
        var phoneControlCount = 0
        device.onControl = { peerId, message in
            if peerId == phone.identity.deviceId, case .statsGet = message { deviceControlCount += 1 }
        }
        phone.onControl = { peerId, message in
            if peerId == device.identity.deviceId, case .statsGet = message { phoneControlCount += 1 }
        }

        try await device.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await phone.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await waitUntil { device.status == .connected && phone.status == .connected }

        let offer = try device.makePairOffer()
        try await phone.acceptPairOffer(json: offer, phoneName: "iPhone")
        try await waitUntil { device.pendingPairRequest?.phoneId == phone.identity.deviceId }
        try await device.confirmPair(deviceId: device.identity.deviceId, phoneId: phone.identity.deviceId)

        try await waitUntil {
            device.peers[phone.identity.deviceId]?.ready == true
                && phone.peers[device.identity.deviceId]?.ready == true
        }
        XCTAssertNotNil(try device.trustedPeer(deviceId: phone.identity.deviceId))
        XCTAssertNotNil(try phone.trustedPeer(deviceId: device.identity.deviceId))

        try await phone.send(.statsGet(StatsGet(id: "phone-to-device")), to: device.identity.deviceId)
        try await waitUntil { deviceControlCount == 1 }
        try await device.send(.statsGet(StatsGet(id: "device-to-phone")), to: phone.identity.deviceId)
        try await waitUntil { phoneControlCount == 1 }

        phone.disconnect()
        try await waitUntil {
            device.peers[phone.identity.deviceId]?.online == false
                && device.peers[phone.identity.deviceId]?.ready == false
        }

        try await phone.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await waitUntil {
            device.peers[phone.identity.deviceId]?.ready == true
                && phone.peers[device.identity.deviceId]?.ready == true
        }
        try await phone.send(.statsGet(StatsGet(id: "phone-reconnected")), to: device.identity.deviceId)
        try await waitUntil { deviceControlCount == 2 }
        try await device.send(.statsGet(StatsGet(id: "device-reconnected")), to: phone.identity.deviceId)
        try await waitUntil { phoneControlCount == 2 }

        try await device.unpair(phone.identity.deviceId)
        try await waitUntil {
            (try? device.trustedPeer(deviceId: phone.identity.deviceId))?.deviceId == nil
                && (try? phone.trustedPeer(deviceId: device.identity.deviceId))?.deviceId == nil
        }
        XCTAssertNil(try device.trustedPeer(deviceId: phone.identity.deviceId))
        XCTAssertNil(try phone.trustedPeer(deviceId: device.identity.deviceId))
        phone.disconnect()
        device.disconnect()
    }

    private func makeClient(role: RemoteRole, name: String) throws -> RemoteClient {
        let store = MemoryStore()
        let identity = try DeviceIdentityRepository(store: store).loadOrCreate()
        return RemoteClient(role: role, name: name, identity: identity, store: store)
    }

    private func waitUntil(
        timeout: TimeInterval = 15,
        _ condition: @MainActor () throws -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw IntegrationError.timedOut
    }

    private func ephemeralPort() async throws -> UInt16 {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw IntegrationError.hubFailedToStart }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw IntegrationError.hubFailedToStart }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let resolved = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        guard resolved == 0, actual.sin_port != 0 else { throw IntegrationError.hubFailedToStart }
        return UInt16(bigEndian: actual.sin_port)
    }
}
