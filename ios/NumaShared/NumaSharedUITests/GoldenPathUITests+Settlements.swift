// Settlement journeys — split from GoldenPathUITests.swift as a pure move.

import XCTest

extension GoldenPathUITests {
    // Minimum-runtime contract: actual local entry and repayment, not just a seeded balance.
    @MainActor
    func testLocalExpenseBalanceAndRepayment() {
        let app = XCUIApplication()
        // NSArgumentDomain overrides privacy for this process only; never reset
        // stored preferences or the user's ledger for compatibility verification.
        let fixtureArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US",
                                "-privacy.hideAmounts", "NO", "--qa-still-motion"]
        app.launchArguments = fixtureArguments + ["--qa-onboarding"]
        app.launch()
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["join-pot"].isHittable)
        XCTAssertTrue(app.staticTexts["welcome-headline"].exists)
        keepScreenshot("compatibility-00-approved-native-welcome")
        app.buttons["create-pot"].tap()
        XCTAssertTrue(app.textFields["setup-pot-name"].waitForExistence(timeout: 3))
        // Confirm real setup metadata before entry; an empty QA Home alone has
        // not committed its currency and is not the supported first-run path.
        selectCurrency("EUR", in: app)
        app.buttons["setup-continue"].tap()
        app.buttons["setup-add-person"].tap()
        let person = app.textFields["setup-sam-name"]
        XCTAssertTrue(person.waitForExistence(timeout: 3))
        person.tap()
        person.typeText("Sam")
        saveSetupPerson(app)
        finishConfiguredSetup(app)
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 5))

        app.buttons["dock-vessel"].tap()
        let merchant = app.textFields["expense-merchant"]
        XCTAssertTrue(merchant.waitForExistence(timeout: 3))
        merchant.tap()
        merchant.typeText("Shared groceries")
        for key in ["3", "0", "0"] {
            app.buttons[key].tap()
        }
        app.buttons["expense-next-payer"].tap()
        let samRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-payer-' AND label BEGINSWITH 'Sam'")).firstMatch
        XCTAssertTrue(samRow.waitForExistence(timeout: 3)); samRow.tap()
        XCTAssertTrue(app.buttons["expense-split-mode"].waitForExistence(timeout: 3))
        // Equal shares count groups, not people: €150.00 ×2.
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == '€150.00'")).count, 2)
        keepScreenshot("compatibility-01-expense-split")
        XCTAssertTrue(app.buttons["expense-save"].waitForExistence(timeout: 3))
        app.buttons["expense-save"].tap()
        XCTAssertTrue(app.buttons["expense-save"].waitForNonExistence(timeout: 5))

        let headline = app.staticTexts["balance-headline-amount"]
        XCTAssertTrue(headline.waitForExistence(timeout: 3))
        XCTAssertEqual(headline.label, "€150")
        XCTAssertTrue(app.buttons["orb-sam"].label.contains("gets back €150"))
        XCTAssertFalse(app.buttons["orb-leo"].exists)
        keepScreenshot("compatibility-02-balances")

        // Undo is in a reserved lane; allow this separate minimum-runtime journey to settle.
        XCTAssertTrue(app.buttons["Undo"].waitForNonExistence(timeout: 8))
        app.buttons["record-repayment"].tap()
        XCTAssertTrue(app.staticTexts["Record a repayment"].waitForExistence(timeout: 3))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'After this, both groups are even.'")).firstMatch.waitForExistence(timeout: 3)
        )
        XCTAssertTrue(app.staticTexts["Record this only after the payment was made outside the app."].exists)
        keepScreenshot("compatibility-03-repayment")
        app.buttons["Mark as paid"].tap()
        XCTAssertTrue(app.staticTexts["Settlement €150 recorded"].waitForExistence(timeout: 3))
        XCTAssertEqual(headline.label, "€0")
        XCTAssertTrue(app.buttons["orb-sam"].label.contains("even"))
        keepScreenshot("compatibility-04-after-repayment")

        // Recording an external repayment never deletes the original expense.
        XCTAssertTrue(app.buttons["Undo"].waitForNonExistence(timeout: 8))
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Activity'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["On this iPhone until you enable sync."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Shared groceries'")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Arseny paid Sam'")).firstMatch.exists)
        keepScreenshot("compatibility-05-local-history")
    }

    // MARK: Settle → Mark as paid → Undo

    @MainActor
    func testSettleMarkPaidAndUndo() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["record-repayment"].tap()
        XCTAssertTrue(app.staticTexts["Record a repayment"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Sam pays Arseny + Maya"].exists)
        XCTAssertTrue(app.staticTexts["Leo pays Arseny + Maya"].exists)

        // Largest debtor first — Sam's €75 row.
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Sam pays Arseny + Maya'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Record a repayment"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Sam will be even."].exists)

        app.buttons["Mark as paid"].tap()
        XCTAssertTrue(app.staticTexts["€55"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Settlement €75 recorded"].exists)

        app.buttons["Undo"].tap()
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["orb-sam"].label.contains("owes €75"))
    }

    @MainActor
    func testManualSettlementRecordsAnyTwoPeople() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["record-repayment"].tap()
        XCTAssertTrue(app.buttons["manual-settlement"].waitForExistence(timeout: 3))
        app.buttons["manual-settlement"].tap()
        XCTAssertTrue(app.staticTexts["Record a transfer"].waitForExistence(timeout: 3))

        app.buttons["settlement-from"].tap()
        chooseMenuItem("Leo", in: app)
        app.buttons["settlement-to"].tap()
        chooseMenuItem("Sam", in: app)
        for key in ["key-1", "key-2", "key-decimal", "key-5", "key-0"] {
            app.buttons[key].tap()
        }

        XCTAssertTrue(app.staticTexts["Leo paid Sam €12.50."].exists)
        app.buttons["Record transfer"].tap()
        XCTAssertTrue(app.staticTexts["Settlement €12.50 recorded"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testSettleOverpayPreviewShowsReversal() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["record-repayment"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Sam pays Arseny + Maya'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Sam will be even."].waitForExistence(timeout: 3))

        for _ in 0..<2 { app.buttons["key-delete"].tap() }
        for key in ["key-1", "key-0", "key-0"] { app.buttons[key].tap() }
        XCTAssertTrue(app.staticTexts["Sam will switch from owing €75 to getting back €25."].waitForExistence(timeout: 2))

        app.buttons["Exact €75.00"].tap()
        XCTAssertTrue(app.staticTexts["Sam will be even."].waitForExistence(timeout: 2))
    }

    @MainActor
    func testFlaggedSettlementRecordsAnExplicitLinkedReversal() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Activity'")
        ).firstMatch.tap()
        // The peek keeps off-screen row copies alive; several AX nodes begin
        // with 'Sam paid your household', and firstMatch can resolve to an
        // occluded copy whose synthesized tap lands nowhere. Pick the
        // on-screen hittable one.
        let settlement = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Sam paid your household'")
        ).allElementsBoundByIndex.first { $0.isHittable && $0.frame.height > 44 }
        guard let settlement else { XCTFail("No on-screen settlement row"); return }
        // The settlement row's AX node reports a mismatched automation type,
        // so a synthesized element tap computes an invalid hit point {-1,-1}
        // even via coordinate-within-element. Tap the screen point directly:
        // frame coordinates → app-level normalized offset, exactly where a
        // user's finger lands.
        let rowFrame = settlement.frame
        let appFrame = app.frame
        let center = app.coordinate(withNormalizedOffset: CGVector(
            dx: (rowFrame.midX - appFrame.minX) / appFrame.width,
            dy: (rowFrame.midY - appFrame.minY) / appFrame.height
        ))
        center.tap()

        // The detail sheet presents async; wait for its action instead of
        // tapping blind.
        let flagButton = app.buttons["Flag as incorrect"]
        XCTAssertTrue(flagButton.waitForExistence(timeout: 5))
        flagButton.tap()
        XCTAssertTrue(
            app.buttons["record-settlement-reversal"].waitForExistence(timeout: 3)
        )
        app.buttons["record-settlement-reversal"].tap()

        XCTAssertTrue(
            app.staticTexts["Reverse flagged settlement"].waitForExistence(timeout: 3)
        )
        XCTAssertTrue(app.buttons["Full reversal €300.00"].exists)
        XCTAssertTrue(
            app.staticTexts["This fully reverses the remaining flagged settlement amount."].exists
        )
        XCTAssertTrue(
            app.staticTexts[
                "This records a correction. The original settlement stays visible. Numa Shared moves no money."
            ].exists
        )
        keepScreenshot("ARS-20-settlement-branding")
        app.buttons["Record reversal"].tap()
        XCTAssertTrue(app.staticTexts["Reversal €300 recorded"].waitForExistence(timeout: 3))
    }

}
