import Foundation
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class DeliveryTests: XCTestCase {
    func testAttemptCountOverflowFailsDeterministicallyAndSchemaRejectsNonInteger() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 130)
        _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        _ = try store.expireHeldEvents(now: savedAt.addingTimeInterval(6))
        try store.databaseQueue.write { db in
            try db.execute(
                sql: "UPDATE event_delivery SET attemptCount = ? WHERE eventID = ?",
                arguments: [Int.max, event.id.description]
            )
        }

        XCTAssertThrowsError(try store.markDispatching(
            eventID: event.id,
            at: savedAt.addingTimeInterval(7)
        )) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .attemptCountOverflow(event.id)
            )
        }
        let delivery = try XCTUnwrap(
            store.loadStoredEvents(for: fixture.potID).first?.delivery
        )
        XCTAssertEqual(delivery.state, .ready)
        XCTAssertEqual(delivery.attemptCount, Int.max)
        XCTAssertThrowsError(try store.databaseQueue.write { db in
            try db.execute(
                sql: "UPDATE event_delivery SET attemptCount = 1.5 WHERE eventID = ?",
                arguments: [event.id.description]
            )
        })
    }

    func testHeldHeadBlocksLaterReadyEvent() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let heldHead = try fixture.event(id: 132)
        let laterReady = try fixture.event(id: 134)

        _ = try store.appendHeldLocalEvent(
            heldHead,
            savedAt: now.addingTimeInterval(100)
        )
        _ = try store.appendHeldLocalEvent(laterReady, savedAt: now)
        XCTAssertEqual(try store.expireHeldEvents(now: now.addingTimeInterval(6)), 1)

        XCTAssertTrue(
            try store.readyEvents(for: fixture.potID, at: now.addingTimeInterval(7)).isEmpty
        )
    }

    func testRetryDelayedHeadBlocksLaterReadyEvent() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let delayedHead = try fixture.event(id: 136)
        let laterReady = try fixture.event(id: 138)
        _ = try store.appendHeldLocalEvent(delayedHead, savedAt: now)
        _ = try store.appendHeldLocalEvent(laterReady, savedAt: now)
        _ = try store.expireHeldEvents(now: now.addingTimeInterval(6))
        _ = try store.markDispatching(
            eventID: delayedHead.id,
            at: now.addingTimeInterval(7)
        )
        let retryAt = now.addingTimeInterval(20)
        _ = try store.scheduleRetry(
            eventID: delayedHead.id,
            noEarlierThan: retryAt,
            at: now.addingTimeInterval(8)
        )

        XCTAssertTrue(
            try store.readyEvents(for: fixture.potID, at: retryAt.addingTimeInterval(-0.001)).isEmpty
        )
        XCTAssertThrowsError(try store.markDispatching(
            eventID: delayedHead.id,
            at: retryAt.addingTimeInterval(-0.001)
        ))
        XCTAssertEqual(
            try store.readyEvents(for: fixture.potID, at: retryAt).map(\.event.id),
            [delayedHead.id]
        )
    }

    func testExplicitRetryClearsDelayOnlyForReadyRows() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let events = try [136, 138, 140, 142].map {
            try fixture.event(id: UInt16($0))
        }
        for event in events {
            _ = try store.appendHeldLocalEvent(event, savedAt: now)
        }
        _ = try store.expireHeldEvents(now: now.addingTimeInterval(6))
        let retryMillis = try PersistenceCoding.milliseconds(now.addingTimeInterval(300))
        try store.databaseQueue.write { db in
            for (event, state) in zip(events, ["ready", "held", "dispatching", "terminal"]) {
                try db.execute(
                    sql: """
                        UPDATE event_delivery
                        SET state = ?, nextRetryAtMillis = ?
                        WHERE eventID = ?
                        """,
                    arguments: [state, retryMillis, event.id.description]
                )
            }
        }

        XCTAssertEqual(
            try store.makeRetryEligible(potID: fixture.potID, at: now),
            1
        )
        let deliveries = try store.loadStoredEvents(for: fixture.potID).map(\.delivery)
        XCTAssertEqual(deliveries.map(\.state), [.ready, .held, .dispatching, .terminal])
        XCTAssertNil(deliveries[0].nextRetryAt)
        XCTAssertNotNil(deliveries[1].nextRetryAt)
        XCTAssertNotNil(deliveries[2].nextRetryAt)
        XCTAssertNotNil(deliveries[3].nextRetryAt)
        XCTAssertEqual(deliveries.map(\.attemptCount), [0, 0, 0, 0])
    }

    func testDispatchingHeadBlocksLaterReadyEventAndDirectBypass() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let head = try fixture.event(id: 142)
        let laterReady = try fixture.event(id: 144)
        _ = try store.appendHeldLocalEvent(head, savedAt: now)
        _ = try store.appendHeldLocalEvent(laterReady, savedAt: now)
        _ = try store.expireHeldEvents(now: now.addingTimeInterval(6))

        XCTAssertThrowsError(try store.markDispatching(
            eventID: laterReady.id,
            at: now.addingTimeInterval(7)
        )) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .eventNotDispatchable(laterReady.id)
            )
        }
        _ = try store.markDispatching(eventID: head.id, at: now.addingTimeInterval(7))
        XCTAssertTrue(
            try store.readyEvents(for: fixture.potID, at: now.addingTimeInterval(7)).isEmpty
        )
        XCTAssertThrowsError(try store.markDispatching(
            eventID: laterReady.id,
            at: now.addingTimeInterval(7)
        )) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .eventNotDispatchable(laterReady.id)
            )
        }
    }

    func testPromotionAcknowledgementBatchRollsBackEveryDeliveryOnConflict() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try fixture.event(id: 145)
        let second = try fixture.event(id: 147)
        _ = try store.appendHeldLocalEvent(first, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(second, savedAt: savedAt)
        let now = savedAt.addingTimeInterval(7)
        _ = try store.expireHeldEvents(now: now)

        XCTAssertThrowsError(try store.acknowledgePromotionBatch([
            EventAcknowledgement(eventID: first.id, serverSequence: 1),
            EventAcknowledgement(eventID: second.id, serverSequence: 1),
        ], at: now)) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .serverSequenceConflict(potID: fixture.potID, sequence: 1)
            )
        }
        let deliveries = try store.loadStoredEvents(for: fixture.potID).map(\.delivery)
        XCTAssertEqual(deliveries.map(\.state), [.ready, .ready])
        XCTAssertEqual(deliveries.map(\.attemptCount), [0, 0])
        XCTAssertEqual(deliveries.map(\.serverSequence), [nil, nil])
    }

    func testTerminalHeadReleasesLaterReadyEvent() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let rejectedHead = try fixture.event(id: 146)
        let laterReady = try fixture.event(id: 148)
        _ = try store.appendHeldLocalEvent(rejectedHead, savedAt: now)
        _ = try store.appendHeldLocalEvent(laterReady, savedAt: now)
        _ = try store.expireHeldEvents(now: now.addingTimeInterval(6))
        _ = try store.markDispatching(
            eventID: rejectedHead.id,
            at: now.addingTimeInterval(7)
        )
        _ = try store.markTerminal(
            eventID: rejectedHead.id,
            reason: "authorization rejected",
            at: now.addingTimeInterval(8)
        )

        XCTAssertEqual(
            try store.readyEvents(for: fixture.potID, at: now.addingTimeInterval(8)).map(\.event.id),
            [laterReady.id]
        )
        XCTAssertEqual(
            try store.markDispatching(
                eventID: laterReady.id,
                at: now.addingTimeInterval(8)
            ).state,
            .dispatching
        )
    }

    func testDispatchAndAcknowledgementNeverMutateCanonicalEvent() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 140)
        _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        let immutableBefore = try store.canonicalEnvelopeData(for: event.id)

        XCTAssertEqual(try store.expireHeldEvents(now: savedAt.addingTimeInterval(6)), 1)
        let dispatching = try store.markDispatching(
            eventID: event.id,
            at: savedAt.addingTimeInterval(7)
        )
        XCTAssertEqual(dispatching.state, .dispatching)
        XCTAssertEqual(dispatching.attemptCount, 1)
        XCTAssertNotNil(dispatching.firstDispatchedAt)

        let acknowledged = try store.acknowledge(
            eventID: event.id,
            serverSequence: 1,
            at: savedAt.addingTimeInterval(8)
        )
        XCTAssertEqual(acknowledged.state, .acknowledged)
        XCTAssertEqual(acknowledged.serverSequence, 1)
        XCTAssertEqual(try store.canonicalEnvelopeData(for: event.id), immutableBefore)
        XCTAssertEqual(try store.loadEvents(for: fixture.potID).first?.serverSequence, 1)
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 0)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 1)
        XCTAssertEqual(
            try store.acknowledge(eventID: event.id, serverSequence: 1),
            acknowledged
        )
        XCTAssertThrowsError(try store.acknowledge(
            eventID: event.id,
            serverSequence: 2
        )) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .serverSequenceConflict(potID: fixture.potID, sequence: 2)
            )
        }

        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: immutableBefore) as? [String: Any]
        )
        XCTAssertNil(json["serverSequence"])
    }

    func testRetrySchedulingAndTerminalFailureRemainUnsynced() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 150)
        _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        _ = try store.expireHeldEvents(now: savedAt.addingTimeInterval(6))
        _ = try store.markDispatching(eventID: event.id, at: savedAt.addingTimeInterval(7))
        XCTAssertEqual(
            try store.reduction(for: fixture.potID).projection.balances[fixture.payerID],
            Money(minorUnits: 5_000, currency: .eur)
        )

        let retryAt = savedAt.addingTimeInterval(20)
        let retry = try store.scheduleRetry(
            eventID: event.id,
            noEarlierThan: retryAt,
            at: savedAt.addingTimeInterval(8)
        )
        XCTAssertEqual(retry.state, .ready)
        XCTAssertEqual(retry.attemptCount, 1)
        XCTAssertTrue(try store.readyEvents(
            for: fixture.potID,
            at: retryAt.addingTimeInterval(-0.001)
        ).isEmpty)
        XCTAssertEqual(try store.readyEvents(for: fixture.potID, at: retryAt).count, 1)

        let terminal = try store.markTerminal(
            eventID: event.id,
            reason: "server rejected schema",
            at: retryAt
        )
        XCTAssertEqual(terminal.state, .terminal)
        XCTAssertEqual(terminal.terminalReason, "server rejected schema")
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 1)
        XCTAssertTrue(try store.readyEvents(for: fixture.potID, at: retryAt).isEmpty)
        XCTAssertEqual(try store.loadEvents(for: fixture.potID).map(\.id), [event.id])
        XCTAssertEqual(
            try store.loadStoredEvents(for: fixture.potID).first?.delivery.state,
            .terminal
        )
        let rejectedReduction = try store.reduction(for: fixture.potID)
        XCTAssertEqual(
            rejectedReduction.projection.balances[fixture.payerID],
            Money.zero(currency: .eur)
        )
        XCTAssertEqual(
            rejectedReduction.projection.balances[fixture.beneficiaryID],
            Money.zero(currency: .eur)
        )
    }
}
