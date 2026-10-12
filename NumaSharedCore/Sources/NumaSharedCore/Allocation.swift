import Foundation

/// Validation failures for weighted minor-unit allocation.
public enum AllocationError: Error, Equatable, Sendable {
    case emptyUnitList
    case duplicateUnit(UnitID)
    case negativeTotal
    case nonPositiveWeight(unitID: UnitID, weight: Int64)
    case weightOverflow
    case allocationOverflow
}

/// Identifier-agnostic failures from the shared minor-unit allocation engine.
public enum MinorUnitAllocationError: Error, Equatable, Sendable {
    case emptyUnitList
    case duplicateUnit(index: Int)
    case negativeTotal
    case nonPositiveWeight(index: Int, weight: Int64)
    case weightOverflow
    case allocationOverflow
}

/// Canonical integer allocator shared by Core money and app-scoped unit IDs.
public enum MinorUnitAllocator {
    public static func allocate<Identifier: Hashable>(
        total: Int64,
        weights: [Identifier: Int64],
        orderedUnitIDs: [Identifier]
    ) throws(MinorUnitAllocationError) -> [Identifier: Int64] {
        guard !orderedUnitIDs.isEmpty else { throw .emptyUnitList }
        guard total >= 0 else { throw .negativeTotal }

        var seen = Set<Identifier>()
        var resolvedWeights = [UInt64]()
        resolvedWeights.reserveCapacity(orderedUnitIDs.count)
        var totalWeight: UInt64 = 0

        for (index, unitID) in orderedUnitIDs.enumerated() {
            guard seen.insert(unitID).inserted else { throw .duplicateUnit(index: index) }
            let weight = weights[unitID] ?? 1
            guard weight > 0 else { throw .nonPositiveWeight(index: index, weight: weight) }
            let (sum, overflow) = totalWeight.addingReportingOverflow(UInt64(weight))
            guard !overflow else { throw .weightOverflow }
            totalWeight = sum
            resolvedWeights.append(UInt64(weight))
        }

        let totalMagnitude = UInt64(total)
        var used: UInt64 = 0
        var result = [Identifier: Int64]()
        result.reserveCapacity(orderedUnitIDs.count)

        for index in orderedUnitIDs.indices {
            let portion: UInt64
            if index == orderedUnitIDs.index(before: orderedUnitIDs.endIndex) {
                portion = totalMagnitude - used
            } else {
                let product = totalMagnitude.multipliedFullWidth(by: resolvedWeights[index])
                portion = totalWeight.dividingFullWidth(product).quotient
            }
            let (newUsed, overflow) = used.addingReportingOverflow(portion)
            guard !overflow, newUsed <= totalMagnitude,
                  let signedPortion = Int64(exactly: portion)
            else {
                throw .allocationOverflow
            }
            used = newUsed
            result[orderedUnitIDs[index]] = signedPortion
        }

        return result
    }
}

/// Splits an amount with integer arithmetic and assigns all residual minor
/// units to the final unit in the caller-supplied stable order.
public enum WeightedAllocator {
    public static func allocate(
        total: Money,
        weights: [UnitID: Int64],
        orderedUnitIDs: [UnitID]
    ) throws -> [UnitID: Money] {
        let allocated: [UnitID: Int64]
        do {
            allocated = try MinorUnitAllocator.allocate(
                total: total.minorUnits,
                weights: weights,
                orderedUnitIDs: orderedUnitIDs
            )
        } catch {
            switch error {
            case .emptyUnitList:
                throw AllocationError.emptyUnitList
            case let .duplicateUnit(index):
                throw AllocationError.duplicateUnit(orderedUnitIDs[index])
            case .negativeTotal:
                throw AllocationError.negativeTotal
            case let .nonPositiveWeight(index, weight):
                throw AllocationError.nonPositiveWeight(
                    unitID: orderedUnitIDs[index],
                    weight: weight
                )
            case .weightOverflow:
                throw AllocationError.weightOverflow
            case .allocationOverflow:
                throw AllocationError.allocationOverflow
            }
        }
        return allocated.mapValues {
            Money(minorUnits: $0, currency: total.currency)
        }
    }
}
