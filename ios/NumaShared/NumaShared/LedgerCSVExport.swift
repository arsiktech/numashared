import Foundation
import NumaSharedCore
import NumaSharedSync

nonisolated struct LedgerCSVExport: Sendable {
    let filename: String
    let data: Data
    let rowCount: Int
}

nonisolated struct LedgerCSVFile: Sendable {
    let url: URL
    let rowCount: Int
}

nonisolated enum LedgerCSVExporter {
    static let columns = [
        "format_version",
        "pot_name",
        "pot_configuration_json",
        "event_id",
        "event_kind",
        "event_schema_version",
        "server_sequence",
        "local_ordinal",
        "applied_order",
        "delivery_state",
        "event_origin",
        "attempt_count",
        "terminal_reason",
        "occurred_at_utc",
        "saved_at_utc",
        "originating_time_zone",
        "event_json",
    ]

    static func make(
        potName: String,
        configuration: PotConfiguration,
        snapshot: LedgerStoreSnapshot
    ) throws -> LedgerCSVExport {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let configurationJSON = try jsonString(
            encoder.encode(configuration)
        )
        let appliedOrder = Dictionary(
            uniqueKeysWithValues: snapshot.reduction.projection.appliedEventIDs
                .enumerated()
                .map { ($0.element, $0.offset) }
        )
        var lines = [csvLine(columns)]
        lines.reserveCapacity(snapshot.storedEvents.count + 1)

        for stored in snapshot.storedEvents {
            let event = stored.event
            lines.append(csvLine([
                "1",
                spreadsheetText(potName),
                configurationJSON,
                event.id.description,
                event.kind.rawValue,
                String(event.schemaVersion),
                event.serverSequence.map(String.init) ?? "",
                String(stored.localOrdinal),
                appliedOrder[event.id].map(String.init) ?? "",
                stored.delivery.state.rawValue,
                stored.origin.rawValue,
                String(stored.delivery.attemptCount),
                stored.delivery.terminalReason ?? "",
                timestamp(event.occurredAt),
                timestamp(stored.savedAt),
                event.originatingTimeZone.identifier,
                try jsonString(encoder.encode(event)),
            ]))
        }

        let body = lines.joined(separator: "\r\n") + "\r\n"
        var data = Data([0xEF, 0xBB, 0xBF])
        data.append(Data(body.utf8))
        return LedgerCSVExport(
            filename: filename(for: potName),
            data: data,
            rowCount: snapshot.storedEvents.count
        )
    }

    private static func jsonString(_ data: Data) throws -> String {
        guard let value = String(data: data, encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        return value
    }

    private static func timestamp(_ date: Date) -> String {
        date.formatted(
            .iso8601
                .year()
                .month()
                .day()
                .time(includingFractionalSeconds: true)
                .timeZone(separator: .colon)
        )
    }

    private static func filename(for potName: String) -> String {
        let pieces = potName.lowercased().components(
            separatedBy: CharacterSet.alphanumerics.inverted
        ).filter { !$0.isEmpty }
        let stem = String((pieces.isEmpty ? ["numa-shared"] : pieces)
            .joined(separator: "-")
            .prefix(48))
        return "\(stem)-event-log.csv"
    }

    /// Quoting protects CSV structure, but spreadsheet importers can still
    /// evaluate a quoted household name as a formula. Protect the display
    /// column only; canonical JSON and numeric replay columns stay unchanged.
    private static func spreadsheetText(_ value: String) -> String {
        let scalars = value.unicodeScalars
        let significant = scalars.first {
            !CharacterSet.whitespacesAndNewlines.contains($0) && $0.value != 0xFEFF
        }
        let formulaPrefixes: Set<Unicode.Scalar> = ["=", "+", "-", "@", "＝", "＋", "－", "＠"]
        let beginsWithControl = scalars.first.map {
            $0 == "\t" || $0 == "\r" || $0 == "\n" || $0.value == 0xFEFF
        } ?? false
        guard beginsWithControl || significant.map(formulaPrefixes.contains) == true else {
            return value
        }
        return "\t" + value
    }

    private static func csvLine(_ fields: [String]) -> String {
        fields.map { value in
            "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }.joined(separator: ",")
    }
}
