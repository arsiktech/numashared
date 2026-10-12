import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class PerformanceSanityTests: XCTestCase {
    func testTenThousandEventReplayProducesCompleteProjection() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)

        for offset in 0 ..< 10_000 {
            let event = try fixture.event(id: UInt16(20_000 + offset))
            _ = try store.appendHeldLocalEvent(event)
        }

        let result = try store.reduction(for: fixture.potID)
        XCTAssertEqual(result.projection.appliedEventIDs.count, 10_000)
        XCTAssertEqual(result.projection.records.count, 10_000)
        XCTAssertEqual(
            result.projection.balances[fixture.payerID],
            Money(minorUnits: 50_000_000, currency: .eur)
        )
        XCTAssertEqual(
            result.projection.balances[fixture.beneficiaryID],
            Money(minorUnits: -50_000_000, currency: .eur)
        )
    }
}
