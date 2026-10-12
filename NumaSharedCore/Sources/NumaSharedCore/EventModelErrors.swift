import Foundation

// MARK: - Event metadata and vocabulary

/// Validation failures for event metadata and revision references.
public enum EventModelError: Error, Equatable, Sendable {
    case invalidTimeZoneIdentifier(String)
    case identicalRevisionHeads(EventID)
    case payerAttributionRequiresBudgetGroups
}

/// A validated IANA time-zone identifier captured at event creation.
public struct IANATimeZone: Codable, Hashable, Sendable {
    public let identifier: String

    public init(_ identifier: String) throws {
        guard Self.v1Identifiers.contains(identifier) else { throw EventModelError.invalidTimeZoneIdentifier(identifier) }
        self.identifier = identifier
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(container.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(identifier)
    }
}
