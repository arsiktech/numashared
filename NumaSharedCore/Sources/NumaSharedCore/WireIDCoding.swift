import Foundation

// MARK: - Lowercase typed identifier coding
//
// One shared UUIDv7 wire codec: wire v1 identifiers are lowercase UUID strings
// and every decode fails closed on malformed input.

internal extension KeyedEncodingContainer {
    mutating func encodeWireID<Tag>(
        _ value: TaggedID<Tag>,
        forKey key: Key
    ) throws {
        try encode(value.description, forKey: key)
    }

    mutating func encodeWireIDs<Tag>(
        _ values: [TaggedID<Tag>],
        forKey key: Key
    ) throws {
        try encode(values.map(\.description), forKey: key)
    }

    mutating func encodeWireIDIfPresent<Tag>(
        _ value: TaggedID<Tag>?,
        forKey key: Key
    ) throws {
        try encodeIfPresent(value?.description, forKey: key)
    }
}

internal extension KeyedDecodingContainer {
    func decodeWireID<Tag>(
        _ type: TaggedID<Tag>.Type,
        forKey key: Key
    ) throws -> TaggedID<Tag> {
        try Self.parsedID(try decode(String.self, forKey: key), key: key, in: self)
    }

    func decodeWireIDIfPresent<Tag>(
        _ type: TaggedID<Tag>.Type,
        forKey key: Key
    ) throws -> TaggedID<Tag>? {
        guard let string = try decodeIfPresent(String.self, forKey: key) else { return nil }
        return try Self.parsedID(string, key: key, in: self)
    }

    func decodeWireIDs<Tag>(
        _ type: TaggedID<Tag>.Type,
        forKey key: Key
    ) throws -> [TaggedID<Tag>] {
        try decode([String].self, forKey: key).map {
            try Self.parsedID($0, key: key, in: self)
        }
    }

    private static func parsedID<Tag, Container: KeyedDecodingContainerProtocol>(
        _ string: String,
        key: Container.Key,
        in container: Container
    ) throws -> TaggedID<Tag> {
        func malformed() -> DecodingError {
            .dataCorruptedError(
                forKey: key,
                in: container,
                debugDescription: "Expected a UUIDv7 string"
            )
        }
        guard let uuid = UUID(uuidString: string) else { throw malformed() }
        do {
            return try TaggedID<Tag>(validating: uuid)
        } catch {
            throw malformed()
        }
    }
}
