import Foundation
import XCTest
@testable import NumaShared

final class PrivacyPreferencesTests: XCTestCase {
    @MainActor
    func testHideAmountsPersistsOnlyInTheInjectedDeviceStore() throws {
        let suiteName = "PrivacyPreferencesTests.\(UUID().uuidString)"
        let otherSuiteName = "PrivacyPreferencesTests.other.\(UUID().uuidString)"
        let suite = try XCTUnwrap(
            UserDefaults(suiteName: suiteName)
        )
        let otherSuite = try XCTUnwrap(UserDefaults(suiteName: otherSuiteName))
        defer {
            suite.removePersistentDomain(forName: suiteName)
            otherSuite.removePersistentDomain(forName: otherSuiteName)
        }

        let preferences = DevicePrivacyPreferences(defaults: suite)
        XCTAssertFalse(preferences.hideAmounts)

        preferences.setHideAmounts(true)

        XCTAssertTrue(DevicePrivacyPreferences(defaults: suite).hideAmounts)
        XCTAssertFalse(DevicePrivacyPreferences(defaults: otherSuite).hideAmounts)
    }

    func testSignOutWarningNamesEveryUnsyncedLoss() {
        XCTAssertEqual(
            AppModel.signOutConfirmationMessage(unsyncedCount: 0),
            "Synced records stay in the shared pot. This iPhone’s local cache will be cleared."
        )
        XCTAssertEqual(
            AppModel.signOutConfirmationMessage(unsyncedCount: 1),
            "1 record hasn’t synced and will be lost from this iPhone."
        )
        XCTAssertEqual(
            AppModel.signOutConfirmationMessage(unsyncedCount: 3),
            "3 records haven’t synced and will be lost from this iPhone."
        )
    }
}
