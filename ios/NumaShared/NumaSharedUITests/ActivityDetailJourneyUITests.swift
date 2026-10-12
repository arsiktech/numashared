import XCTest
import UIKit

final class ActivityDetailJourneyUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launchActivity(
        _ arguments: [String], appearance: XCUIDevice.Appearance? = nil
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "--qa-reset-privacy", "--qa-still-motion"
        ] + arguments
        app.launch()
        XCTAssertTrue(app.buttons["home-tab-activity"].waitForExistence(timeout: 5))
        if let appearance {
            // Establish the device style after bootstrap, then launch under that
            // confirmed style. iOS 27 XCTest sometimes keeps the initial app
            // traits after its live appearance setter; a manual dark launch
            // renders the app correctly. This fixture verifies dark rendering.
            // The first change after a fresh simulator boot can also be
            // dropped entirely, so confirm the rendered style and reapply it
            // a bounded number of times. Callers still assert the result.
            for _ in 0..<3 {
                XCUIDevice.shared.appearance = appearance
                XCTAssertEqual(XCUIDevice.shared.appearance, appearance)
                app.terminate()
                app.launch()
                XCTAssertTrue(app.buttons["home-tab-activity"].waitForExistence(timeout: 5))
                guard appearance == .dark,
                      let brightness = try? sampleBrightness(app, x: 0.5, y: 0.94),
                      brightness >= 0.35
                else { break }
                XCUIDevice.shared.appearance = .light
                RunLoop.current.run(until: Date().addingTimeInterval(1))
            }
        }
        app.buttons["home-tab-activity"].tap()
        XCTAssertTrue(app.textFields["activity-search"].waitForExistence(timeout: 3))
        return app
    }

    @MainActor
    private func row(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'activity-row-' AND label CONTAINS %@", title
        )).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        let list = app.scrollViews.containing(.button, identifier: row.identifier).firstMatch
        for _ in 0..<8 {
            if row.isHittable && row.frame.maxY <= list.frame.maxY { break }
            list.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(row.isHittable)
        return row
    }

    @MainActor
    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Check the rendered sheet surface, not just the requested device setting.
    /// The lower-center point is blank sheet background in these two fixtures.
    @MainActor
    private func assertDarkSurface(_ app: XCUIApplication) throws {
        let brightness = try sampleBrightness(app, x: 0.5, y: 0.94)
        XCTAssertLessThan(brightness, 0.35,
                          "Expected the dark sheet palette before recording dark evidence; brightness=\(brightness)")
    }

    /// Mean RGB brightness (0...1) of one screenshot pixel at a fractional point.
    @MainActor
    private func sampleBrightness(_ app: XCUIApplication, x: Double, y: Double) throws -> Double {
        let screenshot = try XCTUnwrap(app.screenshot().image.cgImage)
        let sample = try XCTUnwrap(screenshot.cropping(to: CGRect(
            x: CGFloat(Int(Double(screenshot.width) * x)), y: CGFloat(Int(Double(screenshot.height) * y)),
            width: 1, height: 1
        )))
        var pixel = [UInt8](repeating: 0, count: 4)
        try pixel.withUnsafeMutableBytes { bytes in
            let context = try XCTUnwrap(CGContext(
                data: bytes.baseAddress, width: 1, height: 1,
                bitsPerComponent: 8, bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ))
            context.draw(sample, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        return Double(Int(pixel[0]) + Int(pixel[1]) + Int(pixel[2])) / (3 * 255)
    }

    /// Includes text, blank middle, amount, and trailing edge. Previously only
    /// the identity mark was reliably tappable, including for synthesized taps.
    @MainActor
    func testWholeActivityRowOpensDetail() {
        let app = launchActivity(["--qa-seeded-home"])
        for fraction in [0.04, 0.2, 0.5, 0.72, 0.97] {
            let activityRow = row("Groceries at Lidl", in: app)
            let frame = activityRow.frame
            XCTAssertGreaterThanOrEqual(frame.height, 44)
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: frame.minX + frame.width * fraction, dy: frame.midY))
                .tap()
            XCTAssertTrue(app.buttons["detail-back"].waitForExistence(timeout: 3),
                          "Activity row zone \(fraction) did not open Detail")
            XCTAssertTrue(app.staticTexts["Groceries at Lidl"].exists)
            app.buttons["detail-back"].tap()
            XCTAssertTrue(app.textFields["activity-search"].waitForExistence(timeout: 3))
        }
        keep("activity-full-row-light")
    }

    @MainActor
    func testLongNamesAndDetailActionsReflowAtLargestTextSize() {
        let app = launchActivity([
            "--qa-shared-table-reference", "--qa-long-household-names",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"
        ])
        let kindFilter = app.buttons["activity-kind-filter"]
        let periodFilter = app.buttons["activity-period-filter"]
        XCTAssertGreaterThanOrEqual(periodFilter.frame.minY - kindFilter.frame.maxY, 6)
        XCTAssertLessThanOrEqual(kindFilter.frame.maxX, app.frame.maxX - 20)
        XCTAssertGreaterThan(kindFilter.frame.height, 44)
        let activityRow = row("Dinner together", in: app)
        XCTAssertTrue(activityRow.label.contains("Alexandria Elizabeth"), activityRow.label)
        XCTAssertLessThanOrEqual(activityRow.frame.maxX, app.frame.maxX - 20)
        XCTAssertGreaterThanOrEqual(activityRow.frame.minX, app.frame.minX + 20)
        for text in activityRow.staticTexts.allElementsBoundByIndex {
            XCTAssertGreaterThanOrEqual(text.frame.minX, activityRow.frame.minX - 1, text.label)
            XCTAssertLessThanOrEqual(text.frame.maxX, activityRow.frame.maxX + 1, text.label)
        }
        keep("activity-long-names-ax-xxxl")
        activityRow.tap()
        XCTAssertTrue(app.buttons["detail-back"].waitForExistence(timeout: 3))
        keep("detail-long-names-ax-xxxl")
        let scroll = app.scrollViews.containing(.button, identifier: "detail-back").firstMatch
        let repeatButton = app.buttons["repeat-record"]
        // Long names at AX XXXL make this detail several screens tall.
        for _ in 0..<20 {
            if repeatButton.isHittable && repeatButton.frame.maxY <= scroll.frame.maxY { break }
            scroll.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(repeatButton.isHittable)
        XCTAssertGreaterThan(repeatButton.frame.height, 50,
                             "Accessibility text must grow the button beyond its ordinary height")
        XCTAssertLessThanOrEqual(repeatButton.frame.maxX, app.frame.maxX - 20)
        let editButton = app.buttons["edit-record"]
        XCTAssertGreaterThanOrEqual(editButton.frame.minY - repeatButton.frame.maxY, 8)
        keep("detail-actions-ax-xxxl")
    }

    @MainActor
    func testActivityAndDetailDarkAppearanceEvidence() throws {
        // XCTest runs teardown blocks even when continueAfterFailure=false
        // aborts an assertion before Swift defer cleanup can execute.
        addTeardownBlock {
            await MainActor.run { XCUIDevice.shared.appearance = .light }
        }
        XCUIDevice.shared.appearance = .light
        let app = launchActivity(["--qa-shared-table-reference"], appearance: .dark)
        let activityRow = row("Dinner together", in: app)
        try assertDarkSurface(app)
        keep("activity-dark")
        activityRow.tap()
        XCTAssertTrue(app.buttons["detail-back"].waitForExistence(timeout: 3))
        try assertDarkSurface(app)
        keep("detail-dark")
    }
}
