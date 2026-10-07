import Foundation
import Security
import XCTest
@testable import CuaRemoteProtocol

@MainActor
final class PhoneReconnectTests: XCTestCase {
    func testOnlyExplicitNetworkFailuresAreRetryable() {
        let network = URLError(.networkConnectionLost)
        for code in [1001, 1006, 1012, 1013] {
            XCTAssertTrue(PhoneConnection.canRetry(network, closeCode: code))
        }
        for code in [1000, 1002, 1008, 1011, 4001, 4999] {
            XCTAssertFalse(PhoneConnection.canRetry(network, closeCode: code))
        }
        XCTAssertTrue(PhoneConnection.canRetry(network, closeCode: 0))
        XCTAssertFalse(PhoneConnection.canRetry(URLError(.cancelled), closeCode: 0))
        XCTAssertFalse(PhoneConnection.canRetry(URLError(.serverCertificateUntrusted), closeCode: 0))
        XCTAssertFalse(PhoneConnection.canRetry(ConnectionError.invalid("bad key"), closeCode: 0))
        XCTAssertTrue(PhoneConnection.canRetry(NSError(domain: NSPOSIXErrorDomain, code: 57), closeCode: 0))
        XCTAssertFalse(PhoneConnection.canRetry(NSError(domain: NSPOSIXErrorDomain, code: 57), closeCode: 1000))
        XCTAssertFalse(PhoneConnection.canRetry(NSError(domain: NSPOSIXErrorDomain, code: 13), closeCode: 0))
    }

    #if os(macOS)
    /// 使用产品 Hub/JWT/真实手机身份签名与 URLSession，不是模拟认证回调。
    /// 没有手机配对或模型调用；不把它作为人工确认或真实 iPhone 的验收。
    func testRealHubFiniteBackoffStopAndAuthenticationFailures() async throws {
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = FileManager.default.temporaryDirectory.appending(path: "cuaremote-phone-reconnect-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let ready = directory.appending(path: "ready.json"), stats = directory.appending(path: "stats.json")
        let service = "cuaremote.phone.reconnect.test." + UUID().uuidString
        let connection = try PhoneConnection(service: service)
        let server = Process(), commands = Pipe()
        server.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["CUAREMOTE_BUN"] ?? NSHomeDirectory() + "/.bun/bin/bun")
        server.currentDirectoryURL = repository; server.standardInput = commands
        server.standardOutput = FileHandle.nullDevice; server.standardError = FileHandle.nullDevice
        server.arguments = ["--eval", """
        import {Hub} from './apps/hub/src/hub.ts';
        import {HubStore} from './apps/hub/src/db.ts';
        import {signJwt} from './apps/hub/src/auth.ts';
        import {writeFileSync,renameSync} from 'node:fs';
        import {createInterface} from 'node:readline';
        const secret=crypto.randomUUID(), store=new HubStore(':memory:'), sockets=new Set();
        const hub=new Hub({store,jwtSecret:secret});
        let opened=0,renames=0,initialClose=0;
        function stats(){writeFileSync(process.argv[2]+'.tmp',JSON.stringify({opened,renames}),{mode:0o600});renameSync(process.argv[2]+'.tmp',process.argv[2])}
        const server=Bun.serve({hostname:'127.0.0.1',port:0,
          fetch(req,srv){if(srv.upgrade(req,{data:{}}))return;return new Response('not found',{status:404})},
          websocket:{
            open(ws){opened++;stats();sockets.add(ws);ws.data.conn={send:d=>ws.send(d),close:(c,r)=>ws.close(c,r)};
              hub.onOpen(ws.data.conn);if(initialClose){ws.close(initialClose,'test initial close');initialClose=0}},
            message(ws,data){if(typeof data==='string'&&JSON.parse(data).type==='device.rename'){renames++;stats()}
              hub.onMessage(ws.data.conn,typeof data==='string'?data:new Uint8Array(data))},
            close(ws){hub.onClose(ws.data.conn);sockets.delete(ws)}
          }});
        const token=signJwt({sub:crypto.randomUUID(),exp:Math.floor(Date.now()/1000)+300},secret);
        writeFileSync(process.argv[1],JSON.stringify({url:`ws://127.0.0.1:${server.port}/ws`,token}),{mode:0o600});
        createInterface({input:process.stdin}).on('line',action=>{
          if(action==='initial'){initialClose=1013;return}
          for(const ws of sockets){if(action==='network')ws.terminate();else if(action==='invalid')ws.send('not JSON');else ws.close(Number(action),'test close')}
        });
        process.on('SIGTERM',()=>{server.stop(true);store.close();process.exit(0)});
        """, ready.path, stats.path]
        defer {
            connection.disconnect()
            if server.isRunning { server.terminate(); server.waitUntilExit() }
            let deletion = SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service,
                kSecAttrAccount: "identity"] as CFDictionary)
            XCTAssertEqual(deletion, errSecSuccess, "仅删除本测试独立 Keychain 身份")
            try? FileManager.default.removeItem(at: directory)
        }
        func waitFor(_ seconds: Int = 10, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async throws {
            for _ in 0..<(seconds * 20) where !condition() { try await Task.sleep(for: .milliseconds(50)) }
            _ = try XCTUnwrap(condition() ? true : nil, "真实连接状态未在指定时限内完成", file: file, line: line)
        }
        func send(_ command: String) throws { try commands.fileHandleForWriting.write(contentsOf: Data((command + "\n").utf8)) }
        func count(_ key: String) throws -> Int {
            let values = try JSONSerialization.jsonObject(with: Data(contentsOf: stats)) as? [String: Int]
            return try XCTUnwrap(values?[key])
        }
        var authenticated = 0, disconnected = 0, failures = 0
        connection.onMessage = { message, _ in if case .authOk = message { authenticated += 1 } }
        connection.onStatus = { status in
            print("PHONE_STATUS " + status)
            if status == "未连接" { disconnected += 1 }
        }
        connection.onError = { error in
            failures += 1
            print("PHONE_ERROR \((error as NSError).domain) \((error as NSError).code)")
        }
        try server.run()
        try await waitFor { FileManager.default.fileExists(atPath: ready.path) }
        let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: String]
        let url = try XCTUnwrap(URL(string: try XCTUnwrap(settings?["url"]))), token = try XCTUnwrap(settings?["token"])
        try await connection.connect(url: url, token: token)
        try await waitFor { authenticated == 1 }
        try await connection.rename(device: "no-such-device", name: "must-not-repeat", requestID: UUID().uuidString)
        try await waitFor { (try? count("renames")) == 1 }
        for (index, seconds) in [2, 4, 8, 16, 30].enumerated() {
            let before = ContinuousClock.now, lost = disconnected
            try send("network")
            try await waitFor { connection.reconnecting }
            XCTAssertGreaterThan(disconnected, lost, "设备与审批必须先失效，不能保持在线等待重连")
            XCTAssertEqual(connection.reconnectAttempts, index + 1)
            try await waitFor(40) { authenticated == index + 2 }
            XCTAssertGreaterThanOrEqual(before.duration(to: .now), .seconds(seconds))
            XCTAssertEqual(try count("renames"), 1, "重连不能重发修改请求")
        }
        try send("network")
        let beforeFailure = failures
        try await waitFor { failures > beforeFailure }
        let opensAtLimit = try count("opened")
        try await Task.sleep(for: .seconds(3))
        XCTAssertFalse(connection.reconnecting)
        XCTAssertEqual(connection.reconnectAttempts, 5)
        XCTAssertEqual(try count("opened"), opensAtLimit)

        var beforeAuth = authenticated
        try await connection.reconnect(); try await waitFor { authenticated == beforeAuth + 1 }
        try send("network"); try await waitFor { connection.reconnecting }
        connection.disconnect()
        let opensAtStop = try count("opened")
        try await Task.sleep(for: .seconds(3))
        XCTAssertFalse(connection.reconnecting)
        XCTAssertEqual(try count("opened"), opensAtStop)

        for command in ["4001", "1000", "invalid"] {
            beforeAuth = authenticated
            try await connection.reconnect(); try await waitFor { authenticated == beforeAuth + 1 }
            let failureCount = failures
            try send(command); try await waitFor { failures > failureCount }
            let stopped = try count("opened")
            try await Task.sleep(for: .seconds(3))
            XCTAssertFalse(connection.reconnecting)
            XCTAssertEqual(connection.reconnectAttempts, 0)
            XCTAssertEqual(try count("opened"), stopped)
        }
        let failureCount = failures
        try await connection.connect(url: url, token: "invalid-jwt")
        try await waitFor { failures > failureCount }
        let invalidOpens = try count("opened")
        try await Task.sleep(for: .seconds(3))
        XCTAssertFalse(connection.reconnecting); XCTAssertEqual(connection.reconnectAttempts, 0)
        XCTAssertEqual(try count("opened"), invalidOpens)

        try send("initial")
        try await Task.sleep(for: .milliseconds(100))
        let initialFailures = failures
        // 真实远端在初次认证前关闭，send 可能先于 receive 报错。
        do { try await connection.connect(url: url, token: token) } catch { }
        try await waitFor { failures > initialFailures }
        try await Task.sleep(for: .seconds(3))
        XCTAssertFalse(connection.reconnecting); XCTAssertEqual(connection.reconnectAttempts, 0)
        XCTAssertEqual(try count("opened"), invalidOpens + 1)
    }
    #endif
}
