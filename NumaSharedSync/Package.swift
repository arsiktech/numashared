// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "NumaSharedSync",
    platforms: [
        .iOS("26.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "NumaSharedSync", type: .dynamic, targets: ["NumaSharedSync"]),
    ],
    dependencies: [
        .package(path: "../NumaSharedCore"),
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1"),
        .package(url: "https://github.com/get-convex/convex-swift.git", exact: "0.8.1"),
    ],
    targets: [
        .target(
            name: "NumaSharedSync",
            dependencies: [
                "NumaSharedCore",
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "ConvexMobile", package: "convex-swift"),
            ]
        ),
        .testTarget(
            name: "NumaSharedSyncTests",
            dependencies: [
                "NumaSharedSync",
                "NumaSharedCore",
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "ConvexMobile", package: "convex-swift"),
            ]
        ),
    ]
)
