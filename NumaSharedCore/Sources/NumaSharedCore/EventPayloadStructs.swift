import Foundation

// MARK: - Revision payloads

/// The basis of a new revision: one parent, or both heads of a contest.
public enum RevisionBasis: Codable, Hashable, Sendable {
    case parent(EventID)
    case resolution(RevisionPair)
}

public struct ExpenseAddedPayload: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let content: ExpenseContent

    public init(recordID: RecordID, content: ExpenseContent) {
        self.recordID = recordID
        self.content = content
    }
}

public struct ExpenseRevisedPayload: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let basis: RevisionBasis
    public let content: RevisableRecordContent

    public init(recordID: RecordID, basis: RevisionBasis, content: RevisableRecordContent) {
        self.recordID = recordID
        self.basis = basis
        self.content = content
    }
}

public struct RecordVoidedPayload: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let reason: String

    public init(recordID: RecordID, reason: String) {
        self.recordID = recordID
        self.reason = reason
    }
}

public struct RecordRestoredPayload: Codable, Hashable, Sendable {
    public let recordID: RecordID

    public init(recordID: RecordID) {
        self.recordID = recordID
    }
}

public struct SettlementRecordedPayload: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let content: SettlementContent

    public init(recordID: RecordID, content: SettlementContent) {
        self.recordID = recordID
        self.content = content
    }
}

public struct SettlementFlaggedPayload: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let reason: String?

    public init(recordID: RecordID, reason: String? = nil) {
        self.recordID = recordID
        self.reason = reason
    }
}

public struct OpeningBalanceSetPayload: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let content: OpeningBalanceContent

    public init(recordID: RecordID, content: OpeningBalanceContent) {
        self.recordID = recordID
        self.content = content
    }
}

// MARK: - Household structure payloads

public enum MemberRole: String, Codable, Hashable, Sendable {
    case owner
    case member
}

public struct MemberAddedPayload: Codable, Hashable, Sendable {
    public let memberID: MemberID
    public let unitID: UnitID
    public let role: MemberRole

    public init(memberID: MemberID, unitID: UnitID, role: MemberRole) {
        self.memberID = memberID
        self.unitID = unitID
        self.role = role
    }
}

public struct MemberClaimedPayload: Codable, Hashable, Sendable {
    public let memberID: MemberID

    public init(memberID: MemberID) {
        self.memberID = memberID
    }
}

public struct MemberClaimReassignedPayload: Codable, Hashable, Sendable {
    public let memberID: MemberID

    public init(memberID: MemberID) {
        self.memberID = memberID
    }
}

public struct MemberArchivedPayload: Codable, Hashable, Sendable {
    public let memberID: MemberID
    public let reason: String?

    public init(memberID: MemberID, reason: String? = nil) {
        self.memberID = memberID
        self.reason = reason
    }
}

public struct OwnershipTransferredPayload: Codable, Hashable, Sendable {
    public let fromMemberID: MemberID
    public let toMemberID: MemberID

    public init(fromMemberID: MemberID, toMemberID: MemberID) {
        self.fromMemberID = fromMemberID
        self.toMemberID = toMemberID
    }
}

/// One complete settlement-group definition at a structural event boundary.
public struct SettlementGroupSnapshot: Codable, Hashable, Sendable {
    public let groupID: GroupID
    public let unitID: UnitID
    public let orderedMemberIDs: [MemberID]
    public let defaultShareWeight: Int64

    public init(
        groupID: GroupID,
        unitID: UnitID,
        orderedMemberIDs: [MemberID],
        defaultShareWeight: Int64
    ) {
        self.groupID = groupID
        self.unitID = unitID
        self.orderedMemberIDs = orderedMemberIDs
        self.defaultShareWeight = defaultShareWeight
    }
}

/// The full weighted settlement-group snapshot after a structural change.
public struct GroupChangedPayload: Codable, Hashable, Sendable {
    public let groups: [SettlementGroupSnapshot]

    public init(groups: [SettlementGroupSnapshot]) {
        self.groups = groups
    }
}

public struct PresetChangedPayload: Codable, Hashable, Sendable {
    public let name: String
    public let orderedUnitIDs: [UnitID]

    public init(name: String, orderedUnitIDs: [UnitID]) {
        self.name = name
        self.orderedUnitIDs = orderedUnitIDs
    }
}

public struct PotRenamedPayload: Codable, Hashable, Sendable {
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

public struct PotArchivedPayload: Codable, Hashable, Sendable {
    public let reason: String?

    public init(reason: String? = nil) {
        self.reason = reason
    }
}
