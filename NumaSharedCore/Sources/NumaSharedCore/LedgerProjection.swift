import Foundation

// MARK: - Ledger projection

/// The complete deterministic, rebuildable projection for one pot.
public struct LedgerProjection: Codable, Equatable, Sendable {
    public let potID: PotID
    public let currency: Currency
    public let balances: [UnitID: Money]
    public let spend: Money
    public let settlementPlan: SettlementPlanOutcome
    public let records: [RecordID: RecordProjection]
    public let appliedEventIDs: [EventID]
    public let auditOnlyEventIDs: [EventID]
    public let lastAppliedServerSequence: Int64?
    public let latestPotName: String?
    public let isArchived: Bool
    public let structure: StructuralProjection

    public init(
        potID: PotID,
        currency: Currency,
        balances: [UnitID: Money],
        spend: Money,
        settlementPlan: SettlementPlanOutcome,
        records: [RecordID: RecordProjection],
        appliedEventIDs: [EventID],
        auditOnlyEventIDs: [EventID],
        lastAppliedServerSequence: Int64?,
        latestPotName: String?,
        isArchived: Bool,
        structure: StructuralProjection
    ) {
        self.potID = potID
        self.currency = currency
        self.balances = balances
        self.spend = spend
        self.settlementPlan = settlementPlan
        self.records = records
        self.appliedEventIDs = appliedEventIDs
        self.auditOnlyEventIDs = auditOnlyEventIDs
        self.lastAppliedServerSequence = lastAppliedServerSequence
        self.latestPotName = latestPotName
        self.isArchived = isArchived
        self.structure = structure
    }
}

/// A projection and its write-safety state.
public struct ReductionResult: Equatable, Sendable {
    public let projection: LedgerProjection
    public let access: ReductionAccess

    public init(projection: LedgerProjection, access: ReductionAccess) {
        self.projection = projection
        self.access = access
    }
}
