import XCTest

final class JourneyNavigationUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--qa-shared-table-reference", "--qa-still-motion",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-privacy.hideAmounts", "NO"] + extra
        app.launch()
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5))
        return app
    }

    @MainActor
    func testHomeReceiptClosesDirectlyAndEditHasOneActionClear() {
        let app = launch()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Dinner together'")).firstMatch.tap()
        let close = app.buttons["detail-back"]
        XCTAssertTrue(close.waitForExistence(timeout: 3))
        XCTAssertEqual(close.label, "Close receipt")
        app.buttons["edit-record"].tap()
        let save = app.buttons["save-record-edit"]
        XCTAssertTrue(save.waitForExistence(timeout: 3))
        XCTAssertFalse(save.isEnabled)
        app.buttons["edit-clear-amount"].tap()
        XCTAssertEqual(app.staticTexts["edit-record-amount"].label, "€0")
        XCTAssertFalse(save.isEnabled)
        app.buttons["key-7"].tap(); app.buttons["key-5"].tap()
        XCTAssertTrue(save.isEnabled)
        save.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertEqual(close.label, "Close receipt")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 3))
        XCTAssertFalse(app.textFields["activity-search"].exists)
        XCTAssertTrue(app.buttons["home-tab-activity"].isHittable)
    }

    @MainActor
    func testSingleRepaymentShowsConfirmationDirectlyAndClearDisablesSave() {
        let app = launch()
        app.buttons["record-repayment"].tap()
        let clear = app.buttons["settlement-clear-amount"]
        XCTAssertTrue(clear.waitForExistence(timeout: 3))
        let save = app.buttons["save-settlement"]
        XCTAssertTrue(save.isEnabled)
        XCTAssertTrue(app.staticTexts["Record this only after the payment was made outside the app."].exists)
        clear.tap()
        XCTAssertFalse(save.isEnabled)
        XCTAssertTrue(app.staticTexts["settlement-amount-guidance"].exists)
        app.buttons["key-4"].tap(); app.buttons["key-2"].tap()
        XCTAssertTrue(save.isEnabled)
        for _ in 0..<6 where !save.isHittable { app.swipeUp() }
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["balance-headline-amount"].label, "€42")
        let undo = app.buttons["Undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 3)); undo.tap()
        XCTAssertEqual(app.staticTexts["balance-headline-amount"].label, "€84")
    }

    @MainActor
    func testLargeTextEditAndAlternateRepaymentRemainReachable() {
        let app = launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let repayment = app.buttons["record-repayment"]
        for _ in 0..<6 where !repayment.isHittable { app.swipeUp() }
        repayment.tap()
        let alternate = app.buttons["manual-settlement"]
        XCTAssertTrue(alternate.waitForExistence(timeout: 3))
        for _ in 0..<12 where !alternate.isHittable { app.swipeUp() }
        XCTAssertTrue(alternate.isHittable)
        alternate.tap()
        let from = app.buttons["settlement-from"]
        for _ in 0..<12 where !from.isHittable { app.swipeDown() }
        XCTAssertTrue(from.isHittable)
        XCTAssertFalse(app.buttons["save-settlement"].isEnabled)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "journey-alternate-repayment-ax-xxxl"; shot.lifetime = .keepAlways; add(shot)
    }
}
