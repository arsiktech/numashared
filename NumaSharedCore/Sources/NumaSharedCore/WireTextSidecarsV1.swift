import Foundation

// MARK: - Text sidecars

/// Failures at the stable v1 transport boundary.
public enum WireEventV1Error: Error, Equatable, Sendable {
    case unsupportedEventKind(String)
    case occurredAtOutOfRange
    case nonCanonicalTextFields
    case invalidTextManifest
    case authoredTextDoesNotMatchManifest
    case blankAuthoredText(WireTextFieldV1)
    case authoredTextTooLong(WireTextFieldV1)
    case reservedRedactedText(WireTextFieldV1)
    case hydrationRequiresArithmeticOnlyEvent
    case invalidServerSequence(Int64)
    case textStatesDoNotMatchManifest
    case missingRequiredText(WireTextFieldV1)
}

/// The only authored fields that may live outside immutable arithmetic.
public enum WireTextFieldV1: String, Codable, CaseIterable, Hashable, Sendable {
    case title
    case category
    case note
    case reason

    internal static let canonicalOrder: [WireTextFieldV1] = [
        .title, .category, .note, .reason,
    ]
}

/// One upload-side authored-text value, ordered exactly like `textFields`.
public struct WireAuthoredTextV1: Codable, Hashable, Sendable {
    public let field: WireTextFieldV1
    public let value: String

    public init(field: WireTextFieldV1, value: String) {
        self.field = field
        self.value = value
    }
}

/// An explicit server-side text state. Redaction never masquerades as authored text.
public enum WireTextStateV1: Codable, Hashable, Sendable {
    case present(field: WireTextFieldV1, value: String)
    case redacted(field: WireTextFieldV1)

    public var field: WireTextFieldV1 {
        switch self {
        case let .present(field, _), let .redacted(field): field
        }
    }

    internal enum State: String, Codable {
        case present
        case redacted
    }

    internal enum CodingKeys: String, CodingKey {
        case field
        case state
        case value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let field = try container.decode(WireTextFieldV1.self, forKey: .field)
        switch try container.decode(State.self, forKey: .state) {
        case .present:
            self = .present(
                field: field,
                value: try container.decode(String.self, forKey: .value)
            )
        case .redacted:
            guard !container.contains(.value) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .value,
                    in: container,
                    debugDescription: "Redacted text must not carry a value"
                )
            }
            self = .redacted(field: field)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(field, forKey: .field)
        switch self {
        case let .present(_, value):
            try container.encode(State.present, forKey: .state)
            try container.encode(value, forKey: .value)
        case .redacted:
            try container.encode(State.redacted, forKey: .state)
        }
    }
}
