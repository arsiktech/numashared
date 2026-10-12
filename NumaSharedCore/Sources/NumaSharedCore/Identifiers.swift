import Foundation

// MARK: - UUIDv7

/// Failures that prevent construction of a standards-shaped UUIDv7 value.
public enum UUIDv7Error: Error, Equatable, Sendable {
    case timestampOutOfRange(UInt64)
}

/// A UUID supplied for a typed domain identifier was not RFC 9562 UUIDv7.
public enum TaggedIDError: Error, Equatable, Sendable {
    case notUUIDv7(UUID)
}

/// UUIDv7 construction and inspection with injectable randomness for tests.
public enum UUIDv7 {
    private static let maximumTimestamp: UInt64 = 0x0000_FFFF_FFFF_FFFF

    /// Generates a UUIDv7 using the current wall clock and system randomness.
    public static func generate(at date: Date = Date()) -> UUID {
        let milliseconds = date.timeIntervalSince1970 * 1_000
        let clamped: UInt64
        if !milliseconds.isFinite || milliseconds <= 0 {
            clamped = 0
        } else if milliseconds >= Double(maximumTimestamp) {
            clamped = maximumTimestamp
        } else {
            clamped = UInt64(milliseconds.rounded(.down))
        }
        var generator = SystemRandomNumberGenerator()
        return make(timestampMilliseconds: clamped, using: &generator)
    }

    /// Generates a UUIDv7 for an exact millisecond timestamp.
    ///
    /// Passing a deterministic random-number generator makes bit layout and
    /// ordering tests independent of the system clock.
    public static func generate<R: RandomNumberGenerator>(
        timestampMilliseconds: UInt64,
        using generator: inout R
    ) throws -> UUID {
        guard timestampMilliseconds <= maximumTimestamp else { throw UUIDv7Error.timestampOutOfRange(timestampMilliseconds) }
        return make(timestampMilliseconds: timestampMilliseconds, using: &generator)
    }

    /// Returns the embedded Unix millisecond timestamp for a UUIDv7.
    public static func timestampMilliseconds(of uuid: UUID) -> UInt64? {
        let bytes = byteArray(of: uuid)
        guard bytes[6] >> 4 == 0x7, bytes[8] & 0xC0 == 0x80 else { return nil }
        return UInt64(bytes[0]) << 40
            | UInt64(bytes[1]) << 32
            | UInt64(bytes[2]) << 24
            | UInt64(bytes[3]) << 16
            | UInt64(bytes[4]) << 8
            | UInt64(bytes[5])
    }

    private static func make<R: RandomNumberGenerator>(
        timestampMilliseconds: UInt64,
        using generator: inout R
    ) -> UUID {
        var random = [UInt8]()
        random.reserveCapacity(10)
        for _ in 0 ..< 10 {
            random.append(UInt8(truncatingIfNeeded: generator.next()))
        }

        let bytes: [UInt8] = [
            UInt8(truncatingIfNeeded: timestampMilliseconds >> 40),
            UInt8(truncatingIfNeeded: timestampMilliseconds >> 32),
            UInt8(truncatingIfNeeded: timestampMilliseconds >> 24),
            UInt8(truncatingIfNeeded: timestampMilliseconds >> 16),
            UInt8(truncatingIfNeeded: timestampMilliseconds >> 8),
            UInt8(truncatingIfNeeded: timestampMilliseconds),
            0x70 | (random[0] & 0x0F),
            random[1],
            0x80 | (random[2] & 0x3F),
            random[3],
            random[4],
            random[5],
            random[6],
            random[7],
            random[8],
            random[9],
        ]
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    private static func byteArray(of uuid: UUID) -> [UInt8] {
        let value = uuid.uuid
        return [
            value.0, value.1, value.2, value.3,
            value.4, value.5, value.6, value.7,
            value.8, value.9, value.10, value.11,
            value.12, value.13, value.14, value.15,
        ]
    }
}

// MARK: - Tagged identifiers

/// A UUID-backed identifier whose phantom tag prevents cross-domain mixing.
public struct TaggedID<Tag>: Hashable, Codable, Sendable, Comparable,
    CustomStringConvertible
{
    public let rawValue: UUID

    /// Validates a UUIDv7 received at an API or persistence boundary.
    public init(validating rawValue: UUID) throws {
        guard UUIDv7.timestampMilliseconds(of: rawValue) != nil else { throw TaggedIDError.notUUIDv7(rawValue) }
        self.rawValue = rawValue
    }

    internal init(unchecked rawValue: UUID) {
        self.rawValue = rawValue
    }

    public static func generate(at date: Date = Date()) -> TaggedID<Tag> {
        TaggedID(unchecked: UUIDv7.generate(at: date))
    }

    public static func < (lhs: TaggedID<Tag>, rhs: TaggedID<Tag>) -> Bool {
        lhs.normalizedRepresentation < rhs.normalizedRepresentation
    }

    public var description: String { normalizedRepresentation }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(validating: container.decode(UUID.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    private var normalizedRepresentation: String {
        rawValue.uuidString.lowercased()
    }
}

public enum PotIDTag: Sendable {}
public enum MemberIDTag: Sendable {}
public enum UnitIDTag: Sendable {}
public enum RecordIDTag: Sendable {}
public enum EventIDTag: Sendable {}
public enum GroupIDTag: Sendable {}

/// A pot identifier.
public typealias PotID = TaggedID<PotIDTag>
/// A household member identifier.
public typealias MemberID = TaggedID<MemberIDTag>
/// A balance-bearing household unit identifier.
public typealias UnitID = TaggedID<UnitIDTag>
/// A ledger record identifier.
public typealias RecordID = TaggedID<RecordIDTag>
/// An event idempotency key and revision identifier.
public typealias EventID = TaggedID<EventIDTag>
/// A household grouping identifier.
public typealias GroupID = TaggedID<GroupIDTag>
