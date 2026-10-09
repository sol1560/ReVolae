// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CuaRemoteMac",
    platforms: [.macOS(.v15)],
    products: [.library(name: "CuaRemoteMac", targets: ["CuaRemoteMac"])],
    dependencies: [
        .package(path: "../apple"),
        .package(path: "../protocol/swift"),
    ],
    targets: [
        .target(
            name: "CuaRemoteMac",
            dependencies: [
                .product(name: "CuaRemoteCore", package: "apple"),
                .product(name: "CuaRemoteProtocol", package: "swift"),
            ]
        ),
        .testTarget(
            name: "CuaRemoteMacTests",
            dependencies: [
                "CuaRemoteMac",
                .product(name: "CuaRemoteCore", package: "apple"),
                .product(name: "CuaRemoteProtocol", package: "swift"),
            ]
        ),
    ]
)
