import XCTest

final class SettingsJourneyUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func openLocalSettings() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "--qa-shared-table-reference", "--qa-reset-privacy", "--qa-still-motion"
        ]
        app.launch()
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.buttons["prepare-csv-export"].waitForExistence(timeout: 3))
        return app
    }

    @MainActor
    func testCSVExportOpensSystemShareSheetWithOneAction() {
        let app = openLocalSettings()
        let export = app.buttons["prepare-csv-export"]
        for _ in 0..<5 {
            if export.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(export.isHittable)
        XCTAssertEqual(export.label, "Export CSV")
        XCTAssertTrue(app.staticTexts["csv-export-disclosure"].exists,
                      "Exact-amount disclosure remains in the export section.")
        XCTAssertFalse(app.buttons["share-csv-export"].exists,
                       "A second share action is needed only for a freshness warning.")
        export.tap()
        // iOS 27 exposes system share actions as cells; older runtimes may
        // expose buttons. Assert their user-visible actions across both.
        let copy = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Copy'")).firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 8),
                      "A current export should open native sharing directly after preparation.\n" + app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Save to Files'")).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "journey-settings-single-action-csv-share"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        // Opening sharing is the end of this check. No destination is selected
        // and no message or file is sent to another application.
    }

    @MainActor
    func testLocalSettingsKeepNotificationPermissionBehindSync() {
        let app = openLocalSettings()
        XCTAssertFalse(app.switches["settings-pot-mute"].isEnabled)
        XCTAssertFalse(app.buttons["allow-notifications"].exists)
        XCTAssertTrue(app.staticTexts[
            "Enable sync before changing this pot’s notifications."
        ].exists)
    }
}
