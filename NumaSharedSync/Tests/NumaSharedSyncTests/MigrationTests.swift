import GRDB
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class MigrationTests: XCTestCase {
    func testV1MigrationMovesAuthoredTextOutOfEnvelopeAndPreservesUnsyncedDelivery() throws {
        let queue = try DatabaseQueue()
        var legacyMigrator = DatabaseMigrator()
        legacyMigrator.registerMigration("v1_ledger_store") { db in
            try LedgerStore.installV1Schema(in: db)
        }
        try legacyMigrator.migrate(queue)

        let fixture = try SyncFixture()
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 90, title: " \n")
        let canonical = PersistenceCoding.canonicalEnvelope(event)
        let configurationBlob = try PersistenceCoding.encode(fixture.configuration)
        let legacyEnvelopeBlob = try PersistenceCoding.encode(canonical)
        let fields = PersistenceCoding.fields(for: event.payload)
        let savedAtMillis = try PersistenceCoding.milliseconds(savedAt)

        try queue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO pot_configurations (
                        potID, currencyCode, currencyExponent, configurationBlob, createdAtMillis
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                arguments: [
                    fixture.potID.description,
                    fixture.configuration.currency.code,
                    fixture.configuration.currency.exponent,
                    configurationBlob,
                    savedAtMillis,
                ]
            )
            try db.execute(
                sql: """
                    INSERT INTO pot_sync_state (potID, lastServerSequence, updatedAtMillis)
                    VALUES (?, 0, ?)
                    """,
                arguments: [fixture.potID.description, savedAtMillis]
            )
            try db.execute(
                sql: """
                    INSERT INTO ledger_events (
                        eventID, potID, origin, recordID, kind, schemaVersion, actorMemberID,
                        occurredAtMillis, originatingTimeZone, currencyCode, parentEventID,
                        resolutionHeadOne, resolutionHeadTwo, envelopeBlob, savedAtMillis
                    ) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                arguments: [
                    event.id.description,
                    event.potID.description,
                    fields.recordID,
                    event.kind.rawValue,
                    Int(event.schemaVersion),
                    event.actorMemberID.description,
                    try PersistenceCoding.milliseconds(event.occurredAt),
                    event.originatingTimeZone.identifier,
                    fields.currencyCode,
                    fields.parentEventID,
                    fields.resolutionHeadOne,
                    fields.resolutionHeadTwo,
                    legacyEnvelopeBlob,
                    savedAtMillis,
                ]
            )
            try db.execute(
                sql: """
                    INSERT INTO event_delivery (
                        eventID, potID, state, undoDeadlineMillis, firstDispatchedAtMillis,
                        attemptCount, nextRetryAtMillis, serverSequence, terminalReason,
                        updatedAtMillis
                    ) VALUES (?, ?, 'ready', NULL, ?, 3, ?, NULL, NULL, ?)
                    """,
                arguments: [
                    event.id.description,
                    event.potID.description,
                    savedAtMillis,
                    savedAtMillis + 60_000,
                    savedAtMillis,
                ]
            )
        }

        let migrated = try LedgerStore(databaseQueue: queue, now: savedAt)
        let stored = try XCTUnwrap(migrated.loadStoredEvents(for: fixture.potID).first)
        XCTAssertEqual(stored.event, event)
        XCTAssertTrue(stored.legacyAuthoredText)
        XCTAssertEqual(stored.delivery.state, .ready)
        XCTAssertEqual(stored.delivery.attemptCount, 3)
        XCTAssertEqual(stored.delivery.nextRetryAt, savedAt.addingTimeInterval(60))
        XCTAssertEqual(try migrated.unsyncedEventCount(for: fixture.potID), 1)

        let arithmetic = try migrated.canonicalEnvelopeData(for: event.id)
        XCTAssertFalse(arithmetic.contains(Data(" \n".utf8)))
        let wire = try PersistenceCoding.decode(WireEventV1.self, from: arithmetic)
        XCTAssertTrue(wire.legacyAuthoredText)
        XCTAssertEqual(wire.textFields, [.title])
        XCTAssertTrue(wire.authoredText.isEmpty)
        XCTAssertEqual(
            try migrated.textStates(for: event.id),
            [.present(field: .title, value: " \n")]
        )
        XCTAssertEqual(try migrated.syncState(for: fixture.potID)?.lastTextRevision, 0)
        XCTAssertFalse(try XCTUnwrap(
            migrated.syncState(for: fixture.potID)
        ).emptyPromotionRequired)
        XCTAssertEqual(
            try queue.read { db in
                try Int.fetchOne(
                    db,
                    sql: "SELECT COUNT(*) FROM grdb_migrations WHERE identifier = ?",
                    arguments: ["v2_erasure_sidecars"]
                )
            },
            1
        )
        XCTAssertEqual(
            try queue.read { db in
                try Int.fetchOne(
                    db,
                    sql: "SELECT COUNT(*) FROM grdb_migrations WHERE identifier = ?",
                    arguments: ["v4_empty_promotion_recovery"]
                )
            },
            1
        )
        XCTAssertEqual(
            try queue.read { db in
                try Int.fetchOne(
                    db,
                    sql: "SELECT COUNT(*) FROM grdb_migrations WHERE identifier = ?",
                    arguments: ["v3_text_revision_cursor"]
                )
            },
            1
        )

        _ = try migrated.redactAuthoredText(for: event.id)
        let reopened = try LedgerStore(databaseQueue: queue, now: savedAt)
        XCTAssertEqual(
            try reopened.textStates(for: event.id),
            [.redacted(field: .title)]
        )
        guard case let .expenseAdded(redacted) = try XCTUnwrap(
            reopened.loadEvents(for: fixture.potID).first
        ).payload else {
            return XCTFail("Expected migrated expense")
        }
        XCTAssertEqual(redacted.content.title, WireEventV1.redactedTextPlaceholder)
        XCTAssertEqual(try reopened.unsyncedEventCount(for: fixture.potID), 1)
    }

    func testGrandfatheredP1TextRemainsLosslessAndUploadable() throws {
        let fixture = try SyncFixture()
        for (offset, title) in [
            " \n",
            String(repeating: "x", count: 513),
            WireEventV1.redactedTextPlaceholder,
        ].enumerated() {
            let event = try fixture.event(id: UInt16(2_500 + offset * 2), title: title)
            XCTAssertThrowsError(try WireEventV1(event))
            let prepared = try PersistenceCoding.prepareForStorage(
                event,
                grandfatherAuthoredText: true
            )
            let arithmetic = try PersistenceCoding.decode(
                WireEventV1.self,
                from: prepared.arithmeticBlob
            )
            XCTAssertTrue(arithmetic.legacyAuthoredText)
            let hydrated = try arithmetic.eventEnvelope(
                serverSequence: nil,
                textStates: [.present(field: .title, value: title)]
            )
            XCTAssertEqual(hydrated, event)
            let upload = try WireEventV1(grandfatheredStoredEvent: hydrated)
            XCTAssertTrue(upload.legacyAuthoredText)
            XCTAssertEqual(upload.authoredText, [
                WireAuthoredTextV1(field: .title, value: title),
            ])
        }
    }

    func testMigrationIsIdempotentAndPotConfigurationIsStable() throws {
        let queue = try DatabaseQueue()
        let firstStore = try LedgerStore(
            databaseQueue: queue,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let secondStore = try LedgerStore(
            databaseQueue: queue,
            now: Date(timeIntervalSince1970: 1_700_000_001)
        )
        let fixture = try SyncFixture()

        try firstStore.registerPot(fixture.configuration)
        try secondStore.registerPot(fixture.configuration)

        XCTAssertEqual(
            try queue.read { db in
                try Int.fetchOne(
                    db,
                    sql: "SELECT COUNT(*) FROM grdb_migrations WHERE identifier = ?",
                    arguments: ["v1_ledger_store"]
                )
            },
            1
        )
        XCTAssertEqual(
            try secondStore.potConfiguration(for: fixture.potID),
            fixture.configuration
        )
        XCTAssertEqual(
            try queue.read { db in
                try Int.fetchOne(
                    db,
                    sql: "SELECT COUNT(*) FROM grdb_migrations WHERE identifier = ?",
                    arguments: ["v7_member_roster_cache"]
                )
            },
            1
        )
        XCTAssertEqual(try secondStore.syncState(for: fixture.potID)?.lastServerSequence, 0)
        XCTAssertEqual(try secondStore.syncState(for: fixture.potID)?.lastTextRevision, 0)
        XCTAssertFalse(try XCTUnwrap(
            secondStore.syncState(for: fixture.potID)
        ).emptyPromotionRequired)

        let alternateUnit = try UnitID(validating: syncTestUUID(900))
        let conflicting = try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            orderedUnitIDs: [fixture.payerID, alternateUnit]
        )
        XCTAssertThrowsError(try secondStore.registerPot(conflicting)) { error in
            XCTAssertEqual(
                error as? LedgerStoreError,
                .potConfigurationConflict(fixture.potID)
            )
        }
    }

    func testPotConfigurationsAreReturnedInStableCreationOrder() throws {
        let store = try LedgerStore.inMemory()
        let fixture = try SyncFixture()
        let earlier = try PotConfiguration(
            id: try PotID(validating: syncTestUUID(899)),
            currency: fixture.configuration.currency,
            orderedUnitIDs: fixture.configuration.orderedUnitIDs
        )
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        try store.registerPot(fixture.configuration, at: now.addingTimeInterval(1))
        try store.registerPot(earlier, at: now)

        XCTAssertEqual(try store.potConfigurations(), [earlier, fixture.configuration])
    }

    func testLocalPotSetupPersistsNamesAndStableExactReplayBindings() throws {
        let queue = try DatabaseQueue()
        let store = try LedgerStore(
            databaseQueue: queue,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let fixture = try SyncFixture()
        let pendingMemberID = try MemberID(validating: syncTestUUID(6))
        let members = [
            LocalPotSetupMember(
                memberID: fixture.actorID,
                unitID: fixture.payerID,
                displayName: "Arseny",
                role: .owner
            ),
            LocalPotSetupMember(
                memberID: pendingMemberID,
                unitID: fixture.beneficiaryID,
                displayName: "Sam",
                role: .member
            ),
        ]
        let savedAt = Date(timeIntervalSince1970: 1_700_000_100)
        try store.registerPot(fixture.configuration, at: savedAt)

        let first = try store.saveLocalPotSetup(
            potID: fixture.potID,
            potName: "Casa Mar",
            ownerMemberID: fixture.actorID,
            members: members,
            originatingTimeZone: fixture.timeZone,
            at: savedAt
        )
        let replay = try store.saveLocalPotSetup(
            potID: fixture.potID,
            potName: "Casa Mar",
            ownerMemberID: fixture.actorID,
            members: members,
            originatingTimeZone: fixture.timeZone,
            at: savedAt.addingTimeInterval(60)
        )
        let reopened = try LedgerStore(
            databaseQueue: queue,
            now: savedAt.addingTimeInterval(120)
        )

        XCTAssertEqual(first, replay)
        XCTAssertEqual(try reopened.localPotSetup(for: fixture.potID), first)
        XCTAssertEqual(first.potName, "Casa Mar")
        XCTAssertTrue(first.isComplete)
        XCTAssertEqual(first.ownerDisplayName, "Arseny")
        XCTAssertEqual(first.bindings.map(\.profile.displayName), ["Arseny", "Sam"])
        XCTAssertEqual(first.bindings.map(\.isConfirmed), [false, false])
        XCTAssertEqual(
            first.renameEvent.payload,
            .potRenamed(name: "Casa Mar")
        )
        XCTAssertEqual(first.renameEvent.actorMemberId, fixture.actorID)
        XCTAssertEqual(
            first.bindings.map(\.event.payload),
            [
                .memberAdded(
                    memberId: fixture.actorID,
                    unitId: fixture.payerID,
                    role: .owner
                ),
                .memberAdded(
                    memberId: pendingMemberID,
                    unitId: fixture.beneficiaryID,
                    role: .member
                ),
            ]
        )
        XCTAssertEqual(
            try queue.read { db in
                try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM ledger_events")
            },
            0
        )
        XCTAssertThrowsError(try queue.write { db in
            try db.execute(
                sql: """
                    UPDATE local_pot_setup
                    SET renameEventBlob = ?
                    WHERE potID = ?
                    """,
                arguments: [Data(), fixture.potID.description]
            )
        })
        XCTAssertThrowsError(try queue.write { db in
            try db.execute(
                sql: """
                    UPDATE local_pot_member_profiles
                    SET bindingEventID = ?
                    WHERE potID = ? AND memberID = ?
                    """,
                arguments: [
                    EventID.generate(at: savedAt).description,
                    fixture.potID.description,
                    fixture.actorID.description,
                ]
            )
        })

        let renameConfirmed = try store.confirmLocalPotRename(
            potID: fixture.potID,
            eventID: first.renameEvent.eventId,
            at: savedAt.addingTimeInterval(1)
        )
        XCTAssertTrue(renameConfirmed.isRenameConfirmed)
        XCTAssertEqual(renameConfirmed.bindings.map(\.isConfirmed), [false, false])

        let firstBinding = try XCTUnwrap(first.bindings.first)
        let bindingConfirmed = try store.confirmLocalMemberBinding(
            potID: fixture.potID,
            eventID: firstBinding.event.eventId,
            at: savedAt.addingTimeInterval(2)
        )
        XCTAssertTrue(bindingConfirmed.isRenameConfirmed)
        XCTAssertEqual(bindingConfirmed.bindings.map(\.isConfirmed), [true, false])
        XCTAssertEqual(
            try reopened.localPotSetup(for: fixture.potID),
            bindingConfirmed
        )

        let unrelatedEventID = EventID.generate(
            at: savedAt.addingTimeInterval(3)
        )
        XCTAssertThrowsError(try store.confirmLocalMemberBinding(
            potID: fixture.potID,
            eventID: unrelatedEventID,
            at: savedAt.addingTimeInterval(3)
        )) {
            XCTAssertEqual(
                $0 as? LocalPotSetupError,
                .operationConflict(fixture.potID)
            )
        }
        XCTAssertEqual(
            try store.localPotSetup(for: fixture.potID),
            bindingConfirmed
        )

        XCTAssertThrowsError(try store.saveLocalPotSetup(
            potID: fixture.potID,
            potName: "Different",
            ownerMemberID: fixture.actorID,
            members: members,
            originatingTimeZone: fixture.timeZone,
            at: savedAt
        )) {
            XCTAssertEqual(
                $0 as? LocalPotSetupError,
                .setupConflict(fixture.potID)
            )
        }
        XCTAssertEqual(
            try store.localPotSetup(for: fixture.potID),
            bindingConfirmed
        )
    }

    func testRegisterPotAcceptsSemanticallyIdenticalLegacyConfigurationBlob() throws {
        let queue = try DatabaseQueue()
        let store = try LedgerStore(
            databaseQueue: queue,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let fixture = try SyncFixture()
        let encoded = try PersistenceCoding.encode(fixture.configuration)
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        var topology = try XCTUnwrap(object["topology"] as? [String: Any])
        topology.removeValue(forKey: "groupUnitIDsByGroupID")
        object["topology"] = topology
        let legacyBlob = try JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys]
        )

        try queue.write { db in
            try db.execute(
                sql: """
                    INSERT INTO pot_configurations (
                        potID, currencyCode, currencyExponent, configurationBlob, createdAtMillis
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                arguments: [
                    fixture.potID.description,
                    fixture.configuration.currency.code,
                    fixture.configuration.currency.exponent,
                    legacyBlob,
                    1_700_000_000_000,
                ]
            )
            try db.execute(
                sql: """
                    INSERT INTO pot_sync_state (potID, lastServerSequence, updatedAtMillis)
                    VALUES (?, 0, ?)
                    """,
                arguments: [fixture.potID.description, 1_700_000_000_000]
            )
        }

        XCTAssertNoThrow(try store.registerPot(fixture.configuration))
        XCTAssertEqual(
            try store.potConfiguration(for: fixture.potID),
            fixture.configuration
        )
    }

    func testPathStoreReleasesHeldEventsImmediatelyOnRestart() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedSyncTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("ledger.sqlite").path
        let fixture = try SyncFixture()
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 100)

        do {
            let store = try LedgerStore(path: path, fileProtection: .none, now: savedAt)
            try store.registerPot(fixture.configuration, at: savedAt)
            _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
            XCTAssertEqual(
                try store.expireHeldEvents(now: savedAt.addingTimeInterval(1)),
                0
            )
            XCTAssertEqual(try store.loadStoredEvents(for: fixture.potID).first?.delivery.state, .held)
        }

        let reopened = try LedgerStore(
            path: path,
            fileProtection: .none,
            now: savedAt.addingTimeInterval(1)
        )
        XCTAssertEqual(try reopened.potConfiguration(for: fixture.potID), fixture.configuration)
        let stored = try XCTUnwrap(reopened.loadStoredEvents(for: fixture.potID).first)
        XCTAssertEqual(stored.event, event)
        XCTAssertEqual(stored.delivery.state, .ready)
        XCTAssertEqual(try reopened.readyEvents(for: fixture.potID).count, 1)
        XCTAssertFalse(try reopened.undoHeldLocalEvent(
            eventID: event.id,
            now: savedAt.addingTimeInterval(1),
            undoSessionIsActive: true
        ))
    }

    func testPathStoreUsesWALJournalMode() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedSyncWAL-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("ledger.sqlite").path

        let store = try LedgerStore(path: path, fileProtection: .none)
        let journalMode = try store.databaseQueue.read { db in
            try String.fetchOne(db, sql: "PRAGMA journal_mode")
        }

        XCTAssertEqual(journalMode?.lowercased(), "wal")
    }

    func testDeliveryPotMustMatchImmutableEventPot() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let otherPotID = try PotID(validating: syncTestUUID(950))
        let otherConfiguration = try PotConfiguration(
            id: otherPotID,
            currency: .eur,
            orderedUnitIDs: [fixture.payerID, fixture.beneficiaryID]
        )
        try store.registerPot(otherConfiguration)
        let event = try fixture.event(id: 104)
        _ = try store.appendHeldLocalEvent(event)

        XCTAssertThrowsError(try store.databaseQueue.write { db in
            try db.execute(
                sql: "UPDATE event_delivery SET potID = ? WHERE eventID = ?",
                arguments: [otherPotID.description, event.id.description]
            )
        })
        XCTAssertEqual(
            try store.loadStoredEvents(for: fixture.potID).first?.delivery.potID,
            fixture.potID
        )
    }

    func testRestartRecoversInterruptedDispatchWithoutRestoringUndo() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedSyncRecovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("ledger.sqlite").path
        let fixture = try SyncFixture()
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 102)
        var firstDispatchedAt: Date?

        do {
            let store = try LedgerStore(path: path, fileProtection: .none, now: savedAt)
            try store.registerPot(fixture.configuration, at: savedAt)
            _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
            _ = try store.expireHeldEvents(now: savedAt.addingTimeInterval(6))
            let delivery = try store.markDispatching(
                eventID: event.id,
                at: savedAt.addingTimeInterval(7)
            )
            firstDispatchedAt = delivery.firstDispatchedAt
            XCTAssertEqual(delivery.attemptCount, 1)
        }

        let reopened = try LedgerStore(
            path: path,
            fileProtection: .none,
            now: savedAt.addingTimeInterval(8)
        )
        let recovered = try XCTUnwrap(
            reopened.loadStoredEvents(for: fixture.potID).first?.delivery
        )
        XCTAssertEqual(recovered.state, .ready)
        XCTAssertEqual(recovered.firstDispatchedAt, firstDispatchedAt)
        XCTAssertEqual(recovered.attemptCount, 1)
        XCTAssertEqual(try reopened.readyEvents(for: fixture.potID).count, 1)
        XCTAssertFalse(try reopened.undoHeldLocalEvent(
            eventID: event.id,
            now: savedAt.addingTimeInterval(8),
            undoSessionIsActive: true
        ))
    }

    func testAuthoritativeRosterCachePersistsReplacementAndNameErasure() throws {
        let queue = try DatabaseQueue()
        let savedAt = Date(timeIntervalSince1970: 1_700_000_100)
        let store = try LedgerStore(databaseQueue: queue, now: savedAt)
        let fixture = try SyncFixture()
        let memberID = try MemberID(validating: syncTestUUID(6))
        try store.registerPot(fixture.configuration, at: savedAt)
        let initial = [
            PotMemberProfile(
                memberID: fixture.actorID,
                unitID: fixture.payerID,
                displayName: "Ari",
                role: .owner,
                state: .active
            ),
            PotMemberProfile(
                memberID: memberID,
                unitID: fixture.beneficiaryID,
                displayName: "Sam",
                role: .member,
                state: .pending
            ),
        ]

        XCTAssertEqual(
            try store.replaceCachedMemberRoster(
                initial,
                for: fixture.potID,
                at: savedAt
            ),
            initial
        )
        XCTAssertEqual(try store.cachedMemberRoster(for: fixture.potID), initial)

        let erased = [
            initial[0],
            PotMemberProfile(
                memberID: memberID,
                unitID: fixture.beneficiaryID,
                displayName: nil,
                role: .member,
                state: .pending
            ),
        ]
        _ = try store.replaceCachedMemberRoster(
            erased,
            for: fixture.potID,
            at: savedAt.addingTimeInterval(1)
        )
        let reopened = try LedgerStore(
            databaseQueue: queue,
            now: savedAt.addingTimeInterval(2)
        )
        XCTAssertEqual(try reopened.cachedMemberRoster(for: fixture.potID), erased)

        XCTAssertThrowsError(try reopened.replaceCachedMemberRoster(
            [erased[0], erased[0]],
            for: fixture.potID,
            at: savedAt.addingTimeInterval(3)
        )) {
            XCTAssertEqual(
                $0 as? MemberRosterCacheError,
                .invalidRoster(fixture.potID)
            )
        }
        XCTAssertEqual(try reopened.cachedMemberRoster(for: fixture.potID), erased)
    }
}
