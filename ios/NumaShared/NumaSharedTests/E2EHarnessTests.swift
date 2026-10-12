#if DEBUG
import Foundation
import XCTest
@testable import NumaShared

final class E2EHarnessTests: XCTestCase {
    func testConfigurationFailureCanUseTheMinimalSafeLaunchEnvelope() throws {
        let environment = [
            "NUMA_SHARED_E2E_RUN_ID": "p2-diagnostic",
            "NUMA_SHARED_E2E_ROLE": "A",
            "NUMA_SHARED_E2E_COMMAND": "create-one",
        ]
        let arguments = [NumaSharedE2EConfiguration.launchArgument]

        let envelope = try XCTUnwrap(
            NumaSharedE2ELaunchEnvelope.process(
                arguments: arguments,
                environment: environment
            )
        )
        XCTAssertThrowsError(
            try NumaSharedE2EConfiguration.process(
                arguments: arguments,
                environment: environment
            )
        )

        let artifactURL = temporaryArtifactURL()
        defer { try? FileManager.default.removeItem(at: artifactURL.deletingLastPathComponent()) }
        try NumaSharedE2EDiagnosticArtifact.writeFailure(
            envelope: envelope,
            stage: .configuration,
            code: .configurationUnavailable,
            to: artifactURL,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )

        let artifact = try decodedArtifact(at: artifactURL)
        XCTAssertEqual(artifact["kind"] as? String, "NUMA_SHARED_E2E_DIAGNOSTIC_V1")
        XCTAssertEqual(artifact["ready"] as? Bool, false)
        XCTAssertEqual(artifact["terminal"] as? Bool, true)
        XCTAssertEqual(artifact["runID"] as? String, "p2-diagnostic")
        XCTAssertEqual(artifact["role"] as? String, "A")
        XCTAssertEqual(artifact["command"] as? String, "create-one")
        XCTAssertEqual(artifact["stage"] as? String, "configuration")
        XCTAssertEqual(
            artifact["failureCode"] as? String,
            "E2E_CONFIGURATION_UNAVAILABLE"
        )
    }

    func testDiagnosticTransitionIsAtomicBoundedAndSecretFree() throws {
        let secret = "sentinel-bootstrap-secret-that-must-never-be-written"
        let privateURL = "http://127.0.0.1:3211/private?token=sentinel"
        let environment = [
            "NUMA_SHARED_E2E_RUN_ID": "p2-transition",
            "NUMA_SHARED_E2E_ROLE": "B",
            "NUMA_SHARED_E2E_COMMAND": "observe",
            "NUMA_SHARED_E2E_BOOTSTRAP_SECRET": secret,
            "NUMA_SHARED_E2E_SITE_URL": privateURL,
        ]
        let envelope = try XCTUnwrap(
            NumaSharedE2ELaunchEnvelope.process(
                arguments: [NumaSharedE2EConfiguration.launchArgument],
                environment: environment
            )
        )
        let artifactURL = temporaryArtifactURL()
        defer { try? FileManager.default.removeItem(at: artifactURL.deletingLastPathComponent()) }

        try NumaSharedE2EDiagnosticArtifact.writeProgress(
            envelope: envelope,
            stage: .authentication,
            to: artifactURL,
            now: Date(timeIntervalSince1970: 1_700_000_001)
        )
        var artifact = try decodedArtifact(at: artifactURL)
        XCTAssertEqual(artifact["terminal"] as? Bool, false)
        XCTAssertNil(artifact["failureCode"] as? String)

        try NumaSharedE2EDiagnosticArtifact.writeFailure(
            envelope: envelope,
            stage: .authentication,
            code: .transportUnavailable,
            to: artifactURL,
            now: Date(timeIntervalSince1970: 1_700_000_002)
        )
        let data = try Data(contentsOf: artifactURL)
        artifact = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(artifact["terminal"] as? Bool, true)
        XCTAssertEqual(artifact["failureCode"] as? String, "E2E_TRANSPORT_UNAVAILABLE")
        XCTAssertLessThan(data.count, 1_024)
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertFalse(text.contains(secret))
        XCTAssertFalse(text.contains(privateURL))
        XCTAssertFalse(text.contains("token=sentinel"))
    }

    private func temporaryArtifactURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("diagnostic.json")
    }

    private func decodedArtifact(at url: URL) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
    }
}
#endif
