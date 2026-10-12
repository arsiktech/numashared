import Foundation
import GRDB
import NumaSharedCore

struct EventStorageFields: Sendable {
    let recordID: String?
    let currencyCode: String?
    let parentEventID: String?
    let resolutionHeadOne: String?
    let resolutionHeadTwo: String?
}

struct PreparedStoredEvent: Sendable {
    let arithmeticBlob: Data
    let authoredText: [WireAuthoredTextV1]
    let opaquePayloadBlob: Data?
    let opaqueFutureTextStatesBlob: Data?
}

enum StoredArithmeticEvent: Sendable {
    case wire(WireEventV1)
    case unsupported(StoredUnsupportedEventV1)

    var eventID: EventID {
        switch self {
        case let .wire(event): event.eventId
        case let .unsupported(event): event.eventId
        }
    }

    var potID: PotID {
        switch self {
        case let .wire(event): event.potId
        case let .unsupported(event): event.potId
        }
    }
}

struct StoredUnsupportedEventV1: Codable, Hashable, Sendable {
    private static let format = "unsupported-wire-v1"

    let eventId: EventID
    let potId: PotID
    let actorMemberId: MemberID
    let occurredAtMillis: Int64
    let originatingTimeZone: IANATimeZone
    let schemaVersion: UInt16
    let kind: String
    let textFields: [WireTextFieldV1]
    let opaqueFutureOriginatingTimeZoneIdentifier: String?
    let opaqueFutureTextFields: JSONValue?

    private let storageFormat: String

    init(
        event: EventEnvelope,
        kind: String,
        textFields: [WireTextFieldV1] = [],
        opaqueFutureOriginatingTimeZoneIdentifier: String? = nil,
        opaqueFutureTextFields: JSONValue? = nil
    ) throws {
        eventId = event.id
        potId = event.potID
        actorMemberId = event.actorMemberID
        occurredAtMillis = try PersistenceCoding.milliseconds(event.occurredAt)
        originatingTimeZone = event.originatingTimeZone
        schemaVersion = event.schemaVersion
        self.kind = kind
        self.textFields = textFields
        self.opaqueFutureOriginatingTimeZoneIdentifier =
            opaqueFutureOriginatingTimeZoneIdentifier
        self.opaqueFutureTextFields = opaqueFutureTextFields
        storageFormat = Self.format
    }

    private enum CodingKeys: String, CodingKey {
        case storageFormat
        case eventId
        case potId
        case actorMemberId
        case occurredAtMillis
        case originatingTimeZone
        case schemaVersion
        case kind
        case textFields
        case opaqueFutureOriginatingTimeZoneIdentifier
        case opaqueFutureTextFields
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let storageFormat = try container.decode(String.self, forKey: .storageFormat)
        guard storageFormat == Self.format else {
            throw DecodingError.dataCorruptedError(
                forKey: .storageFormat,
                in: container,
                debugDescription: "Unsupported stored event format"
            )
        }
        self.storageFormat = storageFormat
        eventId = try container.decode(EventID.self, forKey: .eventId)
        potId = try container.decode(PotID.self, forKey: .potId)
        actorMemberId = try container.decode(MemberID.self, forKey: .actorMemberId)
        occurredAtMillis = try container.decode(Int64.self, forKey: .occurredAtMillis)
        originatingTimeZone = try container.decode(
            IANATimeZone.self,
            forKey: .originatingTimeZone
        )
        schemaVersion = try container.decode(UInt16.self, forKey: .schemaVersion)
        kind = try container.decode(String.self, forKey: .kind)
        textFields = try container.decodeIfPresent(
            [WireTextFieldV1].self,
            forKey: .textFields
        ) ?? []
        opaqueFutureOriginatingTimeZoneIdentifier = try container.decodeIfPresent(
            String.self,
            forKey: .opaqueFutureOriginatingTimeZoneIdentifier
        )
        opaqueFutureTextFields = try container.decodeIfPresent(
            JSONValue.self,
            forKey: .opaqueFutureTextFields
        )
    }

    func eventEnvelope(
        serverSequence: Int64?,
        opaquePayload: JSONValue?
    ) -> EventEnvelope {
        EventEnvelope(
            id: eventId,
            potID: potId,
            actorMemberID: actorMemberId,
            occurredAt: Date(timeIntervalSince1970: Double(occurredAtMillis) / 1_000),
            originatingTimeZone: originatingTimeZone,
            schemaVersion: schemaVersion,
            serverSequence: serverSequence,
            payload: .unsupported(
                kind: kind,
                payload: opaquePayload ?? .object([:])
            )
        )
    }
}

enum PersistenceCoding {
    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(type, from: data)
    }

    static func milliseconds(_ date: Date) throws -> Int64 {
        let value = date.timeIntervalSince1970 * 1_000
        guard value.isFinite,
              value >= Double(Int64.min),
              value < Double(Int64.max)
        else {
            throw LedgerStoreError.dateOutOfRange
        }
        return Int64(value.rounded(.towardZero))
    }

    static func date(milliseconds: Int64?) -> Date? {
        milliseconds.map { Date(timeIntervalSince1970: Double($0) / 1_000) }
    }

    static func canonicalEnvelope(_ event: EventEnvelope) -> EventEnvelope {
        EventEnvelope(
            id: event.id,
            potID: event.potID,
            actorMemberID: event.actorMemberID,
            occurredAt: event.occurredAt,
            originatingTimeZone: event.originatingTimeZone,
            schemaVersion: event.schemaVersion,
            serverSequence: nil,
            payload: event.payload
        )
    }

    static func prepareForStorage(
        _ event: EventEnvelope,
        grandfatherAuthoredText: Bool = false
    ) throws -> PreparedStoredEvent {
        let canonical = canonicalEnvelope(event)
        switch canonical.payload {
        case let .unsupported(kind, payload):
            return PreparedStoredEvent(
                arithmeticBlob: try encode(StoredUnsupportedEventV1(
                    event: canonical,
                    kind: kind
                )),
                authoredText: [],
                opaquePayloadBlob: try encode(payload),
                opaqueFutureTextStatesBlob: nil
            )
        default:
            let wire = try grandfatherAuthoredText
                ? WireEventV1(grandfatheredStoredEvent: canonical)
                : WireEventV1(canonical)
            return PreparedStoredEvent(
                arithmeticBlob: try encode(wire.arithmeticOnly),
                authoredText: wire.authoredText,
                opaquePayloadBlob: nil,
                opaqueFutureTextStatesBlob: nil
            )
        }
    }

    static func storedArithmeticEvent(from data: Data) throws -> StoredArithmeticEvent {
        do {
            return .wire(try decode(WireEventV1.self, from: data))
        } catch {
            return .unsupported(try decode(StoredUnsupportedEventV1.self, from: data))
        }
    }

    static func overlay(
        serverSequence: Int64?,
        on canonicalEvent: EventEnvelope
    ) -> EventEnvelope {
        EventEnvelope(
            id: canonicalEvent.id,
            potID: canonicalEvent.potID,
            actorMemberID: canonicalEvent.actorMemberID,
            occurredAt: canonicalEvent.occurredAt,
            originatingTimeZone: canonicalEvent.originatingTimeZone,
            schemaVersion: canonicalEvent.schemaVersion,
            serverSequence: serverSequence,
            payload: canonicalEvent.payload
        )
    }

    static func fields(for payload: EventPayload) -> EventStorageFields {
        switch payload {
        case let .expenseAdded(value):
            return EventStorageFields(
                recordID: value.recordID.description,
                currencyCode: value.content.amount.currency.code,
                parentEventID: nil,
                resolutionHeadOne: nil,
                resolutionHeadTwo: nil
            )
        case let .expenseRevised(value):
            let currencyCode: String? = switch value.content {
            case let .expense(content): content.amount.currency.code
            case let .openingBalance(content): content.entries.first?.amount.currency.code
            }
            switch value.basis {
            case let .parent(parent):
                return EventStorageFields(
                    recordID: value.recordID.description,
                    currencyCode: currencyCode,
                    parentEventID: parent.description,
                    resolutionHeadOne: nil,
                    resolutionHeadTwo: nil
                )
            case let .resolution(pair):
                return EventStorageFields(
                    recordID: value.recordID.description,
                    currencyCode: currencyCode,
                    parentEventID: nil,
                    resolutionHeadOne: pair.first.description,
                    resolutionHeadTwo: pair.second.description
                )
            }
        case let .recordVoided(value):
            return recordOnly(value.recordID)
        case let .recordRestored(value):
            return recordOnly(value.recordID)
        case let .settlementRecorded(value):
            return EventStorageFields(
                recordID: value.recordID.description,
                currencyCode: value.content.amount.currency.code,
                parentEventID: nil,
                resolutionHeadOne: nil,
                resolutionHeadTwo: nil
            )
        case let .settlementFlagged(value):
            return recordOnly(value.recordID)
        case let .openingBalanceSet(value):
            return EventStorageFields(
                recordID: value.recordID.description,
                currencyCode: value.content.entries.first?.amount.currency.code,
                parentEventID: nil,
                resolutionHeadOne: nil,
                resolutionHeadTwo: nil
            )
        case .memberAdded, .memberClaimed, .memberClaimReassigned, .memberArchived,
             .ownershipTransferred, .groupChanged, .presetChanged, .potRenamed,
             .potArchived, .unsupported:
            return EventStorageFields(
                recordID: nil,
                currencyCode: nil,
                parentEventID: nil,
                resolutionHeadOne: nil,
                resolutionHeadTwo: nil
            )
        }
    }

    static func storedEvent(from row: Row, in db: Database) throws -> StoredLedgerEvent {
        let envelopeBlob: Data = row["envelopeBlob"]
        let arithmetic = try storedArithmeticEvent(from: envelopeBlob)
        let serverSequence: Int64? = row["serverSequence"]
        let event: EventEnvelope = switch arithmetic {
        case let .wire(wire):
            try wire.grandfatheredStoredEventEnvelope(
                serverSequence: serverSequence,
                textStates: textStates(for: wire, in: db)
            )
        case let .unsupported(unsupported):
            unsupported.eventEnvelope(
                serverSequence: serverSequence,
                opaquePayload: try opaquePayload(for: unsupported.eventId, in: db)
            )
        }
        let rawOrigin: String = row["origin"]
        let legacyAuthoredText: Bool = switch arithmetic {
        case let .wire(wire): wire.legacyAuthoredText
        case .unsupported: false
        }
        return StoredLedgerEvent(
            localOrdinal: row["localOrdinal"],
            origin: try eventOrigin(rawOrigin),
            event: event,
            legacyAuthoredText: legacyAuthoredText,
            savedAt: date(milliseconds: row["savedAtMillis"]) ?? .distantPast,
            delivery: EventDelivery(
                eventID: event.id,
                potID: event.potID,
                state: try deliveryState(row["state"]),
                undoDeadline: date(milliseconds: row["undoDeadlineMillis"]),
                firstDispatchedAt: date(milliseconds: row["firstDispatchedAtMillis"]),
                attemptCount: row["attemptCount"],
                nextRetryAt: date(milliseconds: row["nextRetryAtMillis"]),
                serverSequence: serverSequence,
                terminalReason: row["terminalReason"]
            )
        )
    }

    static func delivery(from row: Row) throws -> EventDelivery {
        let envelopeBlob: Data = row["envelopeBlob"]
        let event = try storedArithmeticEvent(from: envelopeBlob)
        return EventDelivery(
            eventID: event.eventID,
            potID: event.potID,
            state: try deliveryState(row["state"]),
            undoDeadline: date(milliseconds: row["undoDeadlineMillis"]),
            firstDispatchedAt: date(milliseconds: row["firstDispatchedAtMillis"]),
            attemptCount: row["attemptCount"],
            nextRetryAt: date(milliseconds: row["nextRetryAtMillis"]),
            serverSequence: row["serverSequence"],
            terminalReason: row["terminalReason"]
        )
    }

    static func textStates(
        for wire: WireEventV1,
        in db: Database
    ) throws -> [WireTextStateV1] {
        try textStates(for: wire.eventId, fields: wire.textFields, in: db)
    }

    static func textStates(
        for unsupported: StoredUnsupportedEventV1,
        in db: Database
    ) throws -> [WireTextStateV1] {
        try textStates(
            for: unsupported.eventId,
            fields: unsupported.textFields,
            in: db
        )
    }

    private static func textStates(
        for eventID: EventID,
        fields: [WireTextFieldV1],
        in db: Database
    ) throws -> [WireTextStateV1] {
        let rows = try Row.fetchAll(
            db,
            sql: "SELECT field, value FROM event_text_sidecars WHERE eventID = ?",
            arguments: [eventID.description]
        )
        let values = try Dictionary(uniqueKeysWithValues: rows.map { row in
            let rawField: String = row["field"]
            guard let field = WireTextFieldV1(rawValue: rawField) else {
                throw LedgerStoreError.corruptTextField(rawField)
            }
            let value: String = row["value"]
            return (field, value)
        })
        return fields.map { field in
            values[field].map { .present(field: field, value: $0) }
                ?? .redacted(field: field)
        }
    }

    static func opaquePayload(
        for eventID: EventID,
        in db: Database
    ) throws -> JSONValue? {
        guard let blob: Data = try Data.fetchOne(
            db,
            sql: "SELECT payloadBlob FROM event_opaque_sidecars WHERE eventID = ?",
            arguments: [eventID.description]
        ) else { return nil }
        return try decode(JSONValue.self, from: blob)
    }

    private static func recordOnly(_ recordID: RecordID) -> EventStorageFields {
        EventStorageFields(
            recordID: recordID.description,
            currencyCode: nil,
            parentEventID: nil,
            resolutionHeadOne: nil,
            resolutionHeadTwo: nil
        )
    }

    private static func deliveryState(_ rawValue: String) throws -> DeliveryState {
        guard let state = DeliveryState(rawValue: rawValue) else {
            throw LedgerStoreError.corruptDeliveryState(rawValue)
        }
        return state
    }

    private static func eventOrigin(_ rawValue: String) throws -> EventOrigin {
        guard let origin = EventOrigin(rawValue: rawValue) else {
            throw LedgerStoreError.corruptEventOrigin(rawValue)
        }
        return origin
    }
}
