import Foundation

// MARK: - Reduction diagnostics

/// Deterministic reasons a known event cannot be applied safely.
public enum InvalidEventReason: Codable, Hashable, Sendable {
    case eventFromDifferentPot(expected: PotID, actual: PotID)
    case invalidSchemaVersion(UInt16)
    case schemaDowngrade(required: UInt16, actual: UInt16)
    case budgetGroupsLocked
    case invalidBudgetGroup(GroupID)
    case payerAttributionRequiresBudgetGroups
    case invalidPayerMember(MemberID)
    case invalidServerSequence(Int64)
    case duplicateServerSequence(Int64)
    case duplicateEventID(EventID)
    case duplicateRecord(RecordID)
    case missingRecord(RecordID)
    case immutableSettlement(recordID: RecordID, attemptedKind: EventKind)
    case nonSettlementFlagTarget(RecordID)
    case currencyMismatch(expected: Currency, actual: Currency)
    case unknownUnit(UnitID)
    case inactiveUnit(UnitID)
    case invalidExpenseAmount
    case invalidExpenseAllocations
    case invalidOpeningBalance
    case invalidSettlement
    case settlementReversalTargetNotFlagged(RecordID)
    case settlementReversalDirectionMismatch(RecordID)
    case settlementReversalExceedsOriginal(RecordID)
    case recordKindChanged(RecordID)
    case unknownRevision(EventID)
    case invalidResolution(RevisionPair)
    case voidReasonRequired
    case arithmeticOverflow
    case duplicateMember(MemberID)
    case memberUnitAlreadyAssigned(unitID: UnitID, existingMemberID: MemberID)
    case memberUnitConflictsWithGroup(unitID: UnitID, groupID: GroupID)
    case unknownMember(MemberID)
    case memberAlreadyClaimed(MemberID)
    case memberNotClaimed(MemberID)
    case memberAlreadyArchived(MemberID)
    case invalidOwnershipTransfer(from: MemberID, to: MemberID)
    case ownershipSourceIsNotOwner(MemberID)
    case nonPositiveGroupWeight(groupID: GroupID, weight: Int64)
    case duplicateGroup(GroupID)
    case duplicateGroupUnit(UnitID)
    case memberInMultipleGroups(MemberID)
    case unknownGroupMember(MemberID)
    case archivedGroupMember(MemberID)
    case groupIdentityRebound(
        groupID: GroupID,
        expectedUnitID: UnitID,
        actualUnitID: UnitID
    )
    case groupUnitReassigned(
        unitID: UnitID,
        existingGroupID: GroupID,
        attemptedGroupID: GroupID
    )
    case knownUnitReusedAsGroup(UnitID)
    case groupUnitConflictsWithPersonalUnit(UnitID)
    case duplicatePresetUnit(UnitID)
    case ownerAlreadyExists(MemberID)
    case activeOwnerRequired
    case ownerMustTransferBeforeArchive(MemberID)
    case eventAfterPotArchived
}

/// The reason a pot stopped reducing safely and became read-only.
public enum ReductionIssue: Codable, Hashable, Sendable {
    case unsupportedTopologySchema(encountered: UInt16, supported: UInt16)
    case unsupportedSchema(
        eventID: EventID,
        encountered: UInt16,
        supported: UInt16
    )
    case unsupportedEventKind(eventID: EventID, kind: String)
    case invalidEvent(eventID: EventID, reason: InvalidEventReason)
    case settlementPlanningFailed(SettlementPlanningError)
}

/// Whether a projection can accept writes or requires a newer/fixed client.
public enum ReductionAccess: Codable, Hashable, Sendable {
    case readWrite
    case readOnly(ReductionIssue)
}
