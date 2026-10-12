import XCTest
@testable import NumaSharedCore

final class RevisionProtocolTests: XCTestCase {
    func testConcurrentHeadsUseHighestServerSequenceProvisionallyThenResolveExplicitly() throws {
        let fixture = try CoreFixture()
        let recordID = RecordID(unchecked: testUUID(40))
        let initial = fixture.event(1, id: 300, payload: .expenseAdded(fixture.expense(
            recordID: recordID,
            title: "Groceries",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )))
        let revisionAContent = fixture.expense(
            recordID: recordID,
            title: "Groceries A",
            amount: 120,
            payer: fixture.am,
            allocations: [(fixture.sam, 120)]
        ).content
        let revisionBContent = fixture.expense(
            recordID: recordID,
            title: "Groceries B",
            amount: 80,
            payer: fixture.am,
            allocations: [(fixture.sam, 80)]
        ).content
        let revisionA = fixture.event(2, id: 450, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(revisionAContent)
            )
        ))
        let revisionB = fixture.event(3, id: 350, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(revisionBContent)
            )
        ))

        let contested = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [revisionB, initial, revisionA]
        )

        XCTAssertEqual(contested.access, .readWrite)
        XCTAssertEqual(contested.projection.balances[fixture.am]?.minorUnits, 80)
        XCTAssertEqual(contested.projection.balances[fixture.sam]?.minorUnits, -80)
        guard case let .revisable(contestedRecord)? = contested.projection.records[recordID] else {
            return XCTFail("Expected contested expense")
        }
        XCTAssertEqual(contestedRecord.appliedRevisionID, revisionB.id)
        XCTAssertEqual(contestedRecord.contested?.headRevisionIDs, [revisionA.id, revisionB.id])
        XCTAssertEqual(contestedRecord.contested?.provisionalRevisionID, revisionB.id)

        let pair = try RevisionPair(revisionA.id, revisionB.id)
        let firstResolution = fixture.event(4, id: 460, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(pair),
                content: .expense(revisionAContent)
            )
        ))
        let resolved = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [initial, revisionA, revisionB, firstResolution]
        )

        guard case let .revisable(resolvedRecord)? = resolved.projection.records[recordID] else {
            return XCTFail("Expected resolved expense")
        }
        XCTAssertNil(resolvedRecord.contested)
        XCTAssertEqual(resolvedRecord.appliedRevisionID, firstResolution.id)
        XCTAssertEqual(resolved.projection.balances[fixture.am]?.minorUnits, 120)

        let laterConcurrentResolution = fixture.event(5, id: 340, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(pair),
                content: .expense(revisionBContent)
            )
        ))
        let laterWins = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [
                laterConcurrentResolution, revisionB, firstResolution, initial, revisionA,
            ]
        )

        guard case let .revisable(finalRecord)? = laterWins.projection.records[recordID] else {
            return XCTFail("Expected resolved expense")
        }
        XCTAssertEqual(laterWins.access, .readWrite)
        XCTAssertNil(finalRecord.contested)
        XCTAssertEqual(finalRecord.appliedRevisionID, laterConcurrentResolution.id)
        XCTAssertEqual(finalRecord.revisions.count, 5)
        XCTAssertEqual(laterWins.projection.balances[fixture.am]?.minorUnits, 80)
    }

    func testResolutionMustReferenceTheActiveContestedHeads() throws {
        let fixture = try CoreFixture()
        let recordID = RecordID(unchecked: testUUID(41))
        let initialPayload = fixture.expense(
            recordID: recordID,
            title: "Expense",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )
        let initial = fixture.event(1, id: 500, payload: .expenseAdded(initialPayload))
        let revisionA = fixture.event(2, id: 501, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(initialPayload.content)
            )
        ))
        let revisionB = fixture.event(3, id: 502, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(initialPayload.content)
            )
        ))
        let wrongPair = try RevisionPair(initial.id, revisionA.id)
        let invalidResolution = fixture.event(4, id: 503, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(wrongPair),
                content: .expense(initialPayload.content)
            )
        ))

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [initial, revisionA, revisionB, invalidResolution]
        )

        XCTAssertEqual(result.access, .readOnly(.invalidEvent(
            eventID: invalidResolution.id,
            reason: .invalidResolution(wrongPair)
        )))
        XCTAssertEqual(result.projection.appliedEventIDs.count, 3)
    }

    func testConcurrentResolutionPreservesAnUnrelatedThirdHead() throws {
        let fixture = try CoreFixture()
        let recordID = RecordID(unchecked: testUUID(42))
        let initialPayload = fixture.expense(
            recordID: recordID,
            title: "Initial",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )
        let initial = fixture.event(1, id: 700, payload: .expenseAdded(initialPayload))

        func revision(sequence: Int64, id: UInt16, amount: Int64) -> EventEnvelope {
            let content = fixture.expense(
                recordID: recordID,
                title: "Revision \(id)",
                amount: amount,
                payer: fixture.am,
                allocations: [(fixture.sam, amount)]
            ).content
            return fixture.event(sequence, id: id, payload: .expenseRevised(
                ExpenseRevisedPayload(
                    recordID: recordID,
                    basis: .parent(initial.id),
                    content: .expense(content)
                )
            ))
        }

        let revisionA = revision(sequence: 2, id: 701, amount: 110)
        let revisionB = revision(sequence: 3, id: 702, amount: 120)
        let revisionC = revision(sequence: 4, id: 703, amount: 130)
        let pair = try RevisionPair(revisionA.id, revisionB.id)
        let firstResolution = fixture.event(5, id: 704, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(pair),
                content: .expense(initialPayload.content)
            )
        ))
        let laterResolution = fixture.event(6, id: 705, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(pair),
                content: .expense(initialPayload.content)
            )
        ))

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [
                laterResolution, revisionC, revisionA, initial,
                firstResolution, revisionB,
            ]
        )

        guard case let .revisable(record)? = result.projection.records[recordID] else {
            return XCTFail("Expected revisable record")
        }
        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(
            record.contested?.headRevisionIDs,
            [revisionC.id, laterResolution.id]
        )
        XCTAssertEqual(record.contested?.provisionalRevisionID, laterResolution.id)
        XCTAssertFalse(record.contested?.headRevisionIDs.contains(firstResolution.id) ?? true)
    }

    func testLaterConcurrentResolutionReplacesPriorResolutionLineageWithoutRecontest() throws {
        let fixture = try CoreFixture()
        let recordID = RecordID(unchecked: testUUID(43))
        let initialPayload = fixture.expense(
            recordID: recordID,
            title: "Initial",
            amount: 100,
            payer: fixture.am,
            allocations: [(fixture.sam, 100)]
        )
        let initial = fixture.event(1, id: 720, payload: .expenseAdded(initialPayload))
        let revisionA = fixture.event(2, id: 721, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(initialPayload.content)
            )
        ))
        let revisionB = fixture.event(3, id: 722, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(initialPayload.content)
            )
        ))
        let pair = try RevisionPair(revisionA.id, revisionB.id)
        let firstResolution = fixture.event(4, id: 723, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(pair),
                content: .expense(initialPayload.content)
            )
        ))
        let editAfterResolution = fixture.event(5, id: 724, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(firstResolution.id),
                content: .expense(initialPayload.content)
            )
        ))
        let laterResolution = fixture.event(6, id: 725, payload: .expenseRevised(
            ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(pair),
                content: .expense(initialPayload.content)
            )
        ))

        let result = LedgerReducer().reduce(
            pot: fixture.pot,
            events: [
                initial, revisionA, revisionB, firstResolution,
                editAfterResolution, laterResolution,
            ]
        )

        guard case let .revisable(record)? = result.projection.records[recordID] else {
            return XCTFail("Expected revisable record")
        }
        XCTAssertEqual(result.access, .readWrite)
        XCTAssertNil(record.contested)
        XCTAssertEqual(record.appliedRevisionID, laterResolution.id)
    }
}
