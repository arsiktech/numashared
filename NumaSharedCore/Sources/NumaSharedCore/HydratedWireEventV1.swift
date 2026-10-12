import Foundation

/// A sequenced server event whose text fields are explicitly present or redacted.
public struct HydratedWireEventV1: Codable, Hashable, Sendable {
    public let event: WireEventV1
    public let serverSequence: Int64
    public let textStates: [WireTextStateV1]
    public let opaqueFutureTextStates: JSONValue?

    internal enum CodingKeys: String, CodingKey {
        case event
        case serverSequence
        case textStates
    }

    public init(
        event: WireEventV1,
        serverSequence: Int64,
        textStates: [WireTextStateV1]
    ) throws {
        _ = try event.eventEnvelope(
            serverSequence: serverSequence,
            textStates: textStates
        )
        self.event = event
        self.serverSequence = serverSequence
        self.textStates = textStates
        opaqueFutureTextStates = nil
    }

    internal init(
        futureEvent event: WireEventV1,
        serverSequence: Int64,
        textStates: [WireTextStateV1],
        opaqueFutureTextStates: JSONValue
    ) {
        self.event = event
        self.serverSequence = serverSequence
        self.textStates = textStates
        self.opaqueFutureTextStates = opaqueFutureTextStates
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let event = try container.decode(WireEventV1.self, forKey: .event)
        let serverSequence = try container.decode(Int64.self, forKey: .serverSequence)
        if event.schemaVersion > EventEnvelope.maximumSupportedSchemaVersion {
            guard serverSequence > 0 else { throw WireEventV1Error.invalidServerSequence(serverSequence) }
            let rawTextStates = try container.decodeIfPresent(
                JSONValue.self,
                forKey: .textStates
            ) ?? .array([])
            self.init(
                futureEvent: event,
                serverSequence: serverSequence,
                textStates: Self.recognizedFutureTextStates(
                    rawTextStates,
                    requiredFields: event.textFields
                ),
                opaqueFutureTextStates: rawTextStates
            )
            return
        }
        try self.init(
            event: event,
            serverSequence: serverSequence,
            textStates: container.decode([WireTextStateV1].self, forKey: .textStates)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(event, forKey: .event)
        try container.encode(serverSequence, forKey: .serverSequence)
        if let opaqueFutureTextStates {
            try container.encode(opaqueFutureTextStates, forKey: .textStates)
        } else {
            try container.encode(textStates, forKey: .textStates)
        }
    }

    internal static func recognizedFutureTextStates(
        _ raw: JSONValue,
        requiredFields: [WireTextFieldV1]
    ) -> [WireTextStateV1] {
        guard case let .array(values) = raw else { return requiredFields.map { .redacted(field: $0) } }
        var recognized: [WireTextFieldV1: WireTextStateV1] = [:]
        for value in values {
            guard case let .object(object) = value,
                  case let .string(rawField)? = object["field"],
                  let field = WireTextFieldV1(rawValue: rawField),
                  case let .string(state)? = object["state"]
            else { continue }
            switch state {
            case "present":
                guard case let .string(text)? = object["value"] else { continue }
                recognized[field] = .present(field: field, value: text)
            case "redacted":
                recognized[field] = .redacted(field: field)
            default:
                continue
            }
        }
        return requiredFields.map { field in
            recognized[field] ?? .redacted(field: field)
        }
    }

    /// Rehydrates domain text, using one fixed placeholder for erased values.
    public func eventEnvelope() throws -> EventEnvelope {
        if event.schemaVersion > EventEnvelope.maximumSupportedSchemaVersion {
            return try event.grandfatheredStoredEventEnvelope(
                serverSequence: serverSequence,
                textStates: textStates
            )
        }
        return try event.eventEnvelope(
            serverSequence: serverSequence,
            textStates: textStates
        )
    }
}
