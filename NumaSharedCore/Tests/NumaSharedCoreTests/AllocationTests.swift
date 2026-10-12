import XCTest
@testable import NumaSharedCore

final class AllocationTests: XCTestCase {
    private let am = UnitID(unchecked: testUUID(1))
    private let sam = UnitID(unchecked: testUUID(2))
    private let leo = UnitID(unchecked: testUUID(3))

    func testCanonicalWeightedAllocationUsesIntegerMinorUnits() throws {
        let allocation = try WeightedAllocator.allocate(
            total: Money(minorUnits: 12_000, currency: .eur),
            weights: [am: 2, sam: 1, leo: 1],
            orderedUnitIDs: [am, sam, leo]
        )

        XCTAssertEqual(allocation[am]?.minorUnits, 6_000)
        XCTAssertEqual(allocation[sam]?.minorUnits, 3_000)
        XCTAssertEqual(allocation[leo]?.minorUnits, 3_000)
    }

    func testRemainderGoesToLastUnitAndSingleUnitGetsEverything() throws {
        let equal = try WeightedAllocator.allocate(
            total: Money(minorUnits: 10_000, currency: .eur),
            weights: [:],
            orderedUnitIDs: [am, sam, leo]
        )
        let single = try WeightedAllocator.allocate(
            total: Money(minorUnits: 9_999, currency: .eur),
            weights: [:],
            orderedUnitIDs: [sam]
        )

        XCTAssertEqual(equal[am]?.minorUnits, 3_333)
        XCTAssertEqual(equal[sam]?.minorUnits, 3_333)
        XCTAssertEqual(equal[leo]?.minorUnits, 3_334)
        XCTAssertEqual(equal.values.reduce(0) { $0 + $1.minorUnits }, 10_000)
        XCTAssertEqual(single[sam]?.minorUnits, 9_999)
    }

    func testGenericMinorUnitAllocatorSupportsAppScopedIdentifiers() throws {
        let units = (0 ..< 10).map { "dynamic-\($0)" }
        let weights = Dictionary(uniqueKeysWithValues: units.map { ($0, Int64(1)) })

        let allocation = try MinorUnitAllocator.allocate(
            total: 101,
            weights: weights,
            orderedUnitIDs: units
        )

        XCTAssertEqual(allocation.values.reduce(0, +), 101)
        XCTAssertEqual(
            units.dropLast().map { allocation[$0] },
            Array(repeating: 10, count: 9)
        )
        XCTAssertEqual(allocation[units.last!], 11)
    }

    func testWeightedAllocatorRetainsTypedValidationErrors() throws {
        XCTAssertThrowsError(try WeightedAllocator.allocate(
            total: Money(minorUnits: 100, currency: .eur),
            weights: [am: 1],
            orderedUnitIDs: [am, am]
        )) { error in
            XCTAssertEqual(error as? AllocationError, .duplicateUnit(am))
        }
        XCTAssertThrowsError(try WeightedAllocator.allocate(
            total: Money(minorUnits: 100, currency: .eur),
            weights: [sam: 0],
            orderedUnitIDs: [sam]
        )) { error in
            XCTAssertEqual(
                error as? AllocationError,
                .nonPositiveWeight(unitID: sam, weight: 0)
            )
        }
    }

    func testDeterministicSplitFuzzPreservesExactSumAcrossExponents() throws {
        var random = LCRandom(seed: 0x4E_55_4D_41)
        for currency in [Currency.jpy, .eur, .bhd] {
            for _ in 0 ..< 1_000 {
                let total = Int64(random.next() % 2_000_001)
                let weights = [
                    am: Int64(random.next() % 9) + 1,
                    sam: Int64(random.next() % 9) + 1,
                    leo: Int64(random.next() % 9) + 1,
                ]
                let allocation = try WeightedAllocator.allocate(
                    total: Money(minorUnits: total, currency: currency),
                    weights: weights,
                    orderedUnitIDs: [am, sam, leo]
                )

                XCTAssertEqual(
                    allocation.values.reduce(0) { $0 + $1.minorUnits },
                    total
                )
                XCTAssertTrue(allocation.values.allSatisfy { $0.minorUnits >= 0 })
                XCTAssertTrue(allocation.values.allSatisfy { $0.currency == currency })
            }
        }
    }
}

private struct LCRandom: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state = 2_862_933_555_777_941_757 &* state &+ 3_037_000_493
        return state
    }
}
