import XCTest
import NumaSharedCore
@testable import NumaShared

final class OnboardingFrictionTests: XCTestCase {
    @MainActor
    func testFreshDefaultsDoNotInventHouseholdOrOwnerIdentity() async throws {
        let model = try await emptyModel()
        XCTAssertEqual(model.potName, "")
        XCTAssertEqual(model.ownerDisplayName, "")
        XCTAssertTrue(model.setupPersonUnits.isEmpty)
        XCTAssertFalse(model.isPotCurrencyConfirmed)
        model.goCreate()
        model.goPeople()
        XCTAssertEqual(model.screen, .create)
        model.potName = "Our place"
        model.goPeople()
        XCTAssertEqual(model.screen, .create, "A household still needs explicit currency confirmation.")
        model.selectPotCurrency(.eur)
        model.goPeople()
        XCTAssertEqual(model.screen, .people, "The owner name is entered on People, not on Create.")
        XCTAssertFalse(model.canCompleteSetup)
        model.addSetupPerson(); model.samDisplayName = "Sam"
        XCTAssertFalse(model.canCompleteSetup)
        model.ownerDisplayName = "Ari"
        XCTAssertTrue(model.canCompleteSetup)
        model.goCreate(); model.goPeople()
        XCTAssertEqual(model.ownerDisplayName, "Ari")
        XCTAssertEqual(model.samDisplayName, "Sam")
        XCTAssertTrue(model.canCompleteSetup)
    }

    @MainActor
    func testNameValidationMatchesFinalSetupForUnicodeAndReservedText() async throws {
        let model = try await emptyModel()
        model.potName = "Our place"; model.ownerDisplayName = "Ari"
        model.selectPotCurrency(.eur); model.addSetupPerson()
        for value in ["", "  ", WireEventV1.redactedTextPlaceholder,
                      String(repeating: "a", count: 129), String(repeating: "👨‍👩‍👧‍👦", count: 20)] {
            XCTAssertFalse(AppModel.isValidSetupValue(value))
            model.samDisplayName = value
            XCTAssertFalse(model.canCompleteSetup)
        }
        for value in [" Sam ", String(repeating: "a", count: 128), "Zoë 👩🏽‍💻"] {
            XCTAssertTrue(AppModel.isValidSetupValue(value))
            model.samDisplayName = value
            XCTAssertTrue(model.canCompleteSetup)
        }
    }

    @MainActor
    func testSavingSetupLocksDraftMutationsAndPersistsReviewedPeople() async throws {
        let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
        let model = AppModel(repository: repository, snapshot: try await repository.bootstrap(seedCasaMar: false))
        model.potName = "Our place"; model.ownerDisplayName = "Ari"
        model.selectPotCurrency(.eur)
        model.addSetupPerson(); model.samDisplayName = "Sam"
        model.addSetupPerson(); model.leoDisplayName = "Alex"
        XCTAssertTrue(model.groupSetupUnits(.am, with: .sam))
        model.goPeople(); model.finishSetup()
        XCTAssertTrue(model.isCompletingSetup)
        XCTAssertNil(model.addSetupPerson())
        model.removeSetupPerson(.sam)
        model.toggleSetupGrouping(.sam); model.clearSetupGrouping()
        XCTAssertFalse(model.groupSetupUnits(.sam, with: .leo))
        model.selectPotCurrency(try XCTUnwrap(CurrencyCatalog.all.first { $0.code == "GBP" }))
        model.goCreate()
        XCTAssertEqual(model.screen, .people)
        XCTAssertEqual(model.setupPersonUnits, [.sam, .leo])
        XCTAssertEqual(model.setupPairs, [[.am, .sam]])
        XCTAssertEqual(model.potCurrency, .eur)
        for _ in 0..<200 where model.isCompletingSetup { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.isCompletingSetup)
        XCTAssertEqual(model.screen, .home)
        let snapshot = try await repository.refreshSnapshot()
        let reopened = AppModel(repository: repository, snapshot: snapshot)
        XCTAssertEqual(reopened.screen, .home)
        XCTAssertEqual(reopened.potName, "Our place")
        XCTAssertEqual(reopened.ownerDisplayName, "Ari")
        XCTAssertEqual(reopened.potCurrency, .eur)
        XCTAssertEqual(reopened.activeBudgetUnitIDs.count, 2)
    }

    @MainActor
    func testRegistrationRetryKeepsReviewedDraftAndOpeningBalanceDestination() async throws {
        for openingBalance in [false, true] {
            let model = try await emptyModel()
            model.beginNewPot()
            model.potName = "New home"; model.ownerDisplayName = "Ari"
            model.selectPotCurrency(.eur)
            model.addSetupPerson(); model.samDisplayName = "Sam"
            model.goPeople()
            model.failNextSetupRegistrationForTesting()
            if openingBalance { model.continueToOpeningBalance() }
            else { model.finishSetup() }
            for _ in 0..<200 where model.isCompletingSetup { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertNotNil(model.setupErrorMessage)
            XCTAssertTrue(model.hasPendingSetupRegistration)
            XCTAssertTrue(model.isSetupDraftLocked)
            XCTAssertNil(model.addSetupPerson())
            model.removeSetupPerson(.sam)
            model.selectPotCurrency(try XCTUnwrap(CurrencyCatalog.all.first { $0.code == "GBP" }))
            model.goCreate()
            XCTAssertEqual(model.screen, .people)
            XCTAssertEqual(model.setupPersonUnits, [.sam])
            XCTAssertEqual(model.potCurrency, .eur)
            // The review's primary Retry action must resume the original route.
            model.finishSetup()
            XCTAssertFalse(model.isSetupDraftLocked)
            XCTAssertNil(model.setupErrorMessage)
            XCTAssertEqual(model.screen, openingBalance ? .openingBalance : .home)
            XCTAssertEqual(model.potName, "New home")
            XCTAssertEqual(model.localPots.last?.currencyCode, "EUR")
            XCTAssertEqual(model.localPots.count, 1, "Retry must not register the household twice.")
        }
    }

    @MainActor
    private func emptyModel() async throws -> AppModel {
        let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
        return AppModel(repository: repository, snapshot: try await repository.bootstrap(seedCasaMar: false))
    }
}
