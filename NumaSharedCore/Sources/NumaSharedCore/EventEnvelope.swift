import Foundation

// MARK: - Event envelope

/// A supported v1 payload, or an opaque marker for a future event kind.
public enum EventPayload: Hashable, Sendable {
    case expenseAdded(ExpenseAddedPayload)
    case expenseRevised(ExpenseRevisedPayload)
    case recordVoided(RecordVoidedPayload)
    case recordRestored(RecordRestoredPayload)
    case settlementRecorded(SettlementRecordedPayload)
    case settlementFlagged(SettlementFlaggedPayload)
    case openingBalanceSet(OpeningBalanceSetPayload)
    case memberAdded(MemberAddedPayload)
    case memberClaimed(MemberClaimedPayload)
    case memberClaimReassigned(MemberClaimReassignedPayload)
    case memberArchived(MemberArchivedPayload)
    case ownershipTransferred(OwnershipTransferredPayload)
    case groupChanged(GroupChangedPayload)
    case presetChanged(PresetChangedPayload)
    case potRenamed(PotRenamedPayload)
    case potArchived(PotArchivedPayload)
    case unsupported(kind: String, payload: JSONValue)

    var payerMemberID: MemberID? {
        switch self {
        case let .expenseAdded(payload): payload.content.payerMemberID
        case let .expenseRevised(payload):
            if case let .expense(content) = payload.content { content.payerMemberID } else { nil }
        default: nil
        }
    }

    public var kind: EventKind {
        switch self {
        case .expenseAdded: .expenseAdded
        case .expenseRevised: .expenseRevised
        case .recordVoided: .recordVoided
        case .recordRestored: .recordRestored
        case .settlementRecorded: .settlementRecorded
        case .settlementFlagged: .settlementFlagged
        case .openingBalanceSet: .openingBalanceSet
        case .memberAdded: .memberAdded
        case .memberClaimed: .memberClaimed
        case .memberClaimReassigned: .memberClaimReassigned
        case .memberArchived: .memberArchived
        case .ownershipTransferred: .ownershipTransferred
        case .groupChanged: .groupChanged
        case .presetChanged: .presetChanged
        case .potRenamed: .potRenamed
        case .potArchived: .potArchived
        case let .unsupported(kind, _): .unsupported(kind)
        }
    }
}

/// Append-only event metadata plus a typed payload.
public struct EventEnvelope: Codable, Hashable, Sendable {
    /// Existing callers continue reading/authoring schema 1 until their complete
    /// transport, persistence, and presentation path opts into budget groups.
    public static let currentSchemaVersion: UInt16 = 1
    public static let budgetGroupSchemaVersion: UInt16 = 2
    public static let maximumSupportedSchemaVersion: UInt16 = 2

    public let id: EventID
    public let potID: PotID
    public let actorMemberID: MemberID
    public let occurredAt: Date
    public let originatingTimeZone: IANATimeZone
    public let schemaVersion: UInt16
    public let serverSequence: Int64?
    public let payload: EventPayload

    public var kind: EventKind { payload.kind }

    public init(
        id: EventID = .generate(),
        potID: PotID,
        actorMemberID: MemberID,
        occurredAt: Date,
        originatingTimeZone: IANATimeZone,
        schemaVersion: UInt16 = EventEnvelope.currentSchemaVersion,
        serverSequence: Int64? = nil,
        payload: EventPayload
    ) {
        self.id = id
        self.potID = potID
        self.actorMemberID = actorMemberID
        self.occurredAt = occurredAt
        self.originatingTimeZone = originatingTimeZone
        self.schemaVersion = schemaVersion
        self.serverSequence = serverSequence
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case potID
        case actorMemberID
        case occurredAt
        case originatingTimeZone
        case schemaVersion
        case serverSequence
        case kind
        case payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(EventID.self, forKey: .id)
        potID = try container.decode(PotID.self, forKey: .potID)
        actorMemberID = try container.decode(MemberID.self, forKey: .actorMemberID)
        occurredAt = try container.decode(Date.self, forKey: .occurredAt)
        originatingTimeZone = try container.decode(IANATimeZone.self, forKey: .originatingTimeZone)
        schemaVersion = try container.decode(UInt16.self, forKey: .schemaVersion)
        serverSequence = try container.decodeIfPresent(Int64.self, forKey: .serverSequence)
        let rawKind = try container.decode(String.self, forKey: .kind)

        if schemaVersion > EventEnvelope.maximumSupportedSchemaVersion {
            payload = .unsupported(
                kind: rawKind,
                payload: try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null
            )
            return
        }

        switch EventKind(rawValue: rawKind) {
        case .expenseAdded:
            payload = .expenseAdded(try container.decode(ExpenseAddedPayload.self, forKey: .payload))
        case .expenseRevised:
            payload = .expenseRevised(try container.decode(ExpenseRevisedPayload.self, forKey: .payload))
        case .recordVoided:
            payload = .recordVoided(try container.decode(RecordVoidedPayload.self, forKey: .payload))
        case .recordRestored:
            payload = .recordRestored(try container.decode(RecordRestoredPayload.self, forKey: .payload))
        case .settlementRecorded:
            payload = .settlementRecorded(try container.decode(SettlementRecordedPayload.self, forKey: .payload))
        case .settlementFlagged:
            payload = .settlementFlagged(try container.decode(SettlementFlaggedPayload.self, forKey: .payload))
        case .openingBalanceSet:
            payload = .openingBalanceSet(try container.decode(OpeningBalanceSetPayload.self, forKey: .payload))
        case .memberAdded:
            payload = .memberAdded(try container.decode(MemberAddedPayload.self, forKey: .payload))
        case .memberClaimed:
            payload = .memberClaimed(try container.decode(MemberClaimedPayload.self, forKey: .payload))
        case .memberClaimReassigned:
            payload = .memberClaimReassigned(try container.decode(MemberClaimReassignedPayload.self, forKey: .payload))
        case .memberArchived:
            payload = .memberArchived(try container.decode(MemberArchivedPayload.self, forKey: .payload))
        case .ownershipTransferred:
            payload = .ownershipTransferred(try container.decode(OwnershipTransferredPayload.self, forKey: .payload))
        case .groupChanged:
            payload = .groupChanged(try container.decode(GroupChangedPayload.self, forKey: .payload))
        case .presetChanged:
            payload = .presetChanged(try container.decode(PresetChangedPayload.self, forKey: .payload))
        case .potRenamed:
            payload = .potRenamed(try container.decode(PotRenamedPayload.self, forKey: .payload))
        case .potArchived:
            payload = .potArchived(try container.decode(PotArchivedPayload.self, forKey: .payload))
        case let .unsupported(kind):
            payload = .unsupported(
                kind: kind,
                payload: try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null
            )
        }
        if schemaVersion < Self.budgetGroupSchemaVersion, payload.payerMemberID != nil {
            throw EventModelError.payerAttributionRequiresBudgetGroups
        }
    }

    public func encode(to encoder: Encoder) throws {
        if schemaVersion < Self.budgetGroupSchemaVersion, payload.payerMemberID != nil {
            throw EventModelError.payerAttributionRequiresBudgetGroups
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(potID, forKey: .potID)
        try container.encode(actorMemberID, forKey: .actorMemberID)
        try container.encode(occurredAt, forKey: .occurredAt)
        try container.encode(originatingTimeZone, forKey: .originatingTimeZone)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encodeIfPresent(serverSequence, forKey: .serverSequence)
        try container.encode(kind.rawValue, forKey: .kind)

        switch payload {
        case let .expenseAdded(value): try container.encode(value, forKey: .payload)
        case let .expenseRevised(value): try container.encode(value, forKey: .payload)
        case let .recordVoided(value): try container.encode(value, forKey: .payload)
        case let .recordRestored(value): try container.encode(value, forKey: .payload)
        case let .settlementRecorded(value): try container.encode(value, forKey: .payload)
        case let .settlementFlagged(value): try container.encode(value, forKey: .payload)
        case let .openingBalanceSet(value): try container.encode(value, forKey: .payload)
        case let .memberAdded(value): try container.encode(value, forKey: .payload)
        case let .memberClaimed(value): try container.encode(value, forKey: .payload)
        case let .memberClaimReassigned(value): try container.encode(value, forKey: .payload)
        case let .memberArchived(value): try container.encode(value, forKey: .payload)
        case let .ownershipTransferred(value): try container.encode(value, forKey: .payload)
        case let .groupChanged(value): try container.encode(value, forKey: .payload)
        case let .presetChanged(value): try container.encode(value, forKey: .payload)
        case let .potRenamed(value): try container.encode(value, forKey: .payload)
        case let .potArchived(value): try container.encode(value, forKey: .payload)
        case let .unsupported(_, payload): try container.encode(payload, forKey: .payload)
        }
    }
}
