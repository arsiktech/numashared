import XCTest

extension GoldenPathUITests {
    @MainActor
    func testExpenseEqualUsesFourActionsAndReturnsHomeWithUndo() throws {
        let app = launch(["--qa-shared-table-reference", "--qa-still-motion"])
        let headline = app.staticTexts["balance-headline-amount"]
        XCTAssertTrue(headline.waitForExistence(timeout: 5))
        let originalBalance = headline.label

        // Four actions, apart from entering data: Add, Who paid?, payer, Save.
        app.buttons["dock-vessel"].tap()
        let description = app.textFields["expense-merchant"]
        XCTAssertTrue(description.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Description · optional"].exists)
        description.tap()
        description.typeText("Dinner together\n")
        app.buttons["9"].tap(); app.buttons["6"].tap()
        attachExpenseReference("journey-expense-entry")
        app.buttons["expense-next-payer"].tap()

        let sam = expensePayer("Sam", in: app)
        XCTAssertTrue(sam.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["expense-save"].exists, "An actual payer must still be chosen explicitly.")
        XCTAssertFalse(app.buttons["expense-next-split"].exists, "Payer selection must not need another Continue tap.")
        attachExpenseReference("journey-expense-payer")
        sam.tap()

        let save = app.buttons["expense-save"]
        XCTAssertTrue(save.waitForExistence(timeout: 3))
        XCTAssertTrue(save.isEnabled)
        XCTAssertTrue(save.isHittable)
        XCTAssertGreaterThanOrEqual(save.frame.height, 44)
        XCTAssertFalse(app.buttons["expense-next-review"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == '€48.00'")).count, 2)
        XCTAssertTrue(app.staticTexts["expense-receipt-attribution"].label.contains("Sam paid · Added by you"))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'You + Sam owe Alex + Jo €36'")).firstMatch.exists)
        attachExpenseReference("journey-expense-editable-receipt")
        save.tap()

        let undo = app.buttons["Undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        XCTAssertEqual(headline.label, "€36")
        XCTAssertTrue(app.staticTexts["Sam paid · today"].exists)
        undo.tap()
        XCTAssertTrue(undo.waitForNonExistence(timeout: 3))
        XCTAssertEqual(headline.label, originalBalance)
        XCTAssertFalse(app.buttons["expense-saved-home"].exists)
        XCTAssertFalse(save.exists, "A successful save returns directly to Home.")
        attachExpenseReference("journey-expense-undo-restored-home")
    }

    @MainActor
    func testExpenseCanCancelFromEveryUnsavedPageWithoutRecording() {
        let app = launch(["--qa-shared-table-reference", "--qa-still-motion"])
        let headline = app.staticTexts["balance-headline-amount"]
        XCTAssertTrue(headline.waitForExistence(timeout: 5))
        let originalBalance = headline.label

        for stage in ["entry", "details", "payer", "receipt"] {
            app.buttons["dock-vessel"].tap()
            XCTAssertTrue(app.textFields["expense-merchant"].waitForExistence(timeout: 3))
            if stage == "details" {
                app.buttons["expense-date-details"].tap()
                XCTAssertTrue(app.buttons["expense-keep-details"].waitForExistence(timeout: 3))
            } else if stage == "payer" || stage == "receipt" {
                app.buttons["9"].tap(); app.buttons["6"].tap()
                app.buttons["expense-next-payer"].tap()
                let sam = expensePayer("Sam", in: app)
                XCTAssertTrue(sam.waitForExistence(timeout: 3))
                if stage == "receipt" {
                    sam.tap()
                    XCTAssertTrue(app.buttons["expense-save"].waitForExistence(timeout: 3))
                }
            }
            let cancel = app.buttons["expense-cancel"]
            XCTAssertTrue(cancel.isEnabled, "Cancel is available on \(stage).")
            XCTAssertTrue(cancel.isHittable)
            cancel.tap()
            XCTAssertTrue(cancel.waitForNonExistence(timeout: 3))
            XCTAssertEqual(headline.label, originalBalance)
            XCTAssertFalse(app.buttons["Undo"].exists, "Cancelling \(stage) must not append a record.")
        }
    }

    @MainActor
    func testExpenseExactSplitBlocksInvalidAmountAndSavesCorrectedReceipt() {
        let app = launch(["--qa-shared-table-reference", "--qa-still-motion"])
        openExpenseReceipt(in: app)
        let exactChoice = app.buttons["Exact amounts"]
        revealExpenseControl(exactChoice, in: app)
        exactChoice.tap()

        let ownShare = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'exact-split-' AND label BEGINSWITH 'You + Sam'")).firstMatch
        XCTAssertTrue(ownShare.waitForExistence(timeout: 3))
        revealExpenseControl(ownShare, in: app)
        replaceExpenseField(ownShare, with: "100", in: app)
        let save = app.buttons["expense-save"]
        XCTAssertFalse(save.isEnabled, "Allocations exceeding the expense cannot be saved.")
        XCTAssertTrue(app.staticTexts["exact-split-error"].exists)

        replaceExpenseField(ownShare, with: "60", in: app)
        XCTAssertTrue(save.isEnabled)
        let otherShare = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'exact-split-' AND label BEGINSWITH 'Alex + Jo'")).firstMatch
        XCTAssertEqual(otherShare.value as? String, "36.00")
        XCTAssertTrue(app.staticTexts["expense-receipt-attribution"].label.contains("Sam paid · Added by you"))
        attachExpenseReference("journey-expense-exact-receipt")
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["balance-headline-amount"].label, "€48")
    }

    @MainActor
    func testExpenseExactSplitKeepsInvalidFieldBlockedAfterEditingAnotherShare() {
        let app = launch(["--qa-shared-table-reference", "--qa-still-motion"])
        openExpenseReceipt(in: app)
        let exactChoice = app.buttons["Exact amounts"]
        revealExpenseControl(exactChoice, in: app)
        exactChoice.tap()

        let ownShare = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'exact-split-' AND label BEGINSWITH 'You + Sam'")).firstMatch
        let otherShare = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'exact-split-' AND label BEGINSWITH 'Alex + Jo'")).firstMatch
        XCTAssertTrue(ownShare.waitForExistence(timeout: 3))
        revealExpenseControl(ownShare, in: app)
        replaceExpenseField(ownShare, with: "48.999", in: app)
        let save = app.buttons["expense-save"]
        XCTAssertFalse(save.isEnabled)

        revealExpenseControl(otherShare, in: app)
        replaceExpenseField(otherShare, with: "48", in: app)
        XCTAssertEqual(ownShare.value as? String, "48.999")
        XCTAssertFalse(save.isEnabled, "Another field must not make invalid displayed precision saveable.")
        XCTAssertTrue(app.staticTexts["exact-split-error"].exists)
        attachExpenseReference("journey-expense-invalid-share-remains-blocked")

        revealExpenseControl(ownShare, in: app)
        replaceExpenseField(ownShare, with: "48", in: app)
        XCTAssertTrue(save.isEnabled)
        XCTAssertFalse(app.staticTexts["exact-split-error"].exists)
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["balance-headline-amount"].label, "€36")
    }

    @MainActor
    func testLegacyExpenseExactSplitDismissesKeyboardAndPreservesInvalidDraft() {
        let app = launch(["--qa-seeded-home", "--qa-still-motion",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons["dock-vessel"].tap()
        XCTAssertTrue(app.textFields["expense-merchant"].waitForExistence(timeout: 3))
        for key in ["key-1", "key-0", "key-0"] { app.buttons[key].tap() }
        app.buttons["Groceries at Lidl"].tap()
        selectEveryone(in: app)
        app.buttons["Review split →"].tap()
        XCTAssertTrue(app.buttons["Exact amounts"].waitForExistence(timeout: 3))
        app.buttons["Exact amounts"].tap()

        let ownShare = app.textFields["exact-split-am"]
        let samShare = app.textFields["exact-split-sam"]
        let leoShare = app.textFields["exact-split-leo"]
        let save = app.buttons["Save expense"]
        XCTAssertTrue(ownShare.waitForExistence(timeout: 3))
        XCTAssertTrue(save.isEnabled)
        replaceExpenseField(ownShare, with: "50.999", in: app)
        XCTAssertFalse(save.isEnabled)

        replaceExpenseField(samShare, with: "25", in: app)
        XCTAssertEqual(ownShare.value as? String, "50.999")
        XCTAssertFalse(save.isEnabled, "Dismissing the keyboard or editing another share must preserve invalid precision.")
        XCTAssertTrue(app.staticTexts["exact-split-error"].exists)
        attachExpenseReference("journey-legacy-expense-invalid-share-after-done")
        let title = app.staticTexts["expense-split-title"]
        let close = app.buttons["expense-split-close"]
        for control in [title, close] {
            XCTAssertTrue(control.exists)
            XCTAssertTrue(control.isHittable)
            XCTAssertGreaterThanOrEqual(control.frame.minY, app.frame.minY)
            XCTAssertLessThan(control.frame.maxY, app.frame.midY,
                "The exact-split sheet must expand so its header stays above the medium-detent clipping boundary.")
        }

        replaceExpenseField(ownShare, with: "50", in: app)
        XCTAssertTrue(save.isEnabled)
        XCTAssertFalse(app.staticTexts["exact-split-error"].exists)
        XCTAssertEqual(samShare.value as? String, "25")
        XCTAssertEqual(leoShare.value as? String, "25.00")
        XCTAssertTrue(save.isHittable)
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["€180"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Groceries at Lidl €100 saved"].exists)
    }

    @MainActor
    func testExpenseOneGroupKeepsBeneficiaryAndPayerExplicit() {
        let app = launch(["--qa-shared-table-reference", "--qa-still-motion"])
        openExpenseReceipt(in: app)
        let oneGroup = app.buttons["For one group"]
        revealExpenseControl(oneGroup, in: app)
        oneGroup.tap()
        let selected = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-beneficiary-' AND label CONTAINS 'Alex + Jo'")).firstMatch
        XCTAssertTrue(selected.exists)
        XCTAssertTrue(selected.isSelected)
        XCTAssertTrue(selected.label.contains("Full amount · €96.00"))
        let own = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-beneficiary-' AND label CONTAINS 'You + Sam'")).firstMatch
        XCTAssertFalse(own.isSelected)
        XCTAssertTrue(own.label.contains("Not included"))
        XCTAssertTrue(app.staticTexts["expense-receipt-attribution"].label.contains("Sam paid · Added by you"))
        let save = app.buttons["expense-save"]
        XCTAssertTrue(save.isEnabled)
        attachExpenseReference("journey-expense-one-group-receipt")
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["balance-headline-amount"].label, "€12")
        let obligation = app.buttons["balance-explanation"].label
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        XCTAssertTrue(obligation.contains("Alex + Jo owe You + Sam"), obligation)
    }

    @MainActor
    private func openExpenseReceipt(in app: XCUIApplication) {
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5))
        app.buttons["dock-vessel"].tap()
        XCTAssertTrue(app.buttons["expense-next-payer"].waitForExistence(timeout: 3))
        // An unnamed expense is valid; optional metadata must not block entry.
        app.buttons["9"].tap(); app.buttons["6"].tap()
        app.buttons["expense-next-payer"].tap()
        let sam = expensePayer("Sam", in: app)
        XCTAssertTrue(sam.waitForExistence(timeout: 3)); sam.tap()
        XCTAssertTrue(app.buttons["expense-save"].waitForExistence(timeout: 3))
    }

    @MainActor
    private func expensePayer(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-payer-' AND label BEGINSWITH %@", name)).firstMatch
    }

    @MainActor
    private func revealExpenseControl(_ element: XCUIElement, in app: XCUIApplication) {
        let scroll = app.scrollViews["expense-page-Review expense"]
        let save = app.buttons["expense-save"]
        for _ in 0..<5 {
            if element.isHittable && !element.frame.intersects(save.frame) { break }
            scroll.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertFalse(element.frame.intersects(save.frame), "The pinned Save button must not cover the target.")
    }

    @MainActor
    private func replaceExpenseField(_ field: XCUIElement, with text: String, in app: XCUIApplication) {
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        // Tapping a trailing-aligned field may place the caret at its start.
        // Select the actual contents instead of assuming an end caret.
        field.press(forDuration: 1)
        let menuItem = app.menuItems["Select All"]
        let selectAll = menuItem.waitForExistence(timeout: 2) ? menuItem : app.buttons["Select All"]
        XCTAssertTrue(selectAll.waitForExistence(timeout: 3))
        selectAll.tap()
        field.typeText(text)
        XCTAssertEqual(field.value as? String, text)

        // Decimal-pad entry has a native tap dismissal that keeps even an invalid
        // draft. Finish editing before snapshots or Save use the updated layout.
        let done = app.buttons["expense-exact-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons.matching(identifier: "expense-exact-done").count, 1)
        XCTAssertEqual(done.label, "Done")
        XCTAssertTrue(done.isEnabled)
        XCTAssertTrue(done.isHittable)
        done.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        XCTAssertFalse(done.exists)
        XCTAssertEqual(field.value as? String, text)
    }

    @MainActor
    private func attachExpenseReference(_ name: String) {
        let image = XCTAttachment(data: XCUIScreen.main.screenshot().pngRepresentation, uniformTypeIdentifier: "public.png")
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }
}
