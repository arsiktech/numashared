import Foundation
import NumaSharedCore
import XCTest
@testable import NumaShared

final class ExpenseFlowTests: XCTestCase {
    @MainActor
    func testReferenceExpensePreviewMatchesSavedEqualExactAndPersonalRecords() async throws {
        for (choice, expectedBalance, expectedParts) in [
            ("equal", Int64(-3_600), [Int64(4_800), 4_800]),
            ("exact", Int64(-4_800), [Int64(6_000), 3_600]),
            ("other", Int64(1_200), [Int64(0), 9_600]),
        ] {
            let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
            _ = try await repository.bootstrap(seedCasaMar: false)
            let snapshot = try await repository.loadSharedTableReferenceFixture()
            let model = AppModel(repository: repository, snapshot: snapshot,
                accountDeletionRecoveryStore: AccountDeletionRecoveryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
            let payer = try XCTUnwrap(model.payerPeople.first { $0.displayName == "Sam" })
            let other = try XCTUnwrap(model.ledgerUnitIDs.first { $0 != model.currentUnitID })
            model.beginAdd()
            model.merchant = "Dinner together"
            model.category = "Dining"
            model.amountInt = "96"
            model.expenseDate = Date(timeIntervalSince1970: 1_789_200_000)
            model.selectExpensePayer(payer)
            model.dropAll()
            if choice == "exact" {
                model.selectExpenseSplitMode(.exact)
                model.updateExactSplitDraft("60", for: model.currentUnitID)
            } else if choice == "other" { model.attached = [other] }
            XCTAssertTrue(model.canSaveExpense)
            XCTAssertEqual(model.expenseBalanceAfter(for: model.currentUnitID), expectedBalance)
            XCTAssertEqual([model.allocatedParts()[model.currentUnitID] ?? 0, model.allocatedParts()[other] ?? 0], expectedParts)
            let preview = try XCTUnwrap(model.expenseImpactDescription)
            XCTAssertTrue(preview.contains(choice == "other" ? "Alex + Jo owe You + Sam" : "You + Sam owe Alex + Jo"))
            var completions = 0
            var savedRecordID: String?
            XCTAssertTrue(model.saveExpense { id in completions += 1; savedRecordID = id })
            XCTAssertFalse(model.saveExpense { _ in completions += 1 }) // busy rejection is explicit
            model.merchant = "A different unsaved draft"
            model.amountInt = "777"
            for _ in 0..<100 where completions == 0 { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertEqual(completions, 1)
            XCTAssertTrue(model.addPresented, "A successful save may keep its truthful completion view open.")
            XCTAssertEqual(model.records.count, 3)
            XCTAssertEqual(model.balances[model.currentUnitID], expectedBalance)
            let record = try XCTUnwrap(model.records.first { $0.payerMemberID == payer.memberID })
            XCTAssertEqual(record.id, savedRecordID)
            XCTAssertEqual(record.title, "Dinner together", "The completion receipt is the committed record, not a mutable draft.")
            XCTAssertEqual(record.amountCents, 9_600)
            XCTAssertEqual(record.occurredAt, model.expenseDate)
            XCTAssertEqual(record.payerDisplayName, "Sam")
            XCTAssertEqual(record.recordedBy, "You")
            XCTAssertNotNil(model.undoText)
        }
    }
    @MainActor
    func testExactMembershipReconcilesThreeGroupKeysBeforeSaving() async throws {
        let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = try await repository.completeBudgetGroupSetup(potName: "Three budgets", currency: .eur,
            people: [(.am, "You"), (.sam, "Sam"), (.leo, "Alex")], pairs: [])
        let model = AppModel(repository: repository, snapshot: snapshot,
            accountDeletionRecoveryStore: AccountDeletionRecoveryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
        model.beginAdd(); model.amountInt = "96"; model.dropAll()
        let third = try XCTUnwrap(model.expenseBeneficiaryUnitIDs.last)
        model.toggleUnit(third) // leave two selected
        model.selectExpenseSplitMode(.exact)
        XCTAssertEqual(model.allocatedParts().count, 2)
        model.toggleUnit(third) // actual re-inclusion seam from the native row
        XCTAssertEqual(Set(model.allocatedParts().keys), Set(model.attachedKeys))
        XCTAssertEqual(model.allocatedParts().count, 3)
        XCTAssertEqual(model.allocatedParts().values.reduce(0, +), 9_600)
        XCTAssertTrue(model.canSaveExpense)
        XCTAssertTrue(model.saveExpense())
        for _ in 0..<100 where model.records.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNil(model.localDataErrorMessage)
        XCTAssertEqual(model.records.count, 1)
        XCTAssertEqual(model.records.first?.parts.count, 3)
        XCTAssertEqual(model.records.first?.parts.values.reduce(0, +), 9_600)

        model.beginAdd(); model.amountInt = "96"; model.dropAll(); model.selectExpenseSplitMode(.exact)
        model.attached.remove(third) // a stale/direct draft mutation must fail closed too
        XCTAssertFalse(model.canSaveExpense)
        XCTAssertFalse(model.saveExpense())
        model.dropAll()
        XCTAssertTrue(model.canSaveExpense)
        XCTAssertEqual(Set(model.allocatedParts().keys), Set(model.attachedKeys))
    }

    @MainActor
    func testExactSplitKeepsInvalidFieldBlockedWhenAnotherFieldChanges() async throws {
        for people in [[(UnitID.am, "You"), (.sam, "Sam")], [(.am, "You"), (.sam, "Sam"), (.leo, "Alex")]] {
            let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
            _ = try await repository.bootstrap(seedCasaMar: false)
            let snapshot = try await repository.completeBudgetGroupSetup(
                potName: "Exact shares", currency: .eur, people: people, pairs: [])
            let model = AppModel(repository: repository, snapshot: snapshot)
            model.beginAdd(); model.amountInt = "96"; model.dropAll(); model.selectExpenseSplitMode(.exact)
            let units = model.attachedKeys
            let first = try XCTUnwrap(units.first)
            let second = units[1]
            let originalParts = model.exactParts
            let originalFirst = model.exactSplitDraft(for: first)
            let originalSecond = model.exactSplitDraft(for: second)

            for invalid in ["", "48.999", "not an amount", "9223372036854775808"] {
                model.updateExactSplitDraft(invalid, for: first)
                XCTAssertFalse(model.canSaveExpense)
                model.updateExactSplitDraft(originalSecond, for: second)
                XCTAssertEqual(model.exactSplitDraft(for: first), invalid)
                XCTAssertNotNil(model.exactSplitErrorMessage,
                                "Editing another share must not clear this field's error.")
                XCTAssertFalse(model.canSaveExpense)
                XCTAssertFalse(model.saveExpense(), "Stale valid parts must not override invalid displayed text.")
                XCTAssertNil(model.expenseImpactDescription)

                model.updateExactSplitDraft(originalFirst, for: first)
                XCTAssertNil(model.exactSplitErrorMessage)
                XCTAssertTrue(model.canSaveExpense)
                XCTAssertEqual(model.exactParts, originalParts)
            }

            XCTAssertTrue(model.saveExpense())
            for _ in 0..<100 where model.isRecordMutationInFlight { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertEqual(model.records.count, 1)
            XCTAssertEqual(model.records.first?.parts, originalParts)
        }
    }

    @MainActor
    func testExactSplitRecoveryPreservesModeAmountAndLegacyUnlockBehavior() async throws {
        let repository = AppLedgerRepository(storageMode: .inMemory)
        let model = AppModel(repository: repository, snapshot: try await repository.loadCasaMarSeed())
        model.beginAdd(); model.amountInt = "100"; model.dropAll(); model.selectExpenseSplitMode(.exact)
        model.updateExactSplitDraft("", for: .sam)
        model.updateExactSplitDraft("25", for: .leo)
        XCTAssertFalse(model.canSaveExpense)

        model.toggleExactSplitLock(.sam)
        XCTAssertTrue(model.canSaveExpense, "Unlocking replaces the invalid field with its calculated share.")
        XCTAssertNil(model.exactSplitErrorMessage)
        XCTAssertEqual(AppModel.parseMinorUnits(model.exactSplitDraft(for: .sam), locale: .current, currency: .eur), 2_500)

        model.updateExactSplitDraft("", for: .sam)
        model.selectExpenseSplitMode(.shares)
        XCTAssertTrue(model.canSaveExpense, "A share-based split does not use hidden exact text.")
        model.selectExpenseSplitMode(.exact)
        XCTAssertTrue(model.canSaveExpense, "Returning to exact mode regenerates the visible drafts.")
        XCTAssertNil(model.exactSplitErrorMessage)

        model.amountInt = "120"
        XCTAssertFalse(model.canSaveExpense, "Old exact allocations cannot save a changed total.")
        model.selectExpenseSplitMode(.exact)
        XCTAssertTrue(model.canSaveExpense)
        XCTAssertEqual(model.exactParts.values.reduce(0, +), 12_000)
    }

}
