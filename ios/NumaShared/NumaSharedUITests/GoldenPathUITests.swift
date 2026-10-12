// GoldenPathUITests.swift — headless verification of the Numa Shared golden
// path, driven by `xcodebuild test` so nothing touches the host's mouse or
// keyboard. Deep states are reached via the app's QA launch arguments
// (--qa-home, --qa-seeded-home) declared in AppModel.init().
//
// Run:
//   cd ios/NumaShared && \
//   xcodebuild test -project NumaShared.xcodeproj -scheme NumaShared \
//     -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0'

import XCTest

final class GoldenPathUITests: XCTestCase {
    @MainActor
    func testBudgetGroupsFourPeopleTapSetupPayerReviewAndRepayment() throws {
        let app = launch(["--qa-onboarding", "--qa-still-motion", "--qa-hide-status-bar"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        selectCurrency("EUR", in: app)
        app.buttons["setup-continue"].tap()
        XCTAssertTrue(app.staticTexts["Who’s at home?"].waitForExistence(timeout: 5))
        for (identifier, name) in [("setup-sam-name", "Sam"), ("setup-leo-name", "Alex")] {
            app.buttons["setup-add-person"].tap()
            let field = app.textFields[identifier]
            XCTAssertTrue(field.waitForExistence(timeout: 3)); field.tap(); field.typeText(name)
            saveSetupPerson(app)
        }
        app.buttons["setup-add-person"].tap()
        let fourth = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'setup-remote:'")).firstMatch
        XCTAssertTrue(fourth.waitForExistence(timeout: 3)); fourth.tap(); fourth.typeText("Jo")
        saveSetupPerson(app)
        let peopleScroll = app.scrollViews["setup-people-scroll"]
        for _ in 0..<5 where !app.buttons["Group options for Sam"].isHittable { peopleScroll.swipeDown() }
        app.buttons["Group options for Sam"].tap()
        chooseMenuItem("Share a balance with Arseny", in: app)
        for _ in 0..<5 where !app.buttons["Group options for Jo"].isHittable { peopleScroll.swipeUp() }
        app.buttons["Group options for Jo"].tap()
        chooseMenuItem("Share a balance with Alex", in: app)
        advanceSetupToGroups(app)
        XCTAssertEqual(app.buttons["setup-people-next"].label, "Create our home")
        keepScreenshot("ars116-01-four-people-two-couples")
        finishConfiguredSetup(app)
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5))
        app.buttons["dock-vessel"].tap()
        // The approved progressive flow's keypad keys expose plain labels.
        for key in ["9", "6"] { app.buttons[key].tap() }
        app.buttons["expense-next-payer"].tap()
        let samRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-payer-' AND label BEGINSWITH 'Sam'")).firstMatch
        XCTAssertTrue(samRow.waitForExistence(timeout: 3)); samRow.tap()
        XCTAssertTrue(app.buttons["expense-split-mode"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == '€48.00'")).count, 2)
        keepScreenshot("ars116-02a-equal-split-groups")
        XCTAssertTrue(app.buttons["expense-save"].waitForExistence(timeout: 3))
        keepScreenshot("ars116-02-actual-payer-equal-groups")
        app.buttons["expense-save"].tap()
        XCTAssertTrue(app.buttons["expense-save"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["€48"].waitForExistence(timeout: 5))
        let undo = app.buttons["Undo"]
        let repayment = app.buttons["record-repayment"]
        XCTAssertTrue(undo.exists)
        XCTAssertFalse(undo.frame.intersects(repayment.frame), "Undo must have its own safe-area lane")
        XCTAssertTrue(repayment.isHittable)
        keepScreenshot("ars117-home-with-reserved-undo")
        repayment.tap()
        XCTAssertTrue(app.buttons["settlement-clear-amount"].waitForExistence(timeout: 3))
        app.buttons["settlement-clear-amount"].tap() // replace suggested 48 with 50 in one action
        app.buttons["key-5"].tap(); app.buttons["key-0"].tap()
        let warning = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Overpayment reverses who owes whom'")).firstMatch
        XCTAssertTrue(warning.waitForExistence(timeout: 3))
        XCTAssertTrue(warning.label.contains("Arseny + Sam owe Alex + Jo €2"))
        keepScreenshot("ars116-03-visible-overpayment-direction")
        let recordPayment = app.buttons["Mark as paid"]
        for _ in 0..<5 where !recordPayment.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(recordPayment.isHittable); recordPayment.tap()
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["€2"].exists)
        keepScreenshot("ars116-06-repayment-recorded-direction-flipped")
    }

    @MainActor
    func testBudgetGroupsThreeSingletonOddCentLargeTypeTapJourney() throws {
        let app = launch(["--qa-onboarding", "--qa-still-motion", "--qa-hide-status-bar",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        func reveal(_ element: XCUIElement) {
            // Settle first: a just-dismissed cover leaves the row unhittable
            // for a moment; give it a grace period before scrolling.
            let hittable = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "isHittable == true"), object: element)
            _ = XCTWaiter.wait(for: [hittable], timeout: 2)
            // Swipe at app level: scrollViews.firstMatch can resolve to a
            // stale scroll view kept alive inside the NavigationStack rather
            // than the visible page.
            for _ in 0..<5 where !element.isHittable { app.swipeUp() }
            // A pinned primary bar can overlap a row while AX still reports the
            // row hittable, so the tap lands on the bar. Scroll until the
            // frames separate, like a user would. Bars only exist on their own
            // setup step, so guard existence before reading frames.
            let pinnedBars = ["setup-continue", "setup-people-next", "expense-next-payer", "expense-save"]
                .map { app.buttons[$0] }
            for _ in 0..<5 where element.frame.maxY > app.frame.maxY
                || pinnedBars.contains(where: {
                    $0.exists && $0.identifier != element.identifier
                        && element.frame.maxY > $0.frame.minY
                }) {
                app.swipeUp()
            }
            XCTAssertTrue(element.isHittable)
        }
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap(); selectCurrency("EUR", in: app)
        app.buttons["setup-continue"].tap()
        XCTAssertTrue(app.staticTexts["Who’s at home?"].waitForExistence(timeout: 5))
        for (identifier, name) in [("setup-sam-name", "Sam"), ("setup-leo-name", "Leo")] {
            reveal(app.buttons["setup-add-person"]); app.buttons["setup-add-person"].tap()
            let field = app.textFields[identifier]
            // Wait for the editor's cover to finish presenting before any
            // swipes; reveal's hittability loop must not fire mid-presentation.
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            reveal(field); field.tap(); field.typeText(name)
            saveSetupPerson(app)
        }
        finishConfiguredSetup(app)
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5)); reveal(app.buttons["dock-vessel"]); app.buttons["dock-vessel"].tap()
        reveal(app.buttons["1"]); app.buttons["1"].tap()
        XCTAssertEqual(app.otherElements["expense-entry-amount"].label, "Total amount, €1.00")
        // At XXXL the keypad's bottom row sits below the pinned bar and the
        // lazy grid hasn't materialized it; scroll it into view like a user.
        reveal(app.buttons["0"]); app.buttons["0"].tap()
        XCTAssertEqual(app.otherElements["expense-entry-amount"].label, "Total amount, €10.00")
        XCTAssertTrue(app.buttons["expense-next-payer"].isEnabled)
        app.buttons["expense-next-payer"].tap()
        let samRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-payer-' AND label BEGINSWITH 'Sam'")).firstMatch
        let payerExists = samRow.waitForExistence(timeout: 3)
        if !payerExists { keepScreenshot("journey-large-type-payer-diagnostic") }
        XCTAssertTrue(payerExists, app.debugDescription); reveal(samRow); samRow.tap()
        XCTAssertTrue(app.buttons["expense-split-mode"].waitForExistence(timeout: 3))
        keepScreenshot("ars116-04-large-type-group-allocation")
        // At XXXL ViewThatFits stacks the split choices vertically and the
        // wrapper's combined frame extends under the pinned Review bar even at
        // full scroll, so the wrapper itself can never read hittable. Assert
        // the real control instead: the selected choice must be on-screen with
        // tap-sized geometry.
        let equally = app.buttons["Equally"]
        XCTAssertTrue(equally.waitForExistence(timeout: 3))
        reveal(equally)
        XCTAssertGreaterThanOrEqual(equally.frame.width, 44)
        XCTAssertGreaterThanOrEqual(equally.frame.height, 44)
        var accessibilityIssues: [String] = []
        try app.performAccessibilityAudit(for: [.dynamicType, .hitRegion, .sufficientElementDescription]) { issue in
            let elementDetails: String
            if let element = issue.element, element.exists {
                elementDetails = "label=\(element.label), identifier=\(element.identifier), type=\(element.elementType.rawValue), frame=\(element.frame), hittable=\(element.isHittable)"
            } else {
                elementDetails = "No currently available accessibility element"
            }
            let details = "auditType=\(issue.auditType.rawValue)\n\(elementDetails)\n\(issue.compactDescription)\n\(issue.detailedDescription)"
            accessibilityIssues.append(details)
            let attachment = XCTAttachment(string: details)
            attachment.name = "ars116-large-type-audit-issue-\(accessibilityIssues.count)"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            self.keepScreenshot("ars116-large-type-audit-issue-\(accessibilityIssues.count)-screen")
            // Defer failure, not acceptance: finish the real journey and then
            // require every collected issue to be absent. No issue is waived.
            return true
        }
        // Equal shares across all three singleton groups: €3.33 ×2 + €3.34.
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == '€3.33'")).count, 2)
        XCTAssertTrue(app.staticTexts["€3.34"].exists)
        XCTAssertTrue(app.buttons["expense-save"].waitForExistence(timeout: 3))
        reveal(app.buttons["expense-save"])
        keepScreenshot("ars116-05-large-type-exact-odd-cent-review")
        app.buttons["expense-save"].tap()
        XCTAssertTrue(app.buttons["expense-save"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5))
        keepScreenshot("ars116-07-large-type-save-complete")
        XCTAssertTrue(accessibilityIssues.isEmpty, accessibilityIssues.joined(separator: "\n\n"))
    }



    @MainActor
    func selectEveryone(in app: XCUIApplication) {
        app.buttons["choose-expense-people"].tap()
        XCTAssertTrue(app.buttons["expense-people-everyone"].waitForExistence(timeout: 3))
        app.buttons["expense-people-everyone"].tap()
        app.buttons["expense-people-done"].tap()
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func launch(
        _ arguments: [String] = ["--qa-onboarding"]
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            + ["--qa-reset-privacy"]
            + arguments
        app.launch()
        return app
    }

    @MainActor
    func selectCurrency(_ code: String, in app: XCUIApplication) {
        let currencyButton = app.buttons["setup-currency"]
        XCTAssertTrue(currencyButton.waitForExistence(timeout: 5))
        // At XXXL the pinned Confirm bar can overlap the row's frame even when
        // accessibility reports it hittable; the tap then lands on the bar and
        // the picker never presents. Swipe up like a user to scroll the row
        // clear before tapping.
        for _ in 0..<5 where currencyButton.isHittable && app.buttons["setup-continue"].frame.intersects(currencyButton.frame) {
            app.scrollViews.firstMatch.swipeUp()
        }
        currencyButton.tap()
        let search = app.textFields["currency-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText(code + "\n")
        let currency = app.buttons["currency-\(code)"]
        XCTAssertTrue(currency.waitForExistence(timeout: 3))
        for _ in 0..<5 where !currency.isHittable || currency.frame.maxY > app.frame.maxY {
            app.swipeUp()
        }
        currency.tap()
        let continueButton = app.buttons["setup-continue"]
        let sheetDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == true AND enabled == true"),
            object: continueButton
        )
        XCTAssertEqual(XCTWaiter.wait(for: [sheetDismissed], timeout: 3), .completed)
        XCTAssertTrue(app.buttons["setup-currency"].label.contains(code))
    }

    @MainActor
    func addSetupPeople(_ app: XCUIApplication) {
        for (identifier, name) in [("setup-sam-name", "Sam"), ("setup-leo-name", "Leo")] {
            app.buttons["setup-add-person"].tap()
            let field = app.textFields[identifier]
            XCTAssertTrue(field.waitForExistence(timeout: 3))
            field.tap(); field.typeText(name)
            saveSetupPerson(app)
        }
    }

    @MainActor
    func saveSetupPerson(_ app: XCUIApplication) {
        let save = app.buttons["setup-person-save"]
        XCTAssertTrue(save.waitForExistence(timeout: 3))
        XCTAssertTrue(save.isEnabled)
        save.tap()
        XCTAssertTrue(app.buttons["setup-add-person"].waitForExistence(timeout: 3))
    }

    @MainActor
    func advanceSetupToGroups(_ app: XCUIApplication) {
        let action = app.buttons["setup-people-next"]
        XCTAssertTrue(action.waitForExistence(timeout: 3))
        if action.label.contains("people") { action.tap() }
        XCTAssertEqual(action.label, "Create our home")
        XCTAssertTrue(app.staticTexts["setup-group-count"].waitForExistence(timeout: 3))
    }

    @MainActor
    func advanceSetupToReview(_ app: XCUIApplication) {
        advanceSetupToGroups(app)
        XCTAssertTrue(app.staticTexts["Once you add money, groups stay put."].exists)
    }

    /// Taps once the control has stopped moving. Keyboard-driven sheet
    /// detent changes and scroll deceleration can move a control after
    /// XCTest resolves its hit point, so the tap would land on stale space.
    @MainActor
    func tapWhenSettled(_ control: XCUIElement, timeout: TimeInterval = 3) {
        waitUntilSettled(control, timeout: timeout)
        control.tap()
    }

    @MainActor
    func waitUntilSettled(_ control: XCUIElement, timeout: TimeInterval = 3) {
        XCTAssertTrue(control.waitForExistence(timeout: timeout))
        let deadline = Date().addingTimeInterval(timeout)
        var previous = control.frame
        while Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            let current = control.frame
            if current == previous && control.isHittable { break }
            previous = current
        }
        XCTAssertTrue(control.isHittable)
    }

    @MainActor
    func revealSetupControl(_ control: XCUIElement, in app: XCUIApplication) {
        let scroll = app.scrollViews["setup-people-scroll"]
        let primary = app.buttons["setup-people-next"]
        // iOS 27 reports below-the-fold scroll content as hittable, so also
        // require the control to sit above the pinned primary button.
        func revealed() -> Bool {
            control.isHittable && control.frame.minY >= scroll.frame.minY
                && control.frame.maxY <= primary.frame.minY
        }
        for _ in 0..<6 {
            if revealed() { break }
            if control.frame.minY < scroll.frame.minY { scroll.swipeDown() }
            else { scroll.swipeUp() }
        }
        XCTAssertTrue(revealed())
    }

    @MainActor
    func finishConfiguredSetup(_ app: XCUIApplication) {
        advanceSetupToReview(app)
        let create = app.buttons["setup-people-next"]
        XCTAssertEqual(create.label, "Create our home")
        create.tap()
    }

    @MainActor
    func chooseMenuItem(_ title: String, in app: XCUIApplication) {
        let item = app.collectionViews.buttons[title].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 3))
        item.tap()
    }

    @MainActor
    func keepScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // MARK: Onboarding

    @MainActor
    func testOnboardingFlowReachesEmptyHome() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["welcome-headline"].waitForExistence(timeout: 5))

        app.buttons["create-pot"].tap()
        XCTAssertTrue(app.staticTexts["Make yourself\nat home."].waitForExistence(timeout: 3))
        XCTAssertEqual(app.textFields["setup-pot-name"].value as? String, "Casa Mar")

        XCTAssertTrue(app.buttons["setup-continue"].isEnabled)
        XCTAssertTrue(app.buttons["setup-continue"].label.hasPrefix("Confirm "))
        app.buttons["setup-continue"].tap()
        XCTAssertTrue(app.staticTexts["Who’s at home?"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.textFields["setup-sam-name"].exists)
        XCTAssertFalse(app.textFields["setup-leo-name"].exists)
        XCTAssertFalse(app.buttons["setup-people-next"].isEnabled)
        app.buttons["setup-add-person"].tap()
        let person = app.textFields["setup-sam-name"]
        XCTAssertTrue(person.waitForExistence(timeout: 3))
        person.tap()
        person.typeText("Sam")
        saveSetupPerson(app)
        XCTAssertTrue(app.buttons["setup-people-next"].isEnabled)

        finishConfiguredSetup(app)
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 3))
        XCTAssertTrue(
            app.staticTexts["No records yet. Your first shared expense starts the story."].waitForExistence(timeout: 3)
        )

        app.buttons["People"].tap()
        // Sheet title / section may surface as nav bar or static header.
        XCTAssertTrue(
            app.navigationBars["People"].waitForExistence(timeout: 3)
                || app.staticTexts["People"].waitForExistence(timeout: 1)
        )
        let samVisible = app.staticTexts["Sam"].waitForExistence(timeout: 3)
            || app.buttons["Invite Sam"].waitForExistence(timeout: 1)
            || app.otherElements.matching(NSPredicate(format: "label CONTAINS[c] %@", "Sam")).firstMatch.waitForExistence(timeout: 1)
        XCTAssertTrue(samVisible, "Expected Sam on the local people roster after setup")
        XCTAssertFalse(app.staticTexts["Leo"].exists)
    }

    @MainActor
    func testOnboardingOpeningBalancesStayExactAndVisible() {
        let app = launch()
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        selectCurrency("USD", in: app)
        app.buttons["setup-continue"].tap()
        app.buttons["setup-add-person"].tap()
        let person = app.textFields["setup-sam-name"]
        XCTAssertTrue(person.waitForExistence(timeout: 3))
        person.tap()
        person.typeText("Sam")
        saveSetupPerson(app)
        advanceSetupToReview(app)
        XCTAssertTrue(app.buttons["Set opening balances"].waitForExistence(timeout: 3))
        revealSetupControl(app.buttons["Set opening balances"], in: app)
        tapWhenSettled(app.buttons["Set opening balances"])

        XCTAssertTrue(app.staticTexts["Opening balances"].waitForExistence(timeout: 3))
        app.textFields["opening-sam-amount"].tap()
        app.textFields["opening-sam-amount"].typeText("25.00")
        XCTAssertFalse(app.textFields["opening-leo-amount"].exists)
        XCTAssertTrue(app.staticTexts["gets back $25"].waitForExistence(timeout: 2))

        app.buttons["save-opening-balances"].tap()

        let headline = app.staticTexts["balance-headline-amount"]
        XCTAssertTrue(headline.waitForExistence(timeout: 3))
        XCTAssertEqual(headline.label, "$25")
        XCTAssertTrue(app.staticTexts["Opening balances saved"].exists)
        XCTAssertTrue(app.buttons["orb-sam"].label.contains("owes $25"))
        // No settlement exists yet — the first-run settle hint is showing.
        XCTAssertTrue(app.buttons["record-repayment"].exists)
        XCTAssertFalse(app.buttons["orb-leo"].exists)
    }

    @MainActor
    func testOnboardingDragCreatesSettlementGroup() {
        let app = launch()
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        app.buttons["setup-continue"].tap()
        addSetupPeople(app)

        let samRow = app.staticTexts["Not invited yet"].firstMatch
        let ownerRow = app.staticTexts["This is you"]
        XCTAssertTrue(samRow.isHittable)
        samRow.press(forDuration: 0.8, thenDragTo: ownerRow)

        advanceSetupToGroups(app)
        XCTAssertTrue(app.staticTexts["Arseny + Sam"].exists)
        XCTAssertEqual(app.buttons["setup-people-next"].label, "Create our home")
        XCTAssertTrue(app.buttons["setup-people-next"].isEnabled)
        advanceSetupToReview(app)
        XCTAssertTrue(app.buttons["Set opening balances"].isEnabled)
        revealSetupControl(app.buttons["Set opening balances"], in: app)
        tapWhenSettled(app.buttons["Set opening balances"])
        XCTAssertTrue(app.staticTexts["Opening balances"].waitForExistence(timeout: 3))
        app.buttons["Skip"].tap()
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testCurrencyConfirmationCommitsAndDismisses() {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()

        XCTAssertTrue(app.buttons["setup-continue"].isEnabled)
        selectCurrency("JPY", in: app)
        app.buttons["setup-continue"].tap()
        XCTAssertTrue(app.staticTexts["Who’s at home?"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testJoinEntryValidatesTheTypedFallbackBeforeAuthentication() {
        let app = launch()
        XCTAssertTrue(app.buttons["join-pot"].waitForExistence(timeout: 5))

        app.buttons["join-pot"].tap()
        XCTAssertTrue(app.textFields["Invite code"].waitForExistence(timeout: 3))
        app.textFields["Invite code"].tap()
        app.textFields["Invite code"].typeText("ABC")
        tapWhenSettled(app.buttons["Check code"])

        XCTAssertTrue(
            app.staticTexts["Invite error: Enter the six-letter or number code."]
                .waitForExistence(timeout: 3)
        )
        XCTAssertFalse(app.buttons["Sign in with Apple"].exists)
    }

    @MainActor
    func testEmptyHomeSeedButtonLoadsJuly() {
        let app = launch(["--qa-home"])
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 5))
        app.buttons["Skip ahead — load July's six records"].tap()
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 3))
    }

    // MARK: Seeded home — the Casa Mar canon

    @MainActor
    func testSeededHomeShowsCanonBalances() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["balance-explanation"].label.contains("Arseny + Maya get back"))
        XCTAssertTrue(app.staticTexts["gets back €130"].exists)
        // The seed already contains settlements, so the first-run settle
        // hint has retired — direction labels stand alone.
        XCTAssertTrue(app.staticTexts["owes €75"].exists)
        XCTAssertTrue(app.staticTexts["owes €55"].exists)
        XCTAssertFalse(app.staticTexts["owes €75 · hold to settle"].exists)
        XCTAssertTrue(app.buttons["record-repayment"].exists)
        XCTAssertTrue(
            app.buttons.matching(
                NSPredicate(format: "label BEGINSWITH 'Activity, 6 records'")
            ).firstMatch.exists
        )
    }

    @MainActor
    func testCreateSecondPotAndSwitchBack() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["pot-switcher"].tap()
        XCTAssertTrue(app.staticTexts["Pots"].waitForExistence(timeout: 3))
        app.buttons["new-pot"].tap()

        XCTAssertTrue(app.staticTexts["Make yourself\nat home."].waitForExistence(timeout: 3))
        let name = app.textFields["setup-pot-name"]
        name.tap()
        name.typeText("Beach House")
        app.buttons["setup-continue"].tap()
        XCTAssertTrue(app.staticTexts["Who’s at home?"].waitForExistence(timeout: 3))
        app.buttons["setup-add-person"].tap()
        let person = app.textFields["setup-sam-name"]
        XCTAssertTrue(person.waitForExistence(timeout: 3))
        person.tap()
        person.typeText("Ana")
        saveSetupPerson(app)
        finishConfiguredSetup(app)

        // The new pot opens empty; the header now names it.
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["pot-switcher"].label.contains("Beach House"))

        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        app.buttons["enable-sync"].tap()
        XCTAssertTrue(
            app.staticTexts["Keep Beach House synced"].waitForExistence(timeout: 3)
        )
        app.buttons["Not now"].tap()
        // Close Settings before reaching the pot switcher; the switcher is
        // unreachable while the Settings sheet covers Home.
        app.buttons["Done"].tap()

        // Casa Mar's ledger is intact after switching back.
        app.buttons["pot-switcher"].tap()
        let backRow = app.buttons["Switch to Casa Mar"]
        XCTAssertTrue(backRow.waitForExistence(timeout: 3))
        backRow.tap()
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["owes €75"].exists)
    }

    @MainActor
    func testHideAmountsPersistsOnThisDevice() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        let hideAmounts = app.switches["hide-amounts-toggle"]
        hideAmounts.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertEqual(hideAmounts.value as? String, "1")
        XCTAssertTrue(app.staticTexts["Amounts appear as €••• only on this iPhone."].exists)
        app.buttons["Done"].tap()
        let headline = app.staticTexts["balance-headline-amount"]
        XCTAssertTrue(headline.waitForExistence(timeout: 3))
        XCTAssertEqual(headline.label, "€•••")

        app.terminate()
        let relaunched = XCUIApplication()
        relaunched.launchArguments = [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "--qa-seeded-home"
        ]
        relaunched.launch()
        let relaunchedHeadline = relaunched.staticTexts["balance-headline-amount"]
        XCTAssertTrue(relaunchedHeadline.waitForExistence(timeout: 5))
        XCTAssertEqual(relaunchedHeadline.label, "€•••")
    }

    @MainActor
    func testAccountDeletionPreviewsSuccessionAndClearsLocalState() {
        let app = launch(["--qa-seeded-home", "--qa-account-deletion"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))

        let deleteAccount = app.buttons["delete-account"]
        for _ in 0..<4 where !deleteAccount.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(deleteAccount.isHittable)
        deleteAccount.tap()

        let dialog = app.sheets["Delete account?"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 3))
        XCTAssertTrue(
            dialog.staticTexts.matching(
                NSPredicate(
                    format: "label CONTAINS 'Ownership of “Casa Mar” will transfer to Maya.'"
                )
            ).firstMatch.exists
        )
        dialog.buttons["Delete account"].tap()

        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["€130"].exists)
    }

    @MainActor
    func testServerBuildFloorReplacesTheAppWithARequiredUpdateScreen() {
        let app = launch(["--qa-seeded-home", "--qa-forced-update"])

        XCTAssertTrue(
            app.otherElements["required-app-update"].waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.staticTexts["Please update Numa Shared"].exists)
        XCTAssertFalse(app.staticTexts["€130"].exists)
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    @MainActor
    func testInitialBootstrapUsesASkeletonInsteadOfUnverifiedFinancialState() {
        let app = launch(["--qa-loading-skeleton"])

        XCTAssertTrue(
            app.otherElements["loading-home-skeleton"].waitForExistence(timeout: 5)
        )
        XCTAssertFalse(app.staticTexts["€130"].exists)
        XCTAssertFalse(app.buttons["create-pot"].exists)
    }

    @MainActor
    func testBootstrapFailureShowsRecoveryAndRetryLoadsVerifiedState() {
        let app = launch(["--qa-onboarding", "--qa-bootstrap-failure"])

        XCTAssertTrue(
            app.staticTexts["Your pot couldn’t be opened"].waitForExistence(timeout: 5)
        )
        XCTAssertFalse(app.buttons["create-pot"].exists)

        app.buttons["local-data-retry"].tap()

        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Your pot couldn’t be opened"].exists)
    }

    @MainActor
    func testAmbiguousLocalWriteShowsRetryBannerAndKeepsVerifiedState() {
        let app = launch(["--qa-seeded-home", "--qa-local-data-error"])

        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts[
                "That change couldn’t be verified. Reload this pot."
            ].exists
        )
        XCTAssertTrue(app.buttons["local-data-banner-retry"].exists)

        app.buttons["local-data-banner-retry"].tap()

        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["local-data-banner-retry"].exists)
    }

    @MainActor
    func testPeopleSurfaceShowsLocalRosterAndSyncBoundary() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["People"].tap()

        XCTAssertTrue(app.navigationBars["People"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Arseny"].exists)
        XCTAssertTrue(app.staticTexts["Sam"].exists)
        XCTAssertTrue(app.staticTexts["Leo"].exists)
        XCTAssertTrue(
            app.staticTexts["Enable sync to invite people and manage roles."].exists
        )
    }

    @MainActor
    func testLocalInviteActionOpensTheAppleIdentityCheckpoint() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons["People"].tap()
        XCTAssertTrue(app.buttons["Invite Sam"].waitForExistence(timeout: 3))

        app.buttons["Invite Sam"].tap()

        XCTAssertTrue(app.staticTexts["Keep Casa Mar synced"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Sign in with Apple"].exists)
        XCTAssertTrue(
            app.staticTexts["This keeps your pots synced and tells friends it’s you."].exists
        )
    }

    @MainActor
    func testCancelingInviteIdentityCheckpointReturnsToPeople() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons["People"].tap()
        XCTAssertTrue(app.buttons["Invite Sam"].waitForExistence(timeout: 3))
        app.buttons["Invite Sam"].tap()
        XCTAssertTrue(app.buttons["Not now"].waitForExistence(timeout: 3))

        app.buttons["Not now"].tap()

        XCTAssertTrue(app.navigationBars["People"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Invite Sam"].exists)
    }

    @MainActor
    func testIssuedInviteShowsCodeShareAndQRCode() {
        let app = launch(["--qa-seeded-home", "--qa-issued-invite"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons["People"].tap()

        XCTAssertTrue(app.staticTexts["SAM234"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Share invite"].exists)
        XCTAssertTrue(app.images["Invite QR code"].exists)
        XCTAssertTrue(app.staticTexts["The link and code expire after 30 days. Numa Shared doesn’t store a recoverable copy of this link."].exists)
        keepScreenshot("ARS-20-invite-branding")
    }

    // MARK: Orb tap → filtered activity with balance explanation

    @MainActor
    func testOrbTapExplainsBalance() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["orb-sam"].tap()
        XCTAssertTrue(app.staticTexts["Sam owes €75"].waitForExistence(timeout: 3))
        // Explanation lines reconcile: −€495 + €120 + €300 = −€75.
        XCTAssertTrue(app.staticTexts["−€495"].exists)
        XCTAssertTrue(app.staticTexts["+€120"].exists)
        XCTAssertTrue(app.staticTexts["+€300"].exists)
        XCTAssertTrue(app.staticTexts["Balances cover the full pot history."].exists)
    }

    // MARK: Add expense — tap path, Everyone preset, split preview, save, undo

    @MainActor
    func testAddExpenseEveryoneSplitSaveAndUndo() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["dock-vessel"].tap() // exposed as a button via .isButton trait
        XCTAssertTrue(app.staticTexts["New expense"].waitForExistence(timeout: 3))

        // 86.40 — "digits are whole euros until '.'"
        for key in ["key-8", "key-6", "key-decimal", "key-4", "key-0"] {
            app.buttons[key].tap()
        }
        app.buttons["Groceries at Lidl"].tap()

        // Everyone preset attaches all three units, 2:1:1.
        selectEveryone(in: app)
        app.buttons["Review split →"].tap()

        XCTAssertTrue(app.staticTexts["Groceries at Lidl — €86.40"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["€43.20"].exists)   // A+M, 2 shares
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == '€21.60'")).count, 2) // Sam + Leo

        app.buttons["Save expense"].tap()
        // A+M paid €86.40, their share €43.20 → net +€43.20 → €173.20 owed.
        XCTAssertTrue(app.staticTexts["€173.20"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Groceries at Lidl €86.40 saved"].exists)

        app.buttons["Undo"].tap()
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testAddExpenseSupportsPayerCategoryAndExactSplit() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["dock-vessel"].tap()
        XCTAssertTrue(app.textFields["expense-merchant"].waitForExistence(timeout: 3))
        for key in ["key-1", "key-0", "key-0"] {
            app.buttons[key].tap()
        }
        app.buttons["Groceries at Lidl"].tap()
        XCTAssertEqual(app.textFields["expense-category"].value as? String, "Groceries")

        app.buttons["expense-payer"].tap()
        chooseMenuItem("Sam", in: app)
        XCTAssertTrue(app.buttons["expense-payer"].label.contains("Paid by Sam"))

        selectEveryone(in: app)
        app.buttons["Review split →"].tap()
        XCTAssertTrue(app.staticTexts["Paid by Sam · today"].waitForExistence(timeout: 3))
        app.buttons["Exact amounts"].tap()

        for unit in ["am", "sam", "leo"] {
            XCTAssertTrue(app.textFields["exact-split-\(unit)"].exists)
        }
        XCTAssertTrue(app.staticTexts["Adds up to €100.00 · paid by Sam"].exists)
    }

    @MainActor
    func testAddExpenseOverflowOffersCompletePeoplePicker() {
        let app = launch(["--qa-seeded-home", "--qa-ten-unit-field"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        app.buttons["dock-vessel"].tap()
        XCTAssertTrue(app.buttons["choose-expense-people"].waitForExistence(timeout: 3))
        app.buttons["choose-expense-people"].tap()
        XCTAssertTrue(app.navigationBars["Who shared it?"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Noor"].exists)
        XCTAssertTrue(app.staticTexts["Zoe"].exists)
        XCTAssertTrue(app.buttons["expense-people-everyone"].exists)
        app.buttons["expense-people-everyone"].tap()
        app.buttons["expense-people-done"].tap()

        app.buttons["key-1"].tap()
        app.buttons["key-0"].tap()
        app.buttons["Review split →"].tap()
        XCTAssertTrue(app.buttons["Exact amounts"].waitForExistence(timeout: 3))
        app.buttons["Exact amounts"].tap()
        app.swipeUp()
        XCTAssertTrue(app.textFields["exact-split-kai"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.textFields["exact-split-kai"].isHittable)
    }

    @MainActor
    func testCaptureAppStoreJourney() {
        let app = launch(["--qa-seeded-home", "--qa-app-store-capture"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Reload sample data"].exists)
        keepScreenshot("01-home")

        app.buttons["dock-vessel"].tap()
        XCTAssertTrue(app.textFields["expense-merchant"].waitForExistence(timeout: 3))
        for key in ["key-8", "key-6", "key-decimal", "key-4", "key-0"] {
            app.buttons[key].tap()
        }
        app.buttons["Groceries at Lidl"].tap()
        selectEveryone(in: app)
        keepScreenshot("02-add-expense")

        app.buttons["Review split →"].tap()
        XCTAssertTrue(app.staticTexts["Groceries at Lidl — €86.40"].waitForExistence(timeout: 3))
        app.buttons["Exact amounts"].tap()
        XCTAssertTrue(app.textFields["exact-split-am"].waitForExistence(timeout: 3))
        keepScreenshot("03-exact-split")

        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["New expense"].waitForExistence(timeout: 3))
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(app.buttons["record-repayment"].waitForExistence(timeout: 3))

        app.buttons["record-repayment"].tap()
        XCTAssertTrue(app.staticTexts["Record a repayment"].waitForExistence(timeout: 3))
        keepScreenshot("04-settle-plan")
        app.buttons["Close"].tap()

        let activity = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Activity'")
        ).firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 3))
        activity.tap()
        XCTAssertTrue(app.staticTexts["On this iPhone until you enable sync."].waitForExistence(timeout: 3))
        keepScreenshot("05-activity")
    }

    @MainActor
    func testCaptureReleaseAppStoreJourney() {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        selectCurrency("EUR", in: app)
        app.buttons["setup-continue"].tap()
        addSetupPeople(app)
        finishConfiguredSetup(app)
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 5))

        app.buttons["dock-vessel"].tap()
        XCTAssertFalse(app.buttons["Groceries at Lidl"].exists)
        let merchant = app.textFields["expense-merchant"]
        XCTAssertTrue(merchant.waitForExistence(timeout: 3))
        merchant.tap()
        merchant.typeText("Groceries at Lidl")
        for key in ["2", "0", "0"] {
            app.buttons[key].tap()
        }
        app.buttons["expense-next-payer"].tap()
        let samRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-payer-' AND label BEGINSWITH 'Sam'")).firstMatch
        XCTAssertTrue(samRow.waitForExistence(timeout: 3)); samRow.tap()
        XCTAssertTrue(app.buttons["expense-split-mode"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["expense-save"].waitForExistence(timeout: 3))
        app.buttons["expense-save"].tap()
        XCTAssertTrue(app.buttons["expense-save"].waitForNonExistence(timeout: 5))
        // Equal shares across the three budget groups: your group owes €66.66
        // of the €200 bill (orbs: €66.66 + €66.68 = Sam's €133.34).
        XCTAssertTrue(app.staticTexts["€66.66"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Undo"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Undo"].waitForNonExistence(timeout: 8))
        Thread.sleep(forTimeInterval: 0.75)
        keepScreenshot("release-01-home")

        app.buttons["dock-vessel"].tap()
        // The approved progressive flow has no merchant-suggestion chips
        // (that is the legacy editor); type the repeat purchase directly.
        let repeatMerchant = app.textFields["expense-merchant"]
        XCTAssertTrue(repeatMerchant.waitForExistence(timeout: 3))
        repeatMerchant.tap()
        repeatMerchant.typeText("Groceries at Lidl")
        for key in ["8", "6", ".", "4", "0"] {
            app.buttons[key].tap()
        }
        keepScreenshot("release-02-add-expense")
        app.buttons["expense-next-payer"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'expense-payer-'")).firstMatch.waitForExistence(timeout: 3))
        // Cancel lives on the entry page; step back from the payer page first.
        app.buttons["expense-back-Paid by"].tap()
        app.buttons["expense-cancel"].tap()
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 3))
        app.buttons["record-repayment"].waitForExistence(timeout: 3)
        app.buttons["record-repayment"].tap()
        XCTAssertTrue(app.staticTexts["Record a repayment"].waitForExistence(timeout: 3))
        keepScreenshot("release-04-settle-plan")
        app.buttons["Close"].tap()

        let activity = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Activity'")
        ).firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 3))
        activity.tap()
        XCTAssertTrue(app.staticTexts["On this iPhone until you enable sync."].waitForExistence(timeout: 3))
        keepScreenshot("release-05-activity")
    }

    // MARK: Record detail — void keeps the record visible, restores balances

    @MainActor
    func testVoidRestoreKeepsHistoryVisible() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))

        // The activity peek is one Button whose label aggregates its rows.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Activity'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["On this iPhone until you enable sync."].waitForExistence(timeout: 3))

        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Groceries at Lidl'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["void-record"].waitForExistence(timeout: 3))

        app.buttons["void-record"].tap()
        let confirm = app.buttons["confirm-void-record"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 3))
        XCTAssertFalse(confirm.isEnabled)
        app.textFields["void-reason"].tap()
        app.textFields["void-reason"].typeText("Duplicate receipt")
        XCTAssertTrue(confirm.isEnabled)
        confirm.tap()
        // Record stays visible in activity, struck through with a Void badge.
        XCTAssertTrue(app.staticTexts["Void"].waitForExistence(timeout: 3))

        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Groceries at Lidl'")).firstMatch.tap()
        XCTAssertTrue(
            app.staticTexts[
                "Voided — Duplicate receipt. Balances restored; the record stays visible."
            ].waitForExistence(timeout: 3)
        )
        app.buttons["Restore record"].tap()
        XCTAssertTrue(app.staticTexts["Groceries at Lidl restored"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testActivitySearchFiltersAndExpenseEditPreview() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Activity'")
        ).firstMatch.tap()

        XCTAssertTrue(app.textFields["activity-search"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["activity-kind-filter"].exists)
        XCTAssertTrue(app.buttons["activity-period-filter"].exists)
        app.textFields["activity-search"].tap()
        app.textFields["activity-search"].typeText("Groceries")
        let groceries = app.buttons.matching(
            NSPredicate(format: "label CONTAINS 'Groceries at Lidl'")
        ).firstMatch
        XCTAssertTrue(groceries.waitForExistence(timeout: 3))
        groceries.tap()
        XCTAssertTrue(app.buttons["edit-record"].waitForExistence(timeout: 3))
        app.buttons["edit-record"].tap()
        XCTAssertTrue(app.staticTexts["Balance impact"].waitForExistence(timeout: 3))
        app.buttons["key-delete"].tap()
        app.buttons["key-1"].tap()
        app.buttons["save-record-edit"].tap()
        XCTAssertTrue(app.staticTexts["€120.01 · Expense"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["REVISION HISTORY"].exists)
    }

    @MainActor
    func testRepeatPastExpenseCreatesANewUndoableRecord() {
        let app = launch(["--qa-seeded-home"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Activity'")
        ).firstMatch.tap()
        let groceries = app.buttons.matching(
            NSPredicate(format: "label CONTAINS 'Groceries at Lidl'")
        )
        XCTAssertTrue(groceries.firstMatch.waitForExistence(timeout: 3))
        groceries.firstMatch.tap()
        XCTAssertTrue(app.buttons["repeat-record"].waitForExistence(timeout: 3))
        app.buttons["repeat-record"].tap()

        XCTAssertTrue(
            app.staticTexts["Groceries at Lidl repeated"].waitForExistence(timeout: 3)
        )
        XCTAssertTrue(app.buttons["Undo"].firstMatch.isEnabled)
    }

    @MainActor
    func testContestedRecordComparesVersionsAndRecordsExplicitChoice() {
        let app = launch(["--qa-contested-record"])
        let activity = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Activity'")
        ).firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        activity.tap()

        let contestedRow = app.buttons.matching(
            NSPredicate(format: "label CONTAINS 'Groceries — Leo edit'")
        ).firstMatch
        XCTAssertTrue(contestedRow.waitForExistence(timeout: 3))
        contestedRow.tap()

        XCTAssertTrue(app.staticTexts["Two edits need your choice"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Groceries — Sam edit"].exists)
        XCTAssertTrue(app.staticTexts["Groceries — Leo edit"].exists)
        XCTAssertTrue(app.staticTexts["Balance impact"].exists)
        XCTAssertTrue(app.buttons["contest-use-1"].exists)
        XCTAssertTrue(app.buttons["contest-use-2"].exists)

        app.buttons["contest-use-1"].tap()

        XCTAssertTrue(app.staticTexts["Groceries — Sam edit"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Two edits need your choice"].exists)
        XCTAssertTrue(app.staticTexts["Choice recorded for Groceries — Sam edit"].exists)
    }

    @MainActor
    func testEnableSyncExplainsIdentityCheckpointWithoutStartingAppleUI() {
        let app = launch(["--qa-home"])
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        let enableSync = app.buttons["enable-sync"]
        XCTAssertTrue(enableSync.waitForExistence(timeout: 3))

        enableSync.tap()

        XCTAssertTrue(app.staticTexts["Keep Casa Mar synced"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["This keeps your pots synced and tells friends it’s you."].exists)
        XCTAssertTrue(app.buttons["Sign in with Apple"].exists)
        XCTAssertTrue(app.buttons["Not now"].exists)
    }

    @MainActor
    func testPrimaryP4SurfacesPassTheSystemAccessibilityAudit() throws {
        // Still-motion: the checker samples rendered pixels, so breath,
        // shimmer, and the entrance stagger must be frozen — the audit
        // measures the settled (Reduce Motion-equivalent) presentation.
        let app = launch(["--qa-seeded-home", "--qa-hide-status-bar", "--qa-still-motion"])
        XCTAssertTrue(app.staticTexts["€130"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["orb-sam"].waitForExistence(timeout: 3))
        try auditVisibleContent(app)

        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        // Audit the presented sheet, not its rising animation frames.
        waitUntilSettled(app.buttons["enable-sync"])
        XCTAssertEqual(app.buttons["enable-sync"].label, "Enable sync")
        try auditVisibleContent(app)

        app.terminate()
        let accessibilityApp = launch([
            "--qa-seeded-home",
            "--qa-hide-status-bar",
            "--qa-still-motion",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityXXXL",
        ])
        XCTAssertTrue(accessibilityApp.buttons["dock-vessel"].waitForExistence(timeout: 5))
        try auditVisibleContent(accessibilityApp)
    }

    /// Runs the full system audit. The contrast check samples screen pixels,
    /// so for an element partly under the floating Home tab bar or past the
    /// window edge it measures the bar or nothing instead of the element.
    /// Only those contrast issues are set aside, each one is recorded, and
    /// every other issue (including contrast on fully visible content) fails.
    @MainActor
    func auditVisibleContent(_ app: XCUIApplication) throws {
        let window = app.windows.firstMatch.frame
        let tabs = ["home-tab-home", "home-tab-activity", "home-tab-people"]
            .map { app.buttons[$0] }.filter(\.exists).map(\.frame)
        let bar = tabs.reduce(CGRect.null) { $0.union($1) }.insetBy(dx: -8, dy: -8)
        // The bar's own labels are visible content and stay fully audited.
        let barLabels: Set<String> = ["Home", "Activity", "People"]
        var setAside: [String] = []
        var failures: [String] = []
        try app.performAccessibilityAudit { issue in
            let frame = issue.element?.frame ?? .null
            let line = "\(issue.compactDescription): \(issue.element?.label ?? "unknown element") at \(frame)"
            let pastWindow = !frame.isNull && !window.contains(frame)
            let underBar = !frame.isNull && !bar.isNull && frame.intersects(bar)
                && !barLabels.contains(issue.element?.label ?? "")
            if issue.auditType == .contrast && (pastWindow || underBar) {
                setAside.append(line)
            } else {
                failures.append(line)
            }
            return true
        }
        if !setAside.isEmpty {
            let note = XCTAttachment(string: setAside.joined(separator: "\n"))
            note.name = "audit-contrast-set-aside"
            note.lifetime = .keepAlways
            add(note)
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }
}
