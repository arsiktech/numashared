import XCTest

extension GoldenPathUITests {
    @MainActor
    func testBlankOwnerCanReturnToPeopleAndCompleteSetup() {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap(); app.buttons["setup-continue"].tap()
        let owner = app.textFields["setup-owner-name"]
        XCTAssertTrue(owner.waitForExistence(timeout: 3))
        replaceSetupName(owner, with: "")
        XCTAssertTrue(app.staticTexts["Enter your name to continue."].exists)
        app.buttons["setup-back-Your people"].tap()
        app.buttons["setup-continue"].tap()
        XCTAssertTrue(owner.waitForExistence(timeout: 3), "An empty owner name must not trap Create.")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        owner.typeText("Ari\n")
        app.buttons["setup-add-person"].tap()
        let person = app.textFields["setup-sam-name"]
        XCTAssertTrue(person.waitForExistence(timeout: 3)); person.typeText("Sam\n")
        XCTAssertTrue(app.buttons["setup-people-next"].waitForExistence(timeout: 3))
        app.buttons["setup-people-next"].tap(); app.buttons["setup-people-next"].tap()
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testReviewEditsHouseholdCurrencyAndEitherCoupleMemberInPlace() throws {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap(); app.buttons["setup-continue"].tap()
        for (id, name) in [("sam", "Sam"), ("leo", "Alex")] {
            app.buttons["setup-add-person"].tap()
            let field = app.textFields["setup-\(id)-name"]
            XCTAssertTrue(field.waitForExistence(timeout: 3)); field.typeText(name + "\n")
            XCTAssertTrue(app.buttons["setup-add-person"].waitForExistence(timeout: 3))
        }
        app.buttons["setup-people-next"].tap()
        let household = app.buttons["setup-edit-household"]
        XCTAssertTrue(household.waitForExistence(timeout: 3)); household.tap()
        let name = app.textFields["setup-household-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3)); replaceSetupName(name, with: "Sunday House")
        XCTAssertTrue(household.waitForExistence(timeout: 3))
        XCTAssertTrue(household.label.contains("Sunday House"))
        app.buttons["setup-edit-currency"].tap()
        let gbp = app.buttons["currency-GBP"]
        XCTAssertTrue(gbp.waitForExistence(timeout: 3)); gbp.tap()
        let currency = app.buttons["setup-edit-currency"]
        XCTAssertTrue(currency.waitForExistence(timeout: 3)); XCTAssertTrue(currency.label.contains("GBP"))
        XCTAssertEqual(app.staticTexts["setup-progress"].label, "Setup step 3 of 3")
        let sam = app.buttons["Group options for Sam"]
        revealSetupControl(sam, in: app); sam.tap()
        chooseMenuItem("Share a balance with Arseny", in: app)
        let couple = app.buttons["Group options for Arseny"]
        revealSetupControl(couple, in: app); couple.tap()
        chooseMenuItem("Edit Sam", in: app)
        let second = app.textFields["setup-sam-name"]
        XCTAssertTrue(second.waitForExistence(timeout: 3)); replaceSetupName(second, with: "Samira")
        XCTAssertTrue(couple.waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["setup-group-count"].label, "2 balance groups")
        XCTAssertTrue(app.staticTexts["Arseny + Samira"].exists)
        attachSetupReference("onboarding-review-direct-corrections")
        var issues: [String] = []
        try app.performAccessibilityAudit(for: [.dynamicType, .hitRegion, .sufficientElementDescription]) { issue in
            let target = issue.element.map { "label=\($0.label) id=\($0.identifier) frame=\($0.frame)" } ?? "No element"
            issues.append("\(issue.compactDescription): \(target)")
            return true
        }
        XCTAssertTrue(issues.isEmpty, issues.joined(separator: "\n"))
        app.buttons["setup-people-next"].tap()
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["pot-switcher"].label, "Sunday House")
        app.buttons["dock-vessel"].tap()
        // Locale supplies the display name; assert the persisted ISO currency.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' · GBP'")).firstMatch.waitForExistence(timeout: 3))
    }

    @MainActor
    func testSetupDirectCurrencyAndKeyboardSaveReachSingleReview() {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        XCTAssertEqual(app.staticTexts["setup-progress"].label, "Setup step 1 of 3")
        let confirm = app.buttons["setup-continue"]
        XCTAssertTrue(confirm.isEnabled)
        XCTAssertEqual(confirm.label, "Confirm USD & continue")
        confirm.tap()
        XCTAssertTrue(app.textFields["setup-owner-name"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["currency-use"].exists, "A separate picker is unnecessary when accepting the visible currency.")
        XCTAssertEqual(app.staticTexts["setup-progress"].label, "Setup step 2 of 3")
        app.buttons["setup-add-person"].tap()
        let name = app.textFields["setup-sam-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "The sole name field should focus automatically.")
        // No field-focus tap and no separate Save tap: Return is the visible
        // keyboard equivalent of the guarded Save person action.
        name.typeText("\n")
        XCTAssertTrue(name.exists, "An empty Return must not add a person.")
        XCTAssertFalse(app.buttons["setup-person-save"].isEnabled)
        name.typeText("Sam\n")
        XCTAssertTrue(app.buttons["setup-add-person"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["setup-person-save"].exists)
        app.buttons["setup-people-next"].tap()
        XCTAssertEqual(app.staticTexts["setup-progress"].label, "Setup step 3 of 3")
        XCTAssertEqual(app.buttons["setup-people-next"].label, "Create our home")
        XCTAssertTrue(app.staticTexts["Household"].exists)
        XCTAssertTrue(app.staticTexts["Currency"].exists)
        XCTAssertTrue(app.staticTexts["USD"].exists)
        XCTAssertEqual(app.staticTexts["setup-group-count"].label, "2 balance groups")
        attachSetupReference("journey-three-step-setup-review")
        app.buttons["setup-people-next"].tap()
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testSetupReviewCorrectsGroupsWithoutAnotherScreen() {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        app.buttons["setup-continue"].tap()
        app.buttons["setup-add-person"].tap()
        let name = app.textFields["setup-sam-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        name.typeText("Sam\n")
        XCTAssertTrue(app.buttons["setup-add-person"].waitForExistence(timeout: 3))
        app.buttons["setup-people-next"].tap()
        let samOptions = app.buttons["Group options for Sam"]
        revealSetupControl(samOptions, in: app)
        samOptions.tap()
        chooseMenuItem("Share a balance with Arseny", in: app)
        XCTAssertEqual(app.staticTexts["setup-group-count"].label, "1 balance group")
        XCTAssertFalse(app.buttons["setup-people-next"].isEnabled, "One financial group cannot form a shared ledger.")
        XCTAssertTrue(app.staticTexts["setup-group-requirement"].exists)
        XCTAssertFalse(app.buttons["Set opening balances"].isEnabled)
        let ownerOptions = app.buttons["Group options for Arseny"]
        revealSetupControl(ownerOptions, in: app)
        ownerOptions.tap()
        chooseMenuItem("Keep balances separate", in: app)
        XCTAssertEqual(app.staticTexts["setup-group-count"].label, "2 balance groups")
        XCTAssertEqual(app.buttons["setup-people-next"].label, "Create our home")
        XCTAssertTrue(app.buttons["setup-people-next"].isEnabled)
        XCTAssertEqual(app.staticTexts["setup-progress"].label, "Setup step 3 of 3")
        attachSetupReference("journey-setup-groups-corrected-in-place")
        app.buttons["setup-people-next"].tap()
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testWelcomeAccessibilityAudit() throws {
        let app = launch(["--qa-onboarding", "--qa-still-motion", "--qa-hide-status-bar"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        try app.performAccessibilityAudit()
    }

    @MainActor
    func testApprovedWelcomeReferenceAndRealActions() throws {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        let create = app.buttons["create-pot"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        XCTAssertEqual(create.label, "Create our home")
        XCTAssertEqual(app.buttons["join-pot"].label, "I have an invite")
        XCTAssertTrue(app.staticTexts["welcome-headline"].exists)
        for action in [create, app.buttons["join-pot"]] {
            XCTAssertTrue(action.isHittable)
            XCTAssertGreaterThanOrEqual(action.frame.height, 44)
        }
        let screenshot = XCUIScreen.main.screenshot()
        let image = XCTAttachment(data: screenshot.pngRepresentation, uniformTypeIdentifier: "public.png")
        image.name = "ars117-approved-01-welcome-native"
        image.lifetime = .keepAlways
        add(image)
        let geometry = XCTAttachment(string: "app=\(app.frame)\ncreate=\(create.frame)\njoin=\(app.buttons["join-pot"].frame)")
        geometry.name = "ars117-approved-welcome-geometry"
        geometry.lifetime = .keepAlways
        add(geometry)
        create.tap()
        XCTAssertTrue(app.textFields["setup-pot-name"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testApprovedCreateCurrencyAndConfirmation() throws {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        XCTAssertTrue(app.buttons["setup-continue"].isEnabled, "The labelled Confirm action provides explicit currency consent.")
        let name = app.textFields["setup-pot-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        let oldName = name.value as? String ?? ""
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        // Submit via the keyboard return; the Done key is AX-unreachable on iOS 27.
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: oldName.count) + "Our place\n")
        selectCurrency("EUR", in: app)
        XCTAssertEqual(name.value as? String, "Our place")
        XCTAssertTrue(app.buttons["setup-continue"].isEnabled)
        attachSetupReference("ars117-approved-02-create-native")
        app.buttons["setup-currency"].tap()
        XCTAssertTrue(app.textFields["currency-search"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["currency-EUR"].value as? String, "Selected")
        attachSetupReference("ars117-approved-03-currency-native")
        app.buttons["setup-back-Currency"].tap()
        XCTAssertTrue(app.buttons["setup-currency"].label.contains("EUR"), "Leaving the picker without selecting must retain EUR.")
        app.buttons["setup-currency"].tap()
        XCTAssertTrue(app.buttons["currency-GBP"].waitForExistence(timeout: 3))
        app.buttons["currency-GBP"].tap()
        XCTAssertTrue(app.buttons["setup-currency"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["setup-currency"].label.contains("GBP"))
        XCTAssertEqual(app.buttons["setup-continue"].label, "Confirm GBP & continue")
        XCTAssertFalse(app.buttons["currency-use"].exists)
        app.buttons["setup-continue"].tap()
        XCTAssertTrue(app.textFields["setup-owner-name"].waitForExistence(timeout: 3), "Owner identity remains editable with people.")
    }

    @MainActor
    func testApprovedPeopleGroupsAndReadyAreRealSetup() throws {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 5))
        app.buttons["create-pot"].tap()
        replaceSetupName(app.textFields["setup-pot-name"], with: "Our place")
        selectCurrency("EUR", in: app)
        app.buttons["setup-continue"].tap()
        let owner = app.textFields["setup-owner-name"]
        XCTAssertTrue(owner.waitForExistence(timeout: 3))
        replaceSetupName(owner, with: "You")
        for (identifier, name) in [("setup-sam-name", "Sam"), ("setup-leo-name", "Alex")] {
            app.buttons["setup-add-person"].tap()
            let field = app.textFields[identifier]
            XCTAssertTrue(field.waitForExistence(timeout: 3))
            field.tap(); field.typeText(name)
            saveSetupPerson(app)
        }
        app.buttons["setup-add-person"].tap()
        let jo = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'setup-remote:'")).firstMatch
        XCTAssertTrue(jo.waitForExistence(timeout: 3))
        jo.tap(); jo.typeText("Jo")
        attachSetupReference("ars117-approved-05-add-person-native")
        saveSetupPerson(app)
        app.buttons["Group options for Sam"].tap()
        chooseMenuItem("Share a balance with You", in: app)
        app.buttons["Group options for Jo"].tap()
        chooseMenuItem("Share a balance with Alex", in: app)
        XCTAssertEqual(app.buttons["setup-people-next"].label, "Continue with 4 people")
        attachSetupReference("ars117-approved-04-setup-people-native")
        advanceSetupToReview(app)
        XCTAssertEqual(app.buttons["setup-people-next"].label, "Create our home")
        XCTAssertTrue(app.staticTexts["You + Sam"].exists)
        XCTAssertTrue(app.staticTexts["Alex + Jo"].exists)
        XCTAssertFalse(app.buttons["setup-edit-groups"].exists, "The review edits groups directly.")
        attachSetupReference("journey-setup-review-native")
        let alexOptions = app.buttons["Group options for Alex"]
        revealSetupControl(alexOptions, in: app)
        alexOptions.tap()
        chooseMenuItem("Keep balances separate", in: app)
        XCTAssertEqual(app.staticTexts["setup-group-count"].label, "3 balance groups")
        attachSetupReference("journey-setup-review-separate-native")
        revealSetupControl(alexOptions, in: app)
        alexOptions.tap()
        chooseMenuItem("Share a balance with Jo", in: app)
        XCTAssertEqual(app.staticTexts["setup-group-count"].label, "2 balance groups")
        XCTAssertEqual(app.buttons["setup-people-next"].label, "Create our home")
        attachSetupReference("journey-setup-review-corrected-native")
        app.buttons["setup-people-next"].tap()
        XCTAssertTrue(app.buttons["dock-vessel"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Nothing shared yet"].exists)
        XCTAssertFalse(app.staticTexts["€84"].exists, "Onboarding must not import the illustrative Home ledger.")
    }

    @MainActor
    private func replaceSetupName(_ field: XCUIElement, with name: String) {
        let old = field.value as? String ?? ""
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        // A trailing newline submits (onSubmit) instead of tapping the keyboard's
        // Done key, whose frame is AX-unreachable on iOS 27 simulators.
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + name + "\n")
    }

    @MainActor
    private func attachSetupReference(_ name: String) {
        let image = XCTAttachment(data: XCUIScreen.main.screenshot().pngRepresentation, uniformTypeIdentifier: "public.png")
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }

    @MainActor
    func testWelcomeInviteUsesRealJoinFlow() {
        let app = launch(["--qa-onboarding", "--qa-still-motion"])
        let join = app.buttons["join-pot"]
        XCTAssertTrue(join.waitForExistence(timeout: 5))
        join.tap()
        XCTAssertFalse(app.textFields["setup-pot-name"].exists)
        XCTAssertTrue(app.buttons["Close join pot"].waitForExistence(timeout: 3))
        app.buttons["Close join pot"].tap()
        XCTAssertTrue(app.buttons["create-pot"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testWelcomeLargeTextStillMotionCanCreate() {
        let app = launch(["--qa-onboarding", "--qa-still-motion",
                          "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let create = app.buttons["create-pot"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        let top = XCTAttachment(screenshot: app.screenshot())
        top.name = "Welcome — accessibility text top"
        top.lifetime = .keepAlways
        add(top)
        for _ in 0..<5 where !create.isHittable { app.swipeUp() }
        XCTAssertTrue(create.isHittable)
        let actions = XCTAttachment(screenshot: app.screenshot())
        actions.name = "Welcome — accessibility text actions"
        actions.lifetime = .keepAlways
        add(actions)
        create.tap()
        XCTAssertTrue(app.textFields["setup-pot-name"].waitForExistence(timeout: 3))
    }
}
