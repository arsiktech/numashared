import Foundation
import NumaSharedCore
import XCTest
@testable import NumaShared

final class JourneyFrictionTests: XCTestCase {
    @MainActor
    func testReceiptReturnsToItsOriginAfterEditing() async throws {
        let model = try await referenceModel()
        let id = try XCTUnwrap(model.records.first?.id)
        model.openDetail(id)
        XCTAssertFalse(model.detailReturnsToActivity)
        model.beginEditRecord()
        model.cancelRecordAction()
        model.leaveDetail()
        XCTAssertEqual(model.sheet, .none)
        model.openActivity()
        model.openDetail(id)
        XCTAssertTrue(model.detailReturnsToActivity)
        model.beginEditRecord()
        model.cancelRecordAction()
        model.leaveDetail()
        XCTAssertEqual(model.sheet, .activity)
    }

    @MainActor
    func testOnlyRepaymentOpensNamedConfirmationAndCanCancelOrChooseAnotherTransfer() async throws {
        let model = try await referenceModel()
        XCTAssertEqual(model.plan.count, 1)
        let step = try XCTUnwrap(model.plan.first)
        let count = model.records.count
        model.openSettlePlan()
        XCTAssertEqual(model.sheet, .settleAmount)
        XCTAssertEqual(model.settleFrom, step.from)
        XCTAssertEqual(model.settleTo, step.to)
        XCTAssertEqual(model.centsOf(model.sInt, model.sFrac), step.amountCents)
        XCTAssertTrue(model.canRecordSettlement)
        XCTAssertEqual(model.records.count, count, "Opening the confirmation never records payment.")
        model.backToPlan()
        XCTAssertEqual(model.sheet, .none)
        model.openSettlePlan()
        model.beginManualSettlement()
        XCTAssertTrue(model.isManualSettlement)
        XCTAssertFalse(model.canRecordSettlement)
        model.sInt = "12"
        model.sFrac = "50"
        XCTAssertTrue(model.canRecordSettlement)
        model.markPaid()
        XCTAssertFalse(model.canRecordSettlement, "A busy save cannot be submitted twice.")
        model.markPaid()
        for _ in 0..<100 where model.isRecordMutationInFlight { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.records.count, count + 1)
        XCTAssertEqual(model.sheet, .none)
        XCTAssertNotNil(model.undoText)
    }

    @MainActor
    func testMultipleRepaymentsKeepPlanSelection() async throws {
        let repository = AppLedgerRepository(storageMode: .inMemory)
        let model = AppModel(repository: repository, snapshot: try await repository.loadCasaMarSeed())
        XCTAssertGreaterThan(model.plan.count, 1)
        model.openSettlePlan()
        XCTAssertEqual(model.sheet, .settlePlan)
        let step = try XCTUnwrap(model.plan.first)
        model.chooseBridge(from: step.from, to: step.to, amountCents: step.amountCents)
        model.backToPlan()
        XCTAssertEqual(model.sheet, .settlePlan)
    }

    @MainActor
    func testClearingPrefilledAmountsPreservesCurrencyRulesAndRejectsEmptySave() async throws {
        for code in ["JPY", "EUR", "KWD"] {
            let currency = try XCTUnwrap(CurrencyCatalog.all.first { $0.code == code })
            let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
            _ = try await repository.bootstrap(seedCasaMar: false)
            let snapshot = try await repository.completeBudgetGroupSetup(potName: "Clear test", currency: currency,
                people: [(.am, "You"), (.sam, "Sam")], pairs: [])
            let model = AppModel(repository: repository, snapshot: snapshot)
            model.beginAdd(); model.amountInt = "120"; model.merchant = "Groceries"; model.dropAll()
            XCTAssertTrue(model.saveExpense())
            for _ in 0..<100 where model.records.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
            let record = try XCTUnwrap(model.records.first)
            model.openDetail(record.id); model.beginEditRecord()
            XCTAssertFalse(model.canSaveExpenseEdit, "Unchanged content must not create another revision.")
            model.editTitle = "  Groceries  "
            XCTAssertFalse(model.canSaveExpenseEdit, "Whitespace-only changes normalize to the same record.")
            model.clearExpenseEditAmount()
            XCTAssertEqual(model.editAmountMinorUnits, 0)
            XCTAssertNil(model.editAmountFrac)
            XCTAssertFalse(model.canSaveExpenseEdit)
            model.editExpenseKey("7"); model.editExpenseKey("."); model.editExpenseKey("5")
            XCTAssertEqual(model.editAmountMinorUnits, currency.exponent == 0 ? 75 : 75 * currency.minorUnitScale / 10)
            XCTAssertTrue(model.canSaveExpenseEdit)
            model.openSettlePlan()
            model.clearSettlementAmount()
            XCTAssertNil(model.sFrac)
            XCTAssertFalse(model.canRecordSettlement)
            model.markPaid()
            XCTAssertEqual(model.records.count, 1)
            model.sKey("7"); model.sKey("."); model.sKey("5")
            XCTAssertEqual(model.centsOf(model.sInt, model.sFrac), currency.exponent == 0 ? 75 : 75 * currency.minorUnitScale / 10)
            XCTAssertTrue(model.canRecordSettlement)
        }
    }

    @MainActor
    private func referenceModel() async throws -> AppModel {
        let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
        _ = try await repository.bootstrap(seedCasaMar: false)
        return AppModel(repository: repository, snapshot: try await repository.loadSharedTableReferenceFixture())
    }
}
