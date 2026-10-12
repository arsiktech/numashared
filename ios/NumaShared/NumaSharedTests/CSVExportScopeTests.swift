import Foundation
import NumaSharedCore
import NumaSharedSync
import XCTest
@testable import NumaShared

final class CSVExportScopeTests: XCTestCase {
    @MainActor
    func testCompletionReportsFreshnessOnlyAfterPublishingCurrentFile() async throws {
        for fresh in [true, false] {
            let model = try await makeModel()
            var completed = 0
            let task = try XCTUnwrap(model.prepareCSVExportForTesting(
                privacyRefresh: { fresh }, writer: { try self.write("scoped history", in: $0) },
                onPrepared: { url, privacyIsCurrent in
                    completed += 1
                    XCTAssertEqual(url, model.csvExportURL)
                    XCTAssertEqual(privacyIsCurrent, fresh)
                    XCTAssertEqual(model.csvExportPrivacyWarning == nil, fresh)
                }))
            await task.value
            XCTAssertEqual(completed, 1)
            if let url = model.csvExportURL { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        }
    }

    @MainActor
    func testInvalidatedExportNeverCallsShareCompletion() async throws {
        let model = try await makeModel()
        let gate = ExportScopeGate(entered: expectation(description: "writer suspended"))
        var completed = false
        let task = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: { true }, writer: { directory in
            let file = try self.write("old private history", in: directory)
            await gate.wait()
            return file
        }, onPrepared: { _, _ in completed = true }))
        await fulfillment(of: [gate.entered], timeout: 1)
        model.beginNewPot()
        gate.release()
        await task.value
        XCTAssertFalse(completed)
        XCTAssertNil(model.csvExportURL)
    }

    @MainActor
    func testFailedRefreshRetiresPreviouslyWarnedExport() async throws {
        for failureDuringPreflight in [true, false] {
            let model = try await makeModel()
            let initialTask = try XCTUnwrap(model.prepareCSVExportForTesting(
                privacyRefresh: { false }, writer: { try self.write("older private history", in: $0) }
            ))
            await initialTask.value
            let oldURL = try XCTUnwrap(model.csvExportURL)
            XCTAssertNotNil(model.csvExportPrivacyWarning)
            XCTAssertTrue(FileManager.default.fileExists(atPath: oldURL.path))

            var writerCalled = false
            let refreshTask = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: {
                if failureDuringPreflight { throw ExportRefreshFailure.expected }
                return true
            }, writer: { _ in
                writerCalled = true
                throw ExportRefreshFailure.expected
            }))
            // The old file must stop being shareable before asynchronous work,
            // including any partial remote redaction, can begin.
            XCTAssertNil(model.csvExportURL)
            XCTAssertNil(model.csvExportRowCount)
            XCTAssertFalse(FileManager.default.fileExists(atPath: oldURL.path))
            await refreshTask.value
            XCTAssertEqual(writerCalled, !failureDuringPreflight)
            XCTAssertNil(model.csvExportURL)
            XCTAssertNil(model.csvExportPrivacyWarning)
            XCTAssertNotNil(model.csvExportErrorMessage)
            XCTAssertFalse(model.isPreparingCSVExport)
        }
    }

    @MainActor
    func testRedactionDuringWriterDiscardsFileButPreflightRevisionCanPublish() async throws {
        let store = try LedgerStore.inMemory()
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let context = try await repository.syncContext()
        let units = context.configuration.orderedUnitIDs
        let event = EventEnvelope(potID: context.configuration.id, actorMemberID: context.ownerMemberID,
            occurredAt: Date(), originatingTimeZone: try IANATimeZone("UTC"),
            payload: .expenseAdded(ExpenseAddedPayload(recordID: .generate(), content: ExpenseContent(
                kind: .shared, title: "Private before erasure", amount: Money(minorUnits: 500, currency: .eur),
                payerUnitID: units[0], allocations: [ExpenseAllocation(unitID: units[1],
                    amount: Money(minorUnits: 500, currency: .eur))]))))
        _ = try store.appendHeldLocalEvent(event)
        let model = AppModel(repository: repository, snapshot: try await repository.refreshSnapshot(),
            accountDeletionRecoveryStore: AccountDeletionRecoveryStore(directory:
                FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
        let gate = ExportScopeGate(entered: expectation(description: "unredacted file suspended"))
        var oldURL: URL?
        let staleTask = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: { true }, writer: { directory in
            let file = try await repository.writeCSVExport(potName: "House", temporaryDirectory: directory)
            oldURL = file.url
            await gate.wait()
            return file
        }))
        await fulfillment(of: [gate.entered], timeout: 1)
        XCTAssertTrue(try String(contentsOf: XCTUnwrap(oldURL), encoding: .utf8).contains("Private before erasure"))
        _ = try store.redactAuthoredText(for: event.id)
        model.applySnapshotForTesting(try await repository.refreshSnapshot())
        gate.release()
        await staleTask.value
        XCTAssertNil(model.csvExportURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(oldURL).path))
        XCTAssertFalse(model.isPreparingCSVExport)
        XCTAssertEqual(model.csvExportErrorMessage, "History changed while preparing this file. Prepare the export again.")

        let freshTask = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: {
            model.applySnapshotForTesting(try await repository.refreshSnapshot())
            return true
        }, writer: { try await repository.writeCSVExport(potName: "House", temporaryDirectory: $0) }))
        await freshTask.value
        let freshURL = try XCTUnwrap(model.csvExportURL)
        defer { try? FileManager.default.removeItem(at: freshURL.deletingLastPathComponent().deletingLastPathComponent()) }
        XCTAssertFalse(try String(contentsOf: freshURL, encoding: .utf8).contains("Private before erasure"))
    }

    @MainActor
    func testPotSwitchDiscardsSuspendedPrivacyResultWithoutClearingNewRequest() async throws {
        let model = try await makeModel()
        let oldGate = ExportScopeGate(entered: expectation(description: "old privacy suspended"))
        let newGate = ExportScopeGate(entered: expectation(description: "new privacy suspended"))
        var oldWriterCalled = false
        let oldTask = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: {
            await oldGate.wait()
            return false
        }, writer: { directory in
            oldWriterCalled = true
            return try self.write("old", in: directory)
        }))
        await fulfillment(of: [oldGate.entered], timeout: 1)
        model.beginNewPot()
        XCTAssertFalse(model.isPreparingCSVExport)
        let newTask = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: {
            await newGate.wait()
            return true
        }, writer: { try self.write("new", in: $0) }))
        await fulfillment(of: [newGate.entered], timeout: 1)
        oldGate.release()
        await oldTask.value
        XCTAssertFalse(oldWriterCalled)
        XCTAssertTrue(model.isPreparingCSVExport)
        XCTAssertNil(model.csvExportURL)
        XCTAssertNil(model.csvExportPrivacyWarning)
        XCTAssertNil(model.csvExportErrorMessage)
        newGate.release()
        await newTask.value
        let url = try XCTUnwrap(model.csvExportURL)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "new")
        XCTAssertFalse(model.isPreparingCSVExport)
    }

    @MainActor
    func testLateOldWriterCannotPublishOrDeleteNewSameNameExport() async throws {
        let model = try await makeModel()
        let gate = ExportScopeGate(entered: expectation(description: "old writer suspended"))
        var oldDirectory: URL?
        let oldTask = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: { false }, writer: { directory in
            oldDirectory = directory
            let file = try self.write("old private data", in: directory)
            await gate.wait()
            return file
        }))
        await fulfillment(of: [gate.entered], timeout: 1)
        model.beginNewPot()
        let newTask = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: { true },
            writer: { try self.write("new scoped data", in: $0) }))
        await newTask.value
        let newURL = try XCTUnwrap(model.csvExportURL)
        defer { try? FileManager.default.removeItem(at: newURL.deletingLastPathComponent()) }
        gate.release()
        await oldTask.value
        XCTAssertEqual(model.csvExportURL, newURL)
        XCTAssertEqual(try String(contentsOf: newURL, encoding: .utf8), "new scoped data")
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(oldDirectory).path))
        XCTAssertNil(model.csvExportPrivacyWarning)
        XCTAssertNil(model.csvExportErrorMessage)
        XCTAssertFalse(model.isPreparingCSVExport)
    }

    @MainActor
    private func makeModel() async throws -> AppModel {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        return AppModel(repository: repository, snapshot: snapshot,
            accountDeletionRecoveryStore: AccountDeletionRecoveryStore(directory:
                FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
    }

    @MainActor
    private func write(_ value: String, in directory: URL) throws -> LedgerCSVFile {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("same-name.csv")
        try Data(value.utf8).write(to: url, options: [.atomic, .completeFileProtection])
        return LedgerCSVFile(url: url, rowCount: 1)
    }
}

private enum ExportRefreshFailure: Error { case expected }

@MainActor
private final class ExportScopeGate {
    let entered: XCTestExpectation
    private var continuation: CheckedContinuation<Void, Never>?

    init(entered: XCTestExpectation) { self.entered = entered }

    func wait() async {
        await withCheckedContinuation {
            continuation = $0
            entered.fulfill()
        }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}
