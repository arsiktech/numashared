// Performance boundary of the golden path — split from
// GoldenPathUITests.swift as a pure move; discovery stays on the one class.

import XCTest

extension GoldenPathUITests {
    // MARK: Performance boundary


    @MainActor
    func testColdLaunchToInteractiveWelcomeIsUnderOnePointFiveSeconds() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "--qa-reset-privacy", "--qa-onboarding",
        ]
        let options = XCTMeasureOptions()
        options.iterationCount = 1
        var appReadyMilliseconds = Int.max

        measure(
            metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)],
            options: options
        ) {
            app.launch()
            let createPot = app.buttons["create-pot"]
            XCTAssertTrue(createPot.waitForExistence(timeout: 5))
            appReadyMilliseconds = Int(createPot.value as? String ?? "") ?? .max
            app.terminate()
        }

        XCTAssertLessThan(
            appReadyMilliseconds,
            1_500,
            "Cold launch must reach the interactive welcome in under 1.5 seconds"
        )
    }

    @MainActor
    func testAddOrbTapRecordsCPUAndFrameHitches() {
        let app = launch(["--qa-seeded-home", "--qa-eight-unit-field"])
        let vessel = app.buttons["dock-vessel"]
        let target = app.buttons["orb-ivy"]
        XCTAssertTrue(vessel.waitForExistence(timeout: 5))
        for unit in ["am", "sam", "leo", "noor", "ivy", "max", "zoe", "eli"] {
            XCTAssertTrue(app.buttons["orb-\(unit)"].exists, "Expected production field unit \(unit)")
        }
        XCTAssertTrue(target.exists)
        for _ in 0..<5 where !vessel.isHittable { app.scrollViews["home-scroll"].swipeUp() }
        XCTAssertTrue(vessel.isHittable)
        let frameRate = app.staticTexts["field-sustained-fps"]
        XCTAssertTrue(frameRate.waitForExistence(timeout: 3))
        let options = XCTMeasureOptions()
        options.iterationCount = 1
        options.invocationOptions = [.manuallyStart, .manuallyStop]

        func prepareField() {
            if app.staticTexts["New expense"].exists {
                app.buttons["Close"].tap()
                XCTAssertTrue(vessel.waitForExistence(timeout: 3))
            }
        }

        measure(
            metrics: [XCTHitchMetric(application: app), XCTCPUMetric(application: app)],
            options: options
        ) {
            prepareField()
            startMeasuring()
            // Tap the labeled row, not a retired hidden drag-to-person path.
            vessel.tap()
            XCTAssertTrue(app.staticTexts["New expense"].waitForExistence(timeout: 3))
            stopMeasuring()
        }
        XCTAssertTrue(app.staticTexts["New expense"].waitForExistence(timeout: 3))
        app.buttons["Close"].tap()
        XCTAssertTrue(vessel.waitForExistence(timeout: 3))
        let measuredFramesPerSecond = Double(frameRate.value as? String ?? "") ?? 0
        print("SUSTAINED_EIGHT_UNIT_FIELD_FPS \(measuredFramesPerSecond)")
        XCTAssertGreaterThanOrEqual(
            measuredFramesPerSecond,
            59,
            "The 8-unit production field must sustain the 60 fps target"
        )
    }

    @MainActor
    func testMoreClusterRepresentsOverflowBeyondEightSettlementUnits() {
        let app = launch(["--qa-seeded-home", "--qa-ten-unit-field"])

        XCTAssertTrue(app.buttons["orb-more"].waitForExistence(timeout: 5))
        XCTAssertEqual(
            app.buttons.matching(
                NSPredicate(format: "identifier BEGINSWITH 'orb-'")
            ).count,
            8
        )
        XCTAssertTrue(app.buttons["orb-more"].label.contains("More"))
    }
}
