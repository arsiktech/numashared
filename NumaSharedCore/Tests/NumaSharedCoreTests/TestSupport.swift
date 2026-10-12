import Foundation
@testable import NumaSharedCore

struct CoreFixture {
    let potID = PotID(unchecked: testUUID(1))
    let actorID = MemberID(unchecked: testUUID(2))
    let am = UnitID(unchecked: testUUID(10))
    let sam = UnitID(unchecked: testUUID(11))
    let leo = UnitID(unchecked: testUUID(12))
    let rentRecordID = RecordID(unchecked: testUUID(20))
    let groceryRecordID = RecordID(unchecked: testUUID(21))
    let internetRecordID = RecordID(unchecked: testUUID(22))
    let pharmacyRecordID = RecordID(unchecked: testUUID(23))
    let samSettlementID = RecordID(unchecked: testUUID(24))
    let leoSettlementID = RecordID(unchecked: testUUID(25))
    let timeZone: IANATimeZone
    let pot: PotConfiguration

    init() throws {
        timeZone = try IANATimeZone("Europe/Madrid")
        pot = try PotConfiguration(
            id: potID,
            currency: .eur,
            orderedUnitIDs: [am, sam, leo]
        )
    }

    func event(
        _ sequence: Int64?,
        id: UInt16,
        schemaVersion: UInt16 = EventEnvelope.currentSchemaVersion,
        payload: EventPayload
    ) -> EventEnvelope {
        EventEnvelope(
            id: EventID(unchecked: testUUID(id)),
            potID: potID,
            actorMemberID: actorID,
            occurredAt: Date(timeIntervalSince1970: 1_783_814_400 + Double(id)),
            originatingTimeZone: timeZone,
            schemaVersion: schemaVersion,
            serverSequence: sequence,
            payload: payload
        )
    }

    func expense(
        recordID: RecordID,
        kind: ExpenseKind = .shared,
        title: String,
        amount: Int64,
        payer: UnitID,
        allocations: [(UnitID, Int64)]
    ) -> ExpenseAddedPayload {
        ExpenseAddedPayload(
            recordID: recordID,
            content: ExpenseContent(
                kind: kind,
                title: title,
                amount: Money(minorUnits: amount, currency: .eur),
                payerUnitID: payer,
                allocations: allocations.map {
                    ExpenseAllocation(
                        unitID: $0.0,
                        amount: Money(minorUnits: $0.1, currency: .eur)
                    )
                }
            )
        )
    }

    func settlement(
        recordID: RecordID,
        title: String,
        amount: Int64,
        from: UnitID,
        to: UnitID,
        reversalOf: RecordID? = nil
    ) -> SettlementRecordedPayload {
        SettlementRecordedPayload(
            recordID: recordID,
            content: SettlementContent(
                title: title,
                amount: Money(minorUnits: amount, currency: .eur),
                fromUnitID: from,
                toUnitID: to,
                reversalOfRecordID: reversalOf
            )
        )
    }

    var canonicalEvents: [EventEnvelope] {
        [
            event(1, id: 101, payload: .expenseAdded(expense(
                recordID: rentRecordID,
                title: "Rent — July",
                amount: 180_000,
                payer: am,
                allocations: [(am, 90_000), (sam, 45_000), (leo, 45_000)]
            ))),
            event(2, id: 102, payload: .expenseAdded(expense(
                recordID: groceryRecordID,
                title: "Groceries at Lidl",
                amount: 12_000,
                payer: sam,
                allocations: [(am, 6_000), (sam, 3_000), (leo, 3_000)]
            ))),
            event(3, id: 103, payload: .expenseAdded(expense(
                recordID: internetRecordID,
                title: "Internet",
                amount: 6_000,
                payer: leo,
                allocations: [(am, 3_000), (sam, 1_500), (leo, 1_500)]
            ))),
            event(4, id: 104, payload: .expenseAdded(expense(
                recordID: pharmacyRecordID,
                kind: .personal,
                title: "Pharmacy — for Leo",
                amount: 2_000,
                payer: am,
                allocations: [(leo, 2_000)]
            ))),
            event(5, id: 105, payload: .settlementRecorded(settlement(
                recordID: samSettlementID,
                title: "Sam paid your household",
                amount: 30_000,
                from: sam,
                to: am
            ))),
            event(6, id: 106, payload: .settlementRecorded(settlement(
                recordID: leoSettlementID,
                title: "Leo paid your household",
                amount: 40_000,
                from: leo,
                to: am
            ))),
        ]
    }
}

func testUUID(_ value: UInt16) -> UUID {
    UUID(uuid: (
        0, 0, 0, 0, 0, 0,
        0x70, 0,
        0x80, 0, 0, 0, 0, 0,
        UInt8(truncatingIfNeeded: value >> 8),
        UInt8(truncatingIfNeeded: value)
    ))
}
