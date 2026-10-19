import Foundation
import Testing
@testable import NumaSharedCore

struct BudgetGroupReducerTests {
    private struct Fixture {
        let base: CoreFixture
        let partner = MemberID(unchecked: testUUID(3_001))
        let neighbor = MemberID(unchecked: testUUID(3_002))
        let coupleID = GroupID(unchecked: testUUID(3_003))
        let coupleUnit = UnitID(unchecked: testUUID(3_004))
        let pot: PotConfiguration

        init() throws {
            base = try CoreFixture()
            pot = try PotConfiguration(id: base.potID, currency: .eur, topology: StructuralProjection(
                members: [
                    base.actorID: MemberTopology(personalUnitID: base.am, unitID: base.am, role: .owner),
                    partner: MemberTopology(personalUnitID: base.sam, unitID: base.sam, role: .member),
                    neighbor: MemberTopology(personalUnitID: base.leo, unitID: base.leo, role: .member),
                ],
                claimedMemberIDs: [], archivedMemberIDs: [], groups: [], presets: [],
                knownUnitIDs: [base.am, base.sam, base.leo]
            ))
        }

        var couple: SettlementGroupSnapshot {
            SettlementGroupSnapshot(groupID: coupleID, unitID: coupleUnit,
                                    orderedMemberIDs: [base.actorID, partner], defaultShareWeight: 1)
        }

        func event(_ sequence: Int64, schema: UInt16 = 2, _ payload: EventPayload) -> EventEnvelope {
            base.event(sequence, id: UInt16(4_000 + sequence), schemaVersion: schema, payload: payload)
        }

        var setup: EventEnvelope { event(1, .groupChanged(GroupChangedPayload(groups: [couple]))) }

        func expense(_ sequence: Int64 = 2, amount: Int64 = 4_000, payer: MemberID? = nil) -> EventEnvelope {
            event(sequence, .expenseAdded(ExpenseAddedPayload(
                recordID: base.groceryRecordID,
                content: ExpenseContent(kind: .personal, title: "Paid for another group",
                    amount: Money(minorUnits: amount, currency: .eur), payerUnitID: coupleUnit,
                    allocations: [ExpenseAllocation(unitID: base.leo, amount: Money(minorUnits: amount, currency: .eur))],
                    payerMemberID: payer)
            )))
        }

        func reduce(_ events: [EventEnvelope]) -> ReductionResult {
            LedgerReducer(supportedSchemaVersion: EventEnvelope.maximumSupportedSchemaVersion)
                .reduce(pot: pot, events: events)
        }
    }

    @Test func equalSplitCountsGroupsNotPeopleAndRemainderIsExact() throws {
        let f = try Fixture()
        let shares = try WeightedAllocator.allocate(total: Money(minorUnits: 12_000, currency: .eur),
            weights: [:], orderedUnitIDs: [f.coupleUnit, f.base.leo])
        #expect(shares[f.coupleUnit]?.minorUnits == 6_000)
        #expect(shares[f.base.leo]?.minorUnits == 6_000)
        let expense = f.event(2, .expenseAdded(ExpenseAddedPayload(recordID: f.base.rentRecordID,
            content: ExpenseContent(kind: .shared, title: "Shared bill", amount: Money(minorUnits: 12_000, currency: .eur),
                payerUnitID: f.coupleUnit, allocations: [f.coupleUnit, f.base.leo].map {
                    ExpenseAllocation(unitID: $0, amount: shares[$0]!)
                }, payerMemberID: f.partner))))
        let result = f.reduce([expense, f.setup])
        #expect(result.access == .readWrite)
        #expect(result.projection.balances[f.coupleUnit]?.minorUnits == 6_000)
        #expect(result.projection.balances[f.base.leo]?.minorUnits == -6_000)
        #expect(result.projection.balances[f.base.am]?.minorUnits == 0)
        #expect(result.projection.balances[f.base.sam]?.minorUnits == 0)
        let ordered = [f.coupleUnit, f.base.leo, UnitID(unchecked: testUUID(3_005))]
        let cents = try WeightedAllocator.allocate(total: Money(minorUnits: 100, currency: .eur),
            weights: [:], orderedUnitIDs: ordered)
        #expect(ordered.map { cents[$0]?.minorUnits } == [33, 33, 34])
        #expect(cents.values.reduce(0) { $0 + $1.minorUnits } == 100)
    }

    @Test func paidForAnotherExternalRepaymentAndVisibleReversal() throws {
        let f = try Fixture()
        let paid = f.expense(payer: f.partner)
        let repayment = f.event(3, .settlementRecorded(f.base.settlement(recordID: f.base.samSettlementID,
            title: "Repayment made elsewhere", amount: 4_000, from: f.base.leo, to: f.coupleUnit)))
        let cleared = f.reduce([f.setup, paid, repayment])
        #expect(cleared.access == .readWrite)
        #expect(cleared.projection.settlementPlan == .exact([]))
        let flag = f.event(4, .settlementFlagged(SettlementFlaggedPayload(recordID: f.base.samSettlementID)))
        let reversal = f.event(5, .settlementRecorded(f.base.settlement(recordID: f.base.leoSettlementID,
            title: "Correct recorded repayment", amount: 4_000, from: f.coupleUnit, to: f.base.leo,
            reversalOf: f.base.samSettlementID)))
        let result = f.reduce([f.setup, paid, repayment, flag, reversal])
        #expect(result.access == .readWrite)
        #expect(result.projection.balances[f.coupleUnit]?.minorUnits == 4_000)
        #expect(result.projection.records.count == 3)
        #expect(result.projection.appliedEventIDs == [f.setup, paid, repayment, flag, reversal].map(\.id))
    }

    @Test func sameGroupSpendingCreatesNoDebtAndInternalRepaymentIsRejected() throws {
        let f = try Fixture()
        let spent = f.event(2, .expenseAdded(f.base.expense(recordID: f.base.rentRecordID,
            title: "Our group's purchase", amount: 500, payer: f.coupleUnit, allocations: [(f.coupleUnit, 500)])))
        #expect(f.reduce([f.setup, spent]).projection.settlementPlan == .exact([]))
        let repayment = f.event(3, .settlementRecorded(f.base.settlement(recordID: f.base.samSettlementID,
            title: "Not a repayment", amount: 500, from: f.coupleUnit, to: f.coupleUnit)))
        #expect(f.reduce([f.setup, spent, repayment]).access == .readOnly(.invalidEvent(
            eventID: repayment.id, reason: .invalidSettlement)))
        let personalUnitCharge = f.event(2, .expenseAdded(f.base.expense(recordID: f.base.rentRecordID,
            title: "No partner debt", amount: 500, payer: f.coupleUnit, allocations: [(f.base.sam, 500)])))
        #expect(f.reduce([f.setup, personalUnitCharge]).access == .readOnly(.invalidEvent(
            eventID: personalUnitCharge.id, reason: .inactiveUnit(f.base.sam))))
    }

    @Test func groupChangesFreezeAtFirstRecordEvenAfterVoidOrSettlement() throws {
        let f = try Fixture()
        let paid = f.expense()
        let void = f.event(3, .recordVoided(RecordVoidedPayload(recordID: f.base.groceryRecordID, reason: "Wrong entry")))
        let dissolve = f.event(4, .groupChanged(GroupChangedPayload(groups: [])))
        let result = f.reduce([f.setup, paid, void, dissolve])
        #expect(result.access == .readOnly(.invalidEvent(eventID: dissolve.id, reason: .budgetGroupsLocked)))
        #expect(result.projection.settlementPlan == .exact([]))
        #expect(result.projection.records.count == 1)
        let opening = f.event(2, .openingBalanceSet(OpeningBalanceSetPayload(recordID: f.base.rentRecordID,
            content: OpeningBalanceContent(title: "Starting balances", entries: [
                OpeningBalanceEntry(unitID: f.coupleUnit, amount: Money(minorUnits: 100, currency: .eur)),
                OpeningBalanceEntry(unitID: f.base.leo, amount: Money(minorUnits: -100, currency: .eur)),
            ]))))
        let repayment = f.event(2, .settlementRecorded(f.base.settlement(recordID: f.base.samSettlementID,
            title: "External repayment", amount: 100, from: f.base.leo, to: f.coupleUnit)))
        for firstRecord in [opening, repayment] {
            #expect(f.reduce([f.setup, firstRecord, dissolve]).access == .readOnly(.invalidEvent(
                eventID: dissolve.id, reason: .budgetGroupsLocked)))
        }
    }

    /// The backend allows groups up to this size until build 11 is fenced out
    /// (convex/lib/clientContract.ts); build 11 must read every one of them.
    @Test func everyGroupSizeTheBackendAllowsByDefaultIsReadable() throws {
        let url = try #require(Bundle.module.url(forResource: "build-11-reader-contract", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let size = try #require(object["maximumBudgetGroupSize"] as? Int)
        let f = try Fixture()
        let members = Array([f.base.actorID, f.partner, f.neighbor].prefix(size))
        #expect(members.count == size)
        let group = SettlementGroupSnapshot(groupID: f.coupleID, unitID: f.coupleUnit,
            orderedMemberIDs: members, defaultShareWeight: 1)
        let change = f.event(1, .groupChanged(GroupChangedPayload(groups: [group])))
        #expect(f.reduce([change]).access == .readWrite)
    }

    @Test func newCardinalityAndWeightRulesDoNotRewriteValidLegacyGroups() throws {
        let f = try Fixture()
        for members in [[], [f.base.actorID, f.partner, f.neighbor]] {
            let group = SettlementGroupSnapshot(groupID: f.coupleID, unitID: f.coupleUnit,
                orderedMemberIDs: members, defaultShareWeight: 1)
            let bad = f.event(1, .groupChanged(GroupChangedPayload(groups: [group])))
            #expect(f.reduce([bad]).access == .readOnly(.invalidEvent(eventID: bad.id, reason: .invalidBudgetGroup(f.coupleID))))
        }
        let old = SettlementGroupSnapshot(groupID: f.coupleID, unitID: f.coupleUnit,
            orderedMemberIDs: [f.base.actorID, f.partner, f.neighbor], defaultShareWeight: 3)
        let legacy = f.event(1, schema: 1, .groupChanged(GroupChangedPayload(groups: [old])))
        let activate = f.event(2, .groupChanged(GroupChangedPayload(groups: [old])))
        #expect(f.reduce([legacy, activate]).access == .readWrite)
        #expect(f.reduce([legacy, activate]).projection.structure.groups == [old])
    }

    @Test func legacyMoneyCannotBeMergedAndActivationKeepsPriorOutcomes() throws {
        let f = try Fixture()
        let legacyExpense = f.event(1, schema: 1, .expenseAdded(f.base.expense(recordID: f.base.groceryRecordID,
            title: "Legacy purchase", amount: 4_000, payer: f.base.sam, allocations: [(f.base.leo, 4_000)])))
        let attempt = f.event(2, .groupChanged(GroupChangedPayload(groups: [f.couple])))
        #expect(f.reduce([legacyExpense, attempt]).access == .readOnly(.invalidEvent(
            eventID: attempt.id, reason: .budgetGroupsLocked)))
        let legacyGroup = f.event(2, schema: 1, .groupChanged(GroupChangedPayload(groups: [f.couple])))
        let legacyArchive = f.event(3, schema: 1, .memberArchived(MemberArchivedPayload(memberID: f.partner)))
        let before = f.reduce([legacyExpense, legacyGroup, legacyArchive])
        let activate = f.event(4, .potRenamed(PotRenamedPayload(name: "Our household")))
        let after = f.reduce([legacyExpense, legacyGroup, legacyArchive, activate])
        #expect(before.access == .readWrite)
        #expect(after.access == .readWrite)
        #expect(before.projection.balances == after.projection.balances)
        #expect(after.projection.balances[f.base.sam]?.minorUnits == 4_000)
    }

    @Test func departureKeepsLegacyAndNewGroupDebtsWhenBothPartnersLeave() throws {
        let f = try Fixture()
        let legacyExpense = f.event(1, schema: 1, .expenseAdded(f.base.expense(recordID: f.base.groceryRecordID,
            title: "Legacy purchase", amount: 4_000, payer: f.base.sam, allocations: [(f.base.leo, 4_000)])))
        let legacyGroup = f.event(2, schema: 1, .groupChanged(GroupChangedPayload(groups: [f.couple])))
        let activation = f.event(3, .potRenamed(PotRenamedPayload(name: "Our household")))
        let transfer = f.event(4, .ownershipTransferred(OwnershipTransferredPayload(
            fromMemberID: f.base.actorID, toMemberID: f.neighbor)))
        let leavePartner = f.event(5, .memberArchived(MemberArchivedPayload(memberID: f.partner)))
        let leaveOwner = f.event(6, .memberArchived(MemberArchivedPayload(memberID: f.base.actorID)))
        let events = [legacyExpense, legacyGroup, activation, transfer, leavePartner, leaveOwner]
        let result = f.reduce(events)
        #expect(result.access == .readWrite)
        #expect(result.projection.balances[f.coupleUnit]?.minorUnits == 4_000)
        #expect(result.projection.balances[f.base.sam]?.minorUnits == 0)
        #expect(result.projection.structure.members[f.partner]?.unitID == f.coupleUnit)
        #expect(result.projection.structure.groups == [f.couple])
        #expect(!result.projection.structure.activeUnitIDs.contains(f.coupleUnit))
        let settle = f.event(7, .settlementRecorded(f.base.settlement(recordID: f.base.samSettlementID,
            title: "Repayment after departure", amount: 4_000, from: f.base.leo, to: f.coupleUnit)))
        #expect(f.reduce(events + [settle]).projection.settlementPlan == .exact([]))
        let corrected = f.event(7, .expenseRevised(ExpenseRevisedPayload(recordID: f.base.groceryRecordID,
            basis: .parent(legacyExpense.id), content: .expense(ExpenseContent(kind: .personal,
                title: "Correct legacy payer", amount: Money(minorUnits: 5_000, currency: .eur),
                payerUnitID: f.base.sam,
                allocations: [ExpenseAllocation(unitID: f.base.leo, amount: Money(minorUnits: 5_000, currency: .eur))],
                payerMemberID: f.partner)))))
        #expect(f.reduce(events + [corrected]).access == .readWrite)
        #expect(f.reduce(events + [corrected]).projection.balances[f.coupleUnit]?.minorUnits == 5_000)
        // Structural identities contain no profile text or account credentials;
        // erasure can remove those sidecars without changing this arithmetic.
        #expect(try JSONDecoder().decode(StructuralProjection.self,
            from: JSONEncoder().encode(result.projection.structure)) == result.projection.structure)
        _ = try PotConfiguration(id: f.base.potID, currency: .eur, topology: result.projection.structure)
    }

    @Test func attributionIsSeparateRoundTripsAndRemainsUnknownForLegacy() throws {
        let f = try Fixture()
        let event = f.expense(payer: f.partner)
        #expect(event.actorMemberID == f.base.actorID)
        #expect(event.payload.payerMemberID == f.partner)
        let encoded = try JSONEncoder().encode(event)
        #expect(try JSONDecoder().decode(EventEnvelope.self, from: encoded) == event)
        let wire = try WireEventV1(event)
        let decoded = try JSONDecoder().decode(WireEventV1.self, from: JSONEncoder().encode(wire))
        #expect(try decoded.arithmeticOnly.eventEnvelope(serverSequence: 2,
            textStates: [.present(field: .title, value: "Paid for another group")]) == event)
        let legacy = f.base.canonicalEvents[0]
        #expect(try JSONDecoder().decode(EventEnvelope.self, from: JSONEncoder().encode(legacy)).payload.payerMemberID == nil)
        let invalid = f.expense(payer: f.neighbor)
        #expect(f.reduce([f.setup, invalid]).access == .readOnly(.invalidEvent(
            eventID: invalid.id, reason: .invalidPayerMember(f.neighbor))))
        var mislabeledWire = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(wire)) as? [String: Any])
        mislabeledWire["schemaVersion"] = 1
        let mislabeledWireData = try JSONSerialization.data(withJSONObject: mislabeledWire)
        #expect(throws: EventModelError.payerAttributionRequiresBudgetGroups) {
            try JSONDecoder().decode(WireEventV1.self, from: mislabeledWireData)
        }
        var mislabeledDomain = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        mislabeledDomain["schemaVersion"] = 1
        let mislabeledDomainData = try JSONSerialization.data(withJSONObject: mislabeledDomain)
        #expect(throws: EventModelError.payerAttributionRequiresBudgetGroups) {
            try JSONDecoder().decode(EventEnvelope.self, from: mislabeledDomainData)
        }
        let wrongSchema = f.event(2, schema: 1, event.payload)
        #expect(throws: EventModelError.payerAttributionRequiresBudgetGroups) { try WireEventV1(wrongSchema) }
        #expect(throws: EventModelError.payerAttributionRequiresBudgetGroups) { try JSONEncoder().encode(wrongSchema) }
    }

    @Test func revisionsPreserveAttributionAndHistoricalCorrectionAfterDeparture() throws {
        let f = try Fixture()
        let paid = f.expense(payer: f.partner)
        let leave = f.event(3, .memberArchived(MemberArchivedPayload(memberID: f.partner)))
        let content = ExpenseContent(kind: .personal, title: "Corrected", amount: Money(minorUnits: 5_000, currency: .eur),
            payerUnitID: f.coupleUnit,
            allocations: [ExpenseAllocation(unitID: f.base.leo, amount: Money(minorUnits: 5_000, currency: .eur))],
            payerMemberID: f.partner)
        let revision = f.event(4, .expenseRevised(ExpenseRevisedPayload(recordID: f.base.groceryRecordID,
            basis: .parent(paid.id), content: .expense(content))))
        let wire = try WireEventV1(revision)
        let decoded = try JSONDecoder().decode(WireEventV1.self, from: JSONEncoder().encode(wire))
        #expect(try decoded.arithmeticOnly.eventEnvelope(serverSequence: 4, textStates: [.present(field: .title, value: "Corrected")]) == revision)
        let void = f.event(5, .recordVoided(RecordVoidedPayload(recordID: f.base.groceryRecordID, reason: "Mistake")))
        let restore = f.event(6, .recordRestored(RecordRestoredPayload(recordID: f.base.groceryRecordID)))
        let result = f.reduce([f.setup, paid, leave, revision, void, restore])
        #expect(result.access == .readWrite)
        #expect(result.projection.balances[f.coupleUnit]?.minorUnits == 5_000)
        if case let .revisable(record) = result.projection.records[f.base.groceryRecordID] {
            #expect(record.revisions.count == 2)
            #expect(record.currentContent == .expense(content))
        } else { Issue.record("Missing visible expense history") }
        let erased = try decoded.arithmeticOnly.eventEnvelope(serverSequence: 4, textStates: [.redacted(field: .title)])
        #expect(erased.payload.payerMemberID == f.partner)
        #expect(!String(decoding: try JSONEncoder().encode(erased), as: UTF8.self).contains("Corrected"))
    }

    @Test func snapshotsKeepActivationAndHistoryLockAndRejectOldReaders() throws {
        let f = try Fixture()
        let result = f.reduce([f.setup, f.expense()])
        let encoded = try JSONEncoder().encode(result.projection.structure)
        let snapshot = try JSONDecoder().decode(StructuralProjection.self, from: encoded)
        #expect(snapshot.minimumSchemaVersion == 2)
        #expect(snapshot.hasFinancialHistory)
        var oldSnapshotObject = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(f.pot.topology)) as? [String: Any])
        oldSnapshotObject.removeValue(forKey: "hasFinancialHistory")
        oldSnapshotObject.removeValue(forKey: "minimumSchemaVersion")
        let oldSnapshot = try JSONDecoder().decode(StructuralProjection.self,
            from: JSONSerialization.data(withJSONObject: oldSnapshotObject))
        #expect(oldSnapshot.hasFinancialHistory)
        let checkpoint = try PotConfiguration(id: f.base.potID, currency: .eur, topology: snapshot)
        let dissolution = f.event(3, .groupChanged(GroupChangedPayload(groups: [])))
        #expect(LedgerReducer(supportedSchemaVersion: 2).reduce(pot: checkpoint, events: [dissolution]).access == .readOnly(.invalidEvent(
            eventID: dissolution.id, reason: .budgetGroupsLocked)))
        #expect(LedgerReducer().reduce(pot: checkpoint, events: []).access ==
            .readOnly(.unsupportedTopologySchema(encountered: 2, supported: 1)))
        struct LegacySnapshot: Decodable { let members: [MemberID: MemberTopology] }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(LegacySnapshot.self, from: encoded) }
        var future = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        future["minimumSchemaVersion"] = 3
        let futureData = try JSONSerialization.data(withJSONObject: future)
        #expect(throws: PotConfigurationError.unsupportedTopologySchemaVersion(3)) {
            try JSONDecoder().decode(StructuralProjection.self, from: futureData)
        }
        let downgrade = f.event(3, schema: 1, .potRenamed(PotRenamedPayload(name: "Old client")))
        #expect(f.reduce([f.setup, f.expense(), downgrade]).access == .readOnly(.invalidEvent(
            eventID: downgrade.id, reason: .schemaDowngrade(required: 2, actual: 1))))
        #expect(LedgerReducer().reduce(pot: f.pot, events: [f.setup]).access ==
            .readOnly(.unsupportedSchema(eventID: f.setup.id, encountered: 2, supported: 1)))
        let futureEvent = f.event(1, schema: 3, .potRenamed(PotRenamedPayload(name: "Future household")))
        #expect(f.reduce([futureEvent]).access == .readOnly(.unsupportedSchema(
            eventID: futureEvent.id, encountered: 3, supported: 2)))
    }

    @Test func duplicateAndOverflowStopBeforeApplyingUnsafeMoney() throws {
        let f = try Fixture()
        let paid = f.expense(amount: Int64.max)
        let extra = f.event(3, .expenseAdded(f.base.expense(recordID: f.base.rentRecordID,
            title: "Would overflow", amount: 1, payer: f.coupleUnit, allocations: [(f.base.leo, 1)])))
        let result = f.reduce([f.setup, paid, extra])
        #expect(result.access == .readOnly(.invalidEvent(eventID: extra.id, reason: .arithmeticOverflow)))
        #expect(result.projection.balances[f.coupleUnit]?.minorUnits == Int64.max)
        #expect(result.projection.appliedEventIDs == [f.setup.id, paid.id])
        let duplicate = f.reduce([f.setup, paid, paid])
        #expect(duplicate.access == .readOnly(.invalidEvent(eventID: paid.id, reason: .duplicateServerSequence(2))))
        #expect(duplicate.projection.records.isEmpty)
        #expect(f.reduce([paid, f.setup]).projection == f.reduce([f.setup, paid]).projection)
    }
}
