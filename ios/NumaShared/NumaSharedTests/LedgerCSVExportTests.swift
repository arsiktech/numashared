import Foundation
import NumaSharedCore
import NumaSharedSync
import XCTest
@testable import NumaShared

final class LedgerCSVExportTests: XCTestCase {
    func testCSVIsEscapedRedactionSafeAndReplaysAppliedRowsExactly() throws {
        let date = Date(timeIntervalSince1970: 1_783_814_400.125)
        let potID = PotID.generate(at: date)
        let memberID = NumaSharedCore.MemberID.generate(at: date)
        let payer = NumaSharedCore.UnitID.generate(at: date)
        let beneficiary = NumaSharedCore.UnitID.generate(at: date)
        let configuration = try PotConfiguration(
            id: potID,
            currency: .eur,
            orderedUnitIDs: [payer, beneficiary]
        )
        let event = EventEnvelope(
            id: EventID.generate(at: date),
            potID: potID,
            actorMemberID: memberID,
            occurredAt: date,
            originatingTimeZone: try IANATimeZone("Europe/Madrid"),
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: RecordID.generate(at: date),
                content: ExpenseContent(
                    kind: .shared,
                    title: "Private, \"quoted\"\nvalue",
                    amount: Money(minorUnits: 12_345, currency: .eur),
                    payerUnitID: payer,
                    allocations: [
                        ExpenseAllocation(
                            unitID: beneficiary,
                            amount: Money(minorUnits: 12_345, currency: .eur)
                        ),
                    ]
                )
            ))
        )
        let store = try LedgerStore.inMemory(now: date)
        try store.registerPot(configuration, at: date)
        _ = try store.appendHeldLocalEvent(event, savedAt: date)
        XCTAssertEqual(try store.redactAuthoredText(for: event.id), 1)
        let snapshot = try store.snapshot(for: potID)

        let export = try LedgerCSVExporter.make(
            potName: "Casa, \"Mar\"",
            configuration: configuration,
            snapshot: snapshot
        )
        let csv = try XCTUnwrap(String(data: export.data, encoding: .utf8))
        XCTAssertFalse(csv.contains("Private"))
        XCTAssertTrue(csv.contains("[redacted]"))
        XCTAssertEqual(export.rowCount, 1)
        XCTAssertEqual(export.filename, "casa-mar-event-log.csv")

        let rows = parseCSV(csv)
        XCTAssertEqual(rows.count, 2)
        let header = try XCTUnwrap(rows.first)
        let dataRow = try XCTUnwrap(rows.dropFirst().first)
        XCTAssertEqual(header, LedgerCSVExporter.columns)
        let values = Dictionary(uniqueKeysWithValues: zip(header, dataRow))
        XCTAssertEqual(values["pot_name"], "Casa, \"Mar\"")
        XCTAssertEqual(values["applied_order"], "0")

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let decodedConfiguration = try decoder.decode(
            PotConfiguration.self,
            from: Data(try XCTUnwrap(values["pot_configuration_json"]).utf8)
        )
        let decodedEvent = try decoder.decode(
            EventEnvelope.self,
            from: Data(try XCTUnwrap(values["event_json"]).utf8)
        )
        let replay = LedgerReducer().reduce(
            pot: decodedConfiguration,
            events: [decodedEvent]
        )
        XCTAssertEqual(replay.projection.balances, snapshot.reduction.projection.balances)
        XCTAssertEqual(
            replay.projection.appliedEventIDs,
            snapshot.reduction.projection.appliedEventIDs
        )
    }

    func testFormulaLikeHouseholdNamesAreTextWithoutChangingReplayColumns() throws {
        let date = Date(timeIntervalSince1970: 1_783_814_400)
        let pot = PotID.generate(at: date)
        let configuration = try PotConfiguration(
            id: pot, currency: .eur,
            orderedUnitIDs: [.generate(at: date), .generate(at: date)]
        )
        let store = try LedgerStore.inMemory(now: date)
        try store.registerPot(configuration, at: date)
        let event = EventEnvelope(
            id: .generate(at: date), potID: pot, actorMemberID: .generate(at: date),
            occurredAt: date, originatingTimeZone: try IANATimeZone("UTC"),
            payload: .potRenamed(PotRenamedPayload(name: "=1+1"))
        )
        _ = try store.appendHeldLocalEvent(event, savedAt: date)
        let snapshot = try store.snapshot(for: pot)
        func row(_ name: String) throws -> [String] {
            let export = try LedgerCSVExporter.make(
                potName: name, configuration: configuration, snapshot: snapshot
            )
            return try XCTUnwrap(parseCSV(try XCTUnwrap(
                String(data: export.data, encoding: .utf8)
            )).dropFirst().first)
        }
        let baseline = try row("Casa, \"Mar\"")
        XCTAssertEqual(baseline[1], "Casa, \"Mar\"")
        for name in ["=1+1", "+1+1", "-1+1", "@SUM(1)", "  =1+1", "\t=1+1",
                     "\r=1+1", "\n=1+1", "\u{FEFF}=1+1", "＝1+1", "＋1", "－1", "＠SUM(1)",
                     "=1+1\",\"=2+2"] {
            let exported = try row(name)
            XCTAssertEqual(exported.count, LedgerCSVExporter.columns.count)
            XCTAssertEqual(exported[1], "\t" + name)
            XCTAssertEqual(Array(exported.dropFirst(2)), Array(baseline.dropFirst(2)))
        }
        XCTAssertEqual(try row(" Home 1")[1], " Home 1")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        let replay = try decoder.decode(EventEnvelope.self, from: Data(baseline.last!.utf8))
        XCTAssertEqual(replay, event)
    }

    private func parseCSV(_ csv: String) -> [[String]] {
        var rows = [[String]]()
        var row = [String]()
        var field = ""
        var quoted = false
        let characters = Array(csv.drop(while: { $0 == "\u{FEFF}" }))
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if quoted {
                if character == "\"" {
                    if index + 1 < characters.count, characters[index + 1] == "\"" {
                        field.append("\"")
                        index += 1
                    } else {
                        quoted = false
                    }
                } else {
                    field.append(character)
                }
            } else if character == "\"" {
                quoted = true
            } else if character == "," {
                row.append(field)
                field = ""
            } else if character == "\n" || character == "\r\n" {
                row.append(field)
                rows.append(row)
                row = []
                field = ""
            } else {
                field.append(character)
            }
            index += 1
        }
        return rows
    }
}
