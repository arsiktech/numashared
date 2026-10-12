import Foundation
import NumaSharedCore
import NumaSharedSync
import XCTest
@testable import NumaShared

final class SyncAdoptionTests: XCTestCase {
    private let accountA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let accountB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    func testCleanDeviceAdoptsExistingRemoteWhileNonemptyLocalPotPromotes() throws {
        let local = AppLedgerIdentitySet.fresh(at: Date(timeIntervalSince1970: 1_700_000_000))
        let remote = AppLedgerIdentitySet.fresh(at: Date(timeIntervalSince1970: 1_700_000_100))
        let descriptor = try remoteDescriptor(identities: remote)

        XCTAssertEqual(
            SyncPotSelection.decide(
                localPotID: local.potID,
                localEventCount: 0,
                remotePots: [descriptor]
            ),
            .adoptRemote(descriptor)
        )
        XCTAssertEqual(
            SyncPotSelection.decide(
                localPotID: local.potID,
                localEventCount: 1,
                remotePots: [descriptor]
            ),
            .useLocal(needsPromotion: true)
        )
        XCTAssertEqual(
            SyncPotSelection.decide(
                localPotID: remote.potID,
                localEventCount: 0,
                remotePots: [descriptor]
            ),
            .adoptRemote(descriptor)
        )
        XCTAssertEqual(
            SyncPotSelection.decide(
                localPotID: local.potID,
                localEventCount: 0,
                remotePots: []
            ),
            .useLocal(needsPromotion: true)
        )
    }

    func testRemoteIdentityPreservesEverySettlementUnitBeyondTheCasaMarFixture() throws {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: date)
        let remoteUnits = (0..<10).map { offset in
            NumaSharedCore.UnitID.generate(
                at: date.addingTimeInterval(TimeInterval(offset + 1))
            )
        }
        let configuration = try PotConfiguration(
            id: .generate(at: date),
            currency: .eur,
            orderedUnitIDs: remoteUnits
        )

        let adopted = try AppLedgerIdentitySet.adoptingRemotePot(
            configuration: configuration,
            memberID: .generate(at: date),
            preserving: local
        )
        let appUnits = remoteUnits.compactMap(adopted.appUnit(for:))

        XCTAssertEqual(adopted.orderedUnitIDs, remoteUnits)
        XCTAssertEqual(appUnits.count, 10)
        XCTAssertEqual(Set(appUnits).count, 10)
        XCTAssertEqual(
            appUnits.map(adopted.coreUnit(for:)),
            remoteUnits
        )
    }

    func testAdoptedRemoteIdentityAndProjectionSurviveRepositoryRelaunch() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(at: baseDate.addingTimeInterval(100))
        let remoteMemberID = NumaSharedCore.MemberID.generate(
            at: baseDate.addingTimeInterval(200)
        )
        let descriptor = try remoteDescriptor(
            identities: remote,
            memberID: remoteMemberID
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedAdoption-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadataURL = directory.appendingPathComponent("active-identity.json")
        let store = try LedgerStore.inMemory(now: baseDate)
        let first = AppLedgerRepository(
            store: store,
            identities: local,
            identityMetadataURL: metadataURL
        )
        _ = try await first.bootstrap(seedCasaMar: false)

        let adopted = try await first.activateRemotePot(
            descriptor,
            accountID: accountA
        )
        XCTAssertEqual(adopted.configuration.id, remote.potID)
        XCTAssertEqual(adopted.ownerMemberID, remoteMemberID)

        let event = EventEnvelope(
            potID: remote.potID,
            actorMemberID: remoteMemberID,
            occurredAt: baseDate.addingTimeInterval(300),
            originatingTimeZone: try IANATimeZone("UTC"),
            serverSequence: 1,
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: .generate(at: baseDate.addingTimeInterval(300)),
                content: ExpenseContent(
                    kind: .shared,
                    title: "Created on device A",
                    amount: Money(minorUnits: 125, currency: .eur),
                    payerUnitID: remote.householdUnitID,
                    allocations: [ExpenseAllocation(
                        unitID: remote.samUnitID,
                        amount: Money(minorUnits: 125, currency: .eur)
                    )]
                )
            ))
        )
        _ = try store.ingestRemoteEvent(event, receivedAt: baseDate.addingTimeInterval(301))
        let firstSnapshot = try await first.refreshSnapshot()
        XCTAssertEqual(firstSnapshot.records.map(\.title), ["Created on device A"])

        let reopened = AppLedgerRepository(
            store: store,
            identities: local,
            identityMetadataURL: metadataURL
        )
        let reopenedContext = try await reopened.syncContext()
        let reopenedSnapshot = try await reopened.refreshSnapshot()
        XCTAssertEqual(reopenedContext.configuration.id, remote.potID)
        XCTAssertEqual(reopenedContext.ownerMemberID, remoteMemberID)
        XCTAssertEqual(reopenedContext.accountID, accountA)
        XCTAssertEqual(
            reopenedContext.minimumReaderSchemaVersion,
            EventEnvelope.currentSchemaVersion
        )
        XCTAssertEqual(reopenedSnapshot.records.map(\.title), ["Created on device A"])
    }

    func testPersistedPotIdentityCannotCrossAuthenticatedAccounts() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedBinding-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local,
            identityMetadataURL: directory.appendingPathComponent("identity.json")
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.bindActiveIdentity(
            to: accountA,
            minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
        )

        do {
            try await repository.validateAccountBinding(accountB)
            XCTFail("A different account must not reuse the persisted pot identity")
        } catch let error as AppLedgerRepositoryError {
            guard case .accountIdentityMismatch = error else {
                return XCTFail("Expected accountIdentityMismatch, got \(error)")
            }
        }
        do {
            _ = try await repository.activateRemotePot(
                remoteDescriptor(identities: remote),
                accountID: accountB
            )
            XCTFail("A different account must not adopt over persisted history")
        } catch let error as AppLedgerRepositoryError {
            guard case .accountIdentityMismatch = error else {
                return XCTFail("Expected accountIdentityMismatch, got \(error)")
            }
        }
        let unchanged = try await repository.syncContext()
        XCTAssertEqual(unchanged.configuration.id, local.potID)
        XCTAssertEqual(unchanged.accountID, accountA)
    }

#if DEBUG
    @MainActor
    func testRuntimeForcesFreshE2ELoginAndAdoptsTheAccountPot() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let descriptor = try remoteDescriptor(identities: remote)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)

        let tokens = RuntimeRefreshTokenStore(token: "stale-fixed-token")
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: tokens
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor]
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 10
        )

        await runtime.loginE2E(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let calls = client.loginCounts()
        let diagnostic = runtime.diagnosticState()
        let active = try await repository.syncContext()
        XCTAssertEqual(calls.fresh, 1)
        XCTAssertEqual(calls.cached, 0)
        XCTAssertEqual(diagnostic.accountID, accountA)
        XCTAssertEqual(active.configuration.id, remote.potID)
        XCTAssertEqual(active.ownerMemberID, descriptor.memberID)
        let firstLivePullCount = client.callCounts().listEvents
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertGreaterThan(client.callCounts().listEvents, firstLivePullCount)
    }

    @MainActor
    func testHeldBudgetGroupPromotionWaitsLocallyThenUsesOriginalPrefix() async throws {
        let date = Date()
        let identities = AppLedgerIdentitySet.fresh(at: date)
        let store = try LedgerStore.inMemory(now: date, readerSchemaVersion: 2)
        let repository = AppLedgerRepository(store: store, identities: identities)
        let groupUnit = NumaSharedCore.UnitID.generate(at: date)
        let group = SettlementGroupSnapshot(groupID: .generate(at: date), unitID: groupUnit,
            orderedMemberIDs: [identities.ownerMemberID, identities.samMemberID], defaultShareWeight: 1)
        _ = try await repository.configureLocalBudgetGroups(potName: "House", members: UnitID.allCases.map { unit in
            LocalPotSetupMember(memberID: identities.memberID(for: unit), unitID: identities.coreUnit(for: unit),
                displayName: "Synthetic member", role: unit == .am ? .owner : .member)
        }, groups: [group], at: date)
        _ = try await repository.appendBudgetGroupExpense(content: ExpenseContent(kind: .personal, title: "Paid for neighbor",
            amount: Money(minorUnits: 40, currency: .eur), payerUnitID: groupUnit,
            allocations: [ExpenseAllocation(unitID: identities.leoUnitID, amount: Money(minorUnits: 40, currency: .eur))],
            payerMemberID: identities.samMemberID), at: date)
        let before = try store.loadStoredEvents(for: identities.potID)
        let client = RuntimeSyncClientStub(session: NumaSession(accessToken: "run-access", accessTokenExpiresInSeconds: 300,
            refreshToken: "run-refresh", refreshExpiresAt: 1_900_000_000_000, accountID: accountA), remotePots: [])
        let runtime = try await AppSyncRuntime(repository: repository,
            authProvider: NumaAuthProvider(server: RuntimeSessionServerStub(), refreshTokens: RuntimeRefreshTokenStore(token: nil)),
            client: client, healthyPollingIntervalMilliseconds: 1_000, retryPollingBaseDelayMilliseconds: 10)
        await runtime.loginE2E(accountKey: "held-budget-bootstrap", bootstrapSecret: String(repeating: "s", count: 32))
        let waiting = runtime.diagnosticState()
        XCTAssertEqual(waiting.report?.isWaitingForLocalReadiness, true)
        XCTAssertNil(waiting.errorCode)
        XCTAssertEqual(client.callCounts().promote, 0)
        XCTAssertEqual(client.callCounts().listEvents, 0)
        XCTAssertEqual(client.callCounts().listTextChanges, 0)
        XCTAssertNil(try store.persistedSyncPause(for: identities.potID))
        XCTAssertEqual(try store.loadStoredEvents(for: identities.potID).map(\.event), before.map(\.event))
        XCTAssertEqual(try store.loadStoredEvents(for: identities.potID).map(\.localOrdinal), before.map(\.localOrdinal))
        _ = try store.expireHeldEvents(now: date.addingTimeInterval(UndoPolicy.window))
        await runtime.synchronizeNow()
        XCTAssertEqual(client.callCounts().promote, 1)
        XCTAssertEqual(client.promotionRequests.first?.events.map(\.eventId), before.map(\.event.id))
        XCTAssertEqual(runtime.diagnosticState().report?.outcome, .completed)
        XCTAssertEqual(try store.loadStoredEvents(for: identities.potID).map(\.delivery.serverSequence), [1, 2, 3, 4, 5, 6])
    }

    @MainActor
    func testPausedRuntimeStillPullsErasureAndRefreshesRosterWithoutDispatching() async throws {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: date)
        let descriptor = try remoteDescriptor(identities: identities)
        let store = try LedgerStore.inMemory(now: date)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let event = EventEnvelope(potID: identities.potID, actorMemberID: identities.samMemberID,
            occurredAt: date, originatingTimeZone: try IANATimeZone("UTC"), serverSequence: 1,
            payload: .expenseAdded(ExpenseAddedPayload(recordID: .generate(at: date), content: ExpenseContent(kind: .personal,
                title: "Text awaiting erasure", amount: Money(minorUnits: 40, currency: .eur), payerUnitID: identities.samUnitID,
                allocations: [ExpenseAllocation(unitID: identities.householdUnitID, amount: Money(minorUnits: 40, currency: .eur))]))))
        _ = try store.ingestRemoteEvent(event)
        let roster = [PotMemberProfile(memberID: identities.ownerMemberID, unitID: identities.householdUnitID,
                displayName: "Owner", role: .owner, state: .active),
            PotMemberProfile(memberID: identities.samMemberID, unitID: identities.samUnitID,
                displayName: nil, role: .member, state: .archived)]
        _ = try store.replaceCachedMemberRoster([roster[0], PotMemberProfile(memberID: identities.samMemberID,
            unitID: identities.samUnitID, displayName: "Name awaiting erasure", role: .member, state: .active)], for: identities.potID)
        try store.setPersistedSyncPause("INACTIVE_UNIT", for: identities.potID)
        let client = RuntimeSyncClientStub(session: NumaSession(accessToken: "run-access", accessTokenExpiresInSeconds: 300,
            refreshToken: "run-refresh", refreshExpiresAt: 1_900_000_000_000, accountID: accountA), remotePots: [descriptor],
            remoteTextChanges: [TextRedactionChange(eventID: event.id, field: .title, revision: 1)], memberRoster: roster)
        let runtime = try await AppSyncRuntime(repository: repository,
            authProvider: NumaAuthProvider(server: RuntimeSessionServerStub(), refreshTokens: RuntimeRefreshTokenStore(token: nil)),
            client: client, healthyPollingIntervalMilliseconds: 10, retryPollingBaseDelayMilliseconds: 10)
        await runtime.loginE2E(accountKey: "paused-erasure", bootstrapSecret: String(repeating: "s", count: 32))
        let first = client.callCounts()
        XCTAssertGreaterThan(first.listTextChanges, 0)
        XCTAssertGreaterThan(first.listRoster, 0)
        XCTAssertEqual(first.append, 0)
        XCTAssertEqual(first.promote, 0)
        XCTAssertEqual(try store.payerDisplayName(memberID: identities.samMemberID, potID: identities.potID), "Former member")
        let snapshot = try store.snapshot(for: identities.potID)
        let csv = try LedgerCSVExporter.make(potName: "House", configuration: descriptor.configuration, snapshot: snapshot)
        XCTAssertFalse(String(decoding: csv.data, as: UTF8.self).contains("Text awaiting erasure"))
        XCTAssertTrue(runtime.diagnosticState().automaticallyPolling)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertGreaterThan(client.callCounts().listTextChanges, first.listTextChanges)
        XCTAssertEqual(client.callCounts().append, 0)
    }

    @MainActor
    func testArchivedRuntimeRefreshesLaterErasureWithoutReadingOrWritingFinancialHistory() async throws {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: date)
        let descriptor = try remoteDescriptor(identities: identities)
        let store = try LedgerStore.inMemory(now: date)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let members = [
            MemberAddedPayload(memberID: identities.samMemberID, unitID: identities.samUnitID, role: .owner),
            MemberAddedPayload(memberID: identities.ownerMemberID, unitID: identities.householdUnitID, role: .member),
        ]
        for (index, member) in members.enumerated() {
            _ = try store.ingestRemoteEvent(EventEnvelope(potID: identities.potID,
                actorMemberID: identities.samMemberID, occurredAt: date,
                originatingTimeZone: try IANATimeZone("UTC"), serverSequence: Int64(index + 1),
                payload: .memberAdded(member)))
        }
        let event = EventEnvelope(potID: identities.potID, actorMemberID: identities.samMemberID,
            occurredAt: date, originatingTimeZone: try IANATimeZone("UTC"), serverSequence: 3,
            payload: .expenseAdded(ExpenseAddedPayload(recordID: .generate(at: date), content: ExpenseContent(kind: .shared,
                title: "Erase after archive", amount: Money(minorUnits: 40, currency: .eur), payerUnitID: identities.samUnitID,
                allocations: [ExpenseAllocation(unitID: identities.householdUnitID, amount: Money(minorUnits: 40, currency: .eur))]))))
        _ = try store.ingestRemoteEvent(event)
        _ = try store.ingestRemoteEvent(EventEnvelope(potID: identities.potID,
            actorMemberID: identities.samMemberID, occurredAt: date,
            originatingTimeZone: try IANATimeZone("UTC"), serverSequence: 4,
            payload: .memberArchived(MemberArchivedPayload(memberID: identities.ownerMemberID))))
        _ = try store.replaceCachedMemberRoster([
            PotMemberProfile(memberID: identities.ownerMemberID, unitID: identities.householdUnitID,
                displayName: "Reader", role: .member, state: .archived),
            PotMemberProfile(memberID: identities.samMemberID, unitID: identities.samUnitID,
                displayName: "Owner", role: .owner, state: .active),
        ], for: identities.potID)
        let archivedBeforeLogin = try await repository.refreshSnapshot()
        XCTAssertTrue(archivedBeforeLogin.isCurrentMemberArchived)
        let client = RuntimeSyncClientStub(session: NumaSession(accessToken: "run-access", accessTokenExpiresInSeconds: 300,
            refreshToken: "run-refresh", refreshExpiresAt: 1_900_000_000_000, accountID: accountA), remotePots: [descriptor])
        let runtime = try await AppSyncRuntime(repository: repository,
            authProvider: NumaAuthProvider(server: RuntimeSessionServerStub(), refreshTokens: RuntimeRefreshTokenStore(token: nil)),
            client: client, healthyPollingIntervalMilliseconds: 10, retryPollingBaseDelayMilliseconds: 10)
        defer { runtime.retire() }
        await runtime.loginE2E(accountKey: "archived-erasure", bootstrapSecret: String(repeating: "s", count: 32))
        let archivedAfterLogin = try await repository.refreshSnapshot()
        XCTAssertTrue(archivedAfterLogin.isCurrentMemberArchived)
        XCTAssertTrue(runtime.diagnosticState().automaticallyPolling)
        let before = client.callCounts()
        client.replaceTextChanges([TextRedactionChange(eventID: event.id, field: .title, revision: 1)])
        for _ in 0..<100 {
            if try store.syncState(for: identities.potID)?.lastTextRevision == 1 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(try store.textStates(for: event.id), [.redacted(field: .title)])
        XCTAssertGreaterThan(client.callCounts().listTextChanges, before.listTextChanges)
        XCTAssertEqual(client.callCounts().listEvents, before.listEvents)
        XCTAssertEqual(client.callCounts().append, 0)
        XCTAssertEqual(client.callCounts().promote, 0)
        // Polling behavior is proven above; stop its timer before deterministic
        // export preflight/failure checks so it cannot consume the injected errors.
        runtime.retire()
        let current = try await runtime.refreshPrivacyBeforeExport()
        XCTAssertTrue(current)
        let csv = try LedgerCSVExporter.make(potName: "House", configuration: descriptor.configuration,
            snapshot: store.snapshot(for: identities.potID))
        XCTAssertFalse(String(decoding: csv.data, as: UTF8.self).contains("Erase after archive"))
        client.textChangeFailure = .retryable(code: "TRANSPORT_UNAVAILABLE")
        let offline = try await runtime.refreshPrivacyBeforeExport()
        XCTAssertFalse(offline)
        client.textChangeFailure = .terminal(code: "INVALID_SERVER_RESPONSE")
        do {
            _ = try await runtime.refreshPrivacyBeforeExport()
            XCTFail("Malformed redactions must not be reported as ordinary offline export")
        } catch {
            XCTAssertEqual(error as? SyncTransportError, .terminal(code: "INVALID_SERVER_RESPONSE"))
        }
    }

    @MainActor
    func testArchivedPartialErasureFailurePublishesCommittedSnapshotBeforeSkipOnlyRetry() async throws {
        for malformedSecondPage in [true, false] {
            let date = Date(timeIntervalSince1970: 1_700_000_000)
            let identities = AppLedgerIdentitySet.fresh(at: date)
            let descriptor = try remoteDescriptor(identities: identities)
            let store = try LedgerStore.inMemory(now: date)
            let repository = AppLedgerRepository(store: store, identities: identities)
            _ = try await repository.bootstrap(seedCasaMar: false)
            let members = [
                MemberAddedPayload(memberID: identities.samMemberID, unitID: identities.samUnitID, role: .owner),
                MemberAddedPayload(memberID: identities.ownerMemberID, unitID: identities.householdUnitID, role: .member),
            ]
            for (index, member) in members.enumerated() {
                _ = try store.ingestRemoteEvent(EventEnvelope(potID: identities.potID,
                    actorMemberID: identities.samMemberID, occurredAt: date,
                    originatingTimeZone: try IANATimeZone("UTC"), serverSequence: Int64(index + 1),
                    payload: .memberAdded(member)))
            }
            let privateTitle = "Committed erasure before later page fails"
            let event = EventEnvelope(potID: identities.potID, actorMemberID: identities.samMemberID,
                occurredAt: date, originatingTimeZone: try IANATimeZone("UTC"), serverSequence: 3,
                payload: .expenseAdded(ExpenseAddedPayload(recordID: .generate(at: date), content: ExpenseContent(kind: .shared,
                    title: privateTitle, amount: Money(minorUnits: 40, currency: .eur), payerUnitID: identities.samUnitID,
                    allocations: [ExpenseAllocation(unitID: identities.householdUnitID, amount: Money(minorUnits: 40, currency: .eur))]))))
            _ = try store.ingestRemoteEvent(event)
            _ = try store.ingestRemoteEvent(EventEnvelope(potID: identities.potID,
                actorMemberID: identities.samMemberID, occurredAt: date,
                originatingTimeZone: try IANATimeZone("UTC"), serverSequence: 4,
                payload: .memberArchived(MemberArchivedPayload(memberID: identities.ownerMemberID))))
            let client = RuntimeSyncClientStub(session: NumaSession(accessToken: "run-access", accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh", refreshExpiresAt: 1_900_000_000_000, accountID: accountA), remotePots: [descriptor])
            let runtime = try await AppSyncRuntime(repository: repository,
                authProvider: NumaAuthProvider(server: RuntimeSessionServerStub(), refreshTokens: RuntimeRefreshTokenStore(token: nil)),
                client: client, healthyPollingIntervalMilliseconds: 4_999)
            await runtime.loginE2E(accountKey: "archived-partial-erasure", bootstrapSecret: String(repeating: "s", count: 32))
            runtime.retire() // Stop the timer before installing the model callback.
            defer { runtime.retire() }
            let initial = try await repository.refreshSnapshot()
            XCTAssertTrue(initial.isCurrentMemberArchived)
            let model = AppModel(repository: repository, snapshot: initial,
                accountDeletionRecoveryStore: AccountDeletionRecoveryStore(directory:
                    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
            model.setSyncRuntimeForTesting(runtime)
            let export = try XCTUnwrap(model.prepareCSVExportForTesting(privacyRefresh: { true }, writer: {
                try await repository.writeCSVExport(potName: "House", temporaryDirectory: $0)
            }))
            await export.value
            let preparedURL = try XCTUnwrap(model.csvExportURL)
            XCTAssertTrue(try String(contentsOf: preparedURL, encoding: .utf8).contains(privateTitle))
            XCTAssertEqual(model.records.map(\.title), [privateTitle])
            let beforeFailure = runtime.diagnosticState()
            client.scriptedTextPages = [
                .success(SyncTextChangePage(changes: [TextRedactionChange(eventID: event.id, field: .title, revision: 1)],
                    hasMore: true, nextAfterRevision: 1)),
                malformedSecondPage
                    ? .success(SyncTextChangePage(changes: [], hasMore: false, nextAfterRevision: 2))
                    : .failure(.terminal(code: "INVALID_SERVER_RESPONSE")),
            ]
            do {
                _ = try await runtime.refreshPrivacyBeforeExport()
                XCTFail("A failed later page must preserve the original failure")
            } catch {
                XCTAssertEqual(error as? SyncTransportError, .terminal(code: "INVALID_SERVER_RESPONSE"))
            }
            XCTAssertEqual(try store.syncState(for: identities.potID)?.lastTextRevision, 1)
            XCTAssertEqual(try store.textStates(for: event.id), [.redacted(field: .title)])
            XCTAssertEqual(model.records.count, 1)
            XCTAssertFalse(model.records.contains { $0.title == privateTitle })
            XCTAssertNil(model.csvExportURL)
            XCTAssertFalse(FileManager.default.fileExists(atPath: preparedURL.path))
            XCTAssertEqual(runtime.diagnosticState().presentation, beforeFailure.presentation)
            XCTAssertEqual(runtime.diagnosticState().errorCode, beforeFailure.errorCode)
            XCTAssertEqual(runtime.diagnosticState().automaticallyPolling, beforeFailure.automaticallyPolling)

            client.scriptedTextPages = [.success(SyncTextChangePage(changes: [], hasMore: false,
                nextAfterRevision: 2, skippedRevisions: [2]))]
            let refreshed = try await runtime.refreshPrivacyBeforeExport()
            XCTAssertTrue(refreshed)
            XCTAssertEqual(try store.syncState(for: identities.potID)?.lastTextRevision, 2)
            XCTAssertEqual(model.records.count, 1)
            XCTAssertFalse(model.records.contains { $0.title == privateTitle })
            XCTAssertNil(model.csvExportURL)
            XCTAssertNil(runtime.diagnosticState().errorCode)
        }
    }

    @MainActor
    func testCompletedRuntimeSyncRefreshesAndPublishesAuthoritativeRoster() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(at: baseDate.addingTimeInterval(100))
        let descriptor = try remoteDescriptor(identities: remote)
        let roster = [
            PotMemberProfile(
                memberID: remote.ownerMemberID,
                unitID: remote.householdUnitID,
                displayName: "Ari",
                role: .owner,
                state: .active
            ),
            PotMemberProfile(
                memberID: remote.samMemberID,
                unitID: remote.samUnitID,
                displayName: "Samira",
                role: .member,
                state: .active
            ),
            PotMemberProfile(
                memberID: remote.leoMemberID,
                unitID: remote.leoUnitID,
                displayName: "Leon",
                role: .member,
                state: .pending
            ),
        ]
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            memberRoster: roster
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 1_000,
            retryPollingBaseDelayMilliseconds: 10
        )

        await runtime.loginE2E(
            accountKey: "p3-roster-refresh",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let snapshot = try await repository.refreshSnapshot()
        XCTAssertEqual(client.callCounts().listRoster, 1)
        XCTAssertEqual(snapshot.memberProfiles.map(\.displayName), ["Ari", "Samira", "Leon"])
        XCTAssertEqual(snapshot.currentMemberProfile?.memberID, descriptor.memberID)
        XCTAssertTrue(snapshot.potSetup.isComplete)
    }

    @MainActor
    func testRuntimeMemberAdministrationRefreshesAfterReplaySafeOwnerMutations() async throws {
        try await checkMemberAdministration(schemaVersion: 1)
    }

    @MainActor
    func testBudgetGroupMemberAdministrationUsesAcceptedSchemaAndExactRetry() async throws {
        try await checkMemberAdministration(schemaVersion: 2)
    }

    @MainActor
    private func checkMemberAdministration(schemaVersion: UInt16) async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(at: baseDate.addingTimeInterval(100))
        let descriptor = try remoteDescriptor(identities: remote, minimumReaderSchemaVersion: schemaVersion)
        let claimToApprove = try XCTUnwrap(PendingInviteClaimID(
            "claim-to-approve-00000001"
        ))
        let claimToReject = try XCTUnwrap(PendingInviteClaimID(
            "claim-to-reject-00000002"
        ))
        let inviteToApprove = try XCTUnwrap(UUID(
            uuidString: "018bcfe5-6800-7000-8000-000000000001"
        ))
        let inviteToReject = try XCTUnwrap(UUID(
            uuidString: "018bcfe5-6800-7000-8000-000000000002"
        ))
        let claims = [
            PendingInviteClaim(
                id: claimToApprove,
                inviteID: inviteToApprove,
                chosenMemberID: remote.leoMemberID,
                createdAtMillis: 1_700_000_000_100
            ),
            PendingInviteClaim(
                id: claimToReject,
                inviteID: inviteToReject,
                chosenMemberID: nil,
                createdAtMillis: 1_700_000_000_200
            ),
        ]
        let roster = [
            PotMemberProfile(
                memberID: remote.ownerMemberID,
                unitID: remote.householdUnitID,
                displayName: "Ari",
                role: .owner,
                state: .active
            ),
            PotMemberProfile(
                memberID: remote.samMemberID,
                unitID: remote.samUnitID,
                displayName: "Samira",
                role: .member,
                state: .active
            ),
            PotMemberProfile(
                memberID: remote.leoMemberID,
                unitID: remote.leoUnitID,
                displayName: "Leon",
                role: .member,
                state: .pending
            ),
        ]
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate, readerSchemaVersion: schemaVersion),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        var remoteEvents: [HydratedWireEventV1] = []
        if schemaVersion == 2 {
            let sourceStore = try LedgerStore.inMemory(now: baseDate, readerSchemaVersion: 2)
            let source = AppLedgerRepository(store: sourceStore, identities: remote)
            _ = try await source.completeBudgetGroupSetup(potName: "Group administration", currency: .eur,
                people: [(.am, "Ari"), (.sam, "Samira"), (.leo, "Leon")], pairs: [])
            let events = try sourceStore.loadEvents(for: remote.potID)
            remoteEvents = try events.enumerated().map { index, event in
                let wire = try WireEventV1(event)
                return try HydratedWireEventV1(event: wire, serverSequence: Int64(index + 1),
                    textStates: wire.authoredText.map { .present(field: $0.field, value: $0.value) })
            }
        }
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "member-admin-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "member-admin-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            remoteEvents: remoteEvents,
            memberRoster: roster,
            pendingInviteClaims: claims,
            claimReassignmentFailuresRemaining: 1
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 1_000,
            retryPollingBaseDelayMilliseconds: 10
        )
        await runtime.loginE2E(
            accountKey: "p3-member-administration",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let initialClaims = try await runtime.refreshMemberAdministration()
        XCTAssertEqual(initialClaims.map(\.id), [claimToApprove, claimToReject])
        let afterApproval = try await runtime.approvePendingInviteClaim(
            claimToApprove,
            memberID: remote.leoMemberID,
            now: baseDate.addingTimeInterval(1)
        )
        XCTAssertEqual(afterApproval.map(\.id), [claimToReject])
        _ = try await runtime.rejectPendingInviteClaim(claimToReject)

        do {
            _ = try await runtime.reassignMemberClaim(
                remote.leoMemberID,
                now: baseDate.addingTimeInterval(2)
            )
            XCTFail("Expected the first reassignment response to be ambiguous")
        } catch {
            XCTAssertEqual(
                error as? SyncTransportError,
                .retryable(code: "TRANSPORT_UNAVAILABLE")
            )
        }
        _ = try await runtime.reassignMemberClaim(
            remote.leoMemberID,
            now: baseDate.addingTimeInterval(3)
        )
        _ = try await runtime.archiveMember(
            remote.leoMemberID,
            now: baseDate.addingTimeInterval(4)
        )
        _ = try await runtime.transferOwnership(
            to: remote.samMemberID,
            now: baseDate.addingTimeInterval(5)
        )
        try await runtime.leaveCurrentPot(
            now: baseDate.addingTimeInterval(6)
        )

        XCTAssertEqual(client.recordedApprovals.map(\.event.schemaVersion), [schemaVersion])
        XCTAssertEqual(client.recordedClaimReassignments.map(\.schemaVersion), [schemaVersion, schemaVersion])
        XCTAssertEqual(client.recordedMemberArchives.map(\.schemaVersion), [schemaVersion])
        XCTAssertEqual(client.recordedOwnershipTransfers.map(\.schemaVersion), [schemaVersion])
        XCTAssertEqual(client.recordedPotLeaves.map(\.archiveEvent.schemaVersion), [schemaVersion])
        XCTAssertEqual(client.recordedApprovals.count, 1)
        XCTAssertEqual(client.recordedRejections, [claimToReject])
        XCTAssertEqual(client.recordedClaimReassignments.count, 2)
        XCTAssertEqual(
            client.recordedClaimReassignments.map(\.eventId),
            Array(repeating: client.recordedClaimReassignments[0].eventId, count: 2)
        )
        XCTAssertEqual(client.recordedMemberArchives.count, 1)
        XCTAssertEqual(client.recordedOwnershipTransfers.count, 1)
        XCTAssertEqual(client.recordedPotLeaves.count, 1)
        let snapshot = try await repository.refreshSnapshot()
        XCTAssertEqual(snapshot.currentMemberProfile?.state, .archived)
        XCTAssertEqual(
            snapshot.memberProfiles.first {
                $0.memberID == remote.samMemberID
            }?.role,
            .owner
        )
    }

    @MainActor
    func testInviteIssuanceRetriesExactCredentialsAndRevokesByStableID() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(at: baseDate.addingTimeInterval(100))
        let descriptor = try remoteDescriptor(identities: remote)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "invite-admin-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "invite-admin-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            memberRoster: [
                PotMemberProfile(
                    memberID: remote.ownerMemberID,
                    unitID: remote.householdUnitID,
                    displayName: "Ari",
                    role: .owner,
                    state: .active
                ),
                PotMemberProfile(
                    memberID: remote.samMemberID,
                    unitID: remote.samUnitID,
                    displayName: "Samira",
                    role: .member,
                    state: .pending
                ),
            ],
            inviteIssueFailuresRemaining: 1
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 1_000,
            retryPollingBaseDelayMilliseconds: 10
        )
        await runtime.loginE2E(
            accountKey: "p3-invite-administration",
            bootstrapSecret: String(repeating: "s", count: 32)
        )
        let firstCredentials = try XCTUnwrap(InviteCredentialPair(
            token: "first_invite_token_0123456789abcdef0123456789abcdef",
            code: "SAM234"
        ))
        let replacementCredentials = try XCTUnwrap(InviteCredentialPair(
            token: "replacement_token_0123456789abcdef0123456789abcdef",
            code: "NEW567"
        ))

        do {
            _ = try await runtime.issueInvite(
                kind: .perMember,
                pendingMemberID: remote.samMemberID,
                credentials: firstCredentials,
                now: baseDate
            )
            XCTFail("Expected the first issue response to be ambiguous")
        } catch {
            XCTAssertEqual(
                error as? SyncTransportError,
                .retryable(code: "TRANSPORT_UNAVAILABLE")
            )
        }
        let issued = try await runtime.issueInvite(
            kind: .perMember,
            pendingMemberID: remote.samMemberID,
            credentials: replacementCredentials,
            now: baseDate.addingTimeInterval(60)
        )

        XCTAssertEqual(client.recordedInviteIssues.count, 2)
        XCTAssertEqual(client.recordedInviteIssues[0], client.recordedInviteIssues[1])
        XCTAssertEqual(issued, client.recordedInviteIssues[0])
        XCTAssertEqual(issued.credentials, firstCredentials)
        let listed = try await runtime.listManagedInvites()
        XCTAssertEqual(listed.map(\.inviteID), [issued.inviteID])
        let afterRevocation = try await runtime.revokeInvite(issued.inviteID)
        XCTAssertEqual(afterRevocation, [])
        XCTAssertEqual(client.recordedInviteRevocations, [issued.inviteID])
    }

    @MainActor
    func testInviteLoginDefersLocalPromotionUntilClaimAndThenAdoptsClaimedPot() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let descriptor = try remoteDescriptor(identities: remote)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "invite-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "invite-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            inviteOutcome: .joined(
                potID: descriptor.configuration.id,
                memberID: descriptor.memberID,
                serverSequence: 1
            )
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let credential = NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        )

        let authenticated = await runtime.loginForInvite(with: credential)
        XCTAssertTrue(authenticated)
        XCTAssertEqual(client.callCounts().listPots, 0)
        XCTAssertEqual(client.callCounts().promote, 0)

        let outcome = try await runtime.claimInvite(
            ticket: "v1.01890f5e-7b00-7000-9000-000000000001.signature",
            kind: .perMember,
            now: baseDate,
            timeZone: try IANATimeZone("Europe/Madrid"),
            targetSchemaVersion: 1
        )

        let active = try await repository.syncContext()
        XCTAssertEqual(
            outcome,
            .joined(
                potID: descriptor.configuration.id,
                memberID: descriptor.memberID,
                serverSequence: 1
            )
        )
        XCTAssertEqual(active.configuration.id, descriptor.configuration.id)
        XCTAssertEqual(active.ownerMemberID, descriptor.memberID)
        XCTAssertEqual(client.callCounts().listPots, 1)
        XCTAssertEqual(client.callCounts().promote, 0)
        XCTAssertEqual(client.inviteRequests().count, 1)
    }

    @MainActor
    func testPotLinkClaimStaysPendingWithoutGrantingOrSwitchingPotAccess() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "invite-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "invite-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            inviteOutcome: .pendingApproval
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )

        let authenticated = await runtime.loginForInvite(with: NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        ))
        XCTAssertTrue(authenticated)
        let outcome = try await runtime.claimInvite(
            ticket: "v1.01890f5e-7b00-7000-9000-000000000001.signature",
            kind: .potLink,
            now: baseDate,
            timeZone: try IANATimeZone("UTC")
        )

        let active = try await repository.syncContext()
        XCTAssertEqual(outcome, .pendingApproval)
        XCTAssertEqual(active.configuration.id, local.potID)
        XCTAssertEqual(client.callCounts().listPots, 0)
        XCTAssertEqual(client.callCounts().promote, 0)
    }

    @MainActor
    func testAuthenticatedRuntimeRegistersPushTokenAndRoundTripsPotMute() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let descriptor = try remoteDescriptor(identities: remote)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "push-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "push-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            inviteOutcome: .joined(
                potID: descriptor.configuration.id,
                memberID: descriptor.memberID,
                serverSequence: 1
            )
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let authenticated = await runtime.loginForInvite(with: NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        ))
        XCTAssertTrue(authenticated)
        _ = try await runtime.claimInvite(
            ticket: "v1.01890f5e-7b00-7000-9000-000000000001.signature",
            kind: .perMember,
            now: baseDate,
            timeZone: try IANATimeZone("Europe/Madrid"),
            targetSchemaVersion: 1
        )
        let token = try XCTUnwrap(APNsDeviceToken(
            hex: String(repeating: "ab", count: 32)
        ))
        let registration = PushTokenRegistration(
            token: token,
            environment: .sandbox,
            timeZone: try IANATimeZone("Europe/Madrid")
        )

        try await runtime.registerPushToken(registration)
        let initiallyMuted = try await runtime.getPotMute()
        let confirmedMuted = try await runtime.setPotMute(true)
        let finallyMuted = try await runtime.getPotMute()
        XCTAssertFalse(initiallyMuted)
        XCTAssertTrue(confirmedMuted)
        XCTAssertTrue(finallyMuted)

        XCTAssertEqual(client.recordedPushRegistrations, [registration])
        XCTAssertEqual(client.recordedPotMuteChanges, [true])

        try await runtime.signOut(unregistering: token)

        XCTAssertEqual(client.recordedPushTokenRemovals, [token])
        XCTAssertEqual(client.callCounts().logout, 1)
        XCTAssertNil(runtime.diagnosticState().accountID)
        XCTAssertEqual(runtime.diagnosticState().presentation, .local)
    }

    @MainActor
    func testNotificationRouteActivatesExactAuthorizedRemotePot() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let first = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let second = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(200)
        )
        let firstDescriptor = try remoteDescriptor(identities: first)
        let secondDescriptor = try remoteDescriptor(identities: second)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "push-route-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "push-route-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [firstDescriptor, secondDescriptor]
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        await runtime.loginE2E(
            accountKey: "p3-notification-route",
            bootstrapSecret: String(repeating: "s", count: 32)
        )
        let initialContext = try await repository.syncContext()
        XCTAssertEqual(
            initialContext.configuration.id,
            firstDescriptor.configuration.id
        )

        let snapshot = try await runtime.openNotificationPot(
            secondDescriptor.configuration.id
        )

        let routedContext = try await repository.syncContext()
        XCTAssertEqual(
            routedContext.configuration.id,
            secondDescriptor.configuration.id
        )
        XCTAssertEqual(snapshot.currentMemberID, secondDescriptor.memberID)
        XCTAssertEqual(client.callCounts().listPots, 2)
    }

    @MainActor
    func testJoinModelAuthenticatesClaimsAndPublishesJoinedWithoutOpeningSyncSetup() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(at: baseDate.addingTimeInterval(100))
        let descriptor = try remoteDescriptor(
            identities: remote,
            memberID: remote.samMemberID
        )
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "invite-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "invite-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            inviteOutcome: .joined(
                potID: descriptor.configuration.id,
                memberID: descriptor.memberID,
                serverSequence: 1
            ),
            memberRoster: [
                PotMemberProfile(
                    memberID: remote.ownerMemberID,
                    unitID: remote.householdUnitID,
                    displayName: "Arseny",
                    role: .owner,
                    state: .active
                ),
                PotMemberProfile(
                    memberID: remote.samMemberID,
                    unitID: remote.samUnitID,
                    displayName: "Sam",
                    role: .member,
                    state: .active
                ),
            ]
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let notifications = PushNotificationSystemStub(
            status: .notDetermined,
            grantsAuthorization: true
        )
        let model = AppModel(
            repository: repository,
            snapshot: snapshot,
            pushNotificationSystem: notifications
        )
        model.setSyncRuntimeForTesting(runtime)
        model.setResolvedInviteForTesting(
            ticket: "v1.01890f5e-7b00-7000-9000-000000000001.signature",
            kind: .perMember,
            potName: "Joined pot"
        )

        await model.submitAppleCredentialForTesting(NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        ))

        XCTAssertEqual(model.joinPhase, .joined(potName: "Joined pot"))
        XCTAssertTrue(model.joinPresented)
        XCTAssertFalse(model.syncSetupPresented)
        XCTAssertNil(model.joinErrorMessage)
        XCTAssertEqual(client.inviteRequests().count, 1)
        XCTAssertEqual(notifications.authorizationRequests, 1)
        XCTAssertEqual(notifications.remoteRegistrationRequests, 1)
    }

    @MainActor
    func testPerMemberClaimRetryReusesEventMetadataAfterAmbiguousServerSuccess() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(at: baseDate.addingTimeInterval(100))
        let descriptor = try remoteDescriptor(identities: remote, minimumReaderSchemaVersion: 2)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate, readerSchemaVersion: 2),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "invite-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "invite-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            listPotsFailuresRemaining: 1,
            inviteOutcome: .joined(
                potID: descriptor.configuration.id,
                memberID: descriptor.memberID,
                serverSequence: 1
            )
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let authenticated = await runtime.loginForInvite(with: NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        ))
        XCTAssertTrue(authenticated)
        let ticket = "v1.01890f5e-7b00-7000-9000-000000000001.signature"
        do {
            _ = try await runtime.claimInvite(ticket: ticket, kind: .perMember, timeZone: try IANATimeZone("UTC"))
            XCTFail("Unknown invitation target schema must not borrow the open pot's schema")
        } catch {
            XCTAssertEqual(error as? SyncTransportError, .terminal(code: "INVITE_READER_UPDATE_REQUIRED"))
        }
        XCTAssertTrue(client.inviteRequests().isEmpty)

        do {
            _ = try await runtime.claimInvite(
                ticket: ticket,
                kind: .perMember,
                now: baseDate,
                timeZone: try IANATimeZone("Europe/Madrid"),
            targetSchemaVersion: 2
        )
            XCTFail("The first remote-pot lookup must fail after the server claim")
        } catch {
            XCTAssertEqual(
                error as? SyncTransportError,
                .retryable(code: "TRANSPORT_UNAVAILABLE")
            )
        }

        _ = try await runtime.claimInvite(
            ticket: ticket,
            kind: .perMember,
            now: baseDate.addingTimeInterval(30),
            timeZone: try IANATimeZone("UTC"),
            targetSchemaVersion: 2
        )

        let requests = client.inviteRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0], requests[1])
        guard case let .perMember(_, metadata) = requests[0] else { return XCTFail("Expected member claim") }
        XCTAssertEqual(metadata.schemaVersion, 2)
    }

    @MainActor
    func testGenericTerminalPauseOffersRetryAndAcknowledgesWithoutRelaunch() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(at: baseDate.addingTimeInterval(100))
        let descriptor = try remoteDescriptor(identities: remote)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            malformedAppendAcknowledgementsRemaining: 1,
            acknowledgeAppendsAfterMalformed: true
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 4_999,
            retryPollingBaseDelayMilliseconds: 4_999
        )
        await runtime.loginE2E(
            accountKey: "p2-terminal-retry",
            bootstrapSecret: String(repeating: "s", count: 32)
        )
        let mutation = try await repository.appendExpense(
            title: "Retry exactly once",
            amountMinorUnits: 100,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: baseDate.addingTimeInterval(101),
            savedAt: baseDate
        )
        let context = try await repository.syncContext()
        _ = try context.store.expireHeldEvents(now: baseDate.addingTimeInterval(7))

        await runtime.synchronizeNow(userInitiated: true)
        var diagnostic = runtime.diagnosticState()
        XCTAssertEqual(
            diagnostic.presentation,
            .paused(pendingCount: 1, code: "INVALID_SERVER_RESPONSE")
        )
        XCTAssertEqual(diagnostic.presentation.action, .retry)
        XCTAssertFalse(diagnostic.automaticallyPolling)
        XCTAssertEqual(
            try context.store.loadStoredEvents(for: remote.potID).first?.delivery.state,
            .ready
        )

        await runtime.synchronizeNow(userInitiated: true)
        diagnostic = runtime.diagnosticState()
        XCTAssertEqual(diagnostic.presentation, .synced)
        XCTAssertTrue(diagnostic.automaticallyPolling)
        let delivery = try XCTUnwrap(
            context.store.loadStoredEvents(for: remote.potID)
                .first { $0.event.id == mutation.eventID }?.delivery
        )
        XCTAssertEqual(delivery.state, .acknowledged)
        XCTAssertEqual(delivery.serverSequence, 1)
        XCTAssertEqual(client.callCounts().append, 2)
    }

    @MainActor
    func testAppleBackendLoginFailureKeepsSetupAndErrorVisible() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "unused",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "unused",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            freshLoginErrorCode: "AUTH_EXCHANGE_UNAVAILABLE"
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let model = AppModel(repository: repository, snapshot: snapshot)
        model.setSyncRuntimeForTesting(runtime)
        model.beginSyncSetup()

        await model.submitAppleCredentialForTesting(NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        ))

        XCTAssertTrue(model.syncSetupPresented)
        XCTAssertEqual(model.syncPresentation, .local)
        XCTAssertEqual(
            model.syncErrorMessage,
            "Your records are safe here. Retry when you’re online."
        )
        XCTAssertEqual(client.callCounts().fresh, 1)
    }

    @MainActor
    func testBeginningSecondPotRetiresPreviousRuntimeBeforeRepositoryChange() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: []
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let model = AppModel(repository: repository, snapshot: snapshot)
        model.setSyncRuntimeForTesting(runtime)

        XCTAssertNotNil(runtime.onUpdate)

        model.beginNewPot()

        XCTAssertNil(runtime.onUpdate)
    }

    @MainActor
    func testInstallingReplacementRuntimeRetiresPreviousRuntime() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let session = NumaSession(
            accessToken: "access",
            accessTokenExpiresInSeconds: 300,
            refreshToken: "refresh",
            refreshExpiresAt: 1_900_000_000_000,
            accountID: accountA
        )
        let firstRuntime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: RuntimeSyncClientStub(session: session, remotePots: [])
        )
        let replacementRuntime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: RuntimeSyncClientStub(session: session, remotePots: [])
        )
        let model = AppModel(repository: repository, snapshot: snapshot)

        model.setSyncRuntimeForTesting(firstRuntime)
        model.setSyncRuntimeForTesting(replacementRuntime)

        XCTAssertNil(firstRuntime.onUpdate)
        XCTAssertNotNil(replacementRuntime.onUpdate)
    }

    @MainActor
    func testConcurrentSyncConfigurationSharesOneFlight() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)
        let gate = RuntimeConfigurationGate()

        let first = Task { @MainActor in
            await model.coordinateSyncConfigurationForTesting {
                await gate.hold()
            }
        }
        await gate.waitUntilStarted()
        let second = Task { @MainActor in
            await model.coordinateSyncConfigurationForTesting {
                await gate.hold()
            }
        }
        for _ in 0 ..< 10 { await Task.yield() }

        let startCount = await gate.startCount()
        await gate.releaseAll()
        await first.value
        await second.value

        XCTAssertEqual(startCount, 1)
    }

    @MainActor
    func testFailedLogoutKeepsAccountAndLocalPotAvailableForRetry() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = try await completeFixtureSetup(
            in: repository,
            at: baseDate
        )
        let refreshTokens = RuntimeRefreshTokenStore(token: "logout-refresh")
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(
                logoutError: .server(
                    code: "AUTH_LOGOUT_UNAVAILABLE",
                    retryable: true
                )
            ),
            refreshTokens: refreshTokens
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: []
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let model = AppModel(repository: repository, snapshot: snapshot)
        model.setSyncRuntimeForTesting(runtime)
        await runtime.loginE2E(accountKey: "owner", bootstrapSecret: "secret")

        model.confirmSignOut()
        for _ in 0 ..< 20 where model.isSigningOut {
            try await Task.sleep(for: .milliseconds(10))
        }

        let retainedToken = await refreshTokens.read()
        XCTAssertFalse(model.isSigningOut)
        XCTAssertFalse(model.signOutCleanupPending)
        XCTAssertEqual(
            model.signOutErrorMessage,
            "Sign out couldn’t finish. Try again."
        )
        XCTAssertEqual(model.potName, "Casa Mar")
        XCTAssertEqual(model.screen, .home)
        XCTAssertEqual(retainedToken, "logout-refresh")
        XCTAssertEqual(runtime.diagnosticState().accountID, accountA)
        XCTAssertNotNil(runtime.onUpdate)
    }

    @MainActor
    func testAccountExitErasesInactiveInMemoryPotBeforeRegistryReset() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let previousRepository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        _ = try await previousRepository.bootstrap(seedCasaMar: false)
        let snapshot = try await completeFixtureSetup(
            in: previousRepository,
            at: baseDate
        )
        let model = AppModel(
            repository: previousRepository,
            snapshot: snapshot
        )
        model.beginNewPot()

        let clean = try await model.eraseAllLocalAccountStateForTesting(
            temporaryDirectory: FileManager.default.temporaryDirectory
                .appendingPathComponent("AccountExit-\(UUID().uuidString)")
        )
        let previous = try await previousRepository.refreshSnapshot()

        XCTAssertFalse(previous.potSetup.isComplete)
        XCTAssertTrue(previous.records.isEmpty)
        XCTAssertFalse(clean.potSetup.isComplete)
        XCTAssertTrue(clean.records.isEmpty)
        XCTAssertEqual(model.localPots.count, 1)
        XCTAssertEqual(model.localPots.first?.id, model.activePotID)
        XCTAssertFalse(model.isCreatingAdditionalPot)
    }

    @MainActor
    func testSignOutErasesInactiveInMemoryPotBeforeRegistryReset() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let previousRepository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        _ = try await previousRepository.bootstrap(seedCasaMar: false)
        let snapshot = try await completeFixtureSetup(
            in: previousRepository,
            at: baseDate
        )
        let model = AppModel(repository: previousRepository, snapshot: snapshot)
        model.beginNewPot()
        let currentRepository = model.repositoryForTesting()
        _ = try await currentRepository.bootstrap(seedCasaMar: false)
        let session = NumaSession(
            accessToken: "access",
            accessTokenExpiresInSeconds: 300,
            refreshToken: "refresh",
            refreshExpiresAt: 1_900_000_000_000,
            accountID: accountA
        )
        let runtime = try await AppSyncRuntime(
            repository: currentRepository,
            authProvider: NumaAuthProvider(
                server: RuntimeSessionServerStub(),
                refreshTokens: RuntimeRefreshTokenStore(token: "logout-refresh")
            ),
            client: RuntimeSyncClientStub(session: session, remotePots: [])
        )
        model.setSyncRuntimeForTesting(runtime)
        await runtime.loginE2E(accountKey: "owner", bootstrapSecret: "secret")

        model.confirmSignOut()
        for _ in 0 ..< 100 where model.isSigningOut {
            try await Task.sleep(for: .milliseconds(10))
        }
        let previous = try await previousRepository.refreshSnapshot()

        XCTAssertFalse(model.isSigningOut)
        XCTAssertNil(model.signOutErrorMessage)
        XCTAssertFalse(previous.potSetup.isComplete)
        XCTAssertTrue(previous.records.isEmpty)
        XCTAssertEqual(model.screen, .welcome)
    }

    @MainActor
    func testPendingAccountDeletionRecoveryRetriesReceiptThenPurgesCredentialAndLedger() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = try await completeFixtureSetup(in: repository, at: baseDate)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AccountDeletionRecovery-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let recoveryStore = AccountDeletionRecoveryStore(directory: directory)
        let requestID = UUIDv7.generate(at: baseDate)
        try recoveryStore.save(AccountDeletionRecoveryState(
            requestID: requestID,
            originatingTimeZone: "Europe/Madrid",
            serverComplete: false
        ))
        let tokens = RuntimeRefreshTokenStore(token: "deletion-refresh")
        let server = RuntimeSessionServerStub()
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: NumaAuthProvider(server: server, refreshTokens: tokens),
            client: RuntimeSyncClientStub(
                session: NumaSession(
                    accessToken: "access",
                    accessTokenExpiresInSeconds: 300,
                    refreshToken: "refresh",
                    refreshExpiresAt: 1_900_000_000_000,
                    accountID: accountA
                ),
                remotePots: []
            )
        )
        let model = AppModel(
            repository: repository,
            snapshot: snapshot,
            accountDeletionRecoveryStore: recoveryStore
        )
        model.setSyncRuntimeForTesting(runtime)

        XCTAssertTrue(model.isBootstrapping)
        model.confirmAccountDeletion()
        for _ in 0 ..< 100 where model.isDeletingAccount {
            try await Task.sleep(for: .milliseconds(10))
        }

        let clean = try await repository.refreshSnapshot()
        let retainedToken = await tokens.read()
        let requests = await server.deletionRequests()
        XCTAssertFalse(model.isDeletingAccount)
        XCTAssertNil(model.accountDeletionErrorMessage)
        XCTAssertEqual(requests.map(\.requestID), [requestID.uuidString.lowercased()])
        XCTAssertNil(retainedToken)
        XCTAssertNil(try recoveryStore.load())
        XCTAssertFalse(clean.potSetup.isComplete)
        XCTAssertTrue(clean.records.isEmpty)
        XCTAssertEqual(model.screen, .welcome)
    }

    @MainActor
    func testServerCompleteAccountDeletionRecoverySkipsServerAndFinishesLocalPurge() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = try await completeFixtureSetup(in: repository, at: baseDate)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AccountDeletionRecovery-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let recoveryStore = AccountDeletionRecoveryStore(directory: directory)
        try recoveryStore.save(AccountDeletionRecoveryState(
            requestID: UUIDv7.generate(at: baseDate),
            originatingTimeZone: "Europe/Madrid",
            serverComplete: true
        ))
        let tokens = RuntimeRefreshTokenStore(token: "deletion-refresh")
        let server = RuntimeSessionServerStub()
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: NumaAuthProvider(server: server, refreshTokens: tokens),
            client: RuntimeSyncClientStub(
                session: NumaSession(
                    accessToken: "access",
                    accessTokenExpiresInSeconds: 300,
                    refreshToken: "refresh",
                    refreshExpiresAt: 1_900_000_000_000,
                    accountID: accountA
                ),
                remotePots: []
            )
        )
        let model = AppModel(
            repository: repository,
            snapshot: snapshot,
            accountDeletionRecoveryStore: recoveryStore
        )
        model.setSyncRuntimeForTesting(runtime)

        XCTAssertTrue(model.isBootstrapping)
        model.confirmAccountDeletion()
        for _ in 0 ..< 100 where model.isDeletingAccount {
            try await Task.sleep(for: .milliseconds(10))
        }

        let clean = try await repository.refreshSnapshot()
        let retainedToken = await tokens.read()
        let requests = await server.deletionRequests()
        XCTAssertTrue(requests.isEmpty)
        XCTAssertNil(retainedToken)
        XCTAssertNil(try recoveryStore.load())
        XCTAssertFalse(clean.potSetup.isComplete)
        XCTAssertTrue(clean.records.isEmpty)
        XCTAssertEqual(model.screen, .welcome)
    }

    @MainActor
    func testLocalDataRetryReloadsAmbiguousMutationWithoutReplayingIt() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: AppLedgerIdentitySet.fresh(at: baseDate)
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = try await completeFixtureSetup(
            in: repository,
            at: baseDate
        )
        let model = AppModel(repository: repository, snapshot: snapshot)
        _ = try await repository.appendExpense(
            title: "Ambiguous disk result",
            amountMinorUnits: 1_200,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: baseDate.addingTimeInterval(10),
            savedAt: baseDate.addingTimeInterval(10)
        )
        model.presentLocalDataFailureForTesting(blocking: false)

        model.retryLocalData()
        for _ in 0 ..< 20 where model.isRecoveringLocalData {
            try await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertNil(model.localDataErrorMessage)
        XCTAssertFalse(model.hasBlockingLocalDataFailure)
        XCTAssertEqual(model.records.map(\.title), ["Ambiguous disk result"])
    }

    @MainActor
    func testAppleBackendLoginSuccessClosesSetup() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = try await completeFixtureSetup(
            in: repository,
            at: baseDate
        )
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: []
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )
        let notifications = PushNotificationSystemStub(
            status: .notDetermined,
            grantsAuthorization: true
        )
        let model = AppModel(
            repository: repository,
            snapshot: snapshot,
            pushNotificationSystem: notifications
        )
        model.setSyncRuntimeForTesting(runtime)
        model.beginSyncSetup()

        await model.submitAppleCredentialForTesting(NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        ))

        XCTAssertFalse(model.syncSetupPresented)
        XCTAssertNil(model.syncErrorMessage)
        XCTAssertEqual(model.syncPresentation, .synced)
        XCTAssertEqual(runtime.diagnosticState().accountID, accountA)
        XCTAssertEqual(client.callCounts().fresh, 1)
        XCTAssertEqual(notifications.authorizationRequests, 0)
    }

    @MainActor
    func testLocalPromotionReconcilesPersistedSetupInStableOrder() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(store: store, identities: local)
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await completeFixtureSetup(in: repository, at: baseDate)
        let initial = try XCTUnwrap(try store.localPotSetup(for: local.potID))
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: []
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )

        await runtime.loginE2E(
            accountKey: "p3-setup-reconciliation",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let reconciled = try XCTUnwrap(try store.localPotSetup(for: local.potID))
        XCTAssertTrue(reconciled.isRenameConfirmed)
        XCTAssertTrue(reconciled.bindings.allSatisfy(\.isConfirmed))
        XCTAssertEqual(
            client.setupOperationIDs(),
            [initial.renameEvent.eventId] + initial.bindings.map(\.event.eventId)
        )
        XCTAssertEqual(client.callCounts().promote, 1)
        XCTAssertEqual(client.callCounts().listEvents, 4)
        XCTAssertEqual(client.callCounts().listTextChanges, 4)
        XCTAssertEqual(runtime.diagnosticState().presentation, .synced)

        await runtime.synchronizeNow(userInitiated: true)

        XCTAssertEqual(client.callCounts().promote, 1)
        XCTAssertEqual(client.setupOperationIDs().count, 4)
    }

    @MainActor
    func testAmbiguousSetupResponseRetriesTheSamePersistedOperationID() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(store: store, identities: local)
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await completeFixtureSetup(in: repository, at: baseDate)
        let initial = try XCTUnwrap(try store.localPotSetup(for: local.potID))
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            setupAmbiguousFailuresRemaining: 1
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )

        await runtime.loginE2E(
            accountKey: "p3-ambiguous-setup",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let interrupted = try XCTUnwrap(try store.localPotSetup(for: local.potID))
        XCTAssertFalse(interrupted.isRenameConfirmed)
        XCTAssertEqual(client.setupOperationIDs(), [initial.renameEvent.eventId])
        XCTAssertEqual(runtime.diagnosticState().presentation, .offline(pendingCount: 0))

        await runtime.synchronizeNow(userInitiated: true)

        let recovered = try XCTUnwrap(try store.localPotSetup(for: local.potID))
        XCTAssertTrue(recovered.isRenameConfirmed)
        XCTAssertTrue(recovered.bindings.allSatisfy(\.isConfirmed))
        XCTAssertEqual(
            Array(client.setupOperationIDs().prefix(2)),
            [initial.renameEvent.eventId, initial.renameEvent.eventId]
        )
        XCTAssertEqual(client.callCounts().promote, 2)
        XCTAssertEqual(runtime.diagnosticState().presentation, .synced)
    }

    @MainActor
    func testMismatchedSetupAcknowledgementCannotConfirmLocalOperation() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(store: store, identities: local)
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await completeFixtureSetup(in: repository, at: baseDate)
        let initial = try XCTUnwrap(try store.localPotSetup(for: local.potID))
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            setupAcknowledgementEventIDOverride: .generate(
                at: baseDate.addingTimeInterval(1)
            )
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client
        )

        await runtime.loginE2E(
            accountKey: "p3-invalid-setup-ack",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let interrupted = try XCTUnwrap(try store.localPotSetup(for: local.potID))
        let diagnostic = runtime.diagnosticState()
        XCTAssertFalse(interrupted.isRenameConfirmed)
        XCTAssertEqual(client.setupOperationIDs(), [initial.renameEvent.eventId])
        XCTAssertEqual(
            diagnostic.presentation,
            .paused(pendingCount: 0, code: "INVALID_SERVER_RESPONSE")
        )
        XCTAssertEqual(diagnostic.errorCode, "INVALID_SERVER_RESPONSE")
        XCTAssertFalse(diagnostic.automaticallyPolling)
    }

    @MainActor
    func testRuntimeRejectsE2ESessionWithoutPublicAccountID() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(
            store: store,
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: nil
            ),
            remotePots: []
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 250
        )

        await runtime.loginE2E(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let calls = client.callCounts()
        let diagnostic = runtime.diagnosticState()
        XCTAssertEqual(calls.fresh, 1)
        XCTAssertEqual(calls.cached, 0)
        XCTAssertEqual(calls.logout, 1)
        XCTAssertEqual(calls.listPots, 0)
        XCTAssertNil(diagnostic.accountID)
        XCTAssertEqual(diagnostic.errorCode, "INVALID_SERVER_RESPONSE")
    }

    @MainActor
    func testRuntimeRejectsDifferentAccountBeforeRemoteList() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedMismatch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local,
            identityMetadataURL: directory.appendingPathComponent("identity.json")
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.bindActiveIdentity(
            to: accountA,
            minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
        )
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountB
            ),
            remotePots: []
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 250
        )

        await runtime.loginE2E(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let calls = client.callCounts()
        let diagnostic = runtime.diagnosticState()
        XCTAssertEqual(calls.listPots, 0)
        XCTAssertEqual(calls.promote, 0)
        XCTAssertNil(diagnostic.accountID)
        XCTAssertEqual(
            diagnostic.presentation,
            .paused(pendingCount: 0, code: "ACCOUNT_IDENTITY_MISMATCH")
        )
        XCTAssertEqual(diagnostic.errorCode, "ACCOUNT_IDENTITY_MISMATCH")
        XCTAssertFalse(diagnostic.automaticallyPolling)
    }

    @MainActor
    func testRuntimeDiscoversRemoteBeforePromotionAfterTransientFailure() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let descriptor = try remoteDescriptor(identities: remote)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            listPotsFailuresRemaining: 1
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 250
        )

        await runtime.loginE2E(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )
        let failedDiscovery = client.callCounts()
        XCTAssertEqual(failedDiscovery.listPots, 1)
        XCTAssertEqual(failedDiscovery.promote, 0)
        XCTAssertEqual(
            runtime.diagnosticState().presentation,
            .offline(pendingCount: 0)
        )
        XCTAssertEqual(
            runtime.diagnosticState().accountID,
            accountA
        )
        XCTAssertTrue(runtime.diagnosticState().automaticallyPolling)

        try await Task.sleep(for: .milliseconds(60))
        XCTAssertEqual(client.callCounts().listPots, 1)

        await runtime.synchronizeNow(userInitiated: true)

        let recovered = client.callCounts()
        let active = try await repository.syncContext()
        XCTAssertEqual(recovered.listPots, 2)
        XCTAssertEqual(recovered.promote, 0)
        XCTAssertEqual(active.configuration.id, remote.potID)
        XCTAssertEqual(
            runtime.diagnosticState().accountID,
            accountA
        )
        XCTAssertTrue(runtime.diagnosticState().automaticallyPolling)
    }

    @MainActor
    func testRetryableCachedRefreshShowsRetryAndManualRetryRecovers() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let descriptor = try remoteDescriptor(identities: remote)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: "cached-refresh")
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor],
            cachedLoginFailuresRemaining: 1
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 250
        )

        await runtime.restoreCachedSession()

        var diagnostic = runtime.diagnosticState()
        XCTAssertEqual(client.callCounts().cached, 1)
        XCTAssertEqual(client.callCounts().fresh, 0)
        XCTAssertEqual(diagnostic.presentation, .offline(pendingCount: 0))
        XCTAssertEqual(diagnostic.presentation.action, .retry)
        XCTAssertEqual(diagnostic.errorCode, "REFRESH_RATE_LIMITED")
        XCTAssertTrue(diagnostic.automaticallyPolling)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(client.callCounts().cached, 1)

        await runtime.synchronizeNow(userInitiated: true)

        diagnostic = runtime.diagnosticState()
        let active = try await repository.syncContext()
        XCTAssertEqual(client.callCounts().cached, 2)
        XCTAssertEqual(client.callCounts().fresh, 0)
        XCTAssertEqual(client.callCounts().listPots, 1)
        XCTAssertEqual(diagnostic.accountID, accountA)
        XCTAssertEqual(diagnostic.presentation, .synced)
        XCTAssertTrue(diagnostic.automaticallyPolling)
        XCTAssertEqual(active.configuration.id, remote.potID)
    }

    @MainActor
    func testRetryableCachedRefreshAutomaticallyRecoversAfterBackoff() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await completeFixtureSetup(in: repository, at: baseDate)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: "cached-refresh")
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            cachedLoginFailuresRemaining: 1
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 10
        )

        await runtime.restoreCachedSession()
        for _ in 0..<20 where runtime.diagnosticState().presentation != .synced {
            try await Task.sleep(for: .milliseconds(10))
        }

        let diagnostic = runtime.diagnosticState()
        XCTAssertEqual(client.callCounts().cached, 2)
        XCTAssertEqual(client.callCounts().fresh, 0)
        XCTAssertEqual(diagnostic.accountID, accountA)
        XCTAssertEqual(diagnostic.presentation, .synced)
        XCTAssertTrue(diagnostic.automaticallyPolling)
    }

    @MainActor
    func testTerminalCachedRefreshRequiresSignInAndDoesNotPoll() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: "expired-refresh")
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "unused",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "unused",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            terminalCachedLoginCode: "REFRESH_TOKEN_EXPIRED"
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 10
        )

        await runtime.restoreCachedSession()

        let diagnostic = runtime.diagnosticState()
        XCTAssertEqual(client.callCounts().cached, 1)
        XCTAssertEqual(client.callCounts().fresh, 0)
        XCTAssertEqual(
            diagnostic.presentation,
            .paused(pendingCount: 0, code: "REFRESH_TOKEN_EXPIRED")
        )
        XCTAssertEqual(diagnostic.presentation.action, .signIn)
        XCTAssertFalse(diagnostic.automaticallyPolling)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(client.callCounts().cached, 1)
        XCTAssertEqual(client.callCounts().listPots, 0)
    }

    @MainActor
    func testStoppingPollDuringMutationPreservesIntentionalSessionFailure() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(
            store: store,
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await completeFixtureSetup(in: repository, at: baseDate)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: "expired-refresh")
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            terminalCachedLoginCode: "REFRESH_TOKEN_EXPIRED"
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 10
        )

        await runtime.loginE2E(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )
        client.blockNextAppend()
        _ = try await repository.appendExpense(
            title: "Cancellation race",
            amountMinorUnits: 100,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: baseDate.addingTimeInterval(1),
            savedAt: baseDate
        )
        _ = try store.expireHeldEvents(now: baseDate.addingTimeInterval(7))
        for _ in 0..<50 where !client.blockingAppendStarted() {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(client.blockingAppendStarted())

        let cancellationWasPublished = expectation(
            description: "Cancellation must remain control flow"
        )
        cancellationWasPublished.isInverted = true
        runtime.onUpdate = { _, _, _, code in
            if code == "SYNC_UNAVAILABLE" {
                cancellationWasPublished.fulfill()
            }
        }

        await runtime.restoreCachedSession()
        for _ in 0..<50 where !client.blockingAppendCancelled() {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(client.blockingAppendCancelled())
        await fulfillment(of: [cancellationWasPublished], timeout: 0.2)

        let diagnostic = runtime.diagnosticState()
        XCTAssertEqual(
            diagnostic.presentation,
            .paused(pendingCount: 1, code: "REFRESH_TOKEN_EXPIRED")
        )
        XCTAssertEqual(diagnostic.errorCode, "REFRESH_TOKEN_EXPIRED")
        XCTAssertFalse(diagnostic.automaticallyPolling)
        let stored = try XCTUnwrap(try store.loadStoredEvents(for: local.potID).first)
        XCTAssertEqual(stored.delivery.state, .ready)
    }

    @MainActor
    func testAccessPotDiscoveryStopsPollingAndPreservesEveryAttempt() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(
            store: store,
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.appendExpense(
            title: "Ready before access loss",
            amountMinorUnits: 100,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: baseDate.addingTimeInterval(1),
            savedAt: baseDate
        )
        _ = try store.expireHeldEvents(now: baseDate.addingTimeInterval(7))
        let heldSavedAt = Date()
        _ = try await repository.appendExpense(
            title: "Undo still active",
            amountMinorUnits: 200,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: heldSavedAt,
            savedAt: heldSavedAt
        )
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [],
            terminalListPotsCode: "NOT_MEMBER"
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 10
        )

        await runtime.loginE2E(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let diagnostic = runtime.diagnosticState()
        XCTAssertEqual(client.callCounts().listPots, 1)
        XCTAssertEqual(
            diagnostic.presentation,
            .paused(pendingCount: 2, code: "NOT_MEMBER")
        )
        XCTAssertEqual(diagnostic.presentation.title, "Access changed")
        XCTAssertEqual(diagnostic.presentation.action, .none)
        XCTAssertFalse(diagnostic.automaticallyPolling)
        XCTAssertEqual(
            try store.loadStoredEvents(for: local.potID).map(\.delivery.state),
            [.ready, .held]
        )
        var snapshot = try await repository.refreshSnapshot()
        XCTAssertTrue(snapshot.records.allSatisfy { $0.deliveryState == .waiting })

        _ = try store.expireHeldEvents(now: heldSavedAt.addingTimeInterval(7))
        await runtime.synchronizeNow()
        snapshot = try await repository.refreshSnapshot()
        XCTAssertEqual(
            try store.loadStoredEvents(for: local.potID).map(\.delivery.state),
            [.ready, .ready]
        )
        XCTAssertEqual(try store.pendingDeliveryEventCount(for: local.potID), 2)
        XCTAssertEqual(snapshot.balances, [.am: 300, .sam: -300, .leo: 0])
        XCTAssertEqual(snapshot.spend, 300)
        XCTAssertTrue(snapshot.records.allSatisfy { $0.deliveryState == .waiting })
        XCTAssertEqual(runtime.diagnosticState().presentation.detail, "2 records waiting")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(client.callCounts().listPots, 2)
    }

    @MainActor
    func testFutureReaderRequirementPausesBeforeAnyUpload() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let local = AppLedgerIdentitySet.fresh(at: baseDate)
        let remote = AppLedgerIdentitySet.fresh(
            at: baseDate.addingTimeInterval(100)
        )
        let descriptor = try remoteDescriptor(
            identities: remote,
            minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion + 1
        )
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: local
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        let provider = NumaAuthProvider(
            server: RuntimeSessionServerStub(),
            refreshTokens: RuntimeRefreshTokenStore(token: nil)
        )
        let client = RuntimeSyncClientStub(
            session: NumaSession(
                accessToken: "run-access",
                accessTokenExpiresInSeconds: 300,
                refreshToken: "run-refresh",
                refreshExpiresAt: 1_900_000_000_000,
                accountID: accountA
            ),
            remotePots: [descriptor]
        )
        let runtime = try await AppSyncRuntime(
            repository: repository,
            authProvider: provider,
            client: client,
            healthyPollingIntervalMilliseconds: 10,
            retryPollingBaseDelayMilliseconds: 10
        )

        await runtime.loginE2E(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let calls = client.callCounts()
        let diagnostic = runtime.diagnosticState()
        let snapshot = try await repository.refreshSnapshot()
        let model = AppModel(repository: repository, snapshot: snapshot)
        XCTAssertEqual(calls.listPots, 1)
        XCTAssertEqual(calls.promote, 0)
        XCTAssertEqual(calls.append, 0)
        XCTAssertEqual(calls.listEvents, 0)
        XCTAssertEqual(calls.listTextChanges, 0)
        XCTAssertEqual(
            diagnostic.presentation,
            .paused(pendingCount: 0, code: "READER_UPDATE_REQUIRED")
        )
        XCTAssertEqual(diagnostic.errorCode, "READER_UPDATE_REQUIRED")
        XCTAssertFalse(diagnostic.automaticallyPolling)
        XCTAssertTrue(snapshot.requiresReaderUpdate)
        XCTAssertTrue(model.requiresUpdate)
        model.beginAdd()
        XCTAssertFalse(model.addPresented)
        try await Task.sleep(for: .milliseconds(50))
        let afterCadence = client.callCounts()
        XCTAssertEqual(afterCadence.listPots, 1)
        XCTAssertEqual(afterCadence.append, 0)
        XCTAssertEqual(afterCadence.listEvents, 0)
        XCTAssertEqual(afterCadence.listTextChanges, 0)
    }
#endif

    private func remoteDescriptor(
        identities: AppLedgerIdentitySet,
        memberID: NumaSharedCore.MemberID? = nil,
        minimumReaderSchemaVersion: UInt16 = EventEnvelope.currentSchemaVersion
    ) throws -> RemotePotDescriptor {
        RemotePotDescriptor(
            configuration: try PotConfiguration(
                id: identities.potID,
                currency: .eur,
                orderedUnitIDs: identities.orderedUnitIDs
            ),
            memberID: memberID ?? identities.ownerMemberID,
            role: .owner,
            minimumReaderSchemaVersion: minimumReaderSchemaVersion,
            lastSequence: 0
        )
    }

    @MainActor
    private func completeFixtureSetup(
        in repository: AppLedgerRepository,
        at date: Date
    ) async throws -> AppLedgerSnapshot {
        try await repository.completeLocalSetup(
            potName: "Casa Mar",
            ownerDisplayName: "Arseny",
            samDisplayName: "Sam",
            leoDisplayName: "Leo",
            at: date
        )
    }
}

#if DEBUG
private actor RuntimeRefreshTokenStore: RefreshTokenStoring {
    private var token: String?

    init(token: String?) {
        self.token = token
    }

    func read() -> String? { token }
    func write(_ token: String) { self.token = token }
    func clear() { token = nil }
}

private actor RuntimeSessionServerStub: NumaSessionServing {
    private let logoutError: NumaSessionError?
    private var accountDeletionRequests: [(
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    )] = []

    init(logoutError: NumaSessionError? = nil) {
        self.logoutError = logoutError
    }

    func exchangeApple(_ credential: NumaAppleCredential) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }

    func refresh(refreshToken: String) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }

    func logout(refreshToken: String) throws {
        if let logoutError { throw logoutError }
    }

    func deleteAccount(
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    ) {
        accountDeletionRequests.append((
            refreshToken,
            requestID,
            originatingTimeZone
        ))
    }

    func deletionRequests() -> [(
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    )] {
        accountDeletionRequests
    }

    func bootstrapE2E(
        accountKey: String,
        bootstrapSecret: String
    ) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }
}

@MainActor
private final class PushNotificationSystemStub: PushNotificationSystem {
    private(set) var status: PushNotificationPermissionState
    private let grantsAuthorization: Bool
    private(set) var authorizationStatusChecks = 0
    private(set) var authorizationRequests = 0
    private(set) var remoteRegistrationRequests = 0

    init(
        status: PushNotificationPermissionState,
        grantsAuthorization: Bool
    ) {
        self.status = status
        self.grantsAuthorization = grantsAuthorization
    }

    func authorizationStatus() async -> PushNotificationPermissionState {
        authorizationStatusChecks += 1
        return status
    }

    func requestAuthorization() async throws -> Bool {
        authorizationRequests += 1
        if grantsAuthorization { status = .authorized }
        return grantsAuthorization
    }

    func registerForRemoteNotifications() {
        remoteRegistrationRequests += 1
    }
}

@MainActor
private final class RuntimeSyncClientStub: NumaAuthenticatedSyncClient {
    private let session: NumaSession
    private let remotePots: [RemotePotDescriptor]
    private let remoteEvents: [HydratedWireEventV1]
    private var remoteTextChanges: [TextRedactionChange]
    var textChangeFailure: SyncTransportError?
    var scriptedTextPages: [Result<SyncTextChangePage, SyncTransportError>] = []
    func replaceTextChanges(_ changes: [TextRedactionChange]) { remoteTextChanges = changes }
    private var freshLoginCount = 0
    private var cachedLoginCount = 0
    private var logoutCount = 0
    private var listPotsCount = 0
    private var promoteCount = 0
    private(set) var promotionRequests: [LocalPotPromotionRequest] = []
    private var appendCount = 0
    private var listEventsCount = 0
    private var listTextChangesCount = 0
    private var listRosterCount = 0
    private var listPotsFailuresRemaining: Int
    private let terminalListPotsCode: String?
    private var cachedLoginFailuresRemaining: Int
    private let terminalCachedLoginCode: String?
    private let freshLoginErrorCode: String?
    private var shouldBlockNextAppend = false
    private var didStartBlockingAppend = false
    private var didCancelBlockingAppend = false
    private var malformedAppendAcknowledgementsRemaining: Int
    private let acknowledgeAppendsAfterMalformed: Bool
    private let inviteOutcome: InviteClaimOutcome?
    private var recordedInviteRequests: [InviteClaimRequest] = []
    private var recordedSetupOperationIDs: [EventID] = []
    private var setupSequences: [EventID: Int64] = [:]
    private var nextSetupSequence: Int64 = 2
    private var setupAmbiguousFailuresRemaining: Int
    private let setupAcknowledgementEventIDOverride: EventID?
    private var memberRoster: [PotMemberProfile]?
    private var pendingInviteClaims: [PendingInviteClaim]
    private var claimReassignmentFailuresRemaining: Int
    private var managedInvites: [ManagedInvite]
    private var inviteIssueFailuresRemaining: Int
    private(set) var recordedApprovals: [PendingInviteClaimApproval] = []
    private(set) var recordedRejections: [PendingInviteClaimID] = []
    private(set) var recordedClaimReassignments: [WireEventV1] = []
    private(set) var recordedMemberArchives: [WireEventV1] = []
    private(set) var recordedOwnershipTransfers: [WireEventV1] = []
    private(set) var recordedPotLeaves: [PotLeaveRequest] = []
    private(set) var recordedInviteIssues: [InviteIssueRequest] = []
    private(set) var recordedInviteRevocations: [UUID] = []
    private(set) var recordedPushRegistrations: [PushTokenRegistration] = []
    private(set) var recordedPushTokenRemovals: [APNsDeviceToken] = []
    private(set) var recordedPotMuteChanges: [Bool] = []
    private var potMuted = false
    private var promotedOwner: (potID: PotID, memberID: MemberID, unitID: NumaSharedCore.UnitID)?

    init(
        session: NumaSession,
        remotePots: [RemotePotDescriptor],
        remoteEvents: [HydratedWireEventV1] = [],
        remoteTextChanges: [TextRedactionChange] = [],
        listPotsFailuresRemaining: Int = 0,
        terminalListPotsCode: String? = nil,
        cachedLoginFailuresRemaining: Int = 0,
        terminalCachedLoginCode: String? = nil,
        freshLoginErrorCode: String? = nil,
        malformedAppendAcknowledgementsRemaining: Int = 0,
        acknowledgeAppendsAfterMalformed: Bool = false,
        inviteOutcome: InviteClaimOutcome? = nil,
        setupAmbiguousFailuresRemaining: Int = 0,
        setupAcknowledgementEventIDOverride: EventID? = nil,
        memberRoster: [PotMemberProfile]? = nil,
        pendingInviteClaims: [PendingInviteClaim] = [],
        claimReassignmentFailuresRemaining: Int = 0,
        managedInvites: [ManagedInvite] = [],
        inviteIssueFailuresRemaining: Int = 0
    ) {
        self.session = session
        self.remotePots = remotePots
        self.remoteEvents = remoteEvents
        self.remoteTextChanges = remoteTextChanges
        self.listPotsFailuresRemaining = listPotsFailuresRemaining
        self.terminalListPotsCode = terminalListPotsCode
        self.cachedLoginFailuresRemaining = cachedLoginFailuresRemaining
        self.terminalCachedLoginCode = terminalCachedLoginCode
        self.freshLoginErrorCode = freshLoginErrorCode
        self.malformedAppendAcknowledgementsRemaining = malformedAppendAcknowledgementsRemaining
        self.acknowledgeAppendsAfterMalformed = acknowledgeAppendsAfterMalformed
        self.inviteOutcome = inviteOutcome
        self.setupAmbiguousFailuresRemaining = setupAmbiguousFailuresRemaining
        self.setupAcknowledgementEventIDOverride = setupAcknowledgementEventIDOverride
        self.memberRoster = memberRoster
        self.pendingInviteClaims = pendingInviteClaims
        self.claimReassignmentFailuresRemaining = claimReassignmentFailuresRemaining
        self.managedInvites = managedInvites
        self.inviteIssueFailuresRemaining = inviteIssueFailuresRemaining
    }

    func login() async -> Result<NumaSession, any Error> {
        freshLoginCount += 1
        if let freshLoginErrorCode {
            return .failure(NumaSessionError.server(
                code: freshLoginErrorCode,
                retryable: true
            ))
        }
        return .success(session)
    }

    func loginFromCache() async -> Result<NumaSession, any Error> {
        cachedLoginCount += 1
        if let terminalCachedLoginCode {
            return .failure(NumaSessionError.server(
                code: terminalCachedLoginCode,
                retryable: false
            ))
        }
        if cachedLoginFailuresRemaining > 0 {
            cachedLoginFailuresRemaining -= 1
            return .failure(NumaSessionError.server(
                code: "REFRESH_RATE_LIMITED",
                retryable: true
            ))
        }
        return .success(session)
    }

    func logout() async {
        logoutCount += 1
    }

    func connectionStates() async -> AsyncStream<SyncConnectionState> {
        AsyncStream { continuation in
            continuation.yield(.connected)
            continuation.finish()
        }
    }

    func listPots() async throws -> [RemotePotDescriptor] {
        listPotsCount += 1
        if let terminalListPotsCode {
            throw SyncTransportError.terminal(code: terminalListPotsCode)
        }
        if listPotsFailuresRemaining > 0 {
            listPotsFailuresRemaining -= 1
            throw SyncTransportError.retryable(code: "TRANSPORT_UNAVAILABLE")
        }
        return remotePots
    }

    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        promoteCount += 1
        promotionRequests.append(request)
        promotedOwner = (
            request.configuration.id,
            request.ownerMemberID,
            request.configuration.orderedUnitIDs[0]
        )
        if request.budgetGroupPromotion != nil {
            return request.events.enumerated().map { index, event in
                EventAcknowledgement(eventID: event.eventId, serverSequence: Int64(index + 1))
            }
        }
        return []
    }

    func listMemberRoster(potID: PotID) async throws -> [PotMemberProfile] {
        listRosterCount += 1
        if let memberRoster { return memberRoster }
        if let descriptor = remotePots.first(where: { $0.configuration.id == potID }) {
            return [PotMemberProfile(
                memberID: descriptor.memberID,
                unitID: descriptor.configuration.orderedUnitIDs[0],
                displayName: "Owner",
                role: descriptor.role,
                state: .active
            )]
        }
        if let promotedOwner, promotedOwner.potID == potID {
            return [PotMemberProfile(
                memberID: promotedOwner.memberID,
                unitID: promotedOwner.unitID,
                displayName: "Owner",
                role: .owner,
                state: .active
            )]
        }
        throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
    }

    func renamePot(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try setupAcknowledgement(for: event.eventId)
    }

    func bindOwnerUnit(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try setupAcknowledgement(for: event.eventId)
    }

    func bindPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        try setupAcknowledgement(for: request.event.eventId)
    }

    func listPendingInviteClaims(
        potID: PotID
    ) async throws -> [PendingInviteClaim] {
        _ = potID
        return pendingInviteClaims
    }

    func listManagedInvites(potID: PotID) async throws -> [ManagedInvite] {
        _ = potID
        return managedInvites
    }

    func issueInvite(_ request: InviteIssueRequest) async throws -> UUID {
        recordedInviteIssues.append(request)
        if inviteIssueFailuresRemaining > 0 {
            inviteIssueFailuresRemaining -= 1
            throw SyncTransportError.retryable(code: "TRANSPORT_UNAVAILABLE")
        }
        managedInvites.append(ManagedInvite(
            inviteID: request.inviteID,
            kind: request.kind,
            pendingMemberID: request.pendingMemberID,
            expiresAtMillis: request.expiresAtMillis,
            createdAtMillis: Int64(
                UUIDv7.timestampMilliseconds(of: request.inviteID) ?? 0
            )
        ))
        return request.inviteID
    }

    func revokeInvite(potID: PotID, inviteID: UUID) async throws {
        _ = potID
        recordedInviteRevocations.append(inviteID)
        managedInvites.removeAll { $0.inviteID == inviteID }
    }

    func registerPushToken(
        _ registration: PushTokenRegistration
    ) async throws {
        recordedPushRegistrations.append(registration)
    }

    func unregisterPushToken(_ token: APNsDeviceToken) async throws {
        recordedPushTokenRemovals.append(token)
    }

    func getPotMute(potID: PotID) async throws -> Bool {
        _ = potID
        return potMuted
    }

    func setPotMute(potID: PotID, muted: Bool) async throws -> Bool {
        _ = potID
        recordedPotMuteChanges.append(muted)
        potMuted = muted
        return muted
    }

    func approvePendingInviteClaim(
        _ request: PendingInviteClaimApproval
    ) async throws -> EventAcknowledgement {
        recordedApprovals.append(request)
        pendingInviteClaims.removeAll { $0.id == request.claimID }
        if case let .memberClaimed(memberID) = request.event.payload {
            updateProfile(memberID) { profile in
                PotMemberProfile(
                    memberID: profile.memberID,
                    unitID: profile.unitID,
                    displayName: profile.displayName,
                    role: profile.role,
                    state: .active
                )
            }
        }
        return EventAcknowledgement(
            eventID: request.event.eventId,
            serverSequence: 20
        )
    }

    func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws {
        recordedRejections.append(claimID)
        pendingInviteClaims.removeAll { $0.id == claimID }
    }

    func reassignMemberClaim(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        recordedClaimReassignments.append(event)
        if claimReassignmentFailuresRemaining > 0 {
            claimReassignmentFailuresRemaining -= 1
            throw SyncTransportError.retryable(code: "TRANSPORT_UNAVAILABLE")
        }
        if case let .memberClaimReassigned(memberID) = event.payload {
            updateProfile(memberID) { profile in
                PotMemberProfile(
                    memberID: profile.memberID,
                    unitID: profile.unitID,
                    displayName: profile.displayName,
                    role: profile.role,
                    state: .pending
                )
            }
        }
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 21)
    }

    func archiveMember(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        recordedMemberArchives.append(event)
        if case let .memberArchived(memberID) = event.payload {
            updateProfile(memberID) { profile in
                PotMemberProfile(
                    memberID: profile.memberID,
                    unitID: profile.unitID,
                    displayName: profile.displayName,
                    role: profile.role,
                    state: .archived
                )
            }
        }
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 22)
    }

    func transferOwnership(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        recordedOwnershipTransfers.append(event)
        if case let .ownershipTransferred(fromMemberID, toMemberID) = event.payload {
            updateProfile(fromMemberID) { profile in
                PotMemberProfile(
                    memberID: profile.memberID,
                    unitID: profile.unitID,
                    displayName: profile.displayName,
                    role: .member,
                    state: profile.state
                )
            }
            updateProfile(toMemberID) { profile in
                PotMemberProfile(
                    memberID: profile.memberID,
                    unitID: profile.unitID,
                    displayName: profile.displayName,
                    role: .owner,
                    state: profile.state
                )
            }
        }
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 23)
    }

    func leavePot(
        _ request: PotLeaveRequest
    ) async throws -> PotLeaveAcknowledgement {
        recordedPotLeaves.append(request)
        if case let .memberArchived(memberID) = request.archiveEvent.payload {
            updateProfile(memberID) { profile in
                PotMemberProfile(
                    memberID: profile.memberID,
                    unitID: profile.unitID,
                    displayName: profile.displayName,
                    role: .member,
                    state: .archived
                )
            }
        }
        return PotLeaveAcknowledgement(
            archive: EventAcknowledgement(
                eventID: request.archiveEvent.eventId,
                serverSequence: 24
            ),
            ownershipTransfer: nil,
            successorMemberID: nil
        )
    }

    func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        _ = potID
        _ = events
        appendCount += 1
        if shouldBlockNextAppend {
            shouldBlockNextAppend = false
            didStartBlockingAppend = true
            do {
                try await Task.sleep(for: .seconds(60))
            } catch {
                didCancelBlockingAppend = true
                throw error
            }
        }
        if malformedAppendAcknowledgementsRemaining > 0 {
            malformedAppendAcknowledgementsRemaining -= 1
            return []
        }
        if acknowledgeAppendsAfterMalformed {
            return events.enumerated().map { index, event in
                EventAcknowledgement(
                    eventID: event.eventId,
                    serverSequence: Int64(index + 1)
                )
            }
        }
        return []
    }

    func blockNextAppend() {
        shouldBlockNextAppend = true
    }

    func blockingAppendStarted() -> Bool {
        didStartBlockingAppend
    }

    func blockingAppendCancelled() -> Bool {
        didCancelBlockingAppend
    }

    func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage {
        listEventsCount += 1
        return SyncEventPage(
            events: remoteEvents.filter { $0.serverSequence > afterSequence },
            hasMore: false,
            nextAfterSequence: max(afterSequence, remoteEvents.last?.serverSequence ?? 0)
        )
    }

    func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        listTextChangesCount += 1
        if !scriptedTextPages.isEmpty { return try scriptedTextPages.removeFirst().get() }
        if let textChangeFailure { throw textChangeFailure }
        return SyncTextChangePage(
            changes: remoteTextChanges.filter { $0.revision > afterRevision },
            hasMore: false,
            nextAfterRevision: max(afterRevision, remoteTextChanges.last?.revision ?? 0)
        )
    }

    func claimInvite(
        _ request: InviteClaimRequest
    ) async throws -> InviteClaimOutcome {
        recordedInviteRequests.append(request)
        guard let inviteOutcome else {
            throw SyncTransportError.terminal(code: "INVITES_UNAVAILABLE")
        }
        return inviteOutcome
    }

    func inviteRequests() -> [InviteClaimRequest] {
        recordedInviteRequests
    }

    func setupOperationIDs() -> [EventID] {
        recordedSetupOperationIDs
    }

    func loginCounts() -> (fresh: Int, cached: Int) {
        (freshLoginCount, cachedLoginCount)
    }

    func callCounts() -> (
        fresh: Int,
        cached: Int,
        logout: Int,
        listPots: Int,
        promote: Int,
        append: Int,
        listEvents: Int,
        listTextChanges: Int,
        listRoster: Int
    ) {
        (
            freshLoginCount,
            cachedLoginCount,
            logoutCount,
            listPotsCount,
            promoteCount,
            appendCount,
            listEventsCount,
            listTextChangesCount,
            listRosterCount
        )
    }

    private func setupAcknowledgement(
        for eventID: EventID
    ) throws -> EventAcknowledgement {
        recordedSetupOperationIDs.append(eventID)
        let sequence: Int64
        if let existing = setupSequences[eventID] {
            sequence = existing
        } else {
            sequence = nextSetupSequence
            nextSetupSequence += 1
            setupSequences[eventID] = sequence
        }
        if setupAmbiguousFailuresRemaining > 0 {
            setupAmbiguousFailuresRemaining -= 1
            throw SyncTransportError.retryable(code: "TRANSPORT_UNAVAILABLE")
        }
        return EventAcknowledgement(
            eventID: setupAcknowledgementEventIDOverride ?? eventID,
            serverSequence: sequence
        )
    }

    private func updateProfile(
        _ memberID: MemberID,
        transform: (PotMemberProfile) -> PotMemberProfile
    ) {
        guard var memberRoster,
              let index = memberRoster.firstIndex(where: {
                  $0.memberID == memberID
              })
        else { return }
        memberRoster[index] = transform(memberRoster[index])
        self.memberRoster = memberRoster
    }
}

private actor RuntimeConfigurationGate {
    private var starts = 0
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func hold() async {
        starts += 1
        await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func waitUntilStarted() async {
        while starts == 0 { await Task.yield() }
    }

    func startCount() -> Int { starts }

    func releaseAll() {
        let pending = continuations
        continuations.removeAll()
        pending.forEach { $0.resume() }
    }
}
#endif
