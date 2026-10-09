// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CuaRemoteCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "CuaRemoteCore", targets: ["CuaRemoteCore"])],
    dependencies: [
        .package(path: "../protocol/swift"),
    ],
    targets: [
        .target(name: "CuaRemoteCore", dependencies: [.product(name: "CuaRemoteProtocol", package: "swift")]),
        .testTarget(name: "CuaRemoteCoreTests", dependencies: ["CuaRemoteCore", .product(name: "CuaRemoteProtocol", package: "swift")], path: "Tests/CuaRemoteCoreTests", resources: [.copy("fixtures")]),
    ]
)
