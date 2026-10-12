import GRDB
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class AuthoredTextPersistenceTests: XCTestCase {
    func testRedactionHardDeletesTextWithoutChangingArithmeticOrResurrectingOnReplay() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try eventWithCategory(
            fixture: fixture,
            id: 300,
            title: "Madrid groceries",
            category: "Household"
        )

        _ = try store.appendHeldLocalEvent(event)

        let arithmeticBefore = try store.canonicalEnvelopeData(for: event.id)
        XCTAssertFalse(arithmeticBefore.contains(Data("Madrid groceries".utf8)))
        XCTAssertFalse(arithmeticBefore.contains(Data("Household".utf8)))
        XCTAssertEqual(
            try store.textStates(for: event.id),
            [
                .present(field: .title, value: "Madrid groceries"),
                .present(field: .category, value: "Household"),
            ]
        )
        XCTAssertThrowsError(try store.databaseQueue.write { db in
            try db.execute(
                sql: """
                    UPDATE event_text_sidecars SET value = 'Changed'
                    WHERE eventID = ? AND field = 'title'
                    """,
                arguments: [event.id.description]
            )
        })

        XCTAssertEqual(
            try store.redactAuthoredText(
                for: event.id,
                fields: [.title, .category]
            ),
            2
        )
        XCTAssertEqual(try store.canonicalEnvelopeData(for: event.id), arithmeticBefore)
        XCTAssertEqual(
            try store.textStates(for: event.id),
            [.redacted(field: .title), .redacted(field: .category)]
        )
        XCTAssertEqual(try sidecarCount(eventID: event.id, in: store), 0)

        let redacted = try XCTUnwrap(store.loadEvents(for: fixture.potID).first)
        guard case let .expenseAdded(payload) = redacted.payload else {
            return XCTFail("Expected expenseAdded")
        }
        XCTAssertEqual(payload.content.title, WireEventV1.redactedTextPlaceholder)
        XCTAssertEqual(payload.content.category, WireEventV1.redactedTextPlaceholder)
        XCTAssertEqual(
            try store.reduction(for: fixture.potID).projection.balances[fixture.payerID],
            Money(minorUnits: 5_000, currency: .eur)
        )

        let serverEcho = try eventWithCategory(
            fixture: fixture,
            id: 300,
            sequence: 1,
            title: "Madrid groceries",
            category: "Household"
        )
        XCTAssertEqual(try store.ingestRemoteEvent(serverEcho), .acknowledgedExistingLocal)
        XCTAssertEqual(try sidecarCount(eventID: event.id, in: store), 0)
        XCTAssertEqual(
            try store.textStates(for: event.id),
            [.redacted(field: .title), .redacted(field: .category)]
        )
    }

    func testExplicitRemoteRedactionHydratesPlaceholderAndDeletesRetainedText() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try eventWithCategory(
            fixture: fixture,
            id: 302,
            title: "Train tickets",
            category: "Travel"
        )
        let wire = try WireEventV1(event)
        let firstHydration = try HydratedWireEventV1(
            event: wire.arithmeticOnly,
            serverSequence: 1,
            textStates: [
                .present(field: .title, value: "Train tickets"),
                .present(field: .category, value: "Travel"),
            ]
        )

        XCTAssertEqual(try store.ingestRemoteEvent(firstHydration), .inserted)
        XCTAssertEqual(try sidecarCount(eventID: event.id, in: store), 2)

        let redactedHydration = try HydratedWireEventV1(
            event: wire.arithmeticOnly,
            serverSequence: 1,
            textStates: [
                .redacted(field: .title),
                .present(field: .category, value: "Travel"),
            ]
        )
        XCTAssertEqual(try store.ingestRemoteEvent(redactedHydration), .alreadyPresent)
        XCTAssertEqual(try sidecarCount(eventID: event.id, in: store), 1)
        XCTAssertEqual(
            try store.textStates(for: event.id),
            [
                .redacted(field: .title),
                .present(field: .category, value: "Travel"),
            ]
        )
    }

    func testRevisionedRemoteRedactionDeletesTextAndAdvancesCursorAtomically() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try eventWithCategory(
            fixture: fixture,
            id: 303,
            sequence: 1,
            title: "Train tickets",
            category: "Travel"
        )
        try store.ingestRemoteEvent(event)
        let changedAt = Date(timeIntervalSince1970: 1_700_001_000)

        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 0)
        XCTAssertEqual(
            try store.redactAuthoredText(
                for: event.id,
                field: .title,
                in: fixture.potID,
                advancingToTextRevision: 1,
                at: changedAt
            ),
            1
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 1)
        XCTAssertThrowsError(
            try store.redactAuthoredText(
                for: event.id,
                field: .category,
                in: fixture.potID,
                advancingToTextRevision: 1,
                at: changedAt
            )
        ) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .nonContiguousTextRevision(expected: 2, actual: 1)
            )
        }
        XCTAssertEqual(
            try store.textStates(for: event.id),
            [
                .redacted(field: .title),
                .present(field: .category, value: "Travel"),
            ]
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 1)

        XCTAssertEqual(
            try store.redactAuthoredText(
                for: event.id,
                field: .category,
                in: fixture.potID,
                advancingToTextRevision: 2,
                at: changedAt.addingTimeInterval(1)
            ),
            1
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 2)
        XCTAssertEqual(
            try store.textStates(for: event.id),
            [.redacted(field: .title), .redacted(field: .category)]
        )
    }

    func testUnknownPayloadIsLosslessInPurgeableSidecarAndNeverResurrects() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = EventEnvelope(
            id: try EventID(validating: syncTestUUID(304)),
            potID: fixture.potID,
            actorMemberID: fixture.actorID,
            occurredAt: Date(timeIntervalSince1970: 1_700_000_304),
            originatingTimeZone: fixture.timeZone,
            serverSequence: 1,
            payload: .unsupported(
                kind: "expenseImported",
                payload: .object([
                    "source": .string("future-client"),
                    "rows": .array([.number(1), .number(2)]),
                ])
            )
        )

        XCTAssertEqual(try store.ingestRemoteEvent(event), .inserted)
        let arithmetic = try store.canonicalEnvelopeData(for: event.id)
        XCTAssertFalse(arithmetic.contains(Data("future-client".utf8)))
        XCTAssertEqual(try opaqueSidecarCount(eventID: event.id, in: store), 1)
        XCTAssertEqual(try store.loadEvents(for: fixture.potID), [event])

        XCTAssertEqual(try store.redactAuthoredText(for: event.id), 1)
        XCTAssertEqual(try opaqueSidecarCount(eventID: event.id, in: store), 0)
        XCTAssertEqual(try store.canonicalEnvelopeData(for: event.id), arithmetic)
        guard case let .unsupported(kind, payload) = try XCTUnwrap(
            store.loadEvents(for: fixture.potID).first
        ).payload else {
            return XCTFail("Expected unsupported compatibility barrier")
        }
        XCTAssertEqual(kind, "expenseImported")
        XCTAssertEqual(payload, .object([:]))
        XCTAssertEqual(
            try store.reduction(for: fixture.potID).access,
            .readOnly(.unsupportedEventKind(eventID: event.id, kind: "expenseImported"))
        )

        XCTAssertEqual(try store.ingestRemoteEvent(event), .alreadyPresent)
        XCTAssertEqual(try opaqueSidecarCount(eventID: event.id, in: store), 0)
    }

    func testUnknownHydrationRetainsTextManifestAndHonorsRedactionWithoutResurrection() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let known = try WireEventV1(fixture.event(id: 306)).arithmeticOnly
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(known)) as? [String: Any]
        )
        object["textFields"] = ["title", "note"]
        object["authoredText"] = []
        object["payload"] = [
            "kind": "expenseImported",
            "source": "future-client",
        ]
        let unknown = try JSONDecoder().decode(
            WireEventV1.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
        let first = try HydratedWireEventV1(
            event: unknown,
            serverSequence: 1,
            textStates: [
                .present(field: .title, value: "Imported expense"),
                .redacted(field: .note),
            ]
        )

        XCTAssertEqual(try store.ingestRemoteEvent(first), .inserted)
        XCTAssertEqual(
            try store.textStates(for: unknown.eventId),
            [
                .present(field: .title, value: "Imported expense"),
                .redacted(field: .note),
            ]
        )
        XCTAssertEqual(try sidecarCount(eventID: unknown.eventId, in: store), 1)

        let replay = try HydratedWireEventV1(
            event: unknown,
            serverSequence: 1,
            textStates: [
                .redacted(field: .title),
                .redacted(field: .note),
            ]
        )
        XCTAssertEqual(try store.ingestRemoteEvent(replay), .alreadyPresent)
        XCTAssertEqual(
            try store.textStates(for: unknown.eventId),
            [.redacted(field: .title), .redacted(field: .note)]
        )
        XCTAssertEqual(try sidecarCount(eventID: unknown.eventId, in: store), 0)

        XCTAssertEqual(try store.ingestRemoteEvent(first), .alreadyPresent)
        XCTAssertEqual(
            try store.textStates(for: unknown.eventId),
            [.redacted(field: .title), .redacted(field: .note)]
        )
        XCTAssertEqual(try sidecarCount(eventID: unknown.eventId, in: store), 0)
    }

    private func eventWithCategory(
        fixture: SyncFixture,
        id: UInt16,
        sequence: Int64? = nil,
        title: String,
        category: String
    ) throws -> EventEnvelope {
        let base = try fixture.event(id: id, sequence: sequence, title: title)
        guard case let .expenseAdded(payload) = base.payload else {
            throw TestError.unexpectedPayload
        }
        return EventEnvelope(
            id: base.id,
            potID: base.potID,
            actorMemberID: base.actorMemberID,
            occurredAt: base.occurredAt,
            originatingTimeZone: base.originatingTimeZone,
            schemaVersion: base.schemaVersion,
            serverSequence: base.serverSequence,
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: payload.recordID,
                content: ExpenseContent(
                    kind: payload.content.kind,
                    title: payload.content.title,
                    amount: payload.content.amount,
                    payerUnitID: payload.content.payerUnitID,
                    allocations: payload.content.allocations,
                    category: category
                )
            ))
        )
    }

    private func sidecarCount(eventID: EventID, in store: LedgerStore) throws -> Int {
        try store.databaseQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM event_text_sidecars WHERE eventID = ?",
                arguments: [eventID.description]
            ) ?? 0
        }
    }

    private func opaqueSidecarCount(eventID: EventID, in store: LedgerStore) throws -> Int {
        try store.databaseQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM event_opaque_sidecars WHERE eventID = ?",
                arguments: [eventID.description]
            ) ?? 0
        }
    }

    private enum TestError: Error {
        case unexpectedPayload
    }
}
