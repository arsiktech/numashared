import XCTest
@testable import NumaSharedCore

final class StructuralReducerTests: XCTestCase {
    func testGroupingMembersProjectsExistingDebtAsOneGroupBalance() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(200))
        let groupID = GroupID(unchecked: testUUID(201))
        let groupUnit = UnitID(unchecked: testUUID(202))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let expense = fixture.event(1, id: 1_200, payload: .expenseAdded(fixture.expense(
            recordID: RecordID(unchecked: testUUID(203)),
            title: "Before grouping",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let group = fixture.event(2, id: 1_201, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))

        let result = LedgerReducer().reduce(pot: pot, events: [group, expense])

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, 0)
        XCTAssertEqual(result.projection.settlementPlan, .exact([]))
    }

    func testGroupedPersonalDebtDoesNotMakeShadowedUnitSettlementEligible() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(210))
        let groupID = GroupID(unchecked: testUUID(211))
        let groupUnit = UnitID(unchecked: testUUID(212))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let expense = fixture.event(1, id: 1_210, payload: .expenseAdded(fixture.expense(
            recordID: RecordID(unchecked: testUUID(213)),
            title: "Before grouping",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let group = fixture.event(2, id: 1_211, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let forbiddenSettlement = fixture.event(3, id: 1_212, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(214)),
                title: "Forbidden internal settlement",
                amount: 100,
                from: fixture.sam,
                to: fixture.am
            )
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [forbiddenSettlement, group, expense]
        )

        assertInvalid(
            result,
            eventID: forbiddenSettlement.id,
            reason: .inactiveUnit(fixture.sam)
        )
        XCTAssertEqual(result.projection.appliedEventIDs, [expense.id, group.id])
        XCTAssertEqual(result.projection.settlementPlan, .exact([]))
    }

    func testMovingMemberReprojectsHistoricalPersonalBalanceIntoDestinationGroup() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(220))
        let leo = MemberID(unchecked: testUUID(221))
        let firstGroup = SettlementGroupSnapshot(
            groupID: GroupID(unchecked: testUUID(222)),
            unitID: UnitID(unchecked: testUUID(223)),
            orderedMemberIDs: [fixture.actorID, maya],
            defaultShareWeight: 2
        )
        let secondGroup = SettlementGroupSnapshot(
            groupID: GroupID(unchecked: testUUID(224)),
            unitID: UnitID(unchecked: testUUID(225)),
            orderedMemberIDs: [maya, leo],
            defaultShareWeight: 2
        )
        let pot = try potWithActor(fixture, additionalMember: maya)
        let addLeo = fixture.event(1, id: 1_220, payload: .memberAdded(
            MemberAddedPayload(memberID: leo, unitID: fixture.leo, role: .member)
        ))
        let expense = fixture.event(2, id: 1_221, payload: .expenseAdded(fixture.expense(
            recordID: RecordID(unchecked: testUUID(226)),
            title: "Before moving",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let groupTogether = fixture.event(3, id: 1_222, payload: .groupChanged(
            GroupChangedPayload(groups: [firstGroup])
        ))
        let moveMaya = fixture.event(4, id: 1_223, payload: .groupChanged(
            GroupChangedPayload(groups: [secondGroup])
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [moveMaya, expense, groupTogether, addLeo]
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 100)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[firstGroup.unitID]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[secondGroup.unitID]?.minorUnits, -100)
        XCTAssertEqual(result.projection.settlementPlan, .exact([
            SettlementTransfer(
                fromUnitID: secondGroup.unitID,
                toUnitID: fixture.am,
                amount: Money(minorUnits: 100, currency: .eur)
            ),
        ]))
    }

    func testDissolvingGroupRestoresPersonalHistoryAndKeepsGroupBalanceSettleable() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(230))
        let groupUnit = UnitID(unchecked: testUUID(231))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let personalExpense = fixture.event(1, id: 1_230, payload: .expenseAdded(
            fixture.expense(
                recordID: RecordID(unchecked: testUUID(232)),
                title: "Personal history",
                amount: 100,
                payer: fixture.am,
                allocations: [(fixture.sam, 100)]
            )
        ))
        let group = fixture.event(2, id: 1_231, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(233)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let groupExpense = fixture.event(3, id: 1_232, payload: .expenseAdded(
            fixture.expense(
                recordID: RecordID(unchecked: testUUID(234)),
                title: "Group history",
                amount: 60,
                payer: groupUnit,
                allocations: [(fixture.leo, 60)]
            )
        ))
        let dissolve = fixture.event(4, id: 1_233, payload: .groupChanged(
            GroupChangedPayload(groups: [])
        ))
        let settleHistoricalGroup = fixture.event(5, id: 1_234, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(235)),
                title: "Settle retired group",
                amount: 60,
                from: fixture.leo,
                to: groupUnit
            )
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [settleHistoricalGroup, dissolve, groupExpense, group, personalExpense]
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 100)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, -100)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, 0)
        XCTAssertEqual(result.projection.settlementPlan, .exact([
            SettlementTransfer(
                fromUnitID: fixture.sam,
                toUnitID: fixture.am,
                amount: Money(minorUnits: 100, currency: .eur)
            ),
        ]))
    }

    func testHistoricalCorrectionsDoNotReintroduceDebtInsideCurrentGroup() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(240))
        let groupUnit = UnitID(unchecked: testUUID(241))
        let recordID = RecordID(unchecked: testUUID(242))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let originalPayload = fixture.expense(
            recordID: recordID,
            title: "Original",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )
        let original = fixture.event(1, id: 1_240, payload: .expenseAdded(originalPayload))
        let group = fixture.event(2, id: 1_241, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(243)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let revisedContent = ExpenseContent(
            kind: .shared,
            title: "Revised",
            amount: Money(minorUnits: 150, currency: .eur),
            payerUnitID: fixture.am,
            allocations: [ExpenseAllocation(
                unitID: fixture.sam,
                amount: Money(minorUnits: 150, currency: .eur)
            )]
        )
        let revise = fixture.event(3, id: 1_242, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(original.id),
                content: .expense(revisedContent)
            )
        ))
        let void = fixture.event(4, id: 1_243, payload: .recordVoided(
            RecordVoidedPayload(recordID: recordID, reason: "Duplicate")
        ))
        let restore = fixture.event(5, id: 1_244, payload: .recordRestored(
            RecordRestoredPayload(recordID: recordID)
        ))

        let revised = LedgerReducer().reduce(pot: pot, events: [revise, group, original])
        let voided = LedgerReducer().reduce(pot: pot, events: [void, revise, group, original])
        let restored = LedgerReducer().reduce(
            pot: pot,
            events: [restore, void, revise, group, original]
        )

        for result in [revised, voided, restored] {
            XCTAssertEqual(result.access, .readWrite)
            XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 0)
            XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 0)
            XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, 0)
            XCTAssertEqual(result.projection.settlementPlan, .exact([]))
        }
    }

    func testContestedResolutionMayReuseUnitsFromEitherHistoricalHead() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(350))
        let groupUnit = UnitID(unchecked: testUUID(351))
        let recordID = RecordID(unchecked: testUUID(352))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let original = fixture.event(1, id: 1_350, payload: .expenseAdded(fixture.expense(
            recordID: recordID,
            title: "Original",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let group = fixture.event(2, id: 1_351, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(353)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let personalContent = ExpenseContent(
            kind: .shared,
            title: "Personal-unit head",
            amount: Money(minorUnits: 150, currency: .eur),
            payerUnitID: fixture.am,
            allocations: [ExpenseAllocation(
                unitID: fixture.sam,
                amount: Money(minorUnits: 150, currency: .eur)
            )]
        )
        let personalHead = fixture.event(3, id: 1_352, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(original.id),
                content: .expense(personalContent)
            )
        ))
        let groupContent = ExpenseContent(
            kind: .shared,
            title: "Group-unit head",
            amount: Money(minorUnits: 60, currency: .eur),
            payerUnitID: groupUnit,
            allocations: [ExpenseAllocation(
                unitID: fixture.leo,
                amount: Money(minorUnits: 60, currency: .eur)
            )]
        )
        let groupHead = fixture.event(4, id: 1_353, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(original.id),
                content: .expense(groupContent)
            )
        ))
        let resolution = fixture.event(5, id: 1_354, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(try RevisionPair(personalHead.id, groupHead.id)),
                content: .expense(personalContent)
            )
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [resolution, groupHead, personalHead, group, original]
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(
            result.projection.appliedEventIDs,
            [original.id, group.id, personalHead.id, groupHead.id, resolution.id]
        )
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, 0)
        XCTAssertEqual(result.projection.settlementPlan, .exact([]))
    }

    func testArchivedMemberKeepsIndividualUnresolvedBalanceOutsideCurrentGroup() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(250))
        let groupUnit = UnitID(unchecked: testUUID(251))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let expense = fixture.event(1, id: 1_250, payload: .expenseAdded(fixture.expense(
            recordID: RecordID(unchecked: testUUID(252)),
            title: "Before departure",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let group = fixture.event(2, id: 1_251, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(253)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let transfer = fixture.event(3, id: 1_252, payload: .ownershipTransferred(
            OwnershipTransferredPayload(fromMemberID: fixture.actorID, toMemberID: maya)
        ))
        let archive = fixture.event(4, id: 1_253, payload: .memberArchived(
            MemberArchivedPayload(memberID: fixture.actorID)
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [archive, transfer, group, expense]
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 100)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, -100)
        XCTAssertEqual(
            result.projection.structure.members[fixture.actorID]?.unitID,
            fixture.am
        )
        XCTAssertEqual(
            result.projection.structure.groups.first?.orderedMemberIDs,
            [maya]
        )
        XCTAssertEqual(result.projection.settlementPlan, .exact([
            SettlementTransfer(
                fromUnitID: groupUnit,
                toUnitID: fixture.am,
                amount: Money(minorUnits: 100, currency: .eur)
            ),
        ]))
        XCTAssertNoThrow(try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: result.projection.structure
        ))
    }

    func testGroupChangeRejectsArchivedMember() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(260))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let transfer = fixture.event(1, id: 1_260, payload: .ownershipTransferred(
            OwnershipTransferredPayload(fromMemberID: fixture.actorID, toMemberID: maya)
        ))
        let archive = fixture.event(2, id: 1_261, payload: .memberArchived(
            MemberArchivedPayload(memberID: fixture.actorID)
        ))
        let regroup = fixture.event(3, id: 1_262, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(261)),
                    unitID: UnitID(unchecked: testUUID(262)),
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [regroup, archive, transfer]
        )

        assertInvalid(
            result,
            eventID: regroup.id,
            reason: .archivedGroupMember(fixture.actorID)
        )
        XCTAssertTrue(result.projection.structure.groups.isEmpty)
    }

    func testGroupIdentityCannotSwitchSettlementUnit() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(270))
        let groupID = GroupID(unchecked: testUUID(271))
        let firstUnit = UnitID(unchecked: testUUID(272))
        let secondUnit = UnitID(unchecked: testUUID(273))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let firstGroup = SettlementGroupSnapshot(
            groupID: groupID,
            unitID: firstUnit,
            orderedMemberIDs: [fixture.actorID, maya],
            defaultShareWeight: 2
        )
        let reboundGroup = SettlementGroupSnapshot(
            groupID: groupID,
            unitID: secondUnit,
            orderedMemberIDs: [fixture.actorID, maya],
            defaultShareWeight: 2
        )
        let create = fixture.event(1, id: 1_270, payload: .groupChanged(
            GroupChangedPayload(groups: [firstGroup])
        ))
        let rebound = fixture.event(2, id: 1_271, payload: .groupChanged(
            GroupChangedPayload(groups: [reboundGroup])
        ))

        let result = LedgerReducer().reduce(pot: pot, events: [rebound, create])

        assertInvalid(
            result,
            eventID: rebound.id,
            reason: .groupIdentityRebound(
                groupID: groupID,
                expectedUnitID: firstUnit,
                actualUnitID: secondUnit
            )
        )
        XCTAssertEqual(result.projection.structure.groups, [firstGroup])
        XCTAssertFalse(result.projection.structure.knownUnitIDs.contains(secondUnit))
    }

    func testRetiredGroupUnitCannotBeReassignedToDifferentGroup() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(280))
        let originalGroupID = GroupID(unchecked: testUUID(281))
        let attemptedGroupID = GroupID(unchecked: testUUID(282))
        let groupUnit = UnitID(unchecked: testUUID(283))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let originalGroup = SettlementGroupSnapshot(
            groupID: originalGroupID,
            unitID: groupUnit,
            orderedMemberIDs: [fixture.actorID, maya],
            defaultShareWeight: 2
        )
        let attemptedGroup = SettlementGroupSnapshot(
            groupID: attemptedGroupID,
            unitID: groupUnit,
            orderedMemberIDs: [fixture.actorID, maya],
            defaultShareWeight: 2
        )
        let create = fixture.event(1, id: 1_280, payload: .groupChanged(
            GroupChangedPayload(groups: [originalGroup])
        ))
        let dissolve = fixture.event(2, id: 1_281, payload: .groupChanged(
            GroupChangedPayload(groups: [])
        ))
        let reassign = fixture.event(3, id: 1_282, payload: .groupChanged(
            GroupChangedPayload(groups: [attemptedGroup])
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [reassign, dissolve, create]
        )

        assertInvalid(
            result,
            eventID: reassign.id,
            reason: .groupUnitReassigned(
                unitID: groupUnit,
                existingGroupID: originalGroupID,
                attemptedGroupID: attemptedGroupID
            )
        )
        XCTAssertTrue(result.projection.structure.groups.isEmpty)
        XCTAssertEqual(
            result.projection.structure.groupUnitIDsByGroupID,
            [originalGroupID: groupUnit]
        )
    }

    func testNewGroupCannotReuseExistingNonGroupUnit() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(290))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let group = fixture.event(1, id: 1_290, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(291)),
                    unitID: fixture.leo,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))

        let result = LedgerReducer().reduce(pot: pot, events: [group])

        assertInvalid(
            result,
            eventID: group.id,
            reason: .knownUnitReusedAsGroup(fixture.leo)
        )
        XCTAssertTrue(result.projection.structure.groups.isEmpty)
    }

    func testGroupChangeProjectionOverflowRollsBackToLastValidState() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(300))
        let groupUnit = UnitID(unchecked: testUUID(301))
        let recordID = RecordID(unchecked: testUUID(302))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let opening = fixture.event(1, id: 1_300, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: recordID,
                content: OpeningBalanceContent(
                    title: "Extreme import",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: .max, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 1, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: .min, currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let group = fixture.event(2, id: 1_301, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(303)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))

        let result = LedgerReducer().reduce(pot: pot, events: [group, opening])

        assertInvalid(result, eventID: group.id, reason: .arithmeticOverflow)
        XCTAssertEqual(result.projection.appliedEventIDs, [opening.id])
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, .max)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 1)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, .min)
        XCTAssertFalse(result.projection.structure.knownUnitIDs.contains(groupUnit))
        XCTAssertTrue(result.projection.structure.groups.isEmpty)
    }

    func testHistoricalRevisionProjectionOverflowRollsBackToLastValidState() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(310))
        let groupUnit = UnitID(unchecked: testUUID(311))
        let recordID = RecordID(unchecked: testUUID(312))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let initialContent = OpeningBalanceContent(
            title: "Extreme import",
            entries: [
                OpeningBalanceEntry(
                    unitID: fixture.am,
                    amount: Money(minorUnits: Int64.max - 1, currency: .eur)
                ),
                OpeningBalanceEntry(
                    unitID: fixture.sam,
                    amount: Money(minorUnits: 1, currency: .eur)
                ),
                OpeningBalanceEntry(
                    unitID: fixture.leo,
                    amount: Money(minorUnits: -Int64.max, currency: .eur)
                ),
            ]
        )
        let opening = fixture.event(1, id: 1_310, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(recordID: recordID, content: initialContent)
        ))
        let group = fixture.event(2, id: 1_311, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(313)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let overflowingContent = OpeningBalanceContent(
            title: "Overflowing correction",
            entries: [
                OpeningBalanceEntry(
                    unitID: fixture.am,
                    amount: Money(minorUnits: .max, currency: .eur)
                ),
                OpeningBalanceEntry(
                    unitID: fixture.sam,
                    amount: Money(minorUnits: 1, currency: .eur)
                ),
                OpeningBalanceEntry(
                    unitID: fixture.leo,
                    amount: Money(minorUnits: .min, currency: .eur)
                ),
            ]
        )
        let revision = fixture.event(3, id: 1_312, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(opening.id),
                content: .openingBalance(overflowingContent)
            )
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [revision, group, opening]
        )

        assertInvalid(result, eventID: revision.id, reason: .arithmeticOverflow)
        XCTAssertEqual(result.projection.appliedEventIDs, [opening.id, group.id])
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, .max)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -Int64.max)
        guard case let .revisable(record)? = result.projection.records[recordID] else {
            return XCTFail("Expected last-valid opening balance")
        }
        XCTAssertEqual(record.currentContent, .openingBalance(initialContent))
    }

    func testSettlementProjectionOverflowRollsBackToLastValidState() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(320))
        let groupUnit = UnitID(unchecked: testUUID(321))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let opening = fixture.event(1, id: 1_320, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: RecordID(unchecked: testUUID(322)),
                content: OpeningBalanceContent(
                    title: "Extreme import",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: Int64.max - 1, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 1, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: -Int64.max, currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let group = fixture.event(2, id: 1_321, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(323)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let settlement = fixture.event(3, id: 1_322, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(324)),
                title: "Overflowing overpayment",
                amount: 1,
                from: groupUnit,
                to: fixture.leo
            )
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [settlement, group, opening]
        )

        assertInvalid(result, eventID: settlement.id, reason: .arithmeticOverflow)
        XCTAssertEqual(result.projection.appliedEventIDs, [opening.id, group.id])
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, .max)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -Int64.max)
        XCTAssertNil(result.projection.records[RecordID(unchecked: testUUID(324))])
    }

    func testVoidProjectionOverflowRollsBackToUnvoidedRecord() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(360))
        let groupUnit = UnitID(unchecked: testUUID(361))
        let extremeRecordID = RecordID(unchecked: testUUID(362))
        let bufferRecordID = RecordID(unchecked: testUUID(363))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let extreme = fixture.event(1, id: 1_360, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: extremeRecordID,
                content: OpeningBalanceContent(
                    title: "Extreme import",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: .max, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 1, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: .min, currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let buffer = fixture.event(2, id: 1_361, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: bufferRecordID,
                content: OpeningBalanceContent(
                    title: "Projection buffer",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: -1, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: 1, currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let group = fixture.event(3, id: 1_362, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(364)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let void = fixture.event(4, id: 1_363, payload: .recordVoided(
            RecordVoidedPayload(recordID: bufferRecordID, reason: "Duplicate import")
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [void, group, buffer, extreme]
        )

        assertInvalid(result, eventID: void.id, reason: .arithmeticOverflow)
        XCTAssertEqual(
            result.projection.appliedEventIDs,
            [extreme.id, buffer.id, group.id]
        )
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, .max)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -Int64.max)
        guard case let .revisable(record)? = result.projection.records[bufferRecordID] else {
            return XCTFail("Expected last-valid projection buffer")
        }
        XCTAssertFalse(record.isVoided)
    }

    func testRestoreProjectionOverflowRollsBackToVoidedRecord() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(370))
        let groupUnit = UnitID(unchecked: testUUID(371))
        let recordID = RecordID(unchecked: testUUID(372))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let opening = fixture.event(1, id: 1_370, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: recordID,
                content: OpeningBalanceContent(
                    title: "Extreme import",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: .max, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 1, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: .min, currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let void = fixture.event(2, id: 1_371, payload: .recordVoided(
            RecordVoidedPayload(recordID: recordID, reason: "Review before grouping")
        ))
        let group = fixture.event(3, id: 1_372, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(373)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let restore = fixture.event(4, id: 1_373, payload: .recordRestored(
            RecordRestoredPayload(recordID: recordID)
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [restore, group, void, opening]
        )

        assertInvalid(result, eventID: restore.id, reason: .arithmeticOverflow)
        XCTAssertEqual(
            result.projection.appliedEventIDs,
            [opening.id, void.id, group.id]
        )
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, 0)
        guard case let .revisable(record)? = result.projection.records[recordID] else {
            return XCTFail("Expected last-valid voided opening balance")
        }
        XCTAssertTrue(record.isVoided)
    }

    func testArchiveProjectionOverflowRollsBackToLastValidState() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(330))
        let groupUnit = UnitID(unchecked: testUUID(331))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let opening = fixture.event(1, id: 1_330, payload: .openingBalanceSet(
            OpeningBalanceSetPayload(
                recordID: RecordID(unchecked: testUUID(332)),
                content: OpeningBalanceContent(
                    title: "Extreme import",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: -1, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: .max, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: -(Int64.max - 1), currency: .eur)
                        ),
                    ]
                )
            )
        ))
        let group = fixture.event(2, id: 1_331, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: GroupID(unchecked: testUUID(333)),
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let groupOverpayment = fixture.event(3, id: 1_332, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(334)),
                title: "Shift one unit into group",
                amount: 1,
                from: groupUnit,
                to: fixture.leo
            )
        ))
        let transfer = fixture.event(4, id: 1_333, payload: .ownershipTransferred(
            OwnershipTransferredPayload(fromMemberID: fixture.actorID, toMemberID: maya)
        ))
        let archive = fixture.event(5, id: 1_334, payload: .memberArchived(
            MemberArchivedPayload(memberID: fixture.actorID)
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [archive, transfer, groupOverpayment, group, opening]
        )

        assertInvalid(result, eventID: archive.id, reason: .arithmeticOverflow)
        XCTAssertEqual(
            result.projection.appliedEventIDs,
            [opening.id, group.id, groupOverpayment.id, transfer.id]
        )
        XCTAssertFalse(
            result.projection.structure.archivedMemberIDs.contains(fixture.actorID)
        )
        XCTAssertEqual(result.projection.balances[fixture.am]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, 0)
        XCTAssertEqual(result.projection.balances[groupUnit]?.minorUnits, .max)
        XCTAssertEqual(result.projection.balances[fixture.leo]?.minorUnits, -Int64.max)
    }

    func testStructuralEventsFoldInSequenceAndEnableLaterFinancialUnits() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(80))
        let mayaUnit = UnitID(unchecked: testUUID(81))
        let groupID = GroupID(unchecked: testUUID(82))
        let householdUnit = UnitID(unchecked: testUUID(83))
        let topology = StructuralProjection(
            members: [
                fixture.actorID: MemberTopology(
                    personalUnitID: fixture.am,
                    unitID: fixture.am,
                    role: .owner
                ),
            ],
            claimedMemberIDs: [fixture.actorID],
            archivedMemberIDs: [],
            groups: [],
            presets: [],
            knownUnitIDs: [fixture.am, fixture.sam, fixture.leo]
        )
        let pot = try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: topology
        )
        let addMaya = fixture.event(1, id: 1_000, payload: .memberAdded(
            MemberAddedPayload(memberID: maya, unitID: mayaUnit, role: .member)
        ))
        let claimMaya = fixture.event(2, id: 1_001, payload: .memberClaimed(
            MemberClaimedPayload(memberID: maya)
        ))
        let group = SettlementGroupSnapshot(
            groupID: groupID,
            unitID: householdUnit,
            orderedMemberIDs: [fixture.actorID, maya],
            defaultShareWeight: 2
        )
        let changeGroup = fixture.event(3, id: 1_002, payload: .groupChanged(
            GroupChangedPayload(groups: [group])
        ))
        let expense = fixture.event(4, id: 1_003, payload: .expenseAdded(
            fixture.expense(
                recordID: RecordID(unchecked: testUUID(84)),
                title: "Group groceries",
                amount: 100,
                payer: householdUnit,
                allocations: [(fixture.sam, 100)]
            )
        ))
        let preset = fixture.event(5, id: 1_004, payload: .presetChanged(
            PresetChangedPayload(
                name: "Everyone",
                orderedUnitIDs: [householdUnit, fixture.sam, fixture.leo]
            )
        ))
        let transfer = fixture.event(6, id: 1_005, payload: .ownershipTransferred(
            OwnershipTransferredPayload(fromMemberID: fixture.actorID, toMemberID: maya)
        ))
        let archive = fixture.event(7, id: 1_006, payload: .memberArchived(
            MemberArchivedPayload(memberID: fixture.actorID)
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [archive, expense, addMaya, transfer, changeGroup, preset, claimMaya]
        )

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.balances[householdUnit]?.minorUnits, 100)
        XCTAssertEqual(result.projection.balances[fixture.sam]?.minorUnits, -100)
        XCTAssertEqual(result.projection.structure.members[fixture.actorID]?.unitID, fixture.am)
        XCTAssertEqual(result.projection.structure.members[fixture.actorID]?.role, .member)
        XCTAssertEqual(result.projection.structure.members[maya]?.unitID, householdUnit)
        XCTAssertEqual(result.projection.structure.members[maya]?.role, .owner)
        XCTAssertEqual(
            result.projection.structure.claimedMemberIDs,
            [fixture.actorID, maya].sorted()
        )
        XCTAssertEqual(result.projection.structure.archivedMemberIDs, [fixture.actorID])
        XCTAssertEqual(result.projection.structure.groups, [SettlementGroupSnapshot(
            groupID: groupID,
            unitID: householdUnit,
            orderedMemberIDs: [maya],
            defaultShareWeight: 2
        )])
        XCTAssertEqual(
            result.projection.structure.presets,
            [ParticipantPresetSnapshot(
                name: "Everyone",
                orderedUnitIDs: [householdUnit, fixture.sam, fixture.leo]
            )]
        )
        XCTAssertEqual(
            result.projection.structure.knownUnitIDs,
            [fixture.am, fixture.sam, fixture.leo, mayaUnit, householdUnit]
        )
        XCTAssertEqual(
            try JSONDecoder().decode(
                StructuralProjection.self,
                from: JSONEncoder().encode(result.projection.structure)
            ),
            result.projection.structure
        )
    }

    func testStructuralProjectionDecodesLegacyGroupRegistryFromCurrentGroups() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(340))
        let groupID = GroupID(unchecked: testUUID(341))
        let groupUnit = UnitID(unchecked: testUUID(342))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let group = fixture.event(1, id: 1_340, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let projection = LedgerReducer().reduce(
            pot: pot,
            events: [group]
        ).projection.structure
        let encoded = try JSONEncoder().encode(projection)
        guard var legacyObject = try JSONSerialization.jsonObject(with: encoded)
            as? [String: Any] else {
            return XCTFail("Expected a structural projection object")
        }
        legacyObject.removeValue(forKey: "groupUnitIDsByGroupID")
        let legacyData = try JSONSerialization.data(withJSONObject: legacyObject)

        let decoded = try JSONDecoder().decode(
            StructuralProjection.self,
            from: legacyData
        )

        XCTAssertEqual(decoded.groupUnitIDsByGroupID, [groupID: groupUnit])
        XCTAssertEqual(decoded.groups, projection.groups)
        XCTAssertEqual(decoded.knownUnitIDs, projection.knownUnitIDs)
        XCTAssertEqual(decoded.activeUnitIDs, projection.activeUnitIDs)
    }

    func testRetiredGroupRegistrySurvivesRoundTripAndStillProtectsIdentity() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(380))
        let groupID = GroupID(unchecked: testUUID(381))
        let groupUnit = UnitID(unchecked: testUUID(382))
        let replacementGroupID = GroupID(unchecked: testUUID(383))
        let replacementUnit = UnitID(unchecked: testUUID(384))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let group = fixture.event(1, id: 1_380, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let dissolve = fixture.event(2, id: 1_381, payload: .groupChanged(
            GroupChangedPayload(groups: [])
        ))
        let retired = LedgerReducer().reduce(
            pot: pot,
            events: [dissolve, group]
        ).projection.structure
        let decoded = try JSONDecoder().decode(
            StructuralProjection.self,
            from: JSONEncoder().encode(retired)
        )
        let reconstructedPot = try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: decoded
        )
        let rebound = fixture.event(1, id: 1_382, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: replacementUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let reassigned = fixture.event(1, id: 1_383, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: replacementGroupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))

        XCTAssertTrue(decoded.groups.isEmpty)
        XCTAssertEqual(decoded.groupUnitIDsByGroupID, [groupID: groupUnit])
        assertInvalid(
            LedgerReducer().reduce(pot: reconstructedPot, events: [rebound]),
            eventID: rebound.id,
            reason: .groupIdentityRebound(
                groupID: groupID,
                expectedUnitID: groupUnit,
                actualUnitID: replacementUnit
            )
        )
        assertInvalid(
            LedgerReducer().reduce(pot: reconstructedPot, events: [reassigned]),
            eventID: reassigned.id,
            reason: .groupUnitReassigned(
                unitID: groupUnit,
                existingGroupID: groupID,
                attemptedGroupID: replacementGroupID
            )
        )
    }

    func testFinancialEventCannotUseAUnitBeforeItsStructuralEvent() throws {
        let fixture = try CoreFixture()
        let futureMember = MemberID(unchecked: testUUID(90))
        let futureUnit = UnitID(unchecked: testUUID(91))
        let expense = fixture.event(1, id: 1_100, payload: .expenseAdded(
            fixture.expense(
                recordID: RecordID(unchecked: testUUID(92)),
                title: "Too early",
                amount: 100,
                payer: fixture.am,
                allocations: [(futureUnit, 100)]
            )
        ))
        let addMember = fixture.event(2, id: 1_101, payload: .memberAdded(
            MemberAddedPayload(
                memberID: futureMember,
                unitID: futureUnit,
                role: .member
            )
        ))

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [addMember, expense]
        )

        XCTAssertEqual(result.access, .readOnly(.invalidEvent(
            eventID: expense.id,
            reason: .unknownUnit(futureUnit)
        )))
        XCTAssertTrue(result.projection.appliedEventIDs.isEmpty)
        XCTAssertNil(result.projection.structure.members[futureMember])
        XCTAssertFalse(result.projection.structure.knownUnitIDs.contains(futureUnit))
    }

    func testGroupedMemberPersonalUnitIsHistoricalButCannotReceiveANewExpense() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(103))
        let groupID = GroupID(unchecked: testUUID(104))
        let groupUnit = UnitID(unchecked: testUUID(105))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let group = fixture.event(1, id: 1_150, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let expenseRecordID = RecordID(unchecked: testUUID(106))
        let expense = fixture.event(2, id: 1_151, payload: .expenseAdded(fixture.expense(
            recordID: expenseRecordID,
            title: "Invalid personal-unit expense",
            amount: 100,
            payer: fixture.am,
            allocations: [(groupUnit, 100)]
        )))

        let result = LedgerReducer().reduce(pot: pot, events: [expense, group])

        assertInvalid(
            result,
            eventID: expense.id,
            reason: .inactiveUnit(fixture.am)
        )
        XCTAssertEqual(result.projection.appliedEventIDs, [group.id])
        XCTAssertTrue(result.projection.structure.knownUnitIDs.contains(fixture.am))
        XCTAssertFalse(result.projection.structure.activeUnitIDs.contains(fixture.am))
        XCTAssertNil(result.projection.records[expenseRecordID])
    }

    func testDissolvedGroupUnitIsHistoricalButCannotReceiveANewExpense() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(107))
        let groupID = GroupID(unchecked: testUUID(108))
        let groupUnit = UnitID(unchecked: testUUID(109))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let group = fixture.event(1, id: 1_152, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let dissolve = fixture.event(2, id: 1_153, payload: .groupChanged(
            GroupChangedPayload(groups: [])
        ))
        let expense = fixture.event(3, id: 1_154, payload: .expenseAdded(fixture.expense(
            recordID: RecordID(unchecked: testUUID(110)),
            title: "Invalid dissolved-group expense",
            amount: 100,
            payer: groupUnit,
            allocations: [(fixture.am, 100)]
        )))

        let result = LedgerReducer().reduce(pot: pot, events: [expense, dissolve, group])

        assertInvalid(
            result,
            eventID: expense.id,
            reason: .inactiveUnit(groupUnit)
        )
        XCTAssertEqual(result.projection.appliedEventIDs, [group.id, dissolve.id])
        XCTAssertTrue(result.projection.structure.knownUnitIDs.contains(groupUnit))
        XCTAssertFalse(result.projection.structure.activeUnitIDs.contains(groupUnit))
    }

    func testDissolvedZeroBalanceGroupCannotBeUsedForANewSettlement() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(111))
        let groupID = GroupID(unchecked: testUUID(112))
        let groupUnit = UnitID(unchecked: testUUID(113))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let group = fixture.event(1, id: 1_155, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let dissolve = fixture.event(2, id: 1_156, payload: .groupChanged(
            GroupChangedPayload(groups: [])
        ))
        let settlement = fixture.event(3, id: 1_157, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(114)),
                title: "Invalid dissolved-group settlement",
                amount: 1,
                from: groupUnit,
                to: fixture.am
            )
        ))

        let result = LedgerReducer().reduce(
            pot: pot,
            events: [settlement, dissolve, group]
        )

        assertInvalid(
            result,
            eventID: settlement.id,
            reason: .inactiveUnit(groupUnit)
        )
    }

    func testArchivedMemberCannotReceiveNewExpenseButCanSettleOutstandingBalance() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(115))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let original = fixture.event(1, id: 1_158, payload: .expenseAdded(fixture.expense(
            recordID: RecordID(unchecked: testUUID(116)),
            title: "Before archive",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let archive = fixture.event(2, id: 1_159, payload: .memberArchived(
            MemberArchivedPayload(memberID: maya)
        ))
        let laterExpense = fixture.event(3, id: 1_160, payload: .expenseAdded(fixture.expense(
            recordID: RecordID(unchecked: testUUID(117)),
            title: "After archive",
            amount: 50,
            payer: fixture.am,
            allocations: [(fixture.sam, 50)]
        )))
        let settlement = fixture.event(3, id: 1_161, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(118)),
                title: "Archived balance settled elsewhere",
                amount: 100,
                from: fixture.sam,
                to: fixture.am
            )
        ))

        let invalidExpense = LedgerReducer().reduce(
            pot: pot,
            events: [laterExpense, archive, original]
        )
        let settled = LedgerReducer().reduce(
            pot: pot,
            events: [settlement, archive, original]
        )

        assertInvalid(
            invalidExpense,
            eventID: laterExpense.id,
            reason: .inactiveUnit(fixture.sam)
        )
        XCTAssertEqual(settled.access, .readWrite)
        XCTAssertFalse(settled.projection.structure.activeUnitIDs.contains(fixture.sam))
        XCTAssertEqual(settled.projection.balances[fixture.am]?.minorUnits, 0)
        XCTAssertEqual(settled.projection.balances[fixture.sam]?.minorUnits, 0)
    }

    func testRevisionMayPreserveItsHistoricalUnitsButCannotIntroduceAnotherInactiveUnit() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(123))
        let groupID = GroupID(unchecked: testUUID(124))
        let groupUnit = UnitID(unchecked: testUUID(125))
        let recordID = RecordID(unchecked: testUUID(126))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let initialPayload = fixture.expense(
            recordID: recordID,
            title: "Original",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )
        let initial = fixture.event(1, id: 1_166, payload: .expenseAdded(initialPayload))
        let group = fixture.event(2, id: 1_167, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let preservedContent = ExpenseContent(
            kind: initialPayload.content.kind,
            title: "Title changed after grouping",
            amount: initialPayload.content.amount,
            payerUnitID: initialPayload.content.payerUnitID,
            allocations: initialPayload.content.allocations
        )
        let preserve = fixture.event(3, id: 1_168, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(preservedContent)
            )
        ))
        let dissolve = fixture.event(3, id: 1_169, payload: .groupChanged(
            GroupChangedPayload(groups: [])
        ))
        let unrelatedContent = fixture.expense(
            recordID: recordID,
            title: "Introduces a retired group",
            amount: 100,
            payer: fixture.am,
            allocations: [(groupUnit, 100)]
        ).content
        let introduceUnrelated = fixture.event(4, id: 1_170, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(unrelatedContent)
            )
        ))

        let preserved = LedgerReducer().reduce(
            pot: pot,
            events: [preserve, group, initial]
        )
        let rejected = LedgerReducer().reduce(
            pot: pot,
            events: [introduceUnrelated, dissolve, group, initial]
        )

        XCTAssertEqual(preserved.access, .readWrite)
        guard case let .revisable(record)? = preserved.projection.records[recordID] else {
            return XCTFail("Expected the revised historical expense")
        }
        XCTAssertEqual(record.currentContent, .expense(preservedContent))
        assertInvalid(
            rejected,
            eventID: introduceUnrelated.id,
            reason: .inactiveUnit(groupUnit)
        )
    }

    func testMemberLifecycleCorruptionHasExplicitDeterministicReasons() throws {
        let fixture = try CoreFixture()
        let pot = try potWithActor(fixture)
        let unknown = MemberID(unchecked: testUUID(93))
        let duplicate = fixture.event(1, id: 1_110, payload: .memberAdded(
            MemberAddedPayload(
                memberID: fixture.actorID,
                unitID: fixture.am,
                role: .owner
            )
        ))
        let claimUnknown = fixture.event(1, id: 1_111, payload: .memberClaimed(
            MemberClaimedPayload(memberID: unknown)
        ))
        let reassignUnknown = fixture.event(1, id: 1_112, payload: .memberClaimReassigned(
            MemberClaimReassignedPayload(memberID: unknown)
        ))
        let archiveUnknown = fixture.event(1, id: 1_113, payload: .memberArchived(
            MemberArchivedPayload(memberID: unknown)
        ))

        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [duplicate]),
            eventID: duplicate.id,
            reason: .duplicateMember(fixture.actorID)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [claimUnknown]),
            eventID: claimUnknown.id,
            reason: .unknownMember(unknown)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [reassignUnknown]),
            eventID: reassignUnknown.id,
            reason: .unknownMember(unknown)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [archiveUnknown]),
            eventID: archiveUnknown.id,
            reason: .unknownMember(unknown)
        )
    }

    func testMemberAdditionRejectsReservedPersonalAndRetiredGroupUnits() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(310))
        let thirdMember = MemberID(unchecked: testUUID(311))
        let groupID = GroupID(unchecked: testUUID(312))
        let groupUnit = UnitID(unchecked: testUUID(313))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let duplicatePersonalUnit = fixture.event(1, id: 1_310, payload: .memberAdded(
            MemberAddedPayload(
                memberID: thirdMember,
                unitID: fixture.sam,
                role: .member
            )
        ))
        let group = fixture.event(1, id: 1_311, payload: .groupChanged(
            GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: groupID,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, maya],
                    defaultShareWeight: 2
                ),
            ])
        ))
        let dissolve = fixture.event(2, id: 1_312, payload: .groupChanged(
            GroupChangedPayload(groups: [])
        ))
        let retiredGroupUnit = fixture.event(3, id: 1_313, payload: .memberAdded(
            MemberAddedPayload(
                memberID: thirdMember,
                unitID: groupUnit,
                role: .member
            )
        ))

        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [duplicatePersonalUnit]),
            eventID: duplicatePersonalUnit.id,
            reason: .memberUnitAlreadyAssigned(
                unitID: fixture.sam,
                existingMemberID: maya
            )
        )
        assertInvalid(
            LedgerReducer().reduce(
                pot: pot,
                events: [retiredGroupUnit, dissolve, group]
            ),
            eventID: retiredGroupUnit.id,
            reason: .memberUnitConflictsWithGroup(
                unitID: groupUnit,
                groupID: groupID
            )
        )
    }

    func testClaimArchiveAndOwnershipStateTransitionsRejectInvalidRepetition() throws {
        let fixture = try CoreFixture()
        let other = MemberID(unchecked: testUUID(94))
        let topology = StructuralProjection(
            members: [
                fixture.actorID: MemberTopology(
                    personalUnitID: fixture.am,
                    unitID: fixture.am,
                    role: .owner
                ),
                other: MemberTopology(
                    personalUnitID: fixture.sam,
                    unitID: fixture.sam,
                    role: .member
                ),
            ],
            claimedMemberIDs: [],
            archivedMemberIDs: [],
            groups: [],
            presets: [],
            knownUnitIDs: [fixture.am, fixture.sam, fixture.leo]
        )
        let pot = try PotConfiguration(id: fixture.potID, currency: .eur, topology: topology)
        let reassignUnclaimed = fixture.event(1, id: 1_120, payload: .memberClaimReassigned(
            MemberClaimReassignedPayload(memberID: other)
        ))
        let claim = fixture.event(1, id: 1_121, payload: .memberClaimed(
            MemberClaimedPayload(memberID: other)
        ))
        let duplicateClaim = fixture.event(2, id: 1_122, payload: .memberClaimed(
            MemberClaimedPayload(memberID: other)
        ))
        let reassign = fixture.event(2, id: 1_127, payload: .memberClaimReassigned(
            MemberClaimReassignedPayload(memberID: other)
        ))
        let reclaim = fixture.event(3, id: 1_128, payload: .memberClaimed(
            MemberClaimedPayload(memberID: other)
        ))
        let archive = fixture.event(1, id: 1_123, payload: .memberArchived(
            MemberArchivedPayload(memberID: other)
        ))
        let duplicateArchive = fixture.event(2, id: 1_124, payload: .memberArchived(
            MemberArchivedPayload(memberID: other)
        ))
        let transferFromNonOwner = fixture.event(1, id: 1_125, payload: .ownershipTransferred(
            OwnershipTransferredPayload(fromMemberID: other, toMemberID: fixture.actorID)
        ))
        let transferToUnknown = fixture.event(1, id: 1_126, payload: .ownershipTransferred(
            OwnershipTransferredPayload(
                fromMemberID: fixture.actorID,
                toMemberID: MemberID(unchecked: testUUID(95))
            )
        ))

        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [reassignUnclaimed]),
            eventID: reassignUnclaimed.id,
            reason: .memberNotClaimed(other)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [claim, duplicateClaim]),
            eventID: duplicateClaim.id,
            reason: .memberAlreadyClaimed(other)
        )
        let detached = LedgerReducer().reduce(pot: pot, events: [claim, reassign])
        XCTAssertEqual(detached.projection.structure.claimedMemberIDs, [])
        let reclaimed = LedgerReducer().reduce(
            pot: pot,
            events: [claim, reassign, reclaim]
        )
        XCTAssertEqual(reclaimed.access, .readWrite)
        XCTAssertEqual(reclaimed.projection.structure.claimedMemberIDs, [other])
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [archive, duplicateArchive]),
            eventID: duplicateArchive.id,
            reason: .memberAlreadyArchived(other)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [transferFromNonOwner]),
            eventID: transferFromNonOwner.id,
            reason: .ownershipSourceIsNotOwner(other)
        )
        let unknown = MemberID(unchecked: testUUID(95))
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [transferToUnknown]),
            eventID: transferToUnknown.id,
            reason: .unknownMember(unknown)
        )
    }

    func testTopologyRequiresOneActiveOwnerOnceMembersExist() throws {
        let fixture = try CoreFixture()
        let other = MemberID(unchecked: testUUID(119))
        let multipleOwners = StructuralProjection(
            members: [
                fixture.actorID: MemberTopology(
                    personalUnitID: fixture.am,
                    unitID: fixture.am,
                    role: .owner
                ),
                other: MemberTopology(
                    personalUnitID: fixture.sam,
                    unitID: fixture.sam,
                    role: .owner
                ),
            ],
            claimedMemberIDs: [],
            archivedMemberIDs: [],
            groups: [],
            presets: [],
            knownUnitIDs: [fixture.am, fixture.sam]
        )
        let missingOwner = StructuralProjection(
            members: [
                fixture.actorID: MemberTopology(
                    personalUnitID: fixture.am,
                    unitID: fixture.am,
                    role: .member
                ),
            ],
            claimedMemberIDs: [],
            archivedMemberIDs: [],
            groups: [],
            presets: [],
            knownUnitIDs: [fixture.am]
        )

        XCTAssertNoThrow(try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            orderedUnitIDs: [fixture.am]
        ))
        XCTAssertThrowsError(try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: multipleOwners
        )) { error in
            XCTAssertEqual(error as? PotConfigurationError, .multipleOwners)
        }
        XCTAssertThrowsError(try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: missingOwner
        )) { error in
            XCTAssertEqual(error as? PotConfigurationError, .activeOwnerRequired)
        }
    }

    func testTopologyRejectsDuplicatePersonalUnits() throws {
        let fixture = try CoreFixture()
        let other = MemberID(unchecked: testUUID(314))
        let topology = StructuralProjection(
            members: [
                fixture.actorID: MemberTopology(
                    personalUnitID: fixture.am,
                    unitID: fixture.am,
                    role: .owner
                ),
                other: MemberTopology(
                    personalUnitID: fixture.am,
                    unitID: fixture.am,
                    role: .member
                ),
            ],
            claimedMemberIDs: [],
            archivedMemberIDs: [],
            groups: [],
            presets: [],
            knownUnitIDs: [fixture.am]
        )

        XCTAssertThrowsError(try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: topology
        )) { error in
            XCTAssertEqual(
                error as? PotConfigurationError,
                .duplicatePersonalUnit(fixture.am)
            )
        }
    }

    func testSecondOwnerIsRejectedAndOwnerMustTransferBeforeArchive() throws {
        let fixture = try CoreFixture()
        let maya = MemberID(unchecked: testUUID(120))
        let mayaUnit = UnitID(unchecked: testUUID(121))
        let pot = try potWithActor(fixture, additionalMember: maya)
        let secondOwner = fixture.event(1, id: 1_162, payload: .memberAdded(
            MemberAddedPayload(
                memberID: MemberID(unchecked: testUUID(122)),
                unitID: mayaUnit,
                role: .owner
            )
        ))
        let prematureArchive = fixture.event(1, id: 1_163, payload: .memberArchived(
            MemberArchivedPayload(memberID: fixture.actorID)
        ))
        let transfer = fixture.event(1, id: 1_164, payload: .ownershipTransferred(
            OwnershipTransferredPayload(fromMemberID: fixture.actorID, toMemberID: maya)
        ))
        let archive = fixture.event(2, id: 1_165, payload: .memberArchived(
            MemberArchivedPayload(memberID: fixture.actorID)
        ))

        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [secondOwner]),
            eventID: secondOwner.id,
            reason: .ownerAlreadyExists(fixture.actorID)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [prematureArchive]),
            eventID: prematureArchive.id,
            reason: .ownerMustTransferBeforeArchive(fixture.actorID)
        )

        let valid = LedgerReducer().reduce(pot: pot, events: [archive, transfer])
        XCTAssertEqual(valid.access, .readWrite)
        XCTAssertEqual(valid.projection.structure.members[maya]?.role, .owner)
        XCTAssertEqual(valid.projection.structure.members[fixture.actorID]?.role, .member)
        XCTAssertEqual(valid.projection.structure.archivedMemberIDs, [fixture.actorID])
    }

    func testGroupSnapshotCorruptionHasExplicitDeterministicReasons() throws {
        let fixture = try CoreFixture()
        let other = MemberID(unchecked: testUUID(96))
        let pot = try potWithActor(fixture, additionalMember: other)
        let firstGroupID = GroupID(unchecked: testUUID(97))
        let secondGroupID = GroupID(unchecked: testUUID(98))
        let firstUnit = UnitID(unchecked: testUUID(99))
        let secondUnit = UnitID(unchecked: testUUID(100))

        let badWeight = SettlementGroupSnapshot(
            groupID: firstGroupID,
            unitID: firstUnit,
            orderedMemberIDs: [fixture.actorID],
            defaultShareWeight: 0
        )
        let duplicateGroupA = SettlementGroupSnapshot(
            groupID: firstGroupID,
            unitID: firstUnit,
            orderedMemberIDs: [fixture.actorID],
            defaultShareWeight: 1
        )
        let duplicateGroupB = SettlementGroupSnapshot(
            groupID: firstGroupID,
            unitID: secondUnit,
            orderedMemberIDs: [other],
            defaultShareWeight: 1
        )
        let overlapA = duplicateGroupA
        let overlapB = SettlementGroupSnapshot(
            groupID: secondGroupID,
            unitID: secondUnit,
            orderedMemberIDs: [fixture.actorID],
            defaultShareWeight: 1
        )
        let unknown = MemberID(unchecked: testUUID(101))
        let unknownMemberGroup = SettlementGroupSnapshot(
            groupID: secondGroupID,
            unitID: secondUnit,
            orderedMemberIDs: [unknown],
            defaultShareWeight: 1
        )
        let duplicateUnitGroup = SettlementGroupSnapshot(
            groupID: secondGroupID,
            unitID: firstUnit,
            orderedMemberIDs: [other],
            defaultShareWeight: 1
        )
        let personalUnitGroup = SettlementGroupSnapshot(
            groupID: secondGroupID,
            unitID: fixture.am,
            orderedMemberIDs: [fixture.actorID],
            defaultShareWeight: 1
        )

        let weightEvent = groupEvent(fixture, id: 1_130, groups: [badWeight])
        let duplicateEvent = groupEvent(
            fixture,
            id: 1_131,
            groups: [duplicateGroupA, duplicateGroupB]
        )
        let overlapEvent = groupEvent(fixture, id: 1_132, groups: [overlapA, overlapB])
        let unknownEvent = groupEvent(fixture, id: 1_133, groups: [unknownMemberGroup])
        let duplicateUnitEvent = groupEvent(
            fixture,
            id: 1_134,
            groups: [duplicateGroupA, duplicateUnitGroup]
        )
        let personalUnitEvent = groupEvent(
            fixture,
            id: 1_135,
            groups: [personalUnitGroup]
        )

        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [weightEvent]),
            eventID: weightEvent.id,
            reason: .nonPositiveGroupWeight(groupID: firstGroupID, weight: 0)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [duplicateEvent]),
            eventID: duplicateEvent.id,
            reason: .duplicateGroup(firstGroupID)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [overlapEvent]),
            eventID: overlapEvent.id,
            reason: .memberInMultipleGroups(fixture.actorID)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [unknownEvent]),
            eventID: unknownEvent.id,
            reason: .unknownGroupMember(unknown)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [duplicateUnitEvent]),
            eventID: duplicateUnitEvent.id,
            reason: .duplicateGroupUnit(firstUnit)
        )
        assertInvalid(
            LedgerReducer().reduce(pot: pot, events: [personalUnitEvent]),
            eventID: personalUnitEvent.id,
            reason: .groupUnitConflictsWithPersonalUnit(fixture.am)
        )
    }

    func testLatestPresetReplacesPriorSnapshotAndValidatesUnits() throws {
        let fixture = try CoreFixture()
        let first = fixture.event(1, id: 1_140, payload: .presetChanged(
            PresetChangedPayload(name: "Everyone", orderedUnitIDs: [fixture.am, fixture.sam])
        ))
        let latest = fixture.event(2, id: 1_141, payload: .presetChanged(
            PresetChangedPayload(
                name: "Everyone",
                orderedUnitIDs: [fixture.am, fixture.sam, fixture.leo]
            )
        ))
        let unknownUnit = UnitID(unchecked: testUUID(102))
        let invalid = fixture.event(3, id: 1_142, payload: .presetChanged(
            PresetChangedPayload(name: "Future", orderedUnitIDs: [unknownUnit])
        ))

        let valid = LedgerReducer().reduce(pot: fixture.pot, events: [latest, first])
        let invalidResult = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [first, latest, invalid]
        )

        XCTAssertEqual(valid.projection.structure.presets, [
            ParticipantPresetSnapshot(
                name: "Everyone",
                orderedUnitIDs: [fixture.am, fixture.sam, fixture.leo]
            ),
        ])
        assertInvalid(
            invalidResult,
            eventID: invalid.id,
            reason: .unknownUnit(unknownUnit)
        )
        XCTAssertEqual(invalidResult.projection.structure.presets, valid.projection.structure.presets)
    }

    private func potWithActor(
        _ fixture: CoreFixture,
        additionalMember: MemberID? = nil
    ) throws -> PotConfiguration {
        var members = [
            fixture.actorID: MemberTopology(
                personalUnitID: fixture.am,
                unitID: fixture.am,
                role: .owner
            ),
        ]
        if let additionalMember {
            members[additionalMember] = MemberTopology(
                personalUnitID: fixture.sam,
                unitID: fixture.sam,
                role: .member
            )
        }
        return try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: StructuralProjection(
                members: members,
                claimedMemberIDs: [],
                archivedMemberIDs: [],
                groups: [],
                presets: [],
                knownUnitIDs: [fixture.am, fixture.sam, fixture.leo]
            )
        )
    }

    private func groupEvent(
        _ fixture: CoreFixture,
        id: UInt16,
        groups: [SettlementGroupSnapshot]
    ) -> EventEnvelope {
        fixture.event(1, id: id, payload: .groupChanged(
            GroupChangedPayload(groups: groups)
        ))
    }

    private func assertInvalid(
        _ result: ReductionResult,
        eventID: EventID,
        reason: InvalidEventReason,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(
            result.access,
            .readOnly(.invalidEvent(eventID: eventID, reason: reason)),
            file: file,
            line: line
        )
    }
}
