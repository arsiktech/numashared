import Foundation
import NumaSharedCore
import XCTest

final class TimeZoneContractTests: XCTestCase {
    func testFrozenBackendContractMatchesIOS18_6FoundationAndCurrentTimeZone() throws {
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(
                forResource: "ios18-time-zone-identifiers",
                withExtension: "json",
                subdirectory: "Fixtures"
            ) ?? Bundle(for: Self.self).url(
                forResource: "ios18-time-zone-identifiers",
                withExtension: "json"
            )
        )
        let expected = try JSONDecoder().decode(
            [String].self,
            from: Data(contentsOf: fixtureURL)
        )
        let actual = Array(
            Set(TimeZone.knownTimeZoneIdentifiers + ["UTC"])
        ).sorted()

        XCTAssertEqual(actual, expected)
        XCTAssertEqual(IANATimeZone.v1Identifiers, Set(expected))
        XCTAssertTrue(
            expected.contains(TimeZone.current.identifier),
            "Current zone must remain uploadable: \(TimeZone.current.identifier)"
        )
        for identifier in expected {
            XCTAssertNoThrow(try IANATimeZone(identifier), identifier)
        }
        for alias in [
            "europe/madrid",
            "utc",
            "US/Pacific",
            "Etc/UTC",
            "Asia/Kolkata",
            "Today",
        ] {
            XCTAssertThrowsError(try IANATimeZone(alias), alias)
        }
    }
}
