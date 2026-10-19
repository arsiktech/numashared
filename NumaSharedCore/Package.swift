// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "NumaSharedCore",
    platforms: [
        .iOS("26.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "NumaSharedCore", type: .dynamic, targets: ["NumaSharedCore"]),
    ],
    targets: [
        .target(name: "NumaSharedCore"),
        .testTarget(
            name: "NumaSharedCoreTests",
            dependencies: ["NumaSharedCore"],
            resources: [
                .copy("Fixtures/wire-events-v1.json"),
                .copy("Fixtures/authored-text-blank-parity.json"),
                .copy("Fixtures/time-zone-identifier-parity.json"),
                .copy("Fixtures/build-11-reader-contract.json"),
            ]
        ),
    ]
)
