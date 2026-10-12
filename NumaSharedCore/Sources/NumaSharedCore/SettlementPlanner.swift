import Foundation

// MARK: - Exact settlement planner

/// Finds a minimum-transfer settlement plan with deterministic tie-breaking.
public enum SettlementPlanner {
    public static func plan(
        balances: [UnitID: Money],
        limits: SettlementPlanningLimits = .standard
    ) throws(SettlementPlanningError) -> [SettlementTransfer] {
        let activeUnitCount = balances.values.reduce(into: 0) { count, money in
            if money.minorUnits != 0 { count += 1 }
        }
        guard UInt64(activeUnitCount) <= limits.maximumActiveUnits else {
            throw SettlementPlanningError.searchLimitExceeded(
                resource: .activeUnits,
                limit: limits.maximumActiveUnits
            )
        }
        guard let currency = balances.values.first?.currency else { return [] }
        guard balances.values.allSatisfy({ $0.currency == currency }) else { throw SettlementPlanningError.mixedCurrencies }

        let sum = balances.values.reduce(Decimal.zero) {
            $0 + Decimal($1.minorUnits)
        }
        guard sum == .zero else { throw SettlementPlanningError.nonZeroSum }

        let activeEntries = balances
            .filter { $0.value.minorUnits != 0 }
            .sorted { $0.key < $1.key }
        let unitIDs = activeEntries.map(\.key)
        let initial = activeEntries.map(\.value.minorUnits)
        var memo = [[Int64]: [SettlementTransfer]]()
        var expandedStates: UInt64 = 0
        var inspectedBranches: UInt64 = 0

        func solve(
            _ values: [Int64],
            depth: UInt64
        ) throws(SettlementPlanningError) -> [SettlementTransfer] {
            if values.allSatisfy({ $0 == 0 }) { return [] }
            if let cached = memo[values] { return cached }
            guard depth < limits.maximumRecursionDepth else {
                throw SettlementPlanningError.searchLimitExceeded(
                    resource: .recursionDepth,
                    limit: limits.maximumRecursionDepth
                )
            }
            guard expandedStates < limits.maximumExpandedStates else {
                throw SettlementPlanningError.searchLimitExceeded(
                    resource: .expandedStates,
                    limit: limits.maximumExpandedStates
                )
            }
            expandedStates += 1

            let debtorIndices = values.indices
                .filter { values[$0] < 0 }
                .sorted {
                    let lhs = values[$0].magnitude
                    let rhs = values[$1].magnitude
                    return lhs == rhs ? unitIDs[$0] < unitIDs[$1] : lhs > rhs
                }
            guard let debtorIndex = debtorIndices.first else { throw SettlementPlanningError.nonZeroSum }
            let creditorIndices = values.indices
                .filter { values[$0] > 0 }
                .sorted {
                    if values[$0] == values[$1] { return unitIDs[$0] < unitIDs[$1] }
                    return values[$0] > values[$1]
                }

            var best: [SettlementTransfer]?
            var seenCreditorBalances = Set<Int64>()
            for creditorIndex in creditorIndices {
                guard inspectedBranches < limits.maximumInspectedBranches else {
                    throw SettlementPlanningError.searchLimitExceeded(
                        resource: .inspectedBranches,
                        limit: limits.maximumInspectedBranches
                    )
                }
                inspectedBranches += 1

                // Equal balances are isomorphic; sorted IDs make the first tie-preferred.
                guard seenCreditorBalances.insert(values[creditorIndex]).inserted else {
                    continue
                }
                let magnitude = min(
                    values[debtorIndex].magnitude,
                    UInt64(values[creditorIndex])
                )
                guard let amount = Int64(exactly: magnitude) else { throw SettlementPlanningError.arithmeticOverflow }

                var next = values
                let (newDebtor, debtorOverflow) = next[debtorIndex]
                    .addingReportingOverflow(amount)
                let (newCreditor, creditorOverflow) = next[creditorIndex]
                    .subtractingReportingOverflow(amount)
                guard !debtorOverflow, !creditorOverflow else { throw SettlementPlanningError.arithmeticOverflow }
                next[debtorIndex] = newDebtor
                next[creditorIndex] = newCreditor

                let transfer = SettlementTransfer(
                    fromUnitID: unitIDs[debtorIndex],
                    toUnitID: unitIDs[creditorIndex],
                    amount: Money(minorUnits: amount, currency: currency)
                )
                let candidate = [transfer] + (try solve(next, depth: depth + 1))
                if let currentBest = best {
                    if preferred(candidate, over: currentBest) { best = candidate }
                } else {
                    best = candidate
                }
            }

            guard let result = best else { throw SettlementPlanningError.nonZeroSum }
            memo[values] = result
            return result
        }

        return try solve(initial, depth: 0)
    }

    private static func preferred(
        _ candidate: [SettlementTransfer],
        over current: [SettlementTransfer]
    ) -> Bool {
        if candidate.count != current.count { return candidate.count < current.count }
        for (lhs, rhs) in zip(candidate, current) {
            if lhs.amount.minorUnits != rhs.amount.minorUnits { return lhs.amount.minorUnits > rhs.amount.minorUnits }
            if lhs.fromUnitID != rhs.fromUnitID { return lhs.fromUnitID < rhs.fromUnitID }
            if lhs.toUnitID != rhs.toUnitID { return lhs.toUnitID < rhs.toUnitID }
        }
        return false
    }
}
