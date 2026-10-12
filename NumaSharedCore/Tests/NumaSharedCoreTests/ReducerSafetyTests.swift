import XCTest
@testable import NumaSharedCore

final class ReducerSafetyTests: XCTestCase {
    func testHigherSchemaStopsPotBeforeEventAndLeavesLaterEventsUnapplied() throws {
        let fixture = try CoreFixture()
        let first = fixture.canonicalEvents[0]
        let future = fixture.event(
            2,
            id: 200,
            schemaVersion: EventEnvelope.currentSchemaVersion + 1,
            payload: fixture.canonicalEvents[1].payload
        )
        let later = fixture.event(3, id: 201, payload: fixture.canonicalEvents[2].payload)

        let result = LedgerReducer().reduce(pot: fixture.pot, events: [later, future, first])

        XCTAssertEqual(result.access, .readOnly(.unsupportedSchema(
            eventID: future.id,
            encountered: 2,
            supported: 1
        )))
        XCTAssertEqual(result.projection.appliedEventIDs, [first.id])
        XCTAssertEqual(result.projection.lastAppliedServerSequence, 1)
        XCTAssertNil(result.projection.records[fixture.groceryRecordID])
        XCTAssertNil(result.projection.records[fixture.internetRecordID])
    }

    func testUnknownKindStopsPotRatherThanSkippingOrGuessing() throws {
        let fixture = try CoreFixture()
        let first = fixture.canonicalEvents[0]
        let unknown = fixture.event(
            2,
            id: 202,
            payload: .unsupported(
                kind: "expenseTeleportationAdded",
                payload: .object(["future": .bool(true)])
            )
        )
        let later = fixture.canonicalEvents[2]
        let resequencedLater = fixture.event(3, id: 203, payload: later.payload)

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [resequencedLater, unknown, first]
        )

        XCTAssertEqual(result.access, .readOnly(.unsupportedEventKind(
            eventID: unknown.id,
            kind: "expenseTeleportationAdded"
        )))
        XCTAssertEqual(result.projection.appliedEventIDs, [first.id])
        XCTAssertEqual(result.projection.lastAppliedServerSequence, 1)
    }

    func testAttemptToReviseImmutableSettlementIsRejectedDeterministically() throws {
        let fixture = try CoreFixture()
        let settlement = fixture.canonicalEvents[4]
        let replacement = fixture.expense(
            recordID: fixture.samSettlementID,
            title: "Not a settlement anymore",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        ).content
        let revision = fixture.event(6, id: 210, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: fixture.samSettlementID,
                basis: .parent(settlement.id),
                content: .expense(replacement)
            )
        ))

        let firstResult = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [revision, settlement]
        )
        let secondResult = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [settlement, revision]
        )

        let expected = ReductionAccess.readOnly(.invalidEvent(
            eventID: revision.id,
            reason: .immutableSettlement(
                recordID: fixture.samSettlementID,
                attemptedKind: .expenseRevised
            )
        ))
        XCTAssertEqual(firstResult, secondResult)
        XCTAssertEqual(firstResult.access, expected)
        XCTAssertEqual(firstResult.projection.appliedEventIDs, [settlement.id])
        guard case .settlement? = firstResult.projection.records[fixture.samSettlementID] else {
            return XCTFail("The immutable settlement must remain projected")
        }
    }

    func testCutKindsHaveNoSupportedCases() {
        let supported = Set(EventKind.supportedCases.map(\.rawValue))

        XCTAssertFalse(supported.contains("refundAdded"))
        XCTAssertFalse(supported.contains("adjustmentAdded"))
        XCTAssertFalse(supported.contains("currencyConverted"))
        XCTAssertFalse(supported.contains("templateChanged"))
        XCTAssertEqual(EventKind(rawValue: "refundAdded"), .unsupported("refundAdded"))
    }

    func testDuplicateServerSequenceStopsBeforeEitherCollidingEvent() throws {
        let fixture = try CoreFixture()
        let first = fixture.canonicalEvents[0]
        let collisionA = fixture.event(2, id: 220, payload: fixture.canonicalEvents[1].payload)
        let collisionB = fixture.event(2, id: 219, payload: fixture.canonicalEvents[2].payload)
        let later = fixture.event(3, id: 221, payload: fixture.canonicalEvents[3].payload)

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [collisionA, later, first, collisionB]
        )

        XCTAssertEqual(result.access, .readOnly(.invalidEvent(
            eventID: collisionB.id,
            reason: .duplicateServerSequence(2)
        )))
        XCTAssertEqual(result.projection.appliedEventIDs, [first.id])
        XCTAssertEqual(result.projection.lastAppliedServerSequence, 1)
        XCTAssertNil(result.projection.records[fixture.groceryRecordID])
        XCTAssertNil(result.projection.records[fixture.internetRecordID])
    }

    func testOverflowingEventRollsBackToLastValidZeroSumProjection() throws {
        let fixture = try CoreFixture()
        let firstRecordID = RecordID(unchecked: testUUID(60))
        let secondRecordID = RecordID(unchecked: testUUID(61))
        let first = fixture.event(1, id: 230, payload: .expenseAdded(fixture.expense(
            recordID: firstRecordID,
            title: "Maximum",
            amount: Int64.max,
            payer: fixture.am,
            allocations: [(fixture.sam, Int64.max)]
        )))
        let overflowing = fixture.event(2, id: 231, payload: .expenseAdded(fixture.expense(
            recordID: secondRecordID,
            title: "One too many",
            amount: 1,
            payer: fixture.am,
            allocations: [(fixture.sam, 1)]
        )))

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [overflowing, first]
        )

        XCTAssertEqual(result.access, .readOnly(.invalidEvent(
            eventID: overflowing.id,
            reason: .arithmeticOverflow
        )))
        XCTAssertEqual(result.projection.appliedEventIDs, [first.id])
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, Int64.max)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, -Int64.max)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, 0)
        XCTAssertEqual(result.projection.spend.minorUnits, Int64.max)
        XCTAssertNil(result.projection.records[secondRecordID])
    }

    func testPersonalChargeRequiresOneBeneficiaryOtherThanPayer() throws {
        let fixture = try CoreFixture()
        let multiRecordID = RecordID(unchecked: testUUID(62))
        let selfRecordID = RecordID(unchecked: testUUID(63))
        let multipleBeneficiaries = fixture.event(1, id: 232, payload: .expenseAdded(
            fixture.expense(
                recordID: multiRecordID,
                kind: .personal,
                title: "Not personal",
                amount: 100,
                payer: fixture.am,
                allocations: [(fixture.sam, 50), (fixture.leo, 50)]
            )
        ))
        let payerAsBeneficiary = fixture.event(1, id: 233, payload: .expenseAdded(
            fixture.expense(
                recordID: selfRecordID,
                kind: .personal,
                title: "No shared effect",
                amount: 100,
                payer: fixture.am,
                allocations: [(fixture.am, 100)]
            )
        ))

        let multiResult = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [multipleBeneficiaries]
        )
        let selfResult = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [payerAsBeneficiary]
        )

        XCTAssertEqual(multiResult.access, .readOnly(.invalidEvent(
            eventID: multipleBeneficiaries.id,
            reason: .invalidExpenseAllocations
        )))
        XCTAssertEqual(selfResult.access, .readOnly(.invalidEvent(
            eventID: payerAsBeneficiary.id,
            reason: .invalidExpenseAllocations
        )))
        XCTAssertTrue(multiResult.projection.records.isEmpty)
        XCTAssertTrue(selfResult.projection.records.isEmpty)
    }

    func testSettlementVoidAndRestoreAttemptsRemainImmutable() throws {
        let fixture = try CoreFixture()
        let settlement = fixture.canonicalEvents[4]
        let void = fixture.event(6, id: 240, payload: .recordVoided(
            RecordVoidedPayload(recordID: fixture.samSettlementID, reason: "Wrong")
        ))
        let restore = fixture.event(6, id: 241, payload: .recordRestored(
            RecordRestoredPayload(recordID: fixture.samSettlementID)
        ))

        let voidResult = LedgerReducer().reduce(pot: fixture.pot, events: [settlement, void])
        let restoreResult = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [settlement, restore]
        )

        XCTAssertEqual(voidResult.access, .readOnly(.invalidEvent(
            eventID: void.id,
            reason: .immutableSettlement(
                recordID: fixture.samSettlementID,
                attemptedKind: .recordVoided
            )
        )))
        XCTAssertEqual(restoreResult.access, .readOnly(.invalidEvent(
            eventID: restore.id,
            reason: .immutableSettlement(
                recordID: fixture.samSettlementID,
                attemptedKind: .recordRestored
            )
        )))
    }

    func testPotArchiveStopsReductionBeforeEveryLaterEvent() throws {
        let fixture = try CoreFixture()
        let archive = fixture.event(1, id: 250, payload: .potArchived(
            PotArchivedPayload(reason: "Household closed")
        ))
        let laterExpense = fixture.event(
            2,
            id: 251,
            payload: fixture.canonicalEvents[0].payload
        )

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [laterExpense, archive]
        )

        guard case .readOnly = result.access else {
            return XCTFail("An archived pot must reject later events")
        }
        XCTAssertEqual(result.projection.appliedEventIDs, [archive.id])
        XCTAssertTrue(result.projection.isArchived)
        XCTAssertTrue(result.projection.records.isEmpty)
        XCTAssertTrue(result.projection.balances.values.allSatisfy { $0.minorUnits == 0 })
    }
}
