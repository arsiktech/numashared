import Foundation

// MARK: - Settlement planning

/// A suggested real-world transfer; it records no movement by itself.
public struct SettlementTransfer: Codable, Hashable, Sendable {
    public let fromUnitID: UnitID
    public let toUnitID: UnitID
    public let amount: Money

    public init(fromUnitID: UnitID, toUnitID: UnitID, amount: Money) {
        self.fromUnitID = fromUnitID
        self.toUnitID = toUnitID
        self.amount = amount
    }
}

/// Deterministic resources bounded by exact settlement-plan search.
public enum SettlementSearchResource: String, Codable, Hashable, Sendable {
    case activeUnits
    case expandedStates
    case inspectedBranches
    case recursionDepth
}

/// Fixed work limits for exact settlement-plan search.
public struct SettlementPlanningLimits: Codable, Hashable, Sendable {
    public let maximumActiveUnits: UInt64
    public let maximumExpandedStates: UInt64
    public let maximumInspectedBranches: UInt64
    public let maximumRecursionDepth: UInt64

    public init(
        maximumActiveUnits: UInt64 = 128,
        maximumExpandedStates: UInt64,
        maximumInspectedBranches: UInt64,
        maximumRecursionDepth: UInt64
    ) {
        self.maximumActiveUnits = maximumActiveUnits
        self.maximumExpandedStates = maximumExpandedStates
        self.maximumInspectedBranches = maximumInspectedBranches
        self.maximumRecursionDepth = maximumRecursionDepth
    }

    /// Versioned identically on every device so projection results stay deterministic.
    public static let standard = SettlementPlanningLimits(
        maximumActiveUnits: 128,
        maximumExpandedStates: 4_096,
        maximumInspectedBranches: 32_768,
        maximumRecursionDepth: 128
    )
}

/// Failures that prevent an exact settlement plan from being proven.
public enum SettlementPlanningError: Error, Codable, Hashable, Sendable {
    case mixedCurrencies
    case nonZeroSum
    case arithmeticOverflow
    case searchLimitExceeded(resource: SettlementSearchResource, limit: UInt64)
}

/// An exact minimum-transfer plan, or an explicit reason one is unavailable.
public enum SettlementPlanOutcome: Codable, Hashable, Sendable {
    case exact([SettlementTransfer])
    case unavailable(SettlementPlanningError)
}
