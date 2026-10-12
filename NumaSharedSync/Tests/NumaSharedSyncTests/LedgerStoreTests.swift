import GRDB
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class LedgerStoreTests: XCTestCase {
    func testCurrencyCanOnlyBeConfirmedBeforeTheFirstLedgerEvent() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let jpy = try Currency(code: "JPY", exponent: 0)

        try store.confirmPotCurrency(jpy, for: fixture.potID)
        XCTAssertEqual(try store.potConfiguration(for: fixture.potID)?.currency, jpy)

        _ = try store.appendHeldLocalEvent(try fixture.event(id: 109))
        XCTAssertThrowsError(try store.confirmPotCurrency(.eur, for: fixture.potID)) {
            XCTAssertEqual($0 as? LedgerStoreError, .potCurrencyAlreadyInUse(fixture.potID))
        }
    }

    func testAppendLoadsReducerProjectionAndStoresQueryableMetadata() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try fixture.event(id: 110)

        let appended = try store.appendHeldLocalEvent(
            event,
            savedAt: Date(timeIntervalSince1970: 1_700_000_100)
        )

        XCTAssertGreaterThan(appended.localOrdinal, 0)
        XCTAssertEqual(appended.event, event)
        XCTAssertFalse(appended.legacyAuthoredText)
        XCTAssertFalse(try XCTUnwrap(
            store.loadStoredEvents(for: fixture.potID).first
        ).legacyAuthoredText)
        XCTAssertEqual(appended.delivery.state, .held)
        let reduction = try store.reduction(for: fixture.potID)
        XCTAssertEqual(reduction.access, .readWrite)
        XCTAssertEqual(
            reduction.projection.balances[fixture.payerID],
            Money(minorUnits: 5_000, currency: .eur)
        )
        XCTAssertEqual(
            reduction.projection.balances[fixture.beneficiaryID],
            Money(minorUnits: -5_000, currency: .eur)
        )

        let metadata = try store.databaseQueue.read { db in
            try Row.fetchOne(
                db,
                sql: """
                    SELECT recordID, kind, currencyCode, occurredAtMillis,
                           originatingTimeZone
                    FROM ledger_events WHERE eventID = ?
                    """,
                arguments: [event.id.description]
            )
        }
        XCTAssertEqual(metadata?["kind"] as String?, "expenseAdded")
        XCTAssertEqual(metadata?["currencyCode"] as String?, "EUR")
        XCTAssertEqual(metadata?["originatingTimeZone"] as String?, "Europe/Madrid")
        XCTAssertNotNil(metadata?["recordID"] as String?)
        XCTAssertNotNil(metadata?["occurredAtMillis"] as Int64?)
        XCTAssertThrowsError(try store.databaseQueue.write { db in
            try db.execute(
                sql: "UPDATE ledger_events SET kind = 'potRenamed' WHERE eventID = ?",
                arguments: [event.id.description]
            )
        })
    }

    func testUndoIsTransactionalAndHonorsEveryBoundary() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)

        let removable = try fixture.event(id: 120)
        _ = try store.appendHeldLocalEvent(removable, savedAt: savedAt)
        XCTAssertTrue(try store.undoHeldLocalEvent(
            eventID: removable.id,
            now: savedAt.addingTimeInterval(5.999),
            undoSessionIsActive: true
        ))
        XCTAssertTrue(try store.loadEvents(for: fixture.potID).isEmpty)

        let inactive = try fixture.event(id: 122)
        _ = try store.appendHeldLocalEvent(inactive, savedAt: savedAt)
        XCTAssertFalse(try store.undoHeldLocalEvent(
            eventID: inactive.id,
            now: savedAt.addingTimeInterval(2),
            undoSessionIsActive: false
        ))

        let boundary = try fixture.event(id: 124)
        _ = try store.appendHeldLocalEvent(boundary, savedAt: savedAt)
        XCTAssertFalse(try store.undoHeldLocalEvent(
            eventID: boundary.id,
            now: savedAt.addingTimeInterval(6),
            undoSessionIsActive: true
        ))
        XCTAssertEqual(try store.expireHeldEvents(now: savedAt.addingTimeInterval(6)), 2)
        _ = try store.markDispatching(
            eventID: inactive.id,
            at: savedAt.addingTimeInterval(6.5)
        )
        _ = try store.acknowledge(
            eventID: inactive.id,
            serverSequence: 1,
            at: savedAt.addingTimeInterval(6.75)
        )
        let delivery = try store.markDispatching(
            eventID: boundary.id,
            at: savedAt.addingTimeInterval(7)
        )
        XCTAssertNotNil(delivery.firstDispatchedAt)
        XCTAssertFalse(try store.undoHeldLocalEvent(
            eventID: boundary.id,
            now: savedAt.addingTimeInterval(7.5),
            undoSessionIsActive: true
        ))
    }

    func testDuplicateLocalEventDoesNotCreatePartialDeliveryRow() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try fixture.event(id: 130)
        _ = try store.appendHeldLocalEvent(event)

        XCTAssertThrowsError(try store.appendHeldLocalEvent(event)) { error in
            XCTAssertEqual(error as? LedgerStoreError, .duplicateEventID(event.id))
        }
        XCTAssertEqual(try store.loadEvents(for: fixture.potID).count, 1)
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 1)
    }

    func testProjectionSnapshotKeepsTerminalClassificationInternallyConsistent() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 132)
        _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        _ = try store.expireHeldEvents(now: savedAt.addingTimeInterval(6))

        let ready = try store.snapshot(for: fixture.potID)

        XCTAssertEqual(ready.reductionOrderedEvents.map(\.event.id), [event.id])
        XCTAssertEqual(ready.storedEvents.map(\.delivery.state), [.ready])
        XCTAssertEqual(ready.pendingDeliveryEventCount, 1)
        XCTAssertEqual(ready.reduction.projection.records.count, 1)

        _ = try store.markDispatching(
            eventID: event.id,
            at: savedAt.addingTimeInterval(7)
        )
        _ = try store.markTerminal(
            eventID: event.id,
            reason: "NOT_MEMBER",
            at: savedAt.addingTimeInterval(8)
        )

        let terminal = try store.snapshot(for: fixture.potID)

        XCTAssertTrue(terminal.reductionOrderedEvents.isEmpty)
        XCTAssertEqual(terminal.storedEvents.map(\.delivery.state), [.terminal])
        XCTAssertEqual(terminal.pendingDeliveryEventCount, 0)
        XCTAssertTrue(terminal.reduction.projection.records.isEmpty)
    }
}
