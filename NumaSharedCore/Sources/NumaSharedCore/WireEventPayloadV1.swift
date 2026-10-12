import Foundation

// MARK: - Discriminated arithmetic payload

public enum WireEventPayloadV1: Codable, Hashable, Sendable {
    case expenseAdded(recordId: RecordID, content: WireExpenseContentV1)
    case expenseRevised(
        recordId: RecordID,
        basis: WireRevisionBasisV1,
        content: WireRevisableContentV1
    )
    case recordVoided(recordId: RecordID)
    case recordRestored(recordId: RecordID)
    case settlementRecorded(recordId: RecordID, content: WireSettlementContentV1)
    case settlementFlagged(recordId: RecordID)
    case openingBalanceSet(recordId: RecordID, content: WireOpeningBalanceContentV1)
    case memberAdded(memberId: MemberID, unitId: UnitID, role: MemberRole)
    case memberClaimed(memberId: MemberID)
    case memberClaimReassigned(memberId: MemberID)
    case memberArchived(memberId: MemberID)
    case ownershipTransferred(fromMemberId: MemberID, toMemberId: MemberID)
    case groupChanged(groups: [WireSettlementGroupV1])
    case presetChanged(name: String, orderedUnitIds: [UnitID])
    case potRenamed(name: String)
    case potArchived
    /// A lossless download-only payload emitted by a newer server.
    case unsupported(kind: String, payload: JSONValue)

    internal enum Kind: String, Codable {
        case expenseAdded
        case expenseRevised
        case recordVoided
        case recordRestored
        case settlementRecorded
        case settlementFlagged
        case openingBalanceSet
        case memberAdded
        case memberClaimed
        case memberClaimReassigned
        case memberArchived
        case ownershipTransferred
        case groupChanged
        case presetChanged
        case potRenamed
        case potArchived
    }

    internal enum CodingKeys: String, CodingKey {
        case kind
        case recordId
        case content
        case basis
        case memberId
        case unitId
        case role
        case fromMemberId
        case toMemberId
        case groups
        case name
        case orderedUnitIds
        case payload
    }

    internal struct OpaqueCodingKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil

        init(_ stringValue: String) {
            self.stringValue = stringValue
        }

        init?(stringValue: String) {
            self.init(stringValue)
        }

        init?(intValue: Int) {
            return nil
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawKind = try container.decode(String.self, forKey: .kind)
        guard let kind = Kind(rawValue: rawKind) else {
            guard case var .object(opaqueFields) = try JSONValue(from: decoder) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .kind,
                    in: container,
                    debugDescription: "An event payload must be a JSON object"
                )
            }
            opaqueFields.removeValue(forKey: CodingKeys.kind.rawValue)
            self = .unsupported(kind: rawKind, payload: .object(opaqueFields))
            return
        }
        switch kind {
        case .expenseAdded:
            self = .expenseAdded(
                recordId: try container.decodeWireID(RecordID.self, forKey: .recordId),
                content: try container.decode(WireExpenseContentV1.self, forKey: .content)
            )
        case .expenseRevised:
            self = .expenseRevised(
                recordId: try container.decodeWireID(RecordID.self, forKey: .recordId),
                basis: try container.decode(WireRevisionBasisV1.self, forKey: .basis),
                content: try container.decode(WireRevisableContentV1.self, forKey: .content)
            )
        case .recordVoided:
            self = .recordVoided(recordId: try container.decodeWireID(RecordID.self, forKey: .recordId))
        case .recordRestored:
            self = .recordRestored(recordId: try container.decodeWireID(RecordID.self, forKey: .recordId))
        case .settlementRecorded:
            self = .settlementRecorded(
                recordId: try container.decodeWireID(RecordID.self, forKey: .recordId),
                content: try container.decode(WireSettlementContentV1.self, forKey: .content)
            )
        case .settlementFlagged:
            self = .settlementFlagged(recordId: try container.decodeWireID(RecordID.self, forKey: .recordId))
        case .openingBalanceSet:
            self = .openingBalanceSet(
                recordId: try container.decodeWireID(RecordID.self, forKey: .recordId),
                content: try container.decode(WireOpeningBalanceContentV1.self, forKey: .content)
            )
        case .memberAdded:
            self = .memberAdded(
                memberId: try container.decodeWireID(MemberID.self, forKey: .memberId),
                unitId: try container.decodeWireID(UnitID.self, forKey: .unitId),
                role: try container.decode(MemberRole.self, forKey: .role)
            )
        case .memberClaimed:
            self = .memberClaimed(memberId: try container.decodeWireID(MemberID.self, forKey: .memberId))
        case .memberClaimReassigned:
            self = .memberClaimReassigned(memberId: try container.decodeWireID(MemberID.self, forKey: .memberId))
        case .memberArchived:
            self = .memberArchived(memberId: try container.decodeWireID(MemberID.self, forKey: .memberId))
        case .ownershipTransferred:
            self = .ownershipTransferred(
                fromMemberId: try container.decodeWireID(MemberID.self, forKey: .fromMemberId),
                toMemberId: try container.decodeWireID(MemberID.self, forKey: .toMemberId)
            )
        case .groupChanged:
            self = .groupChanged(
                groups: try container.decode([WireSettlementGroupV1].self, forKey: .groups)
            )
        case .presetChanged:
            self = .presetChanged(
                name: try container.decode(String.self, forKey: .name),
                orderedUnitIds: try container.decodeWireIDs(UnitID.self, forKey: .orderedUnitIds)
            )
        case .potRenamed:
            self = .potRenamed(name: try container.decode(String.self, forKey: .name))
        case .potArchived:
            self = .potArchived
        }
    }

    public func encode(to encoder: Encoder) throws {
        if case let .unsupported(kind, payload) = self {
            var opaque = encoder.container(keyedBy: OpaqueCodingKey.self)
            try opaque.encode(kind, forKey: OpaqueCodingKey(CodingKeys.kind.rawValue))
            switch payload {
            case let .object(fields):
                for (key, value) in fields where key != CodingKeys.kind.rawValue {
                    try opaque.encode(value, forKey: OpaqueCodingKey(key))
                }
            default:
                // Compatibility for manually constructed legacy barriers whose
                // retained body was not a JSON object.
                try opaque.encode(payload, forKey: OpaqueCodingKey(CodingKeys.payload.rawValue))
            }
            return
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .expenseAdded(recordId, content):
            try container.encode(Kind.expenseAdded, forKey: .kind)
            try container.encodeWireID(recordId, forKey: .recordId)
            try container.encode(content, forKey: .content)
        case let .expenseRevised(recordId, basis, content):
            try container.encode(Kind.expenseRevised, forKey: .kind)
            try container.encodeWireID(recordId, forKey: .recordId)
            try container.encode(basis, forKey: .basis)
            try container.encode(content, forKey: .content)
        case let .recordVoided(recordId):
            try container.encode(Kind.recordVoided, forKey: .kind)
            try container.encodeWireID(recordId, forKey: .recordId)
        case let .recordRestored(recordId):
            try container.encode(Kind.recordRestored, forKey: .kind)
            try container.encodeWireID(recordId, forKey: .recordId)
        case let .settlementRecorded(recordId, content):
            try container.encode(Kind.settlementRecorded, forKey: .kind)
            try container.encodeWireID(recordId, forKey: .recordId)
            try container.encode(content, forKey: .content)
        case let .settlementFlagged(recordId):
            try container.encode(Kind.settlementFlagged, forKey: .kind)
            try container.encodeWireID(recordId, forKey: .recordId)
        case let .openingBalanceSet(recordId, content):
            try container.encode(Kind.openingBalanceSet, forKey: .kind)
            try container.encodeWireID(recordId, forKey: .recordId)
            try container.encode(content, forKey: .content)
        case let .memberAdded(memberId, unitId, role):
            try container.encode(Kind.memberAdded, forKey: .kind)
            try container.encodeWireID(memberId, forKey: .memberId)
            try container.encodeWireID(unitId, forKey: .unitId)
            try container.encode(role, forKey: .role)
        case let .memberClaimed(memberId):
            try container.encode(Kind.memberClaimed, forKey: .kind)
            try container.encodeWireID(memberId, forKey: .memberId)
        case let .memberClaimReassigned(memberId):
            try container.encode(Kind.memberClaimReassigned, forKey: .kind)
            try container.encodeWireID(memberId, forKey: .memberId)
        case let .memberArchived(memberId):
            try container.encode(Kind.memberArchived, forKey: .kind)
            try container.encodeWireID(memberId, forKey: .memberId)
        case let .ownershipTransferred(fromMemberId, toMemberId):
            try container.encode(Kind.ownershipTransferred, forKey: .kind)
            try container.encodeWireID(fromMemberId, forKey: .fromMemberId)
            try container.encodeWireID(toMemberId, forKey: .toMemberId)
        case let .groupChanged(groups):
            try container.encode(Kind.groupChanged, forKey: .kind)
            try container.encode(groups, forKey: .groups)
        case let .presetChanged(name, orderedUnitIds):
            try container.encode(Kind.presetChanged, forKey: .kind)
            try container.encode(name, forKey: .name)
            try container.encodeWireIDs(orderedUnitIds, forKey: .orderedUnitIds)
        case let .potRenamed(name):
            try container.encode(Kind.potRenamed, forKey: .kind)
            try container.encode(name, forKey: .name)
        case .potArchived:
            try container.encode(Kind.potArchived, forKey: .kind)
        case .unsupported:
            throw EncodingError.invalidValue(
                self,
                EncodingError.Context(
                    codingPath: encoder.codingPath,
                    debugDescription: "Unsupported payload encoding must use the opaque branch"
                )
            )
        }
    }
}
