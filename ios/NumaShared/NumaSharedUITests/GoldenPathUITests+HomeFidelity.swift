import XCTest

extension GoldenPathUITests {
    @MainActor
    func testHomeLongHouseholdNamesReflowWithoutChangingTheLedger() throws {
        let app = launch(["--qa-shared-table-reference", "--qa-long-household-names", "--qa-still-motion"])
        let household = app.buttons["pot-switcher"]
        XCTAssertTrue(household.waitForExistence(timeout: 5))
        XCTAssertEqual(household.label, "Our very welcoming shared household by the sea")
        XCTAssertGreaterThan(household.frame.height, 50.5)
        XCTAssertTrue(household.isHittable)
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'orb-' AND label CONTAINS 'Samantha Alexandra'")).firstMatch
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'orb-' AND label CONTAINS 'Josephine Gabriella'")).firstMatch
        for group in [first, second] {
            XCTAssertTrue(group.exists)
            XCTAssertTrue(group.isHittable)
            XCTAssertGreaterThanOrEqual(group.frame.height, 44)
            XCTAssertLessThanOrEqual(group.frame.maxX, app.frame.maxX - 24)
        }
        XCTAssertEqual(app.staticTexts["balance-headline-amount"].label, "€84")
        let image = XCTAttachment(data: XCUIScreen.main.screenshot().pngRepresentation, uniformTypeIdentifier: "public.png")
        image.name = "ars117-home-long-names-native"
        image.lifetime = .keepAlways
        add(image)
        let sentence = app.staticTexts["You + Samantha Alexandra owe\nAlexandria Elizabeth + Josephine Gabriella"]
        XCTAssertTrue(sentence.exists)
        XCTAssertGreaterThan(sentence.frame.height, 80)
    }

    @MainActor
    func testApprovedHomeReferenceGeometryAndRealActions() throws {
        let app = launch(["--qa-shared-table-reference", "--qa-still-motion"])
        let amount = app.staticTexts["balance-headline-amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 5))
        XCTAssertEqual(amount.label, "€84")
        XCTAssertTrue(app.buttons["balance-explanation"].label.contains("You + Sam owe"))
        XCTAssertTrue(app.staticTexts["Dinner together"].exists)
        XCTAssertTrue(app.staticTexts["Internet"].exists)
        XCTAssertTrue(app.staticTexts["Alex paid · yesterday"].exists)
        XCTAssertTrue(app.staticTexts["Jo paid · 10 September"].exists)
        XCTAssertTrue(app.staticTexts["€96.00"].exists)
        XCTAssertTrue(app.staticTexts["€72.00"].exists)

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(springboard.staticTexts["Ready for Apple Intelligence"].waitForNonExistence(timeout: 15))
        let screenshot = XCUIScreen.main.screenshot()
        // Preserve the original PNG bytes. UIImage's conversion can normalize
        // a raster differently; read the PNG's IHDR dimensions directly.
        let png = screenshot.pngRepresentation
        let pixelWidth = png[16..<20].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let pixelHeight = png[20..<24].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let image = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        image.name = "ars117-approved-09-home-native-393x852"
        image.lifetime = .keepAlways
        add(image)
        let identifiers = ["pot-switcher", "home-obligation-sentence", "balance-explanation",
            "balance-headline-amount", "record-repayment", "dock-vessel", "home-latest-heading", "home-tab-home", "home-tab-activity", "home-tab-people"]
        let geometry = identifiers.map { identifier -> String in
            let element = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
            guard element.exists else { return "\(identifier): exists=false" }
            return "\(identifier): frame=\(element.frame)"
        }.joined(separator: "\n")
        let measured = XCTAttachment(string: "PNG=\(pixelWidth)x\(pixelHeight) appFrame=\(app.frame)\n" + geometry)
        measured.name = "ars117-approved-home-native-geometry"
        measured.lifetime = .keepAlways
        add(measured)
        for id in ["record-repayment", "dock-vessel"] {
            let action = app.buttons[id]
            XCTAssertTrue(action.isHittable)
            XCTAssertGreaterThanOrEqual(action.frame.width, 44)
            XCTAssertGreaterThanOrEqual(action.frame.height, 44)
        }

        app.buttons["balance-explanation"].tap()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'You + Sam'")).firstMatch.exists)
        app.buttons["Close"].tap()
        app.buttons["dock-vessel"].tap()
        XCTAssertTrue(app.buttons["expense-next-payer"].waitForExistence(timeout: 3))
        app.buttons["expense-cancel"].tap()
        app.buttons["record-repayment"].tap()
        // A single planned transfer opens its amount directly (5466758),
        // so there is no plan row to choose first.
        XCTAssertTrue(app.buttons["Mark as paid"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["manual-settlement"].exists)
        XCTAssertTrue(app.buttons["Exact €84.00"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'both groups are even'")).firstMatch.exists)
        // Physical simulator framebuffer is1179wide; both raw XCTest PNG
        // and UIImage normalize it to1178. Native app bounds remain393pt.
        // Preserve the original raster; comparison documents this1px rounding.
        // The 393×852 reference assertion is the exact-model fidelity lane
        // (scripts/README "Approved interface comparison"); larger devices
        // still capture the same native geometry attachment for comparison.
        if app.frame.width == 393 {
            XCTAssertEqual(pixelWidth, 1178)
            XCTAssertEqual(pixelHeight, 2556)
        } else {
            XCTAssertEqual(app.frame.width, 440)
            XCTAssertEqual(pixelWidth, 1320)
            XCTAssertEqual(pixelHeight, 2868)
        }
    }
}
