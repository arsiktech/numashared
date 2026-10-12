import Foundation
import XCTest
@testable import NumaShared

final class PotRegistryTests: XCTestCase {
    func testStateRoundTripsThroughJSON() throws {
        let pot = LocalPotDescriptor(
            id: UUID(),
            name: "Casa Mar",
            currencyCode: "EUR",
            databaseName: PotRegistry.legacyDatabaseName,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let state = PotRegistry.State(pots: [pot], activeID: pot.id)
        let decoded = try JSONDecoder().decode(
            PotRegistry.State.self,
            from: JSONEncoder().encode(state)
        )
        XCTAssertEqual(decoded, state)
    }

    func testStatePersistsAndLoadsFromInjectedDirectory() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let pot = LocalPotDescriptor(
            id: UUID(),
            name: "Casa Mar",
            currencyCode: "EUR",
            databaseName: PotRegistry.legacyDatabaseName,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let state = PotRegistry.State(pots: [pot], activeID: pot.id)

        try PotRegistry.save(state, in: directory)

        XCTAssertEqual(try PotRegistry.load(from: directory), state)
    }

    func testCorruptRegistryThrowsInsteadOfMasqueradingAsMissing() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("not-json".utf8).write(
            to: directory.appendingPathComponent("pots-v1.json")
        )

        XCTAssertThrowsError(try PotRegistry.load(from: directory))
    }

    func testRegistryRejectsMissingActiveAndDuplicateDatabases() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = LocalPotDescriptor(
            id: UUID(),
            name: "First",
            currencyCode: "EUR",
            databaseName: PotRegistry.legacyDatabaseName,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let second = LocalPotDescriptor(
            id: UUID(),
            name: "Second",
            currencyCode: "EUR",
            databaseName: PotRegistry.legacyDatabaseName,
            createdAt: Date(timeIntervalSince1970: 1_700_000_001)
        )

        XCTAssertThrowsError(try PotRegistry.save(.init(
            pots: [first],
            activeID: UUID()
        ), in: directory))
        XCTAssertThrowsError(try PotRegistry.save(.init(
            pots: [first, second],
            activeID: first.id
        ), in: directory))
    }

    func testNewDatabaseNamesAreUniqueSQLiteFilesAndNeverLegacy() {
        let names = Set((0 ..< 64).map { _ in PotRegistry.newDatabaseName() })
        XCTAssertEqual(names.count, 64)
        XCTAssertFalse(names.contains(PotRegistry.legacyDatabaseName))
        for name in names {
            XCTAssertTrue(name.hasPrefix("pot-"))
            XCTAssertTrue(name.hasSuffix(".sqlite"))
        }
    }

    func testAccountExitDeletesEveryManagedStoreAndSidecar() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("PotRegistryTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let customDatabase = "pot-abcd1234.sqlite"
        let removableFiles = [
            PotRegistry.legacyDatabaseName,
            "\(PotRegistry.legacyDatabaseName)-wal",
            "\(PotRegistry.legacyDatabaseName)-shm",
            "identity-v1.json",
            customDatabase,
            "\(customDatabase)-wal",
            "\(customDatabase)-shm",
            "\(customDatabase).identity-v1.json",
        ]
        for filename in removableFiles {
            try Data("private".utf8).write(
                to: directory.appendingPathComponent(filename)
            )
        }
        let unrelatedURL = directory.appendingPathComponent("keep-me.txt")
        try Data("public".utf8).write(to: unrelatedURL)

        try PotRegistry.removeAccountStores(
            named: [PotRegistry.legacyDatabaseName, customDatabase],
            from: directory
        )

        for filename in removableFiles {
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: directory.appendingPathComponent(filename).path
            ))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelatedURL.path))
    }

    func testAccountExitRejectsUnmanagedDatabaseNamesBeforeDeletingAnything() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("PotRegistryTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let managedURL = directory.appendingPathComponent(PotRegistry.legacyDatabaseName)
        try Data("private".utf8).write(to: managedURL)

        XCTAssertThrowsError(try PotRegistry.removeAccountStores(
            named: [PotRegistry.legacyDatabaseName, "../outside.sqlite"],
            from: directory
        ))
        XCTAssertTrue(FileManager.default.fileExists(atPath: managedURL.path))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("PotRegistryTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }
}
