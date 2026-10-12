import Foundation
import Testing
import NumaSharedCore
@testable import NumaSharedSync

private struct GroupSyncFixture {
    let base = try! SyncFixture()
    let partner = try! MemberID(validating: syncTestUUID(6))
    let third = try! MemberID(validating: syncTestUUID(7))
    let thirdUnit = try! UnitID(validating: syncTestUUID(8))
    let groupUnit = try! UnitID(validating: syncTestUUID(9))
    let date = Date(timeIntervalSince1970: 1_700_000_000)
    var configuration: PotConfiguration {
        get throws { try PotConfiguration(id: base.potID, currency: .eur,
            orderedUnitIDs: [base.payerID, base.beneficiaryID, thirdUnit]) }
    }
    var group: SettlementGroupSnapshot {
        SettlementGroupSnapshot(groupID: try! GroupID(validating: syncTestUUID(10)), unitID: groupUnit,
            orderedMemberIDs: [base.actorID, partner], defaultShareWeight: 1)
    }
    func setup(_ store: LedgerStore) throws {
        try store.registerPot(configuration)
        _ = try store.saveLocalPotSetup(potID: base.potID, potName: "House", ownerMemberID: base.actorID,
            members: [LocalPotSetupMember(memberID: base.actorID, unitID: base.payerID, displayName: "Recorder", role: .owner),
                LocalPotSetupMember(memberID: partner, unitID: base.beneficiaryID, displayName: "Actual payer", role: .member),
                LocalPotSetupMember(memberID: third, unitID: thirdUnit, displayName: "Neighbor", role: .member)],
            originatingTimeZone: base.timeZone, at: date, budgetGroups: [group])
    }
    func expense() throws -> EventEnvelope {
        let amount = Money(minorUnits: 12_000, currency: .eur)
        return EventEnvelope(id: try EventID(validating: syncTestUUID(101)), potID: base.potID,
            actorMemberID: base.actorID, occurredAt: date.addingTimeInterval(1), originatingTimeZone: base.timeZone, schemaVersion: 2,
            payload: .expenseAdded(ExpenseAddedPayload(recordID: base.recordID,
                content: ExpenseContent(kind: .shared, title: "Private meal", amount: amount, payerUnitID: groupUnit,
                    allocations: [ExpenseAllocation(unitID: groupUnit, amount: Money(minorUnits: 6_000, currency: .eur)),
                        ExpenseAllocation(unitID: thirdUnit, amount: Money(minorUnits: 6_000, currency: .eur))], payerMemberID: partner))))
    }
}

@Test func groupSetupAndMoneySurviveRestartWithOriginalIDsAndKnownPayer() throws {
    let f = GroupSyncFixture()
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("budget-group-\(UUID()).sqlite")
    defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: url.path + suffix) } }
    var store = try LedgerStore(path: url.path, now: f.date, readerSchemaVersion: 2)
    try f.setup(store)
    _ = try store.appendHeldLocalEvent(f.expense(), savedAt: f.date)
    let before = try store.loadStoredEvents(for: f.base.potID)
    #expect(before.map(\.event.schemaVersion) == [1, 1, 1, 1, 2, 2])
    let reduction = try store.reduction(for: f.base.potID)
    #expect(reduction.access == .readWrite)
    #expect(reduction.projection.balances[f.groupUnit]?.minorUnits == 6_000)
    #expect(reduction.projection.balances[f.thirdUnit]?.minorUnits == -6_000)
    store = try LedgerStore(path: url.path, now: f.date.addingTimeInterval(8), readerSchemaVersion: 2)
    let after = try store.loadStoredEvents(for: f.base.potID)
    #expect(after.map(\.event) == before.map(\.event))
    #expect(after.map(\.localOrdinal) == before.map(\.localOrdinal))
    #expect(try store.hasLocalBudgetGroupSetup(for: f.base.potID))
    #expect(try store.expectedTopologyRevision(for: after[4].event.id) == 4)
    #expect(try store.payerDisplayName(memberID: f.partner, potID: f.base.potID) == "Actual payer")
    // The default consumer remains schema1 and exposes only its last valid prefix.
    let old = try LedgerStore(path: url.path)
    if case .readOnly(.unsupportedSchema) = try old.reduction(for: f.base.potID).access {} else { Issue.record("Old reader accepted schema2") }
}

@Test func groupWirePreservesPayerOnExpenseAndRevisionAndErasureRemainsErased() throws {
    let f = GroupSyncFixture(), store = try LedgerStore.inMemory(readerSchemaVersion: 2)
    try f.setup(store)
    let expense = try f.expense()
    _ = try store.appendHeldLocalEvent(expense, savedAt: f.date)
    guard case let .expenseAdded(added) = expense.payload else { return }
    let revision = EventEnvelope(potID: f.base.potID, actorMemberID: f.base.actorID, occurredAt: f.date,
        originatingTimeZone: f.base.timeZone, schemaVersion: 2,
        payload: .expenseRevised(ExpenseRevisedPayload(recordID: added.recordID,
            basis: .parent(expense.id), content: .expense(added.content))))
    for event in [expense, revision] {
        let json = try ConvexWireArguments.event(WireEventV1(event)).convexEncode()
        #expect(json.contains("\"payerMemberId\":\"\(f.partner.description)\""))
        #expect(json.contains("\"actorMemberId\":\"\(f.base.actorID.description)\""))
    }
    let legacy = try ConvexWireArguments.event(WireEventV1(f.base.event(id: 105))).convexEncode()
    #expect(!legacy.contains("payerMemberId"))
    _ = try store.redactAuthoredText(for: expense.id, fields: [.title])
    _ = try store.replaceCachedMemberRoster([
        PotMemberProfile(memberID: f.base.actorID, unitID: f.base.payerID, displayName: "Recorder", role: .owner, state: .active, budgetUnitID: f.groupUnit),
        PotMemberProfile(memberID: f.partner, unitID: f.base.beneficiaryID, displayName: nil, role: .member, state: .archived, budgetUnitID: f.groupUnit),
        PotMemberProfile(memberID: f.third, unitID: f.thirdUnit, displayName: "Neighbor", role: .member, state: .pending)], for: f.base.potID)
    #expect(try store.payerDisplayName(memberID: f.partner, potID: f.base.potID) == "Former member")
    #expect(try store.payerDisplayName(memberID: nil, potID: f.base.potID) == nil)
    #expect(try store.cachedMemberRoster(for: f.base.potID)[1].budgetUnitID == f.groupUnit)
    #expect(try store.localPotSetup(for: f.base.potID)?.bindings[1].profile.displayName == nil)
    let snapshot = try store.snapshot(for: f.base.potID)
    let encoded = String(decoding: try JSONEncoder().encode(snapshot.reduction.projection), as: UTF8.self)
    #expect(!encoded.contains("Private meal"))
    #expect(!encoded.contains("Actual payer"))
}

@Test func ambiguousTypedPromotionRetriesExactPrefixAndDoesNotReorderMoney() async throws {
    let f = GroupSyncFixture(), store = try LedgerStore.inMemory(readerSchemaVersion: 2)
    try f.setup(store)
    _ = try store.appendHeldLocalEvent(f.expense(), savedAt: f.date)
    let originals = try store.loadStoredEvents(for: f.base.potID)
    let transport = GroupPromotionTransport()
    let request = PotSyncRequest(potID: f.base.potID, promotion: LocalPotPromotion(ownerMemberID: f.base.actorID,
        ownerDisplayName: "Recorder", minimumReaderSchemaVersion: 1))
    let coordinator = SyncCoordinator(store: store, transport: transport)
    _ = try await coordinator.synchronize(request, now: f.date.addingTimeInterval(8))
    let restarted = SyncCoordinator(store: store, transport: transport)
    let report = try await restarted.synchronize(request, now: f.date.addingTimeInterval(12))
    #expect(report.outcome == .completed)
    let requests = await transport.requests
    #expect(requests.count == 2)
    #expect(requests[0] == requests[1])
    #expect(requests[0].events.map(\.eventId) == originals.map(\.event.id))
    #expect(requests[0].budgetGroupPromotion?.startingSequence == 1)
    #expect(try store.loadStoredEvents(for: f.base.potID).map(\.delivery.serverSequence) == [1, 2, 3, 4, 5, 6])
    #expect(try store.reduction(for: f.base.potID).access == .readWrite)
}

@Test func reconciliationPausesSurviveCoordinatorRestartWithoutChangingQueuedMoney() async throws {
    let f = GroupSyncFixture(), store = try LedgerStore.inMemory(readerSchemaVersion: 2)
    try f.setup(store)
    _ = try store.appendHeldLocalEvent(f.expense(), savedAt: f.date)
    let originals = try store.loadStoredEvents(for: f.base.potID).map(\.event)
    let transport = GroupPromotionTransport(failure: "TOPOLOGY_REVISION_CONFLICT")
    let request = PotSyncRequest(potID: f.base.potID, promotion: LocalPotPromotion(ownerMemberID: f.base.actorID,
        ownerDisplayName: "Recorder", minimumReaderSchemaVersion: 1))
    _ = try await SyncCoordinator(store: store, transport: transport).synchronize(request, now: f.date.addingTimeInterval(8))
    let restarted = SyncCoordinator(store: store, transport: transport)
    let report = try await restarted.synchronize(request, now: f.date.addingTimeInterval(18))
    #expect(report.outcome == .paused(eventID: nil, code: "TOPOLOGY_REVISION_CONFLICT"))
    #expect(await transport.requests.count == 1)
    #expect(try store.loadStoredEvents(for: f.base.potID).map(\.event) == originals)
    #expect(try store.syncState(for: f.base.potID)?.emptyPromotionRequired == false)
    #expect(try store.loadStoredEvents(for: f.base.potID).allSatisfy { $0.delivery.state == .ready })
}

private actor GroupPromotionTransport: SyncTransport {
    var requests: [LocalPotPromotionRequest] = []
    var remote: [HydratedWireEventV1] = []
    let failure: String?
    init(failure: String? = nil) { self.failure = failure }
    func connectionStates() async -> AsyncStream<SyncConnectionState> { AsyncStream { $0.finish() } }
    func listPots() async throws -> [RemotePotDescriptor] { [] }
    func promoteLocalPot(_ request: LocalPotPromotionRequest) async throws -> [EventAcknowledgement] {
        requests.append(request)
        if let failure { throw SyncTransportError.terminal(code: failure) }
        if remote.isEmpty {
            remote = try request.events.enumerated().map { index, event in
                try HydratedWireEventV1(event: event.arithmeticOnly, serverSequence: Int64(index + 1),
                    textStates: event.authoredText.map { .present(field: $0.field, value: $0.value) })
            }
            throw SyncTransportError.retryable(code: "NETWORK")
        }
        return remote.map { EventAcknowledgement(eventID: $0.event.eventId, serverSequence: $0.serverSequence) }
    }
    func appendEvents(potID: PotID, events: [WireEventV1]) async throws -> [EventAcknowledgement] { throw SyncTransportError.terminal(code: "UNEXPECTED_APPEND") }
    func listEvents(potID: PotID, afterSequence: Int64) async throws -> SyncEventPage {
        SyncEventPage(events: remote.filter { $0.serverSequence > afterSequence }, hasMore: false,
            nextAfterSequence: remote.last?.serverSequence ?? afterSequence)
    }
    func listTextChanges(potID: PotID, afterRevision: Int64) async throws -> SyncTextChangePage {
        SyncTextChangePage(changes: [], hasMore: false, nextAfterRevision: afterRevision)
    }
}
