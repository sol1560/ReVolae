// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CuaRemoteMac",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "cuaremote-macos", targets: ["CuaRemoteMac"]),
        .executable(name: "cuaremote-native-helper", targets: ["NativeHelper"]),
        .executable(name: "cuaremote-menu", targets: ["MacMenu"]),
    ],
    dependencies: [.package(path: "../../packages/protocol/swift")],
    targets: [
        .target(name: "MacLauncher"),
        .target(name: "NativeSupport", dependencies: [.product(name: "CuaRemoteProtocol", package: "swift")]),
        .executableTarget(name: "NativeHelper", dependencies: ["NativeSupport"]),
        .executableTarget(name: "CuaRemoteMac", dependencies: ["MacLauncher"]),
        .executableTarget(name: "MacMenu", dependencies: ["MacLauncher", "NativeSupport"]),
        .testTarget(name: "MacLauncherTests", dependencies: ["MacLauncher"]),
        .testTarget(name: "NativeSupportTests", dependencies: ["NativeSupport"]),
        .testTarget(name: "MacMenuTests", dependencies: ["MacMenu"]),
    ]
)
