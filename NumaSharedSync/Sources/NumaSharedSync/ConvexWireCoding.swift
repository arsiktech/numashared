import ConvexMobile
import Foundation
import NumaSharedCore

enum ConvexWireCodingError: Error, Equatable, Sendable {
    case unsupportedUploadKind(String)
    case invalidIntegerEncoding
    case invalidFloatEncoding
}

indirect enum ConvexWireArgument: ConvexEncodable, Sendable {
    case string(String)
    case int64(Int64)
    case float(Double)
    case bool(Bool)
    case array([ConvexWireArgument])
    case object([String: ConvexWireArgument])

    func convexEncode() throws -> String {
        switch self {
        case let .string(value):
            return try value.convexEncode()
        case let .int64(value):
            return try value.convexEncode()
        case let .float(value):
            guard value.isFinite else {
                throw ConvexWireCodingError.invalidFloatEncoding
            }
            return try value.convexEncode()
        case let .bool(value):
            return try value.convexEncode()
        case let .array(values):
            let elements = try values.map { try $0.convexEncode() }
            return "[\(elements.joined(separator: ","))]"
        case let .object(values):
            let fields = try values.keys.sorted().map { key in
                let encodedKey = try key.convexEncode()
                let encodedValue = try values[key]?.convexEncode() ?? "null"
                return "\(encodedKey):\(encodedValue)"
            }
            return "{\(fields.joined(separator: ","))}"
        }
    }
}

enum ConvexWireArguments {
    static func event(_ event: WireEventV1) throws -> ConvexWireArgument {
        let object: [String: ConvexWireArgument] = [
            "eventId": .string(event.eventId.description),
            "potId": .string(event.potId.description),
            "actorMemberId": .string(event.actorMemberId.description),
            "occurredAtMillis": .int64(event.occurredAtMillis),
            "originatingTimeZone": .string(event.originatingTimeZone.identifier),
            "schemaVersion": .int64(Int64(event.schemaVersion)),
            "payload": try payload(event.payload),
            "textFields": .array(event.textFields.map { .string($0.rawValue) }),
            "authoredText": .array(event.authoredText.map { text in
                .object([
                    "field": .string(text.field.rawValue),
                    "value": .string(text.value),
                ])
            }),
        ]
        return .object(object)
    }

    static func configuration(
        _ request: LocalPotPromotionRequest
    ) -> ConvexWireArgument {
        .object([
            "potId": .string(request.configuration.id.description),
            "currency": currency(request.configuration.currency),
            "orderedUnitIds": .array(
                request.configuration.orderedUnitIDs.map { .string($0.description) }
            ),
            "ownerMemberId": .string(request.ownerMemberID.description),
            "minimumReaderSchemaVersion": .int64(
                Int64(request.minimumReaderSchemaVersion)
            ),
        ])
    }

    static func decode<T: Decodable>(
        _ type: T.Type,
        from value: ConvexDecodedValue
    ) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }

    private static func payload(
        _ payload: WireEventPayloadV1
    ) throws -> ConvexWireArgument {
        switch payload {
        case let .expenseAdded(recordId, content):
            .object([
                "kind": .string("expenseAdded"),
                "recordId": .string(recordId.description),
                "content": expense(content),
            ])
        case let .expenseRevised(recordId, basis, content):
            .object([
                "kind": .string("expenseRevised"),
                "recordId": .string(recordId.description),
                "basis": revisionBasis(basis),
                "content": revisable(content),
            ])
        case let .recordVoided(recordId):
            recordPayload(kind: "recordVoided", recordId: recordId)
        case let .recordRestored(recordId):
            recordPayload(kind: "recordRestored", recordId: recordId)
        case let .settlementRecorded(recordId, content):
            .object([
                "kind": .string("settlementRecorded"),
                "recordId": .string(recordId.description),
                "content": settlement(content),
            ])
        case let .settlementFlagged(recordId):
            recordPayload(kind: "settlementFlagged", recordId: recordId)
        case let .openingBalanceSet(recordId, content):
            .object([
                "kind": .string("openingBalanceSet"),
                "recordId": .string(recordId.description),
                "content": openingBalance(content),
            ])
        case let .memberAdded(memberId, unitId, role):
            .object([
                "kind": .string("memberAdded"),
                "memberId": .string(memberId.description),
                "unitId": .string(unitId.description),
                "role": .string(role.rawValue),
            ])
        case let .memberClaimed(memberId):
            memberPayload(kind: "memberClaimed", memberId: memberId)
        case let .memberClaimReassigned(memberId):
            memberPayload(kind: "memberClaimReassigned", memberId: memberId)
        case let .memberArchived(memberId):
            memberPayload(kind: "memberArchived", memberId: memberId)
        case let .ownershipTransferred(fromMemberId, toMemberId):
            .object([
                "kind": .string("ownershipTransferred"),
                "fromMemberId": .string(fromMemberId.description),
                "toMemberId": .string(toMemberId.description),
            ])
        case let .groupChanged(groups):
            .object([
                "kind": .string("groupChanged"),
                "groups": .array(groups.map(group)),
            ])
        case let .presetChanged(name, orderedUnitIds):
            .object([
                "kind": .string("presetChanged"),
                "name": .string(name),
                "orderedUnitIds": .array(orderedUnitIds.map { .string($0.description) }),
            ])
        case let .potRenamed(name):
            .object([
                "kind": .string("potRenamed"),
                "name": .string(name),
            ])
        case .potArchived:
            .object(["kind": .string("potArchived")])
        case let .unsupported(kind, _):
            throw ConvexWireCodingError.unsupportedUploadKind(kind)
        }
    }

    private static func expense(_ content: WireExpenseContentV1) -> ConvexWireArgument {
        var object: [String: ConvexWireArgument] = [
            "expenseKind": .string(content.expenseKind.rawValue),
            "amount": money(content.amount),
            "payerUnitId": .string(content.payerUnitId.description),
            "allocations": .array(content.allocations.map { allocation in
                .object(["unitId": .string(allocation.unitId.description), "amount": money(allocation.amount)])
            }),
        ]
        if let memberID = content.payerMemberId { object["payerMemberId"] = .string(memberID.description) }
        return .object(object)
    }

    private static func openingBalance(
        _ content: WireOpeningBalanceContentV1
    ) -> ConvexWireArgument {
        .object([
            "entries": .array(content.entries.map { entry in
                .object([
                    "unitId": .string(entry.unitId.description),
                    "amount": money(entry.amount),
                ])
            }),
        ])
    }

    private static func settlement(
        _ content: WireSettlementContentV1
    ) -> ConvexWireArgument {
        var fields: [String: ConvexWireArgument] = [
            "amount": money(content.amount),
            "fromUnitId": .string(content.fromUnitId.description),
            "toUnitId": .string(content.toUnitId.description),
        ]
        if let target = content.reversalOfRecordId {
            fields["reversalOfRecordId"] = .string(target.description)
        }
        return .object(fields)
    }

    private static func revisionBasis(
        _ basis: WireRevisionBasisV1
    ) -> ConvexWireArgument {
        switch basis {
        case let .parent(parentEventId):
            .object([
                "kind": .string("parent"),
                "parentEventId": .string(parentEventId.description),
            ])
        case let .resolution(firstEventId, secondEventId):
            .object([
                "kind": .string("resolution"),
                "firstEventId": .string(firstEventId.description),
                "secondEventId": .string(secondEventId.description),
            ])
        }
    }

    private static func revisable(
        _ content: WireRevisableContentV1
    ) -> ConvexWireArgument {
        switch content {
        case let .expense(expenseContent):
            guard case var .object(object) = expense(expenseContent) else { preconditionFailure() }
            object["kind"] = .string("expense")
            return .object(object)
        case let .openingBalance(openingContent):
            return .object([
                "kind": .string("openingBalance"),
                "entries": .array(openingContent.entries.map { entry in
                    .object([
                        "unitId": .string(entry.unitId.description),
                        "amount": money(entry.amount),
                    ])
                }),
            ])
        }
    }

    private static func group(_ group: WireSettlementGroupV1) -> ConvexWireArgument {
        .object([
            "groupId": .string(group.groupId.description),
            "unitId": .string(group.unitId.description),
            "orderedMemberIds": .array(
                group.orderedMemberIds.map { .string($0.description) }
            ),
            "defaultShareWeight": .int64(group.defaultShareWeight),
        ])
    }

    private static func money(_ money: Money) -> ConvexWireArgument {
        .object([
            "minorUnits": .int64(money.minorUnits),
            "currency": currency(money.currency),
        ])
    }

    private static func currency(_ currency: Currency) -> ConvexWireArgument {
        .object([
            "code": .string(currency.code),
            "exponent": .int64(Int64(currency.exponent)),
        ])
    }

    private static func recordPayload(
        kind: String,
        recordId: RecordID
    ) -> ConvexWireArgument {
        .object([
            "kind": .string(kind),
            "recordId": .string(recordId.description),
        ])
    }

    private static func memberPayload(
        kind: String,
        memberId: MemberID
    ) -> ConvexWireArgument {
        .object([
            "kind": .string(kind),
            "memberId": .string(memberId.description),
        ])
    }
}

indirect enum ConvexDecodedValue: Codable, Sendable {
    case object([String: ConvexDecodedValue])
    case array([ConvexDecodedValue])
    case string(String)
    case int64(Int64)
    case decimal(Decimal)
    case float(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: DynamicCodingKey.self) {
            if container.allKeys.count == 1,
               let integerKey = container.allKeys.first(where: { $0.stringValue == "$integer" }) {
                self = .int64(try Self.decodeInteger(
                    container.decode(String.self, forKey: integerKey)
                ))
                return
            }
            if container.allKeys.count == 1,
               let floatKey = container.allKeys.first(where: { $0.stringValue == "$float" }) {
                self = .float(try Self.decodeFloat(
                    container.decode(String.self, forKey: floatKey)
                ))
                return
            }
            self = .object(try Dictionary(uniqueKeysWithValues: container.allKeys.map { key in
                (key.stringValue, try container.decode(ConvexDecodedValue.self, forKey: key))
            }))
            return
        }
        if var container = try? decoder.unkeyedContainer() {
            var values: [ConvexDecodedValue] = []
            while !container.isAtEnd {
                values.append(try container.decode(ConvexDecodedValue.self))
            }
            self = .array(values)
            return
        }
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Decimal.self) {
            self = .decimal(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case let .object(values):
            var container = encoder.container(keyedBy: DynamicCodingKey.self)
            for (key, value) in values {
                try container.encode(value, forKey: DynamicCodingKey(key))
            }
        case let .array(values):
            var container = encoder.unkeyedContainer()
            for value in values { try container.encode(value) }
        case let .string(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .int64(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .decimal(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .float(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .bool(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        }
    }

    private static func decodeInteger(_ base64: String) throws -> Int64 {
        guard let data = Data(base64Encoded: base64), data.count == 8 else {
            throw ConvexWireCodingError.invalidIntegerEncoding
        }
        var bits: UInt64 = 0
        for (offset, byte) in data.enumerated() {
            bits |= UInt64(byte) << UInt64(offset * 8)
        }
        return Int64(bitPattern: bits)
    }

    private static func decodeFloat(_ base64: String) throws -> Double {
        guard let data = Data(base64Encoded: base64), data.count == 8 else {
            throw ConvexWireCodingError.invalidFloatEncoding
        }
        var bits: UInt64 = 0
        for (offset, byte) in data.enumerated() {
            bits |= UInt64(byte) << UInt64(offset * 8)
        }
        let value = Double(bitPattern: bits)
        guard value.isFinite else { throw ConvexWireCodingError.invalidFloatEncoding }
        return value
    }
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init(_ stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}
