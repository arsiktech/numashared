import Foundation
import GRDB
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class RemoteIngestTests: XCTestCase {
    func testFutureWirePayloadSurvivesPathBackedRelaunchWithoutV1Decoding() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedFutureWire-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("ledger.sqlite").path
        let fixture = try SyncFixture()
        // A future schema may expand text limits. Its durable compatibility
        // barrier must not depend on today's authored-text admission rules.
        let futureTitle = String(repeating: "x", count: 513)
        let known = try WireEventV1(fixture.event(id: 189)).arithmeticOnly
        var eventObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(known)) as? [String: Any]
        )
        eventObject["schemaVersion"] = EventEnvelope.maximumSupportedSchemaVersion + 1
        eventObject["originatingTimeZone"] = "Mars/Olympus_Mons"
        eventObject["textFields"] = ["title", "futureCaption", "note"]
        eventObject["authoredText"] = []
        eventObject["payload"] = [
            "kind": "expenseAdded",
            "recordId": known.eventId.description,
            "content": "future-shape",
            "futureField": ["value": 42],
        ]
        let rawTextStates: JSONValue = .array([
            .object([
                "field": .string("title"),
                "state": .string("present"),
                "value": .string(futureTitle),
            ]),
            .object([
                "field": .string("futureCaption"),
                "format": .string("v2"),
                "state": .string("present"),
                "value": .string("future private text"),
            ]),
            .object([
                "field": .string("note"),
                "state": .string("redacted"),
            ]),
        ])
        let hydrated = try JSONDecoder().decode(
            HydratedWireEventV1.self,
            from: try PersistenceCoding.encode(JSONValue.object([
                "event": try JSONDecoder().decode(
                    JSONValue.self,
                    from: JSONSerialization.data(withJSONObject: eventObject)
                ),
                "serverSequence": .number(1),
                "textStates": rawTextStates,
            ]))
        )

        do {
            let store = try LedgerStore(path: path, fileProtection: .none)
            try store.registerPot(fixture.configuration)
            _ = try store.appendHeldLocalEvent(fixture.event(id: 188))
            XCTAssertEqual(try store.ingestRemoteEvent(hydrated), .inserted)
        }

        let reopened = try LedgerStore(path: path, fileProtection: .none)
        XCTAssertEqual(hydrated.event.textFields, [.title, .note])
        XCTAssertEqual(hydrated.textStates, [
            .present(field: .title, value: futureTitle),
            .redacted(field: .note),
        ])
        XCTAssertEqual(try reopened.textStates(for: known.eventId), hydrated.textStates)
        let event = try XCTUnwrap(reopened.loadEvents(for: fixture.potID).first)
        XCTAssertEqual(event.schemaVersion, EventEnvelope.maximumSupportedSchemaVersion + 1)
        guard case let .unsupported(kind, payload) = event.payload else {
            return XCTFail("Expected a persisted compatibility barrier")
        }
        XCTAssertEqual(kind, "expenseAdded")
        XCTAssertEqual(payload, .object([
            "recordId": .string(known.eventId.description),
            "content": .string("future-shape"),
            "futureField": .object(["value": .number(42)]),
        ]))
        XCTAssertEqual(
            try reopened.reduction(for: fixture.potID).access,
            .readOnly(.unsupportedSchema(
                eventID: event.id,
                encountered: EventEnvelope.maximumSupportedSchemaVersion + 1,
                supported: EventEnvelope.currentSchemaVersion
            ))
        )
        XCTAssertTrue(try reopened.reduction(for: fixture.potID).projection.appliedEventIDs.isEmpty)
        XCTAssertEqual(try reopened.unsyncedEventCount(for: fixture.potID), 1)

        let retained = try reopened.databaseQueue.read { db -> (StoredUnsupportedEventV1, JSONValue) in
            let arithmetic: Data = try XCTUnwrap(Data.fetchOne(
                db,
                sql: "SELECT envelopeBlob FROM ledger_events WHERE eventID = ?",
                arguments: [known.eventId.description]
            ))
            guard case let .unsupported(stored) = try PersistenceCoding
                .storedArithmeticEvent(from: arithmetic)
            else { throw TestError.expectedUnsupported }
            let statesBlob: Data = try XCTUnwrap(Data.fetchOne(
                db,
                sql: """
                    SELECT metadataBlob FROM event_future_text_sidecars
                    WHERE eventID = ?
                    """,
                arguments: [known.eventId.description]
            ))
            return (
                stored,
                try PersistenceCoding.decode(JSONValue.self, from: statesBlob)
            )
        }
        XCTAssertEqual(
            retained.0.opaqueFutureOriginatingTimeZoneIdentifier,
            "Mars/Olympus_Mons"
        )
        XCTAssertEqual(retained.0.opaqueFutureTextFields, .array([
            .string("title"), .string("futureCaption"), .string("note"),
        ]))
        XCTAssertEqual(retained.1, rawTextStates)

        XCTAssertEqual(
            try reopened.redactAuthoredText(
                for: known.eventId,
                field: .title,
                in: fixture.potID,
                advancingToTextRevision: 1
            ),
            1
        )
        let afterRedaction = try futureTextStates(eventID: known.eventId, in: reopened)
        guard case let .array(redactedStates) = afterRedaction else {
            return XCTFail("Expected retained future text-state array")
        }
        XCTAssertEqual(redactedStates[0], .object([
            "field": .string("title"),
            "state": .string("redacted"),
        ]))
        XCTAssertEqual(redactedStates[1], try XCTUnwrap({
            guard case let .array(states) = rawTextStates else { return nil }
            return states[1]
        }()))
        XCTAssertEqual(redactedStates[2], try XCTUnwrap({
            guard case let .array(states) = rawTextStates else { return nil }
            return states[2]
        }()))

        XCTAssertEqual(try reopened.redactAuthoredText(for: known.eventId), 2)
        XCTAssertNil(try futureTextStates(eventID: known.eventId, in: reopened))
        XCTAssertEqual(try reopened.ingestRemoteEvent(hydrated), .alreadyPresent)
        XCTAssertNil(try futureTextStates(eventID: known.eventId, in: reopened))
        XCTAssertEqual(try reopened.textStates(for: known.eventId), [
            .redacted(field: .title),
            .redacted(field: .note),
        ])
    }

    private func futureTextStates(
        eventID: EventID,
        in store: LedgerStore
    ) throws -> JSONValue? {
        try store.databaseQueue.read { db in
            guard let blob: Data = try Data.fetchOne(
                db,
                sql: """
                    SELECT metadataBlob FROM event_future_text_sidecars
                    WHERE eventID = ?
                    """,
                arguments: [eventID.description]
            ) else { return nil }
            return try PersistenceCoding.decode(JSONValue.self, from: blob)
        }
    }

    private enum TestError: Error {
        case expectedUnsupported
    }

    func testFutureSchemaAboveServerGapImmediatelyMakesReductionReadOnly() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let sequenceOne = try fixture.event(id: 190, sequence: 1)
        let localOptimistic = try fixture.event(id: 192)
        let futureBase = try fixture.event(id: 194, sequence: 3)
        let future = EventEnvelope(
            id: futureBase.id,
            potID: futureBase.potID,
            actorMemberID: futureBase.actorMemberID,
            occurredAt: futureBase.occurredAt,
            originatingTimeZone: futureBase.originatingTimeZone,
            schemaVersion: EventEnvelope.currentSchemaVersion + 1,
            serverSequence: futureBase.serverSequence,
            payload: futureBase.payload
        )

        _ = try store.ingestRemoteEvent(sequenceOne)
        _ = try store.appendHeldLocalEvent(localOptimistic)
        _ = try store.ingestRemoteEvent(future)

        let reduction = try store.reduction(for: fixture.potID)
        XCTAssertEqual(reduction.access, .readOnly(.unsupportedSchema(
            eventID: future.id,
            encountered: EventEnvelope.currentSchemaVersion + 1,
            supported: EventEnvelope.currentSchemaVersion
        )))
        XCTAssertEqual(reduction.projection.appliedEventIDs, [sequenceOne.id])
        XCTAssertEqual(
            reduction.projection.balances[fixture.payerID],
            Money(minorUnits: 5_000, currency: .eur)
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 1)
    }

    func testUnsupportedKindAboveServerGapBlocksLaterLocalOptimisticEvents() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let sequenceOne = try fixture.event(id: 196, sequence: 1)
        let localOptimistic = try fixture.event(id: 198)
        let unsupported = EventEnvelope(
            id: try EventID(validating: syncTestUUID(200)),
            potID: fixture.potID,
            actorMemberID: fixture.actorID,
            occurredAt: Date(timeIntervalSince1970: 1_700_000_200),
            originatingTimeZone: fixture.timeZone,
            serverSequence: 3,
            payload: .unsupported(
                kind: "expenseImported",
                payload: .object(["source": .string("future-client")])
            )
        )

        _ = try store.ingestRemoteEvent(sequenceOne)
        _ = try store.appendHeldLocalEvent(localOptimistic)
        _ = try store.ingestRemoteEvent(unsupported)

        XCTAssertEqual(
            try store.reductionOrderedEvents(for: fixture.potID).map(\.event.id),
            [sequenceOne.id, unsupported.id, localOptimistic.id]
        )
        let reduction = try store.reduction(for: fixture.potID)
        XCTAssertEqual(reduction.access, .readOnly(.unsupportedEventKind(
            eventID: unsupported.id,
            kind: "expenseImported"
        )))
        XCTAssertEqual(reduction.projection.appliedEventIDs, [sequenceOne.id])
        XCTAssertEqual(
            reduction.projection.balances[fixture.payerID],
            Money(minorUnits: 5_000, currency: .eur)
        )
        XCTAssertFalse(reduction.projection.appliedEventIDs.contains(localOptimistic.id))
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 1)
    }

    func testReductionBuffersRemoteGapAndKeepsLocalAcknowledgementOptimisticUntilConvergence() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let localSequenceThree = try fixture.event(id: 184)

        _ = try store.appendHeldLocalEvent(localSequenceThree, savedAt: savedAt)
        _ = try store.expireHeldEvents(now: savedAt.addingTimeInterval(6))
        _ = try store.markDispatching(
            eventID: localSequenceThree.id,
            at: savedAt.addingTimeInterval(7)
        )
        _ = try store.acknowledge(
            eventID: localSequenceThree.id,
            serverSequence: 3,
            at: savedAt.addingTimeInterval(8)
        )

        let optimistic = try store.reduction(for: fixture.potID)
        XCTAssertEqual(optimistic.projection.appliedEventIDs, [localSequenceThree.id])
        XCTAssertNil(optimistic.projection.lastAppliedServerSequence)
        XCTAssertNil(try revision(
            eventID: localSequenceThree.id,
            in: optimistic.projection
        ).serverSequence)

        let remoteSequenceTwo = try fixture.event(id: 186, sequence: 2)
        _ = try store.ingestRemoteEvent(
            remoteSequenceTwo,
            receivedAt: savedAt.addingTimeInterval(9)
        )

        let withRemoteGap = try store.reduction(for: fixture.potID)
        XCTAssertEqual(withRemoteGap.projection.appliedEventIDs, [localSequenceThree.id])
        XCTAssertEqual(
            withRemoteGap.projection.balances[fixture.payerID],
            Money(minorUnits: 5_000, currency: .eur)
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 0)

        let remoteSequenceOne = try fixture.event(id: 188, sequence: 1)
        _ = try store.ingestRemoteEvent(
            remoteSequenceOne,
            receivedAt: savedAt.addingTimeInterval(10)
        )

        let converged = try store.reduction(for: fixture.potID)
        XCTAssertEqual(
            converged.projection.appliedEventIDs,
            [remoteSequenceOne.id, remoteSequenceTwo.id, localSequenceThree.id]
        )
        XCTAssertEqual(converged.projection.lastAppliedServerSequence, 3)
        XCTAssertEqual(try revision(
            eventID: localSequenceThree.id,
            in: converged.projection
        ).serverSequence, 3)
        XCTAssertEqual(
            converged.projection.balances[fixture.payerID],
            Money(minorUnits: 15_000, currency: .eur)
        )

        let origins = Dictionary(uniqueKeysWithValues: try store
            .loadStoredEvents(for: fixture.potID)
            .map { ($0.event.id, $0.origin) })
        XCTAssertEqual(origins[localSequenceThree.id], .local)
        XCTAssertEqual(origins[remoteSequenceOne.id], .remote)
        XCTAssertEqual(origins[remoteSequenceTwo.id], .remote)
    }

    func testRemoteIngestIsIdempotentAndOrderedAheadOfPendingByServerSequence() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let pendingFirst = try fixture.event(id: 160)
        let pendingSecond = try fixture.event(id: 162)
        let sequenceTwo = try fixture.event(id: 164, sequence: 2)
        let sequenceOne = try fixture.event(id: 166, sequence: 1)
        _ = try store.appendHeldLocalEvent(pendingFirst)
        _ = try store.ingestRemoteEvent(sequenceTwo)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 0)
        _ = try store.appendHeldLocalEvent(pendingSecond)
        _ = try store.ingestRemoteEvent(sequenceOne)

        XCTAssertEqual(
            try store.loadEvents(for: fixture.potID).map(\.id),
            [sequenceOne.id, sequenceTwo.id, pendingFirst.id, pendingSecond.id]
        )
        XCTAssertEqual(try store.ingestRemoteEvent(sequenceOne), .alreadyPresent)
        XCTAssertEqual(try store.loadEvents(for: fixture.potID).count, 4)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 2)

        let conflictingPayload = try fixture.event(
            id: 166,
            sequence: 1,
            title: "Changed immutable content"
        )
        XCTAssertThrowsError(try store.ingestRemoteEvent(conflictingPayload)) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .immutableEventConflict(sequenceOne.id)
            )
        }
        let duplicateSequence = try fixture.event(id: 168, sequence: 2)
        XCTAssertThrowsError(try store.ingestRemoteEvent(duplicateSequence)) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .serverSequenceConflict(potID: fixture.potID, sequence: 2)
            )
        }
    }

    func testRemoteEchoAcknowledgesExistingLocalEventWithoutChangingOrdinal() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let local = try fixture.event(id: 170)
        let appended = try store.appendHeldLocalEvent(local)
        let echo = try fixture.event(id: 170, sequence: 11)

        XCTAssertEqual(
            try store.ingestRemoteEvent(echo),
            .acknowledgedExistingLocal
        )
        let stored = try XCTUnwrap(store.loadStoredEvents(for: fixture.potID).first)
        XCTAssertEqual(stored.localOrdinal, appended.localOrdinal)
        XCTAssertEqual(stored.event.serverSequence, 11)
        XCTAssertEqual(stored.delivery.state, .acknowledged)
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 0)
        XCTAssertFalse(try store.undoHeldLocalEvent(
            eventID: local.id,
            now: Date(),
            undoSessionIsActive: true
        ))
    }

    func testOutOfOrderLocalAcknowledgementDoesNotSkipCursorGap() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let local = try fixture.event(id: 180)
        _ = try store.appendHeldLocalEvent(local, savedAt: savedAt)
        _ = try store.expireHeldEvents(now: savedAt.addingTimeInterval(6))
        _ = try store.markDispatching(eventID: local.id, at: savedAt.addingTimeInterval(7))
        _ = try store.acknowledge(
            eventID: local.id,
            serverSequence: 2,
            at: savedAt.addingTimeInterval(8)
        )

        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 0)

        let missingFirst = try fixture.event(id: 182, sequence: 1)
        _ = try store.ingestRemoteEvent(missingFirst, receivedAt: savedAt.addingTimeInterval(9))
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 2)
    }

    private func revision(
        eventID: EventID,
        in projection: LedgerProjection
    ) throws -> RevisionProjection {
        try XCTUnwrap(projection.records.values.lazy.compactMap { record in
            guard case let .revisable(revisable) = record else { return nil }
            return revisable.revisions.first(where: { $0.eventID == eventID })
        }.first)
    }
}
