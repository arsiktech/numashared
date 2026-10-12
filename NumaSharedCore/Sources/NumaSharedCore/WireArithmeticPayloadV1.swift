import Foundation

// MARK: - Arithmetic payload components

public struct WireExpenseAllocationV1: Codable, Hashable, Sendable {
    public let unitId: UnitID
    public let amount: Money

    public init(unitId: UnitID, amount: Money) {
        self.unitId = unitId
        self.amount = amount
    }

    internal enum CodingKeys: String, CodingKey {
        case unitId
        case amount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        unitId = try container.decodeWireID(UnitID.self, forKey: .unitId)
        amount = try container.decode(Money.self, forKey: .amount)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeWireID(unitId, forKey: .unitId)
        try container.encode(amount, forKey: .amount)
    }
}

public struct WireExpenseContentV1: Codable, Hashable, Sendable {
    public let expenseKind: ExpenseKind
    public let amount: Money
    public let payerUnitId: UnitID
    public let payerMemberId: MemberID?
    public let allocations: [WireExpenseAllocationV1]

    public init(
        expenseKind: ExpenseKind,
        amount: Money,
        payerUnitId: UnitID,
        allocations: [WireExpenseAllocationV1],
        payerMemberId: MemberID? = nil
    ) {
        self.expenseKind = expenseKind
        self.amount = amount
        self.payerUnitId = payerUnitId
        self.payerMemberId = payerMemberId
        self.allocations = allocations
    }

    internal enum CodingKeys: String, CodingKey {
        case expenseKind
        case amount
        case payerUnitId
        case payerMemberId
        case allocations
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        expenseKind = try container.decode(ExpenseKind.self, forKey: .expenseKind)
        amount = try container.decode(Money.self, forKey: .amount)
        payerUnitId = try container.decodeWireID(UnitID.self, forKey: .payerUnitId)
        payerMemberId = try container.decodeWireIDIfPresent(MemberID.self, forKey: .payerMemberId)
        allocations = try container.decode([WireExpenseAllocationV1].self, forKey: .allocations)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expenseKind, forKey: .expenseKind)
        try container.encode(amount, forKey: .amount)
        try container.encodeWireID(payerUnitId, forKey: .payerUnitId)
        try container.encode(allocations, forKey: .allocations)
        try container.encodeWireIDIfPresent(payerMemberId, forKey: .payerMemberId)
    }
}

public struct WireOpeningBalanceEntryV1: Codable, Hashable, Sendable {
    public let unitId: UnitID
    public let amount: Money

    public init(unitId: UnitID, amount: Money) {
        self.unitId = unitId
        self.amount = amount
    }

    internal enum CodingKeys: String, CodingKey {
        case unitId
        case amount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        unitId = try container.decodeWireID(UnitID.self, forKey: .unitId)
        amount = try container.decode(Money.self, forKey: .amount)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeWireID(unitId, forKey: .unitId)
        try container.encode(amount, forKey: .amount)
    }
}

public struct WireOpeningBalanceContentV1: Codable, Hashable, Sendable {
    public let entries: [WireOpeningBalanceEntryV1]

    public init(entries: [WireOpeningBalanceEntryV1]) {
        self.entries = entries
    }
}

public struct WireSettlementContentV1: Codable, Hashable, Sendable {
    public let amount: Money
    public let fromUnitId: UnitID
    public let toUnitId: UnitID
    public let reversalOfRecordId: RecordID?

    public init(
        amount: Money,
        fromUnitId: UnitID,
        toUnitId: UnitID,
        reversalOfRecordId: RecordID? = nil
    ) {
        self.amount = amount
        self.fromUnitId = fromUnitId
        self.toUnitId = toUnitId
        self.reversalOfRecordId = reversalOfRecordId
    }

    internal enum CodingKeys: String, CodingKey {
        case amount
        case fromUnitId
        case toUnitId
        case reversalOfRecordId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        amount = try container.decode(Money.self, forKey: .amount)
        fromUnitId = try container.decodeWireID(UnitID.self, forKey: .fromUnitId)
        toUnitId = try container.decodeWireID(UnitID.self, forKey: .toUnitId)
        reversalOfRecordId = try container.decodeWireIDIfPresent(
            RecordID.self,
            forKey: .reversalOfRecordId
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(amount, forKey: .amount)
        try container.encodeWireID(fromUnitId, forKey: .fromUnitId)
        try container.encodeWireID(toUnitId, forKey: .toUnitId)
        try container.encodeWireIDIfPresent(
            reversalOfRecordId,
            forKey: .reversalOfRecordId
        )
    }
}

public enum WireRevisionBasisV1: Codable, Hashable, Sendable {
    case parent(parentEventId: EventID)
    case resolution(firstEventId: EventID, secondEventId: EventID)

    internal enum Kind: String, Codable {
        case parent
        case resolution
    }

    internal enum CodingKeys: String, CodingKey {
        case kind
        case parentEventId
        case firstEventId
        case secondEventId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .parent:
            self = .parent(
                parentEventId: try container.decodeWireID(EventID.self, forKey: .parentEventId)
            )
        case .resolution:
            self = .resolution(
                firstEventId: try container.decodeWireID(EventID.self, forKey: .firstEventId),
                secondEventId: try container.decodeWireID(EventID.self, forKey: .secondEventId)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .parent(parentEventId):
            try container.encode(Kind.parent, forKey: .kind)
            try container.encodeWireID(parentEventId, forKey: .parentEventId)
        case let .resolution(firstEventId, secondEventId):
            try container.encode(Kind.resolution, forKey: .kind)
            try container.encodeWireID(firstEventId, forKey: .firstEventId)
            try container.encodeWireID(secondEventId, forKey: .secondEventId)
        }
    }
}

public enum WireRevisableContentV1: Codable, Hashable, Sendable {
    case expense(WireExpenseContentV1)
    case openingBalance(WireOpeningBalanceContentV1)

    internal enum Kind: String, Codable {
        case expense
        case openingBalance
    }

    internal enum CodingKeys: String, CodingKey {
        case kind
        case expenseKind
        case amount
        case payerUnitId
        case payerMemberId
        case allocations
        case entries
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .expense:
            self = .expense(WireExpenseContentV1(
                expenseKind: try container.decode(ExpenseKind.self, forKey: .expenseKind),
                amount: try container.decode(Money.self, forKey: .amount),
                payerUnitId: try container.decodeWireID(UnitID.self, forKey: .payerUnitId),
                allocations: try container.decode([WireExpenseAllocationV1].self, forKey: .allocations),
                payerMemberId: try container.decodeWireIDIfPresent(MemberID.self, forKey: .payerMemberId)
            ))
        case .openingBalance:
            self = .openingBalance(WireOpeningBalanceContentV1(
                entries: try container.decode([WireOpeningBalanceEntryV1].self, forKey: .entries)
            ))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .expense(content):
            try container.encode(Kind.expense, forKey: .kind)
            try container.encode(content.expenseKind, forKey: .expenseKind)
            try container.encode(content.amount, forKey: .amount)
            try container.encodeWireID(content.payerUnitId, forKey: .payerUnitId)
            try container.encode(content.allocations, forKey: .allocations)
            try container.encodeWireIDIfPresent(content.payerMemberId, forKey: .payerMemberId)
        case let .openingBalance(content):
            try container.encode(Kind.openingBalance, forKey: .kind)
            try container.encode(content.entries, forKey: .entries)
        }
    }
}

public struct WireSettlementGroupV1: Codable, Hashable, Sendable {
    public let groupId: GroupID
    public let unitId: UnitID
    public let orderedMemberIds: [MemberID]
    public let defaultShareWeight: Int64

    public init(
        groupId: GroupID,
        unitId: UnitID,
        orderedMemberIds: [MemberID],
        defaultShareWeight: Int64
    ) {
        self.groupId = groupId
        self.unitId = unitId
        self.orderedMemberIds = orderedMemberIds
        self.defaultShareWeight = defaultShareWeight
    }

    internal enum CodingKeys: String, CodingKey {
        case groupId
        case unitId
        case orderedMemberIds
        case defaultShareWeight
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groupId = try container.decodeWireID(GroupID.self, forKey: .groupId)
        unitId = try container.decodeWireID(UnitID.self, forKey: .unitId)
        orderedMemberIds = try container.decodeWireIDs(MemberID.self, forKey: .orderedMemberIds)
        defaultShareWeight = try container.decode(Int64.self, forKey: .defaultShareWeight)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeWireID(groupId, forKey: .groupId)
        try container.encodeWireID(unitId, forKey: .unitId)
        try container.encodeWireIDs(orderedMemberIds, forKey: .orderedMemberIds)
        try container.encode(defaultShareWeight, forKey: .defaultShareWeight)
    }
}
