import Foundation

/// The complete v1 event vocabulary. Unknown values remain decodable so the
/// reducer can place that pot into the required read-only update state.
public enum EventKind: Codable, Hashable, Sendable {
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
    case unsupported(String)

    /// All kinds the v1 reducer understands. CUT kinds are intentionally absent.
    public static let supportedCases: [EventKind] = [
        .expenseAdded, .expenseRevised, .recordVoided, .recordRestored,
        .settlementRecorded, .settlementFlagged, .openingBalanceSet,
        .memberAdded, .memberClaimed, .memberClaimReassigned,
        .memberArchived, .ownershipTransferred, .groupChanged,
        .presetChanged, .potRenamed, .potArchived,
    ]

    private static let rawValues: [EventKind: String] = [
        .expenseAdded: "expenseAdded",
        .expenseRevised: "expenseRevised",
        .recordVoided: "recordVoided",
        .recordRestored: "recordRestored",
        .settlementRecorded: "settlementRecorded",
        .settlementFlagged: "settlementFlagged",
        .openingBalanceSet: "openingBalanceSet",
        .memberAdded: "memberAdded",
        .memberClaimed: "memberClaimed",
        .memberClaimReassigned: "memberClaimReassigned",
        .memberArchived: "memberArchived",
        .ownershipTransferred: "ownershipTransferred",
        .groupChanged: "groupChanged",
        .presetChanged: "presetChanged",
        .potRenamed: "potRenamed",
        .potArchived: "potArchived",
    ]

    public init(rawValue: String) {
        self = Self.rawValues.first(where: { $0.value == rawValue })?.key ?? .unsupported(rawValue)
    }

    public var rawValue: String {
        Self.rawValues[self] ?? ""
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(rawValue: try container.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
