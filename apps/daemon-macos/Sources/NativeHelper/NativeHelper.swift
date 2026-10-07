import Foundation
import NativeSupport
import CuaRemoteProtocol

@main
struct NativeHelper {
    @MainActor static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            let data: Data
            let encoder = JSONEncoder()
            switch args.first {
            case "stats" where args.count == 1: data = try encoder.encode(SystemState.stats())
            case "apps" where args.count == 1: data = try encoder.encode(Applications.list())
            case "permissions" where args.count == 1: data = try encoder.encode(Permissions.snapshot())
            case "confirm-pair" where args.count == 3:
                data = try encoder.encode(Permissions.confirmPair(phoneName: args[1], phoneID: args[2]))
            case "identity-load" where args.count == 2:
                data = try IdentityStore.response(stateDirectory: args[1])
            case "identity-save" where args.count == 2:
                try IdentityStore.save(FileHandle.standardInput.readDataToEndOfFile(), stateDirectory: args[1])
                data = Data("{\"saved\":true}".utf8)
            case "inventory" where args.count == 3:
                guard let phase = AppInventoryPhase(rawValue: args[2]) else { throw NativeFailure.unavailable("未知采集阶段") }
                data = try encoder.encode(Applications.inventory(bundleID: args[1], phase: phase))
            case "capture" where args.count == 2:
                guard let width = Int(args[1]) else { throw NativeFailure.unavailable("画面宽度必须是整数") }
                data = try await encoder.encode(ScreenCapture.image(maxWidth: width,
                    bundleID: ProcessInfo.processInfo.environment["CUAREMOTE_CAPTURE_BUNDLE_ID"]))
            default: throw NativeFailure.unavailable("用法：stats | apps | permissions | confirm-pair <phoneName> <phoneId> | identity-load|identity-save <stateDir> | inventory <bundleId> <phase> | capture <maxWidth>")
            }
            FileHandle.standardOutput.write(data + Data([10]))
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}
