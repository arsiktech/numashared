import Foundation

// MARK: - Upload and hydration envelopes

/// Stable v1 upload contract. `serverSequence` is deliberately absent.
public struct WireEventV1: Codable, Hashable, Sendable {
    public static let redactedTextPlaceholder = "[redacted]"

    public let eventId: EventID
    public let potId: PotID
    public let actorMemberId: MemberID
    public let occurredAtMillis: Int64
    public let originatingTimeZone: IANATimeZone
    public let schemaVersion: UInt16
    public let payload: WireEventPayloadV1
    public let textFields: [WireTextFieldV1]
    public let authoredText: [WireAuthoredTextV1]
    public let legacyAuthoredText: Bool
    /// Raw future-only header/manifest values retained without v1 admission.
    public let opaqueFutureOriginatingTimeZoneIdentifier: String?
    public let opaqueFutureTextFields: JSONValue?

    public init(_ event: EventEnvelope) throws {
        try self.init(event, validateAuthoredTextValues: true)
    }

    /// Re-encodes an event that was admitted by a previously shipped local
    /// database. This skips only authored-text value policy introduced after
    /// v1 storage; the immutable manifest and arithmetic contract remain
    /// validated. New writes and remote responses must use `init(_:)`.
    public init(grandfatheredStoredEvent event: EventEnvelope) throws {
        try self.init(event, validateAuthoredTextValues: false)
    }

    internal init(
        _ event: EventEnvelope,
        validateAuthoredTextValues: Bool
    ) throws {
        if event.schemaVersion < EventEnvelope.budgetGroupSchemaVersion,
           event.payload.payerMemberID != nil {
            throw EventModelError.payerAttributionRequiresBudgetGroups
        }
        let milliseconds = (event.occurredAt.timeIntervalSince1970 * 1_000)
            .rounded(.towardZero)
        guard milliseconds.isFinite,
              milliseconds >= 0,
              milliseconds < 9_223_372_036_854_775_808.0
        else {
            throw WireEventV1Error.occurredAtOutOfRange
        }
        let separated = try WireEventPayloadV1.separating(event.payload)
        eventId = event.id
        potId = event.potID
        actorMemberId = event.actorMemberID
        occurredAtMillis = Int64(milliseconds)
        originatingTimeZone = event.originatingTimeZone
        schemaVersion = event.schemaVersion
        payload = separated.payload
        textFields = separated.authoredText.map(\.field)
        authoredText = separated.authoredText
        legacyAuthoredText = !validateAuthoredTextValues
        opaqueFutureOriginatingTimeZoneIdentifier = nil
        opaqueFutureTextFields = nil
        try Self.validate(
            payload: payload,
            textFields: textFields,
            authoredText: authoredText,
            validateAuthoredTextValues: validateAuthoredTextValues
        )
    }

    /// The immutable arithmetic form stored by the server and returned for hydration.
    public var arithmeticOnly: WireEventV1 {
        WireEventV1(
            eventId: eventId,
            potId: potId,
            actorMemberId: actorMemberId,
            occurredAtMillis: occurredAtMillis,
            originatingTimeZone: originatingTimeZone,
            schemaVersion: schemaVersion,
            payload: payload,
            textFields: textFields,
            authoredText: [],
            legacyAuthoredText: legacyAuthoredText,
            opaqueFutureOriginatingTimeZoneIdentifier:
                opaqueFutureOriginatingTimeZoneIdentifier,
            opaqueFutureTextFields: opaqueFutureTextFields
        )
    }

    internal init(
        eventId: EventID,
        potId: PotID,
        actorMemberId: MemberID,
        occurredAtMillis: Int64,
        originatingTimeZone: IANATimeZone,
        schemaVersion: UInt16,
        payload: WireEventPayloadV1,
        textFields: [WireTextFieldV1],
        authoredText: [WireAuthoredTextV1],
        legacyAuthoredText: Bool,
        opaqueFutureOriginatingTimeZoneIdentifier: String?,
        opaqueFutureTextFields: JSONValue?
    ) {
        self.eventId = eventId
        self.potId = potId
        self.actorMemberId = actorMemberId
        self.occurredAtMillis = occurredAtMillis
        self.originatingTimeZone = originatingTimeZone
        self.schemaVersion = schemaVersion
        self.payload = payload
        self.textFields = textFields
        self.authoredText = authoredText
        self.legacyAuthoredText = legacyAuthoredText
        self.opaqueFutureOriginatingTimeZoneIdentifier =
            opaqueFutureOriginatingTimeZoneIdentifier
        self.opaqueFutureTextFields = opaqueFutureTextFields
    }

    internal enum CodingKeys: String, CodingKey {
        case eventId
        case potId
        case actorMemberId
        case occurredAtMillis
        case originatingTimeZone
        case schemaVersion
        case payload
        case textFields
        case authoredText
        case legacyAuthoredText
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let eventId = try container.decodeWireID(EventID.self, forKey: .eventId)
        let potId = try container.decodeWireID(PotID.self, forKey: .potId)
        let actorMemberId = try container.decodeWireID(MemberID.self, forKey: .actorMemberId)
        let occurredAtMillis = try container.decode(Int64.self, forKey: .occurredAtMillis)
        let schemaVersion = try container.decode(UInt16.self, forKey: .schemaVersion)
        guard occurredAtMillis >= 0 else { throw WireEventV1Error.occurredAtOutOfRange }
        if schemaVersion > EventEnvelope.maximumSupportedSchemaVersion {
            let rawTimeZone = try container.decode(String.self, forKey: .originatingTimeZone)
            guard let compatibilityTimeZone = (try? IANATimeZone(rawTimeZone))
                ?? (try? IANATimeZone("UTC"))
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .originatingTimeZone,
                    in: container,
                    debugDescription: "No v1 compatibility time zone is available"
                )
            }
            let rawPayload = try container.decode(JSONValue.self, forKey: .payload)
            let rawTextFields = try container.decodeIfPresent(
                JSONValue.self,
                forKey: .textFields
            ) ?? .array([])
            guard case var .object(fields) = rawPayload,
                  case let .string(kind)? = fields.removeValue(forKey: "kind")
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .payload,
                    in: container,
                    debugDescription: "A future event payload must be a discriminated object"
                )
            }
            self.init(
                eventId: eventId,
                potId: potId,
                actorMemberId: actorMemberId,
                occurredAtMillis: occurredAtMillis,
                originatingTimeZone: compatibilityTimeZone,
                schemaVersion: schemaVersion,
                payload: .unsupported(kind: kind, payload: .object(fields)),
                textFields: Self.recognizedFutureTextFields(rawTextFields),
                authoredText: [],
                legacyAuthoredText: false,
                opaqueFutureOriginatingTimeZoneIdentifier: rawTimeZone,
                opaqueFutureTextFields: rawTextFields
            )
            return
        }
        let originatingTimeZone = try container.decode(
            IANATimeZone.self,
            forKey: .originatingTimeZone
        )
        let payload = try container.decode(WireEventPayloadV1.self, forKey: .payload)
        let textFields = try container.decode([WireTextFieldV1].self, forKey: .textFields)
        let authoredText = try container.decode(
            [WireAuthoredTextV1].self,
            forKey: .authoredText
        )
        let legacyAuthoredText = try container.decodeIfPresent(
            Bool.self,
            forKey: .legacyAuthoredText
        ) ?? false
        try Self.validate(
            payload: payload,
            textFields: textFields,
            authoredText: authoredText,
            validateAuthoredTextValues: !legacyAuthoredText
        )
        if schemaVersion < EventEnvelope.budgetGroupSchemaVersion, payload.payerMemberId != nil {
            throw EventModelError.payerAttributionRequiresBudgetGroups
        }
        self.init(
            eventId: eventId,
            potId: potId,
            actorMemberId: actorMemberId,
            occurredAtMillis: occurredAtMillis,
            originatingTimeZone: originatingTimeZone,
            schemaVersion: schemaVersion,
            payload: payload,
            textFields: textFields,
            authoredText: authoredText,
            legacyAuthoredText: legacyAuthoredText,
            opaqueFutureOriginatingTimeZoneIdentifier: nil,
            opaqueFutureTextFields: nil
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeWireID(eventId, forKey: .eventId)
        try container.encodeWireID(potId, forKey: .potId)
        try container.encodeWireID(actorMemberId, forKey: .actorMemberId)
        try container.encode(occurredAtMillis, forKey: .occurredAtMillis)
        if let opaqueFutureOriginatingTimeZoneIdentifier {
            try container.encode(
                opaqueFutureOriginatingTimeZoneIdentifier,
                forKey: .originatingTimeZone
            )
        } else {
            try container.encode(originatingTimeZone, forKey: .originatingTimeZone)
        }
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(payload, forKey: .payload)
        if let opaqueFutureTextFields {
            try container.encode(opaqueFutureTextFields, forKey: .textFields)
        } else {
            try container.encode(textFields, forKey: .textFields)
        }
        try container.encode(authoredText, forKey: .authoredText)
        if legacyAuthoredText {
            try container.encode(true, forKey: .legacyAuthoredText)
        }
    }

    internal static func recognizedFutureTextFields(
        _ raw: JSONValue
    ) -> [WireTextFieldV1] {
        guard case let .array(values) = raw else { return [] }
        let recognized = Set(values.compactMap { value -> WireTextFieldV1? in
            guard case let .string(rawField) = value else { return nil }
            return WireTextFieldV1(rawValue: rawField)
        })
        return WireTextFieldV1.canonicalOrder.filter(recognized.contains)
    }

    internal static func validate(
        payload: WireEventPayloadV1,
        textFields: [WireTextFieldV1],
        authoredText: [WireAuthoredTextV1],
        validateAuthoredTextValues: Bool
    ) throws {
        let canonicalFields = WireTextFieldV1.canonicalOrder.filter(textFields.contains)
        guard canonicalFields == textFields,
              Set(textFields).count == textFields.count
        else {
            throw WireEventV1Error.nonCanonicalTextFields
        }
        let contract = payload.textContract
        guard contract.required.allSatisfy(textFields.contains),
              textFields.allSatisfy(contract.allowed.contains)
        else {
            throw WireEventV1Error.invalidTextManifest
        }
        guard authoredText.isEmpty || authoredText.map(\.field) == textFields else { throw WireEventV1Error.authoredTextDoesNotMatchManifest }
        if validateAuthoredTextValues {
            for text in authoredText {
                try validateAuthoredText(text.value, field: text.field)
            }
        }
    }

    internal static func validateAuthoredText(
        _ value: String,
        field: WireTextFieldV1
    ) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WireEventV1Error.blankAuthoredText(field) }
        guard value.utf16.count <= 512 else { throw WireEventV1Error.authoredTextTooLong(field) }
        guard value != redactedTextPlaceholder else { throw WireEventV1Error.reservedRedactedText(field) }
    }

    /// Rehydrates one arithmetic-only event from explicit text states.
    /// A nil sequence is reserved for a local optimistic event.
    public func eventEnvelope(
        serverSequence: Int64?,
        textStates: [WireTextStateV1]
    ) throws -> EventEnvelope {
        try eventEnvelope(
            serverSequence: serverSequence,
            textStates: textStates,
            validateAuthoredTextValues: !legacyAuthoredText
        )
    }

    /// Hydrates a row already admitted by a prior on-device schema without
    /// retroactively applying newer authored-text policy.
    public func grandfatheredStoredEventEnvelope(
        serverSequence: Int64?,
        textStates: [WireTextStateV1]
    ) throws -> EventEnvelope {
        try eventEnvelope(
            serverSequence: serverSequence,
            textStates: textStates,
            validateAuthoredTextValues: false
        )
    }

    internal func eventEnvelope(
        serverSequence: Int64?,
        textStates: [WireTextStateV1],
        validateAuthoredTextValues: Bool
    ) throws -> EventEnvelope {
        if let serverSequence, serverSequence <= 0 {
            throw WireEventV1Error.invalidServerSequence(serverSequence)
        }
        guard authoredText.isEmpty else { throw WireEventV1Error.hydrationRequiresArithmeticOnlyEvent }
        guard textStates.map(\.field) == textFields else { throw WireEventV1Error.textStatesDoNotMatchManifest }
        let text = try Dictionary(uniqueKeysWithValues: textStates.map { state in
            switch state {
            case let .present(field, value):
                if validateAuthoredTextValues {
                    try Self.validateAuthoredText(value, field: field)
                }
                return (field, value)
            case let .redacted(field):
                return (field, Self.redactedTextPlaceholder)
            }
        })
        return EventEnvelope(
            id: eventId,
            potID: potId,
            actorMemberID: actorMemberId,
            occurredAt: Date(timeIntervalSince1970: Double(occurredAtMillis) / 1_000),
            originatingTimeZone: originatingTimeZone,
            schemaVersion: schemaVersion,
            serverSequence: serverSequence,
            payload: try payload.domainPayload(text: text)
        )
    }
}
