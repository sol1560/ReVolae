// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CuaRemoteProtocol",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [.library(name: "CuaRemoteProtocol", targets: ["CuaRemoteProtocol"])],
    targets: [
        .target(name: "CuaRemoteProtocol", path: "Sources/CuaRemoteProtocol"),
        .testTarget(name: "CuaRemoteProtocolTests", dependencies: ["CuaRemoteProtocol"], path: "Tests/CuaRemoteProtocolTests", resources: [.copy("fixtures")]),
    ]
)
