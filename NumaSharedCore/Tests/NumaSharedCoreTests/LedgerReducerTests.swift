import XCTest
@testable import NumaSharedCore

final class LedgerReducerTests: XCTestCase {
    func testCasaMarCanonicalProjectionUsesServerSequenceOrder() throws {
        let fixture = try CoreFixture()
        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents.reversed()
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 13_000)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, -7_500)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -5_500)
        XCTAssertEqual(
            result.projection.balances.values.reduce(0) { $0 + $1.minorUnits },
            0
        )
        XCTAssertEqual(result.projection.spend.minorUnits, 200_000)
        XCTAssertEqual(result.projection.settlementPlan, .exact([
            SettlementTransfer(
                fromUnitID: fixture.sam,
                toUnitID: fixture.am,
                amount: Money(minorUnits: 7_500, currency: .eur)
            ),
            SettlementTransfer(
                fromUnitID: fixture.leo,
                toUnitID: fixture.am,
                amount: Money(minorUnits: 5_500, currency: .eur)
            ),
        ]))
        XCTAssertEqual(result.projection.lastAppliedServerSequence, 6)
    }

    func testVoidAndRestoreAreAppendOnlyEvents() throws {
        let fixture = try CoreFixture()
        let void = fixture.event(7, id: 107, payload: .recordVoided(
            RecordVoidedPayload(recordID: fixture.rentRecordID, reason: "Duplicate import")
        ))
        let voided = LedgerReducer().reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents + [void]
        )

        XCTAssertEqual(voided.projection.balances[fixture.am]?.minorUnits, -77_000)
        XCTAssertEqual(voided.projection.balances[fixture.sam]?.minorUnits, 37_500)
        XCTAssertEqual(voided.projection.balances[fixture.leo]?.minorUnits, 39_500)
        XCTAssertEqual(voided.projection.spend.minorUnits, 20_000)
        XCTAssertEqual(voided.projection.appliedEventIDs.count, 7)
        guard case let .revisable(voidedRent)? = voided.projection.records[fixture.rentRecordID] else {
            return XCTFail("Expected a revisable rent record")
        }
        XCTAssertTrue(voidedRent.isVoided)
        XCTAssertEqual(voidedRent.voidReason, "Duplicate import")

        let restore = fixture.event(8, id: 108, payload: .recordRestored(
            RecordRestoredPayload(recordID: fixture.rentRecordID)
        ))
        let restored = LedgerReducer().reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents + [void, restore]
        )

        XCTAssertEqual(restored.projection.balances[fixture.am]?.minorUnits, 13_000)
        XCTAssertEqual(restored.projection.spend.minorUnits, 200_000)
        guard case let .revisable(restoredRent)? = restored.projection.records[fixture.rentRecordID] else {
            return XCTFail("Expected a revisable rent record")
        }
        XCTAssertFalse(restoredRent.isVoided)
        XCTAssertNil(restoredRent.voidReason)
    }

    func testSettlementOverpayFlipsDirectionWithoutMutatingPriorSettlement() throws {
        let fixture = try CoreFixture()
        let overpay = fixture.event(7, id: 109, payload: .settlementRecorded(fixture.settlement(
            recordID: RecordID(unchecked: testUUID(26)),
            title: "Sam paid your household",
            amount: 10_000,
            from: fixture.sam,
            to: fixture.am
        )))
        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents + [overpay]
        )

        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 2_500)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 3_000)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -5_500)
        XCTAssertEqual(result.projection.records.count, 7)
    }

    func testFlaggedSettlementSupportsOnlyBoundedLinkedOppositeReversals() throws {
        let fixture = try CoreFixture()
        let targetRecordID = RecordID(unchecked: testUUID(30))
        let original = fixture.event(7, id: 110, payload: .settlementRecorded(
            fixture.settlement(
                recordID: targetRecordID,
                title: "Sam paid your household",
                amount: 1_000,
                from: fixture.sam,
                to: fixture.am
            )
        ))
        let flag = fixture.event(8, id: 111, payload: .settlementFlagged(
            SettlementFlaggedPayload(recordID: targetRecordID, reason: "Wrong amount")
        ))
        let partialRecordID = RecordID(unchecked: testUUID(31))
        let partial = fixture.event(9, id: 112, payload: .settlementRecorded(
            fixture.settlement(
                recordID: partialRecordID,
                title: "Partial reversal",
                amount: 400,
                from: fixture.am,
                to: fixture.sam,
                reversalOf: targetRecordID
            )
        ))
        let finalRecordID = RecordID(unchecked: testUUID(32))
        let final = fixture.event(10, id: 113, payload: .settlementRecorded(
            fixture.settlement(
                recordID: finalRecordID,
                title: "Final reversal",
                amount: 600,
                from: fixture.am,
                to: fixture.sam,
                reversalOf: targetRecordID
            )
        ))
        let reducer = LedgerReducer()
        let baseline = reducer.reduce(pot: fixture.pot, events: fixture.canonicalEvents)
        let complete = reducer.reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents + [original, flag, partial, final]
        )

        XCTAssertEqual(complete.access, .readWrite)
        XCTAssertEqual(complete.projection.balances, baseline.projection.balances)
        guard case let .settlement(target)? = complete.projection.records[targetRecordID],
              case let .settlement(projectedPartial)? =
                complete.projection.records[partialRecordID]
        else { return XCTFail("Expected the original and linked reversal projections") }
        XCTAssertTrue(target.isFlagged)
        XCTAssertEqual(projectedPartial.content.reversalOfRecordID, targetRecordID)

        let unflagged = reducer.reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents + [original, partial]
        )
        XCTAssertEqual(
            unflagged.access,
            .readOnly(.invalidEvent(
                eventID: partial.id,
                reason: .settlementReversalTargetNotFlagged(targetRecordID)
            ))
        )

        let wrongDirection = fixture.event(9, id: 114, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(33)),
                title: "Wrong direction",
                amount: 100,
                from: fixture.sam,
                to: fixture.am,
                reversalOf: targetRecordID
            )
        ))
        XCTAssertEqual(
            reducer.reduce(
                pot: fixture.pot,
                events: fixture.canonicalEvents + [original, flag, wrongDirection]
            ).access,
            .readOnly(.invalidEvent(
                eventID: wrongDirection.id,
                reason: .settlementReversalDirectionMismatch(targetRecordID)
            ))
        )

        let excessive = fixture.event(10, id: 115, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(34)),
                title: "Too much",
                amount: 601,
                from: fixture.am,
                to: fixture.sam,
                reversalOf: targetRecordID
            )
        ))
        XCTAssertEqual(
            reducer.reduce(
                pot: fixture.pot,
                events: fixture.canonicalEvents + [original, flag, partial, excessive]
            ).access,
            .readOnly(.invalidEvent(
                eventID: excessive.id,
                reason: .settlementReversalExceedsOriginal(targetRecordID)
            ))
        )
    }

    func testEveryCanonicalPrefixIsZeroSumAndReplayIsDeterministic() throws {
        let fixture = try CoreFixture()
        let reducer = LedgerReducer()

        for count in 1 ... fixture.canonicalEvents.count {
            let projection = reducer.reduce(
                pot: fixture.pot,
                events: fixture.canonicalEvents.prefix(count)
            ).projection
            XCTAssertEqual(
                projection.balances.values.reduce(0) { $0 + $1.minorUnits },
                0,
                "Prefix \(count) must remain zero-sum"
            )
        }

        let shuffled = [
            fixture.canonicalEvents[4], fixture.canonicalEvents[1],
            fixture.canonicalEvents[5], fixture.canonicalEvents[0],
            fixture.canonicalEvents[3], fixture.canonicalEvents[2],
        ]
        XCTAssertEqual(
            reducer.reduce(pot: fixture.pot, events: fixture.canonicalEvents),
            reducer.reduce(pot: fixture.pot, events: shuffled)
        )
    }

    func testOpeningBalanceIsZeroSumRevisableRecordAndNotSpend() throws {
        let fixture = try CoreFixture()
        let recordID = RecordID(unchecked: testUUID(30))
        let opening = fixture.event(1, id: 120, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: recordID,
                content: OpeningBalanceContent(
                    title: "Opening balance",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 1_000, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: -1_000, currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let result = LedgerReducer().reduce(pot: fixture.pot, events: [opening])

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 1_000)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -1_000)
        XCTAssertEqual(result.projection.spend.minorUnits, 0)
        guard case let .exact(plan) = result.projection.settlementPlan else {
            return XCTFail("Expected an exact settlement plan")
        }
        XCTAssertEqual(plan.count, 1)
    }

    func testSettlementPlannerFindsFewerTransfersThanFirstGreedyPairing() throws {
        let fixture = try CoreFixture()
        let fourth = UnitID(unchecked: testUUID(13))
        let fifth = UnitID(unchecked: testUUID(14))
        let balances = [
            fixture.am: Money(minorUnits: -8, currency: .eur),
            fixture.sam: Money(minorUnits: -7, currency: .eur),
            fixture.leo: Money(minorUnits: -5, currency: .eur),
            fourth: Money(minorUnits: 12, currency: .eur),
            fifth: Money(minorUnits: 8, currency: .eur),
        ]

        let plan = try SettlementPlanner.plan(balances: balances)

        XCTAssertEqual(plan.count, 3)
        XCTAssertEqual(plan.first?.amount.minorUnits, 8)
        XCTAssertEqual(plan.first?.toUnitID, fifth)
    }

    func testSettlementPlanDistinguishesExactEmptyFromUnavailable() throws {
        let fixture = try CoreFixture()
        let noWork = SettlementPlanningLimits(
            maximumExpandedStates: 0,
            maximumInspectedBranches: 0,
            maximumRecursionDepth: 0
        )
        let settled = LedgerReducer(settlementPlanningLimits: noWork).reduce(
            pot: fixture.pot,
            events: []
        )
        let unavailable = LedgerReducer(settlementPlanningLimits: noWork).reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents
        )

        XCTAssertEqual(settled.projection.settlementPlan, .exact([]))
        XCTAssertEqual(
            unavailable.projection.settlementPlan,
            .unavailable(.searchLimitExceeded(resource: .recursionDepth, limit: 0))
        )
    }

    func testSettlementPlannerThrowsAfterFindingAnUnprovenBestSoFarPlan() throws {
        let fixture = try CoreFixture()
        let balances = settlementPlannerCounterexample(fixture: fixture)
        let limits = SettlementPlanningLimits(
            maximumExpandedStates: 100,
            maximumInspectedBranches: 9,
            maximumRecursionDepth: 100
        )

        XCTAssertThrowsError(try SettlementPlanner.plan(
            balances: balances,
            limits: limits
        )) { error in
            XCTAssertEqual(
                error as? SettlementPlanningError,
                .searchLimitExceeded(resource: .inspectedBranches, limit: 9)
            )
        }
        XCTAssertEqual(try SettlementPlanner.plan(balances: balances).count, 3)
    }

    func testSettlementPlannerIsIndependentOfDictionaryInsertionOrder() throws {
        let fixture = try CoreFixture()
        let entries = Array(settlementPlannerCounterexample(fixture: fixture))
            .sorted { $0.key < $1.key }
        var forward = [UnitID: Money]()
        var reverse = [UnitID: Money]()
        for entry in entries {
            forward[entry.key] = entry.value
        }
        for entry in entries.reversed() {
            reverse[entry.key] = entry.value
        }

        XCTAssertEqual(
            try SettlementPlanner.plan(balances: forward),
            try SettlementPlanner.plan(balances: reverse)
        )

        let limits = SettlementPlanningLimits(
            maximumExpandedStates: 100,
            maximumInspectedBranches: 9,
            maximumRecursionDepth: 100
        )
        XCTAssertEqual(
            settlementPlanningError(for: forward, limits: limits),
            settlementPlanningError(for: reverse, limits: limits)
        )
    }

    func testSettlementPlannerReportsEachBoundedResource() throws {
        let fixture = try CoreFixture()
        let balances = [
            fixture.am: Money(minorUnits: -2, currency: .eur),
            fixture.sam: Money(minorUnits: 1, currency: .eur),
            fixture.leo: Money(minorUnits: 1, currency: .eur),
        ]
        let stateLimited = SettlementPlanningLimits(
            maximumExpandedStates: 1,
            maximumInspectedBranches: 100,
            maximumRecursionDepth: 100
        )
        let branchLimited = SettlementPlanningLimits(
            maximumExpandedStates: 100,
            maximumInspectedBranches: 0,
            maximumRecursionDepth: 100
        )
        let depthLimited = SettlementPlanningLimits(
            maximumExpandedStates: 100,
            maximumInspectedBranches: 100,
            maximumRecursionDepth: 1
        )

        XCTAssertEqual(
            settlementPlanningError(for: balances, limits: stateLimited),
            .searchLimitExceeded(resource: .expandedStates, limit: 1)
        )
        XCTAssertEqual(
            settlementPlanningError(for: balances, limits: branchLimited),
            .searchLimitExceeded(resource: .inspectedBranches, limit: 0)
        )
        XCTAssertEqual(
            settlementPlanningError(for: balances, limits: depthLimited),
            .searchLimitExceeded(resource: .recursionDepth, limit: 1)
        )
    }

    func testSettlementPlannerRejectsActiveUnitCountBeforeSearchAllocation() throws {
        let fixture = try CoreFixture()
        let limits = SettlementPlanningLimits(
            maximumActiveUnits: 2,
            maximumExpandedStates: .max,
            maximumInspectedBranches: .max,
            maximumRecursionDepth: .max
        )

        let result = LedgerReducer(settlementPlanningLimits: limits).reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(
            result.projection.settlementPlan,
            .unavailable(.searchLimitExceeded(resource: .activeUnits, limit: 2))
        )
    }

    func testReducerKeepsValidLedgerWritableWhenExactPlanExceedsLimit() throws {
        let fixture = try CoreFixture()
        let limits = SettlementPlanningLimits(
            maximumExpandedStates: 100,
            maximumInspectedBranches: 0,
            maximumRecursionDepth: 100
        )
        let result = LedgerReducer(settlementPlanningLimits: limits).reduce(
            pot: fixture.pot,
            events: fixture.canonicalEvents
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 13_000)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, -7_500)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -5_500)
        XCTAssertEqual(result.projection.appliedEventIDs.count, fixture.canonicalEvents.count)
        XCTAssertEqual(
            result.projection.settlementPlan,
            .unavailable(.searchLimitExceeded(resource: .inspectedBranches, limit: 0))
        )
    }

    func testSameTimestampLocalEventsPreserveStoreAppendOrder() throws {
        let fixture = try CoreFixture()
        let recordID = RecordID(unchecked: testUUID(50))
        let add = fixture.event(nil, id: 900, payload: .expenseAdded(fixture.expense(
            recordID: recordID,
            title: "Local expense",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let void = fixture.event(nil, id: 800, payload: .recordVoided(
            RecordVoidedPayload(recordID: recordID, reason: "Undo replacement")
        ))

        let result = LedgerReducer().reduce(pot: fixture.pot, events: [add, void])

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.appliedEventIDs, [add.id, void.id])
        guard case let .revisable(record)? = result.projection.records[recordID] else {
            return XCTFail("Expected local record")
        }
        XCTAssertTrue(record.isVoided)
        XCTAssertEqual(
            result.projection.balances.values.reduce(0) { $0 + $1.minorUnits },
            0
        )
    }

    func testOpeningBalanceSupportsRevisionVoidAndRestoreHistory() throws {
        let fixture = try CoreFixture()
        let recordID = RecordID(unchecked: testUUID(51))
        let initial = fixture.event(1, id: 910, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: recordID,
                content: OpeningBalanceContent(
                    title: "Opening balance",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 100, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: -100, currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let revisedContent = OpeningBalanceContent(
            title: "Opening balance corrected",
            entries: [
                OpeningBalanceEntry(
                    unitID: fixture.sam,
                    amount: Money(minorUnits: 200, currency: .eur)
                ),
                OpeningBalanceEntry(
                    unitID: fixture.leo,
                    amount: Money(minorUnits: -200, currency: .eur)
                ),
            ]
        )
        let revision = fixture.event(2, id: 911, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .openingBalance(revisedContent)
            )
        ))
        let void = fixture.event(3, id: 912, payload: .recordVoided(
            RecordVoidedPayload(recordID: recordID, reason: "Reviewing import")
        ))
        let restore = fixture.event(4, id: 913, payload: .recordRestored(
            RecordRestoredPayload(recordID: recordID)
        ))

        let revised = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [initial, revision]
        )
        let voided = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [initial, revision, void]
        )
        let restored = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [initial, revision, void, restore]
        )

        XCTAssertEqual(revised.projection.balances[fixture.sam]?.minorUnits, 200)
        XCTAssertEqual(voided.projection.balances[fixture.sam]?.minorUnits, 0)
        XCTAssertEqual(restored.projection.balances[fixture.sam]?.minorUnits, 200)
        XCTAssertEqual(restored.projection.spend.minorUnits, 0)
        guard case let .revisable(record)? = restored.projection.records[recordID] else {
            return XCTFail("Expected opening balance record")
        }
        XCTAssertEqual(record.revisions.count, 2)
        XCTAssertFalse(record.isVoided)
    }

    func testSettlementPlannerHandlesExtremeZeroSumWithoutOrderOverflow() throws {
        let fixture = try CoreFixture()
        let balances = [
            fixture.am: Money(minorUnits: Int64.min, currency: .eur),
            fixture.sam: Money(minorUnits: Int64.max, currency: .eur),
            fixture.leo: Money(minorUnits: 1, currency: .eur),
        ]

        let plan = try SettlementPlanner.plan(balances: balances)

        XCTAssertEqual(plan.count, 2)
        XCTAssertEqual(
            plan.reduce(Decimal.zero) { $0 + Decimal($1.amount.minorUnits) },
            Decimal(Int64.max) + 1
        )
    }

    private func settlementPlannerCounterexample(
        fixture: CoreFixture
    ) -> [UnitID: Money] {
        let fourth = UnitID(unchecked: testUUID(13))
        let fifth = UnitID(unchecked: testUUID(14))
        return [
            fixture.am: Money(minorUnits: -8, currency: .eur),
            fixture.sam: Money(minorUnits: -7, currency: .eur),
            fixture.leo: Money(minorUnits: -5, currency: .eur),
            fourth: Money(minorUnits: 12, currency: .eur),
            fifth: Money(minorUnits: 8, currency: .eur),
        ]
    }

    private func settlementPlanningError(
        for balances: [UnitID: Money],
        limits: SettlementPlanningLimits
    ) -> SettlementPlanningError? {
        do {
            _ = try SettlementPlanner.plan(balances: balances, limits: limits)
            return nil
        } catch {
            return error
        }
    }
}
