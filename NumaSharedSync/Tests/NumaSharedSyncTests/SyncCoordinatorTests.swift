import Foundation
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class SyncCoordinatorTests: XCTestCase {
    func testEventTerminalTaxonomyMatchesTrackedBackendContract() throws {
        var contractURL = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { contractURL.deleteLastPathComponent() }
        contractURL.appendPathComponent("contracts/event-terminal-codes.json")
        let codes = try JSONDecoder().decode(
            [String].self,
            from: Data(contentsOf: contractURL)
        )
        XCTAssertEqual(Set(codes), SyncCoordinator.eventTerminalCodes)
        XCTAssertEqual(codes, codes.sorted())
    }

    func testRetryPolicyRejectsNonFiniteDelays() {
        XCTAssertThrowsError(
            try SyncRetryPolicy(baseDelay: .infinity, maximumDelay: .infinity)
        ) { error in
            XCTAssertEqual(error as? SyncRetryPolicyError, .nonFiniteDelay)
        }
        XCTAssertThrowsError(
            try SyncRetryPolicy(baseDelay: 1, maximumDelay: .nan)
        ) { error in
            XCTAssertEqual(error as? SyncRetryPolicyError, .nonFiniteDelay)
        }
    }

    func testCancellationDuringPullRemainsControlFlowAndNextRunCanProceed() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let transport = FakeSyncTransport(blocksFirstListUntilCancelled: true)
        let coordinator = SyncCoordinator(store: store, transport: transport)
        let first = Task {
            try await coordinator.synchronize(PotSyncRequest(potID: fixture.potID))
        }
        await transport.waitUntilBlockingListStarts()

        first.cancel()

        do {
            _ = try await first.value
            XCTFail("A cancelled pull must not become a sync report")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        let second = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID)
        )
        let status = try await coordinator.status(for: fixture.potID)
        XCTAssertEqual(second.outcome, .completed)
        XCTAssertEqual(status, .synced(lastServerSequence: 0))
    }

    func testCancellationDuringAppendReturnsTheQueueHeadToReady() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 799)
        _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        let transport = FakeSyncTransport(blocksFirstAppendUntilCancelled: true)
        let coordinator = SyncCoordinator(store: store, transport: transport)
        let now = savedAt.addingTimeInterval(7)
        let first = Task {
            try await coordinator.synchronize(
                PotSyncRequest(potID: fixture.potID),
                now: now
            )
        }
        await transport.waitUntilBlockingAppendStarts()

        first.cancel()

        do {
            _ = try await first.value
            XCTFail("A cancelled append must not become a sync report")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertEqual(
            try store.loadStoredEvents(for: fixture.potID).first?.delivery.state,
            .ready
        )

        let second = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: now
        )
        XCTAssertEqual(second.outcome, .completed)
        XCTAssertEqual(
            try store.loadStoredEvents(for: fixture.potID).first?.delivery.state,
            .acknowledged
        )
    }

    func testPromotionAtomicallyIncludesAndAcknowledgesTheReadyOutbox() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try fixture.event(id: 801)
        let second = try fixture.event(id: 803)
        _ = try store.appendHeldLocalEvent(first, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(second, savedAt: savedAt)
        let transport = FakeSyncTransport()
        let coordinator = SyncCoordinator(store: store, transport: transport)
        let request = PotSyncRequest(
            potID: fixture.potID,
            promotion: LocalPotPromotion(
                ownerMemberID: fixture.actorID,
                ownerDisplayName: "Arseny",
                minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
            )
        )

        let report = try await coordinator.synchronize(
            request,
            now: savedAt.addingTimeInterval(7)
        )

        let operations = await transport.operations()
        let maximumConcurrentAppends = await transport.maximumConcurrentAppends()
        let status = try await coordinator.status(for: fixture.potID)
        XCTAssertEqual(report.outcome, .completed)
        XCTAssertEqual(report.dispatchedEventCount, 2)
        XCTAssertEqual(operations, [
            .promote(fixture.potID, [first.id, second.id]),
            .list(afterSequence: 2),
            .listText(afterRevision: 0),
            .list(afterSequence: 2),
            .listText(afterRevision: 0),
        ])
        XCTAssertEqual(maximumConcurrentAppends, 0)
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 0)
        XCTAssertEqual(
            try store.loadEvents(for: fixture.potID).map(\.serverSequence),
            [1, 2]
        )
        XCTAssertEqual(
            status,
            .synced(lastServerSequence: 2)
        )
    }

    func testPromotionRejectsNoncontiguousSequencesBeforeAnyLocalAcknowledgement() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try fixture.event(id: 804)
        let second = try fixture.event(id: 806)
        _ = try store.appendHeldLocalEvent(first, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(second, savedAt: savedAt)
        let transport = FakeSyncTransport(promotionAcknowledgements: [
            EventAcknowledgement(eventID: first.id, serverSequence: 1),
            EventAcknowledgement(eventID: second.id, serverSequence: 3),
        ])
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(
                potID: fixture.potID,
                promotion: LocalPotPromotion(
                    ownerMemberID: fixture.actorID,
                    ownerDisplayName: "Arseny",
                    minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                )
            ),
            now: savedAt.addingTimeInterval(7)
        )

        XCTAssertEqual(
            report.outcome,
            .paused(eventID: first.id, code: "INVALID_SERVER_RESPONSE")
        )
        let deliveries = try store.loadStoredEvents(for: fixture.potID).map(\.delivery)
        XCTAssertEqual(deliveries.map(\.state), [.ready, .ready])
        XCTAssertEqual(deliveries.map(\.attemptCount), [0, 0])
        XCTAssertEqual(deliveries.map(\.serverSequence), [nil, nil])
    }

    func testPromotionRejectsSwappedSequencesBeforeAnyLocalAcknowledgement() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try fixture.event(id: 808)
        let second = try fixture.event(id: 810)
        _ = try store.appendHeldLocalEvent(first, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(second, savedAt: savedAt)
        let transport = FakeSyncTransport(promotionAcknowledgements: [
            EventAcknowledgement(eventID: first.id, serverSequence: 2),
            EventAcknowledgement(eventID: second.id, serverSequence: 1),
        ])
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(
                potID: fixture.potID,
                promotion: LocalPotPromotion(
                    ownerMemberID: fixture.actorID,
                    ownerDisplayName: "Arseny",
                    minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                )
            ),
            now: savedAt.addingTimeInterval(7)
        )

        XCTAssertEqual(
            report.outcome,
            .paused(eventID: first.id, code: "INVALID_SERVER_RESPONSE")
        )
        let deliveries = try store.loadStoredEvents(for: fixture.potID).map(\.delivery)
        XCTAssertEqual(deliveries.map(\.state), [.ready, .ready])
        XCTAssertEqual(deliveries.map(\.attemptCount), [0, 0])
        XCTAssertEqual(deliveries.map(\.serverSequence), [nil, nil])
    }

    func testPromotionUsesAtomicHundredEventPrefixThenDrainsTheRemainder() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let events = try (0..<101).map { offset in
            try fixture.event(id: UInt16(1_000 + offset * 2))
        }
        for event in events {
            _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        }
        let transport = FakeSyncTransport()
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(
                potID: fixture.potID,
                promotion: LocalPotPromotion(
                    ownerMemberID: fixture.actorID,
                    ownerDisplayName: "Arseny",
                    minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                )
            ),
            now: savedAt.addingTimeInterval(7)
        )

        let operations = await transport.operations()
        guard case let .promote(promotedPotID, promotedIDs) = operations.first else {
            return XCTFail("Expected promotion to be the first operation")
        }
        let appendedEventIDs = await transport.appendedEventIDs()
        XCTAssertEqual(promotedPotID, fixture.potID)
        XCTAssertEqual(promotedIDs, Array(events.prefix(100)).map(\.id))
        XCTAssertEqual(appendedEventIDs, [events[100].id])
        XCTAssertEqual(report.outcome, .completed)
        XCTAssertEqual(report.dispatchedEventCount, 101)
        XCTAssertEqual(try store.pendingDeliveryEventCount(for: fixture.potID), 0)
        XCTAssertEqual(
            try store.loadEvents(for: fixture.potID).compactMap(\.serverSequence),
            Array(1...101).map(Int64.init)
        )
    }

    func testTerminalPromotionBatchPersistsFailedAttemptsThenCreatesEmptyPot() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try fixture.event(id: 1_205)
        let second = try fixture.event(id: 1_207)
        _ = try store.appendHeldLocalEvent(first, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(second, savedAt: savedAt)
        let transport = FakeSyncTransport(promotionFailures: [
            .terminal(code: "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED"),
        ])
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(
                potID: fixture.potID,
                promotion: LocalPotPromotion(
                    ownerMemberID: fixture.actorID,
                    ownerDisplayName: "Arseny",
                    minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                )
            ),
            now: savedAt.addingTimeInterval(7)
        )

        XCTAssertEqual(report.outcome, .completed)
        XCTAssertEqual(report.dispatchedEventCount, 0)
        let firstOperations = Array((await transport.operations()).prefix(2))
        XCTAssertEqual(firstOperations, [
            .promote(fixture.potID, [first.id, second.id]),
            .promote(fixture.potID, []),
        ])
        let deliveries = try store.loadStoredEvents(for: fixture.potID).map(\.delivery)
        XCTAssertEqual(deliveries.map(\.state), [.terminal, .terminal])
        XCTAssertEqual(deliveries.map(\.terminalReason), [
            "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
            "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
        ])
        XCTAssertEqual(try store.pendingDeliveryEventCount(for: fixture.potID), 0)
        let status = try await coordinator.status(for: fixture.potID)
        XCTAssertEqual(status, .synced(lastServerSequence: 0))
    }

    func testTerminalHundredEventPromotionCreatesEmptyPotThenAppendsRemainder() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let events = try (0..<101).map { offset in
            try fixture.event(id: UInt16(1_400 + offset * 2))
        }
        for event in events {
            _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        }
        let transport = FakeSyncTransport(promotionFailures: [
            .terminal(code: "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED"),
        ])
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(
                potID: fixture.potID,
                promotion: LocalPotPromotion(
                    ownerMemberID: fixture.actorID,
                    ownerDisplayName: "Arseny",
                    minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                )
            ),
            now: savedAt.addingTimeInterval(7)
        )

        let operations = await transport.operations()
        XCTAssertEqual(Array(operations.prefix(3)), [
            .promote(fixture.potID, Array(events.prefix(100)).map(\.id)),
            .promote(fixture.potID, []),
            .list(afterSequence: 0),
        ])
        XCTAssertTrue(operations.contains(.append(events[100].id)))
        XCTAssertEqual(report.outcome, .completed)
        XCTAssertEqual(report.dispatchedEventCount, 1)
        let statesByEventID = Dictionary(uniqueKeysWithValues:
            try store.loadStoredEvents(for: fixture.potID).map {
                ($0.event.id, $0.delivery.state)
            }
        )
        XCTAssertTrue(events.prefix(100).allSatisfy {
            statesByEventID[$0.id] == .terminal
        })
        XCTAssertEqual(statesByEventID[events[100].id], .acknowledged)
        XCTAssertFalse(try XCTUnwrap(store.syncState(for: fixture.potID)).emptyPromotionRequired)
    }

    func testInterruptedEmptyPromotionRequirementSurvivesRestartBeforeRemainderAppend() async throws {
        let fixture = try SyncFixture()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedPromotionRecovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("ledger.sqlite").path
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let events = try (0..<101).map { offset in
            try fixture.event(id: UInt16(1_700 + offset * 2))
        }

        do {
            let store = try LedgerStore(path: path, fileProtection: .none, now: savedAt)
            try store.registerPot(fixture.configuration)
            for event in events {
                _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
            }
            let transport = FakeSyncTransport(promotionFailures: [
                .terminal(code: "NEGATIVE_CONTRIBUTION_BUDGET_EXCEEDED"),
                .retryable(code: "TRANSPORT_UNAVAILABLE"),
            ])
            let coordinator = SyncCoordinator(store: store, transport: transport)
            let report = try await coordinator.synchronize(
                PotSyncRequest(
                    potID: fixture.potID,
                    promotion: LocalPotPromotion(
                        ownerMemberID: fixture.actorID,
                        ownerDisplayName: "Arseny",
                        minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                    )
                ),
                now: savedAt.addingTimeInterval(7)
            )
            guard case .retryScheduled = report.outcome else {
                return XCTFail("Expected interrupted empty promotion to retry")
            }
            XCTAssertTrue(try XCTUnwrap(store.syncState(for: fixture.potID)).emptyPromotionRequired)
        }

        let reopened = try LedgerStore(
            path: path,
            fileProtection: .none,
            now: savedAt.addingTimeInterval(8)
        )
        let transport = FakeSyncTransport()
        let coordinator = SyncCoordinator(store: reopened, transport: transport)
        let report = try await coordinator.synchronize(
            PotSyncRequest(
                potID: fixture.potID,
                promotion: LocalPotPromotion(
                    ownerMemberID: fixture.actorID,
                    ownerDisplayName: "Arseny",
                    minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                )
            ),
            now: savedAt.addingTimeInterval(8)
        )

        let operations = await transport.operations()
        XCTAssertEqual(operations.first, .promote(fixture.potID, []))
        XCTAssertTrue(operations.contains(.append(events[100].id)))
        XCTAssertEqual(report.outcome, .completed)
        XCTAssertFalse(try XCTUnwrap(reopened.syncState(for: fixture.potID)).emptyPromotionRequired)
    }

    func testRetryablePromotionFailureLeavesWholeBatchReadyForAtomicReplay() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let first = try fixture.event(id: 805)
        let second = try fixture.event(id: 807)
        _ = try store.appendHeldLocalEvent(first, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(second, savedAt: savedAt)
        let transport = FakeSyncTransport(promotionFailures: [
            .retryable(code: "TRANSPORT_UNAVAILABLE"),
        ])
        let coordinator = SyncCoordinator(
            store: store,
            transport: transport,
            retryPolicy: try SyncRetryPolicy(baseDelay: 2, maximumDelay: 30)
        )
        let now = savedAt.addingTimeInterval(7)
        let request = PotSyncRequest(
            potID: fixture.potID,
            promotion: LocalPotPromotion(
                ownerMemberID: fixture.actorID,
                ownerDisplayName: "Arseny",
                minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
            )
        )

        let firstReport = try await coordinator.synchronize(request, now: now)
        XCTAssertEqual(
            firstReport.outcome,
            .retryScheduled(eventID: nil, retryAt: now.addingTimeInterval(2))
        )
        XCTAssertEqual(
            try store.loadStoredEvents(for: fixture.potID).map(\.delivery.state),
            [.ready, .ready]
        )

        let secondReport = try await coordinator.synchronize(request, now: now)
        XCTAssertEqual(secondReport.outcome, .completed)
        XCTAssertEqual(secondReport.dispatchedEventCount, 2)
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 0)
        let promotionOperationCount = await transport.operations().filter {
            if case .promote = $0 { true } else { false }
        }.count
        XCTAssertEqual(
            promotionOperationCount,
            2
        )
    }

    func testRetryableFailureKeepsTheSameEventQueuedWithBackoff() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try fixture.event(id: 811)
        _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
        let transport = FakeSyncTransport(appendFailures: [
            .retryable(code: "TRANSPORT_UNAVAILABLE"),
        ])
        let coordinator = SyncCoordinator(
            store: store,
            transport: transport,
            retryPolicy: try SyncRetryPolicy(baseDelay: 2, maximumDelay: 30)
        )
        let now = savedAt.addingTimeInterval(7)

        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: now
        )

        XCTAssertEqual(
            report.outcome,
            .retryScheduled(eventID: event.id, retryAt: now.addingTimeInterval(2))
        )
        let delivery = try XCTUnwrap(
            store.loadStoredEvents(for: fixture.potID).first?.delivery
        )
        let firstAttemptIDs = await transport.appendedEventIDs()
        XCTAssertEqual(delivery.state, .ready)
        XCTAssertEqual(delivery.attemptCount, 1)
        XCTAssertEqual(delivery.nextRetryAt, now.addingTimeInterval(2))
        XCTAssertEqual(firstAttemptIDs, [event.id])

        let secondReport = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: now.addingTimeInterval(1)
        )
        let allAttemptIDs = await transport.appendedEventIDs()
        XCTAssertEqual(secondReport.outcome, .completed)
        XCTAssertEqual(allAttemptIDs, [event.id])

        let thirdReport = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: now.addingTimeInterval(2)
        )
        let retriedIDs = await transport.appendedEventIDs()
        XCTAssertEqual(thirdReport.outcome, .completed)
        XCTAssertEqual(retriedIDs, [event.id, event.id])
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 0)
        XCTAssertEqual(try store.loadEvents(for: fixture.potID).first?.serverSequence, 1)
    }

    func testConnectedPendingUndoRecordIsSyncingRatherThanOffline() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        _ = try store.appendHeldLocalEvent(
            fixture.event(id: 809),
            savedAt: savedAt
        )
        let coordinator = SyncCoordinator(
            store: store,
            transport: FakeSyncTransport()
        )

        _ = try await coordinator.registerRemotePots()

        let status = try await coordinator.status(for: fixture.potID)
        XCTAssertEqual(status, .syncing(pendingEventCount: 1))
    }

    func testEventTerminalFailureReleasesTheQueueAndSyncsAYoungerEvent() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let rejected = try fixture.event(id: 821)
        let younger = try fixture.event(id: 823)
        _ = try store.appendHeldLocalEvent(rejected, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(younger, savedAt: savedAt)
        let transport = FakeSyncTransport(appendFailures: [
            .terminal(code: "ACTOR_MISMATCH"),
        ])
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: savedAt.addingTimeInterval(7)
        )

        let appendedEventIDs = await transport.appendedEventIDs()
        let status = try await coordinator.status(for: fixture.potID)
        XCTAssertEqual(
            report.outcome,
            .completed
        )
        XCTAssertEqual(appendedEventIDs, [rejected.id, younger.id])
        let deliveries = try store.loadStoredEvents(for: fixture.potID).map(\.delivery)
        let statesByEventID = Dictionary(uniqueKeysWithValues: deliveries.map {
            ($0.eventID, $0.state)
        })
        XCTAssertEqual(statesByEventID[rejected.id], .terminal)
        XCTAssertEqual(statesByEventID[younger.id], .acknowledged)
        XCTAssertEqual(
            status,
            .synced(lastServerSequence: 1)
        )
    }

    func testUnknownPotTerminalAppendFailuresPauseWithIntactQueue() async throws {
        for code in [
            "DEPLOYMENT_NOT_APPROVED",
            "UNSUPPORTED_READER_SCHEMA",
            "INVALID_SERVER_RESPONSE",
        ] {
            let fixture = try SyncFixture()
            let store = try LedgerStore.inMemory()
            try store.registerPot(fixture.configuration)
            let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
            let head = try fixture.event(id: 2_101)
            let younger = try fixture.event(id: 2_103)
            _ = try store.appendHeldLocalEvent(head, savedAt: savedAt)
            _ = try store.appendHeldLocalEvent(younger, savedAt: savedAt)
            let transport = FakeSyncTransport(appendFailures: [.terminal(code: code)])
            let coordinator = SyncCoordinator(store: store, transport: transport)

            let report = try await coordinator.synchronize(
                PotSyncRequest(potID: fixture.potID),
                now: savedAt.addingTimeInterval(7)
            )

            XCTAssertEqual(report.outcome, .paused(eventID: head.id, code: code))
            XCTAssertEqual(
                try store.loadStoredEvents(for: fixture.potID).map(\.delivery.state),
                [.ready, .ready]
            )
            let appendedEventIDs = await transport.appendedEventIDs()
            XCTAssertEqual(appendedEventIDs, [head.id])
        }
    }

    func testPotTerminalPromotionFailuresNeverTerminalizeOrEmptyPromote() async throws {
        for code in [
            "DEPLOYMENT_NOT_APPROVED",
            "UNSUPPORTED_READER_SCHEMA",
            "INVALID_SERVER_RESPONSE",
        ] {
            let fixture = try SyncFixture()
            let store = try LedgerStore.inMemory()
            try store.registerPot(fixture.configuration)
            let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
            let first = try fixture.event(id: 2_201)
            let second = try fixture.event(id: 2_203)
            _ = try store.appendHeldLocalEvent(first, savedAt: savedAt)
            _ = try store.appendHeldLocalEvent(second, savedAt: savedAt)
            let transport = FakeSyncTransport(promotionFailures: [.terminal(code: code)])
            let coordinator = SyncCoordinator(store: store, transport: transport)

            let report = try await coordinator.synchronize(
                PotSyncRequest(
                    potID: fixture.potID,
                    promotion: LocalPotPromotion(
                        ownerMemberID: fixture.actorID,
                        ownerDisplayName: "Arseny",
                        minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                    )
                ),
                now: savedAt.addingTimeInterval(7)
            )

            XCTAssertEqual(report.outcome, .paused(eventID: nil, code: code))
            XCTAssertEqual(
                try store.loadStoredEvents(for: fixture.potID).map(\.delivery.state),
                [.ready, .ready]
            )
            let operations = await transport.operations()
            XCTAssertEqual(operations, [
                .promote(fixture.potID, [first.id, second.id]),
            ])
            XCTAssertFalse(try XCTUnwrap(store.syncState(for: fixture.potID)).emptyPromotionRequired)
        }
    }

    func testPotTerminalAppendCanResumeInSameProcessWithoutDuplicateAcknowledgement() async throws {
        for code in ["AUTH_SESSION_REVOKED", "INVALID_SERVER_RESPONSE"] {
            let fixture = try SyncFixture()
            let store = try LedgerStore.inMemory()
            try store.registerPot(fixture.configuration)
            let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
            let event = try fixture.event(id: 2_301)
            _ = try store.appendHeldLocalEvent(event, savedAt: savedAt)
            let transport = FakeSyncTransport(appendFailures: [.terminal(code: code)])
            let coordinator = SyncCoordinator(store: store, transport: transport)

            let first = try await coordinator.synchronize(
                PotSyncRequest(potID: fixture.potID),
                now: savedAt.addingTimeInterval(7)
            )
            XCTAssertEqual(first.outcome, .paused(eventID: event.id, code: code))
            XCTAssertEqual(
                try store.loadStoredEvents(for: fixture.potID).first?.delivery.state,
                .ready
            )

            let second = try await coordinator.synchronize(
                PotSyncRequest(potID: fixture.potID),
                now: savedAt.addingTimeInterval(8)
            )
            XCTAssertEqual(second.outcome, .completed)
            let delivery = try XCTUnwrap(
                store.loadStoredEvents(for: fixture.potID).first?.delivery
            )
            XCTAssertEqual(delivery.state, .acknowledged)
            XCTAssertEqual(delivery.serverSequence, 1)
            let appendedEventIDs = await transport.appendedEventIDs()
            XCTAssertEqual(appendedEventIDs, [event.id, event.id])
        }
    }

    func testAccessFailurePreservesEveryQueuedAttempt() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let rejected = try fixture.event(id: 827)
        let younger = try fixture.event(id: 829)
        _ = try store.appendHeldLocalEvent(rejected, savedAt: savedAt)
        _ = try store.appendHeldLocalEvent(younger, savedAt: savedAt)
        let coordinator = SyncCoordinator(
            store: store,
            transport: FakeSyncTransport(appendFailures: [
                .terminal(code: "NOT_MEMBER"),
            ])
        )

        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: savedAt.addingTimeInterval(7)
        )

        XCTAssertEqual(
            report.outcome,
            .paused(eventID: rejected.id, code: "NOT_MEMBER")
        )
        XCTAssertEqual(
            try store.loadStoredEvents(for: fixture.potID).map(\.delivery.state),
            [.ready, .ready]
        )
        XCTAssertEqual(try store.pendingDeliveryEventCount(for: fixture.potID), 2)
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 2)
    }

    func testAccessPauseReportsPreservedWaitingCount() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let rejected = try fixture.event(id: 825)
        _ = try store.appendHeldLocalEvent(rejected, savedAt: savedAt)
        let coordinator = SyncCoordinator(
            store: store,
            transport: FakeSyncTransport(appendFailures: [
                .terminal(code: "NOT_MEMBER"),
            ])
        )

        _ = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: savedAt.addingTimeInterval(7)
        )

        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 1)
        XCTAssertEqual(try store.pendingDeliveryEventCount(for: fixture.potID), 1)
        let status = try await coordinator.status(for: fixture.potID)
        XCTAssertEqual(status, .paused(pendingEventCount: 1, code: "NOT_MEMBER"))
    }

    func testConflictingAcknowledgementReturnsHeadToReadyAndRecoversSameProcess() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        _ = try store.ingestRemoteEvent(try fixture.event(id: 2_401, sequence: 1))
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let local = try fixture.event(id: 2_403)
        _ = try store.appendHeldLocalEvent(local, savedAt: savedAt)
        let transport = FakeSyncTransport()
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let first = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: savedAt.addingTimeInterval(7)
        )
        XCTAssertEqual(
            first.outcome,
            .paused(eventID: local.id, code: "INVALID_SERVER_RESPONSE")
        )
        XCTAssertEqual(
            try store.loadStoredEvents(for: fixture.potID).last?.delivery.state,
            .ready
        )

        let second = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: savedAt.addingTimeInterval(8)
        )
        XCTAssertEqual(second.outcome, .completed)
        let delivery = try XCTUnwrap(
            store.loadStoredEvents(for: fixture.potID).last?.delivery
        )
        XCTAssertEqual(delivery.state, .acknowledged)
        XCTAssertEqual(delivery.serverSequence, 2)
        let appendedEventIDs = await transport.appendedEventIDs()
        XCTAssertEqual(appendedEventIDs, [local.id, local.id])
    }

    func testPullsEveryPageInSequenceAndRegistersDiscoveredPots() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        let first = try hydrated(fixture.event(id: 831), sequence: 1)
        let second = try hydrated(fixture.event(id: 833), sequence: 2)
        let transport = FakeSyncTransport(
            remotePots: [RemotePotDescriptor(
                configuration: fixture.configuration,
                memberID: fixture.actorID,
                role: .owner,
                minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion,
                lastSequence: 2
            )],
            pages: [
                SyncEventPage(
                    events: [first],
                    hasMore: true,
                    nextAfterSequence: 1
                ),
                SyncEventPage(
                    events: [second],
                    hasMore: false,
                    nextAfterSequence: 2
                ),
                SyncEventPage(events: [], hasMore: false, nextAfterSequence: 2),
            ]
        )
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let discovered = try await coordinator.registerRemotePots()
        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: Date(timeIntervalSince1970: 1_700_001_000)
        )

        let listAfterSequences = await transport.listAfterSequences()
        XCTAssertEqual(discovered.map(\.configuration.id), [fixture.potID])
        XCTAssertEqual(report.ingestedEventCount, 2)
        XCTAssertEqual(
            try store.loadEvents(for: fixture.potID).map(\.serverSequence),
            [1, 2]
        )
        XCTAssertEqual(listAfterSequences, [0, 1, 2])
    }

    func testMalformedPageFailsClosedWithoutAdvancingTheCursor() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let outOfOrder = try hydrated(fixture.event(id: 837), sequence: 2)
        let transport = FakeSyncTransport(pages: [
            SyncEventPage(
                events: [outOfOrder],
                hasMore: false,
                nextAfterSequence: 2
            ),
        ])
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: Date(timeIntervalSince1970: 1_700_001_000)
        )

        XCTAssertEqual(
            report.outcome,
            .paused(eventID: nil, code: "INVALID_SERVER_RESPONSE")
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 0)
        XCTAssertTrue(try store.loadEvents(for: fixture.potID).isEmpty)
    }

    func testFutureSchemaPullPausesBeforeAnyPendingLocalUpload() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let pending = try fixture.event(id: 837)
        _ = try store.appendHeldLocalEvent(pending, savedAt: savedAt)
        let source = try fixture.event(id: 839)
        let future = EventEnvelope(
            id: source.id,
            potID: source.potID,
            actorMemberID: source.actorMemberID,
            occurredAt: source.occurredAt,
            originatingTimeZone: source.originatingTimeZone,
            schemaVersion: EventEnvelope.currentSchemaVersion + 1,
            serverSequence: nil,
            payload: source.payload
        )
        let transport = FakeSyncTransport(pages: [SyncEventPage(
            events: [try hydrated(future, sequence: 1)],
            hasMore: false,
            nextAfterSequence: 1
        )])
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: savedAt.addingTimeInterval(7)
        )

        XCTAssertEqual(
            report.outcome,
            .paused(eventID: future.id, code: "READER_UPDATE_REQUIRED")
        )
        XCTAssertEqual(report.dispatchedEventCount, 0)
        let appendedEventIDs = await transport.appendedEventIDs()
        XCTAssertEqual(appendedEventIDs, [])
        XCTAssertEqual(try store.unsyncedEventCount(for: fixture.potID), 1)
        XCTAssertEqual(
            try store.reduction(for: fixture.potID).access,
            .readOnly(.unsupportedSchema(
                eventID: future.id,
                encountered: EventEnvelope.currentSchemaVersion + 1,
                supported: EventEnvelope.currentSchemaVersion
            ))
        )
    }

    func testPullsContiguousTextRedactionsAcrossEveryPage() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let first = try fixture.event(id: 839)
        let second = try fixture.event(id: 841)
        let transport = FakeSyncTransport(
            pages: [
                SyncEventPage(
                    events: [
                        try hydrated(first, sequence: 1),
                        try hydrated(second, sequence: 2),
                    ],
                    hasMore: false,
                    nextAfterSequence: 2
                ),
                SyncEventPage(events: [], hasMore: false, nextAfterSequence: 2),
            ],
            textPages: [
                SyncTextChangePage(
                    changes: [TextRedactionChange(
                        eventID: first.id,
                        field: .title,
                        revision: 1
                    )],
                    hasMore: true,
                    nextAfterRevision: 1
                ),
                SyncTextChangePage(
                    changes: [TextRedactionChange(
                        eventID: second.id,
                        field: .title,
                        revision: 2
                    )],
                    hasMore: false,
                    nextAfterRevision: 2
                ),
                SyncTextChangePage(changes: [], hasMore: false, nextAfterRevision: 2),
            ]
        )
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: Date(timeIntervalSince1970: 1_700_001_000)
        )

        let requestedTextRevisions = await transport.listAfterTextRevisions()
        XCTAssertEqual(report.outcome, .completed)
        XCTAssertEqual(requestedTextRevisions, [0, 1, 2])
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 2)
        XCTAssertEqual(try store.textStates(for: first.id), [.redacted(field: .title)])
        XCTAssertEqual(try store.textStates(for: second.id), [.redacted(field: .title)])
    }

    func testPrivacyOnlyRefreshCrossesFilteredPageWithoutFinancialReadsOrWrites() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try fixture.event(id: 849, sequence: 1)
        _ = try store.ingestRemoteEvent(event)
        let transport = FakeSyncTransport(textPages: [
            SyncTextChangePage(changes: [], hasMore: true, nextAfterRevision: 500,
                skippedRevisions: Array(1...500)),
            SyncTextChangePage(changes: [TextRedactionChange(eventID: event.id, field: .title, revision: 501)],
                hasMore: false, nextAfterRevision: 501),
        ])
        let coordinator = SyncCoordinator(store: store, transport: transport)
        let count = try await coordinator.refreshAuthoredText(for: fixture.potID)
        XCTAssertEqual(count, 1)
        let operations = await transport.operations()
        XCTAssertEqual(operations, [.listText(afterRevision: 0), .listText(afterRevision: 500)])
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 501)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 1)
        XCTAssertEqual(try store.textStates(for: event.id), [.redacted(field: .title)])
    }

    func testMalformedTextRevisionPageFailsClosedWithoutDeletingText() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try fixture.event(id: 843)
        let transport = FakeSyncTransport(
            pages: [SyncEventPage(
                events: [try hydrated(event, sequence: 1)],
                hasMore: false,
                nextAfterSequence: 1
            )],
            textPages: [SyncTextChangePage(
                changes: [TextRedactionChange(
                    eventID: event.id,
                    field: .title,
                    revision: 1
                )],
                hasMore: false,
                nextAfterRevision: 2
            )]
        )
        let coordinator = SyncCoordinator(store: store, transport: transport)

        let report = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: Date(timeIntervalSince1970: 1_700_001_000)
        )

        XCTAssertEqual(
            report.outcome,
            .paused(eventID: nil, code: "INVALID_SERVER_RESPONSE")
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 0)
        XCTAssertEqual(
            try store.textStates(for: event.id),
            [.present(field: .title, value: "Groceries")]
        )
    }

    func testTextChangeAheadOfEventSnapshotRetriesFailClosedThenConverges() async throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let existing = try fixture.event(id: 845)
        let notYetVisible = try fixture.event(id: 847)
        _ = try store.ingestRemoteEvent(
            try hydrated(existing, sequence: 1),
            receivedAt: Date(timeIntervalSince1970: 1_700_000_900)
        )
        let change = TextRedactionChange(
            eventID: notYetVisible.id,
            field: .title,
            revision: 1
        )
        let transport = FakeSyncTransport(
            pages: [
                SyncEventPage(events: [], hasMore: false, nextAfterSequence: 1),
                SyncEventPage(
                    events: [try hydrated(notYetVisible, sequence: 2)],
                    hasMore: false,
                    nextAfterSequence: 2
                ),
                SyncEventPage(events: [], hasMore: false, nextAfterSequence: 2),
            ],
            textPages: [
                SyncTextChangePage(
                    changes: [change],
                    hasMore: false,
                    nextAfterRevision: 1
                ),
                SyncTextChangePage(
                    changes: [change],
                    hasMore: false,
                    nextAfterRevision: 1
                ),
                SyncTextChangePage(changes: [], hasMore: false, nextAfterRevision: 1),
            ]
        )
        let coordinator = SyncCoordinator(store: store, transport: transport)
        let firstNow = Date(timeIntervalSince1970: 1_700_001_000)

        let firstReport = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: firstNow
        )

        XCTAssertEqual(
            firstReport.outcome,
            .retryScheduled(eventID: nil, retryAt: firstNow.addingTimeInterval(2))
        )
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 1)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 0)
        XCTAssertEqual(
            try store.textStates(for: existing.id),
            [.present(field: .title, value: "Groceries")]
        )
        XCTAssertFalse(
            try store.loadEvents(for: fixture.potID).contains {
                $0.id == notYetVisible.id
            }
        )

        let secondReport = try await coordinator.synchronize(
            PotSyncRequest(potID: fixture.potID),
            now: firstNow.addingTimeInterval(2)
        )

        XCTAssertEqual(secondReport.outcome, .completed)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 2)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 1)
        XCTAssertEqual(
            try store.textStates(for: notYetVisible.id),
            [.redacted(field: .title)]
        )
        XCTAssertEqual(
            try store.textStates(for: existing.id),
            [.present(field: .title, value: "Groceries")]
        )
    }

    private func hydrated(
        _ event: EventEnvelope,
        sequence: Int64
    ) throws -> HydratedWireEventV1 {
        let wire = try WireEventV1(event)
        return try HydratedWireEventV1(
            event: wire.arithmeticOnly,
            serverSequence: sequence,
            textStates: wire.authoredText.map {
                .present(field: $0.field, value: $0.value)
            }
        )
    }
}

private actor FakeSyncTransport: SyncTransport {
    enum Operation: Equatable, Sendable {
        case promote(PotID, [EventID])
        case list(afterSequence: Int64)
        case listText(afterRevision: Int64)
        case append(EventID)
    }

    private let remotePots: [RemotePotDescriptor]
    private var pages: [SyncEventPage]
    private var textPages: [SyncTextChangePage]
    private var appendFailures: [SyncTransportError]
    private var promotionFailures: [SyncTransportError]
    private let promotionAcknowledgements: [EventAcknowledgement]?
    private var recordedOperations: [Operation] = []
    private var nextSequence: Int64 = 1
    private var activeAppends = 0
    private var maxActiveAppends = 0
    private let blocksFirstAppendUntilCancelled: Bool
    private let blocksFirstListUntilCancelled: Bool
    private var didStartBlockingAppend = false
    private var didStartBlockingList = false
    private var blockingAppendWaiter: CheckedContinuation<Void, Never>?
    private var blockingListWaiter: CheckedContinuation<Void, Never>?

    init(
        remotePots: [RemotePotDescriptor] = [],
        pages: [SyncEventPage] = [],
        textPages: [SyncTextChangePage] = [],
        promotionFailures: [SyncTransportError] = [],
        promotionAcknowledgements: [EventAcknowledgement]? = nil,
        appendFailures: [SyncTransportError] = [],
        blocksFirstAppendUntilCancelled: Bool = false,
        blocksFirstListUntilCancelled: Bool = false
    ) {
        self.remotePots = remotePots
        self.pages = pages
        self.textPages = textPages
        self.promotionFailures = promotionFailures
        self.promotionAcknowledgements = promotionAcknowledgements
        self.appendFailures = appendFailures
        self.blocksFirstAppendUntilCancelled = blocksFirstAppendUntilCancelled
        self.blocksFirstListUntilCancelled = blocksFirstListUntilCancelled
    }

    func connectionStates() async -> AsyncStream<SyncConnectionState> {
        AsyncStream { continuation in
            continuation.yield(.connected)
            continuation.finish()
        }
    }

    func listPots() async throws -> [RemotePotDescriptor] {
        remotePots
    }

    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        recordedOperations.append(.promote(
            request.configuration.id,
            request.events.map(\.eventId)
        ))
        if !promotionFailures.isEmpty {
            throw promotionFailures.removeFirst()
        }
        if let promotionAcknowledgements {
            return promotionAcknowledgements
        }
        return request.events.map { event in
            defer { nextSequence += 1 }
            return EventAcknowledgement(
                eventID: event.eventId,
                serverSequence: nextSequence
            )
        }
    }

    func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        activeAppends += 1
        maxActiveAppends = max(maxActiveAppends, activeAppends)
        defer { activeAppends -= 1 }
        guard let event = events.first, events.count == 1 else {
            throw SyncTransportError.terminal(code: "FAKE_EXPECTED_SINGLE_EVENT")
        }
        recordedOperations.append(.append(event.eventId))
        if blocksFirstAppendUntilCancelled, !didStartBlockingAppend {
            didStartBlockingAppend = true
            blockingAppendWaiter?.resume()
            blockingAppendWaiter = nil
            try await Task.sleep(for: .seconds(60))
        }
        if !appendFailures.isEmpty {
            throw appendFailures.removeFirst()
        }
        let acknowledgement = EventAcknowledgement(
            eventID: event.eventId,
            serverSequence: nextSequence
        )
        nextSequence += 1
        return [acknowledgement]
    }

    func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage {
        recordedOperations.append(.list(afterSequence: afterSequence))
        if blocksFirstListUntilCancelled, !didStartBlockingList {
            didStartBlockingList = true
            blockingListWaiter?.resume()
            blockingListWaiter = nil
            try await Task.sleep(for: .seconds(60))
        }
        if !pages.isEmpty {
            return pages.removeFirst()
        }
        return SyncEventPage(
            events: [],
            hasMore: false,
            nextAfterSequence: afterSequence
        )
    }

    func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        recordedOperations.append(.listText(afterRevision: afterRevision))
        if !textPages.isEmpty {
            return textPages.removeFirst()
        }
        return SyncTextChangePage(
            changes: [],
            hasMore: false,
            nextAfterRevision: afterRevision
        )
    }

    func operations() -> [Operation] { recordedOperations }
    func waitUntilBlockingAppendStarts() async {
        if didStartBlockingAppend { return }
        await withCheckedContinuation { blockingAppendWaiter = $0 }
    }
    func waitUntilBlockingListStarts() async {
        if didStartBlockingList { return }
        await withCheckedContinuation { blockingListWaiter = $0 }
    }
    func maximumConcurrentAppends() -> Int { maxActiveAppends }
    func appendedEventIDs() -> [EventID] {
        recordedOperations.compactMap { operation in
            guard case let .append(eventID) = operation else { return nil }
            return eventID
        }
    }
    func listAfterSequences() -> [Int64] {
        recordedOperations.compactMap { operation in
            guard case let .list(afterSequence) = operation else { return nil }
            return afterSequence
        }
    }
    func listAfterTextRevisions() -> [Int64] {
        recordedOperations.compactMap { operation in
            guard case let .listText(afterRevision) = operation else { return nil }
            return afterRevision
        }
    }
}
