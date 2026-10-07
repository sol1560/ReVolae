import Darwin
import Foundation
import XCTest
@testable import MacMenu

@MainActor
final class HostModelTests: XCTestCase {
    private var repository: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    func testUnstartedAndInvalidConfiguration() {
        let model = HostModel()
        XCTAssertFalse(model.running)
        XCTAssertEqual(model.connectionLabel, "未连接")
        model.start()
        XCTAssertFalse(model.running)
        XCTAssertEqual(model.error, "请选择允许访问的目录，并为所有路径使用绝对路径")
    }

    /// 真实 hub、JWT、Bun 设备、Keychain、CLI 和管道；不调用模型，也不假装人工配对。
    func testActualLauncherAuthenticationRefreshSameProcessAndStop() async throws {
        let temp = FileManager.default.temporaryDirectory.appending(path: "cuaremote-menu-test-" + UUID().uuidString)
        let work = temp.appending(path: "work"), state = temp.appending(path: "state"), ready = temp.appending(path: "hub.json")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let bun = ProcessInfo.processInfo.environment["CUAREMOTE_BUN"] ?? NSHomeDirectory() + "/.bun/bin/bun"
        let hub = Process()
        hub.executableURL = URL(fileURLWithPath: bun)
        hub.currentDirectoryURL = repository
        hub.arguments = ["--eval", """
        import {createHubServer} from './apps/hub/src/server.ts';
        import {HubStore} from './apps/hub/src/db.ts';
        import {signJwt} from './apps/hub/src/auth.ts';
        import {writeFileSync} from 'node:fs';
        const secret=crypto.randomUUID(), store=new HubStore(':memory:');
        const {server,url}=createHubServer({port:0,hostname:'127.0.0.1',store,jwtSecret:secret});
        const token=signJwt({sub:crypto.randomUUID(),exp:Math.floor(Date.now()/1000)+300},secret);
        writeFileSync(process.argv[1],JSON.stringify({url,token}),{mode:0o600});
        process.on('SIGTERM',()=>{server.stop(true);store.close();process.exit(0)});
        """, ready.path]
        hub.standardOutput = FileHandle.nullDevice; hub.standardError = FileHandle.nullDevice
        let model = HostModel(executables: repository.appending(path: "apps/daemon-macos/.build/debug"))
        var authenticated = false
        try hub.run()
        do {
            for _ in 0..<100 where !FileManager.default.fileExists(atPath: ready.path) { try await Task.sleep(for: .milliseconds(50)) }
            let payload = try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: String]
            model.repository = repository.path; model.bun = bun
            model.hub = try XCTUnwrap(payload?["url"]); model.token = try XCTUnwrap(payload?["token"])
            model.allowedDirectory = work.path; model.stateDirectory = state.path
            model.provider = "ollama:qwen3" // 仅配置真实本地供应方；本测试不提交任务、不调用模型。
            model.start()
            for _ in 0..<200 where model.hostStatus?.connection != .authenticated { try await Task.sleep(for: .milliseconds(50)); model.refresh() }
            authenticated = model.hostStatus?.connection == .authenticated
            XCTAssertTrue(authenticated, "真实设备应完成 JWT 和签名认证")
            XCTAssertTrue(model.running)
            let launchBefore = try Data(contentsOf: state.appending(path: "launcher.json"))
            let code = try XCTUnwrap(model.pairingCode)
            model.refreshPairing()
            for _ in 0..<200 where model.refreshingPairing { try await Task.sleep(for: .milliseconds(50)) }
            XCTAssertFalse(model.refreshingPairing, "必须收到真实标准输出回执")
            XCTAssertNil(model.error)
            XCTAssertNotEqual(model.pairingCode, code, "刷新应更换一次性码")
            XCTAssertEqual(try Data(contentsOf: state.appending(path: "launcher.json")), launchBefore, "刷新不能重启进程")
            // 文件被设备消费或移除后，下一次采样不能继续显示缓存的短期码。
            try FileManager.default.removeItem(at: state.appending(path: "pairing.json"))
            model.refresh()
            XCTAssertNil(model.pairingCode)
            XCTAssertNil(model.pairingExpiry)
            await model.stop()
            XCTAssertFalse(model.running)
            XCTAssertNil(model.hostStatus)
            XCTAssertFalse(FileManager.default.fileExists(atPath: state.appending(path: "launcher.json").path))
        } catch {
            await model.stop()
            cleanup(hub: hub, state: state, temp: temp, expectedIdentity: authenticated)
            throw error
        }
        cleanup(hub: hub, state: state, temp: temp, expectedIdentity: authenticated)
    }

    /// 使用真实 Hub 登录、设备签名、CLI 与 Keychain，仅通过受控 socket 制造断网。
    func testNetworkReconnectKeepsValidatedConfigurationAndStopCancelsRetry() async throws {
        let temp = FileManager.default.temporaryDirectory.appending(path: "cuaremote-reconnect-menu-" + UUID().uuidString)
        let work = temp.appending(path: "work"), state = temp.appending(path: "state"), ready = temp.appending(path: "hub.json")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let bun = ProcessInfo.processInfo.environment["CUAREMOTE_BUN"] ?? NSHomeDirectory() + "/.bun/bin/bun"
        let hub = Process(), commands = Pipe()
        hub.executableURL = URL(fileURLWithPath: bun); hub.currentDirectoryURL = repository
        hub.standardInput = commands; hub.standardOutput = FileHandle.nullDevice; hub.standardError = FileHandle.nullDevice
        hub.arguments = ["--eval", """
        import {Hub} from './apps/hub/src/hub.ts';
        import {HubStore} from './apps/hub/src/db.ts';
        import {signJwt} from './apps/hub/src/auth.ts';
        import {writeFileSync} from 'node:fs';
        import {createInterface} from 'node:readline';
        const secret=crypto.randomUUID(), store=new HubStore(':memory:'), sockets=new Set();
        const hub=new Hub({store,jwtSecret:secret});
        const server=Bun.serve({hostname:'127.0.0.1',port:0,
          fetch(req,srv){if(new URL(req.url).pathname==='/ws'&&srv.upgrade(req,{data:{}}))return;return hub.handleHttp(req)},
          websocket:{
            open(ws){sockets.add(ws);ws.data.conn={send:d=>ws.send(d),close:(c,r)=>ws.close(c,r)};hub.onOpen(ws.data.conn)},
            message(ws,data){hub.onMessage(ws.data.conn,typeof data==='string'?data:new Uint8Array(data))},
            close(ws){hub.onClose(ws.data.conn);sockets.delete(ws)}
          }});
        const token=signJwt({sub:crypto.randomUUID(),exp:Math.floor(Date.now()/1000)+300},secret);
        writeFileSync(process.argv[1],JSON.stringify({url:`ws://127.0.0.1:${server.port}/ws`,token}),{mode:0o600});
        createInterface({input:process.stdin}).on('line',action=>{
          for(const ws of sockets){if(action==='network')ws.terminate();else if(action==='auth')ws.close(4001,'test revoked')}
        });
        process.on('SIGTERM',()=>{server.stop(true);store.close();process.exit(0)});
        """, ready.path]
        let model = HostModel(executables: repository.appending(path: "apps/daemon-macos/.build/debug"))
        var authenticated = false
        func waitFor(seconds: Int = 10, _ condition: () -> Bool) async throws {
            for _ in 0..<(seconds * 20) where !condition() { try await Task.sleep(for: .milliseconds(50)); model.refresh() }
            _ = try XCTUnwrap(condition() ? true : nil, "真实连接状态未在指定时限内完成")
        }
        func send(_ action: String) throws { try commands.fileHandleForWriting.write(contentsOf: Data((action + "\n").utf8)) }
        try hub.run()
        do {
            try await waitFor { FileManager.default.fileExists(atPath: ready.path) }
            let payload = try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: String]
            let hubURL = try XCTUnwrap(payload?["url"]), token = try XCTUnwrap(payload?["token"])
            model.repository = repository.path; model.bun = bun; model.hub = hubURL; model.token = token
            model.allowedDirectory = work.path; model.stateDirectory = state.path; model.provider = "ollama:qwen3"
            model.start()
            try await waitFor { model.hostStatus?.connection == .authenticated }
            authenticated = true
            XCTAssertEqual(model.token, "")
            let firstProcess = try Data(contentsOf: state.appending(path: "launcher.json"))
            // 自动恢复必须使用已验证快照，不能依赖被清空或改动的表单。
            model.hub = "ws://127.0.0.1:1/ws"; model.allowedDirectory = ""; model.stateDirectory = ""
            try send("network")
            try await waitFor { model.retrying }
            XCTAssertEqual(model.reconnectAttempts, 1)
            try await waitFor { model.hostStatus?.connection == .authenticated }
            XCTAssertNotEqual(try Data(contentsOf: state.appending(path: "launcher.json")), firstProcess)
            XCTAssertEqual(model.token, ""); XCTAssertNil(model.error)
            try send("network")
            try await waitFor { model.retrying }
            XCTAssertEqual(model.reconnectAttempts, 2)
            await model.stop()
            try await Task.sleep(for: .seconds(5))
            XCTAssertFalse(model.running); XCTAssertFalse(model.retrying)
            XCTAssertFalse(FileManager.default.fileExists(atPath: state.appending(path: "launcher.json").path))

            // 用户重新发起连接后，认证类关闭不能自动恢复。
            model.hub = hubURL; model.allowedDirectory = work.path; model.stateDirectory = state.path; model.token = token
            model.start(); try await waitFor { model.hostStatus?.connection == .authenticated }
            try send("auth"); try await waitFor { !model.running }
            try await Task.sleep(for: .seconds(3))
            XCTAssertFalse(model.retrying); XCTAssertFalse(model.running); XCTAssertEqual(model.reconnectAttempts, 0)

            // 首次登录令牌错误同样只失败一次，不保留可自动重试的凭据。
            model.token = "invalid-jwt"; model.start()
            try await waitFor { !model.running }
            try await Task.sleep(for: .seconds(3))
            XCTAssertFalse(model.retrying); XCTAssertEqual(model.reconnectAttempts, 0)
            XCTAssertNotNil(model.error)

            // 实际等待全部五档退避；第六次断网必须停止，防止无限后台重启。
            model.token = token; model.start()
            try await waitFor { model.hostStatus?.connection == .authenticated }
            for (index, seconds) in [2, 4, 8, 16, 30].enumerated() {
                let before = ContinuousClock.now
                try send("network")
                try await waitFor { model.retrying }
                XCTAssertEqual(model.reconnectAttempts, index + 1)
                try await waitFor(seconds: 40) { model.hostStatus?.connection == .authenticated }
                XCTAssertGreaterThanOrEqual(before.duration(to: .now), .seconds(seconds))
            }
            try send("network"); try await waitFor { !model.running }
            try await Task.sleep(for: .seconds(3))
            XCTAssertFalse(model.running); XCTAssertFalse(model.retrying)
            XCTAssertEqual(model.reconnectAttempts, 5)
            XCTAssertFalse(FileManager.default.fileExists(atPath: state.appending(path: "launcher.json").path))
            await model.stop()
        } catch {
            await model.stop()
            cleanup(hub: hub, state: state, temp: temp, expectedIdentity: authenticated)
            throw error
        }
        cleanup(hub: hub, state: state, temp: temp, expectedIdentity: authenticated)
    }

    private func cleanup(hub: Process, state: URL, temp: URL, expectedIdentity: Bool) {
        if hub.isRunning { hub.terminate(); hub.waitUntilExit() }
        if let resolved = realpath(state.path, nil) {
            defer { free(resolved) }
            let deletion = Process()
            deletion.executableURL = URL(fileURLWithPath: "/usr/bin/security")
            deletion.arguments = ["delete-generic-password", "-s", "io.cuaremote.device.identity", "-a", String(cString: resolved)]
            deletion.standardOutput = FileHandle.nullDevice; deletion.standardError = FileHandle.nullDevice
            do {
                try deletion.run(); deletion.waitUntilExit()
                XCTAssertTrue(deletion.terminationStatus == 0 || (!expectedIdentity && deletion.terminationStatus == 44), "本测试 Keychain 条目必须清理")
            } catch { XCTFail("未能清理本测试 Keychain 条目") }
        }
        try? FileManager.default.removeItem(at: temp)
    }
}
