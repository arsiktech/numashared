import Foundation

// MARK: - Financial record content

/// Whether an expense is shared across units or is a personal charge.
public enum ExpenseKind: String, Codable, Hashable, Sendable {
    case shared
    case personal
}

/// One beneficiary's exact share of an expense.
public struct ExpenseAllocation: Codable, Hashable, Sendable {
    public let unitID: UnitID
    public let amount: Money

    public init(unitID: UnitID, amount: Money) {
        self.unitID = unitID
        self.amount = amount
    }
}

/// The revisable financial content of an expense record.
public struct ExpenseContent: Codable, Hashable, Sendable {
    public let kind: ExpenseKind
    public let title: String
    public let amount: Money
    public let payerUnitID: UnitID
    /// The actual payer, when known; never inferred from the event's author.
    /// Schema 2 keeps this erasable-profile identity separate from debt ownership.
    public let payerMemberID: MemberID?
    public let allocations: [ExpenseAllocation]
    public let category: String?

    public init(
        kind: ExpenseKind,
        title: String,
        amount: Money,
        payerUnitID: UnitID,
        allocations: [ExpenseAllocation],
        category: String? = nil,
        payerMemberID: MemberID? = nil
    ) {
        self.kind = kind
        self.title = title
        self.amount = amount
        self.payerUnitID = payerUnitID
        self.payerMemberID = payerMemberID
        self.allocations = allocations
        self.category = category
    }
}

/// One signed unit balance imported by an opening-balance record.
public struct OpeningBalanceEntry: Codable, Hashable, Sendable {
    public let unitID: UnitID
    public let amount: Money

    public init(unitID: UnitID, amount: Money) {
        self.unitID = unitID
        self.amount = amount
    }
}

/// The revisable content of a zero-sum opening balance.
public struct OpeningBalanceContent: Codable, Hashable, Sendable {
    public let title: String
    public let entries: [OpeningBalanceEntry]
    public let note: String?

    public init(title: String, entries: [OpeningBalanceEntry], note: String? = nil) {
        self.title = title
        self.entries = entries
        self.note = note
    }
}

/// The immutable financial content of a settlement record.
public struct SettlementContent: Codable, Hashable, Sendable {
    public let title: String
    public let amount: Money
    public let fromUnitID: UnitID
    public let toUnitID: UnitID
    public let reversalOfRecordID: RecordID?

    public init(
        title: String,
        amount: Money,
        fromUnitID: UnitID,
        toUnitID: UnitID,
        reversalOfRecordID: RecordID? = nil
    ) {
        self.title = title
        self.amount = amount
        self.fromUnitID = fromUnitID
        self.toUnitID = toUnitID
        self.reversalOfRecordID = reversalOfRecordID
    }
}

/// Content allowed in the revision chain. Settlements are deliberately absent.
public enum RevisableRecordContent: Codable, Hashable, Sendable {
    case expense(ExpenseContent)
    case openingBalance(OpeningBalanceContent)
}

/// A normalized pair of contested revision heads referenced by a resolution.
public struct RevisionPair: Codable, Hashable, Sendable {
    public let first: EventID
    public let second: EventID

    public init(_ first: EventID, _ second: EventID) throws {
        guard first != second else { throw EventModelError.identicalRevisionHeads(first) }
        if first < second {
            self.first = first
            self.second = second
        } else {
            self.first = second
            self.second = first
        }
    }

    private enum CodingKeys: String, CodingKey {
        case first
        case second
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            container.decode(EventID.self, forKey: .first),
            container.decode(EventID.self, forKey: .second)
        )
    }
}
