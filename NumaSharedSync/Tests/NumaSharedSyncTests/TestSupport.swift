import Foundation
import NumaSharedCore

struct SyncFixture {
    let potID: PotID
    let actorID: MemberID
    let payerID: UnitID
    let beneficiaryID: UnitID
    let recordID: RecordID
    let configuration: PotConfiguration
    let timeZone: IANATimeZone

    init() throws {
        potID = try PotID(validating: syncTestUUID(1))
        actorID = try MemberID(validating: syncTestUUID(2))
        payerID = try UnitID(validating: syncTestUUID(3))
        beneficiaryID = try UnitID(validating: syncTestUUID(4))
        recordID = try RecordID(validating: syncTestUUID(5))
        configuration = try PotConfiguration(
            id: potID,
            currency: .eur,
            orderedUnitIDs: [payerID, beneficiaryID]
        )
        timeZone = try IANATimeZone("Europe/Madrid")
    }

    func event(
        id: UInt16,
        sequence: Int64? = nil,
        title: String = "Groceries"
    ) throws -> EventEnvelope {
        let eventID = try EventID(validating: syncTestUUID(id))
        let eventRecordID = try RecordID(validating: syncTestUUID(id &+ 1_000))
        return EventEnvelope(
            id: eventID,
            potID: potID,
            actorMemberID: actorID,
            occurredAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(id)),
            originatingTimeZone: timeZone,
            serverSequence: sequence,
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: eventRecordID,
                content: ExpenseContent(
                    kind: .shared,
                    title: title,
                    amount: Money(minorUnits: 10_000, currency: .eur),
                    payerUnitID: payerID,
                    allocations: [
                        ExpenseAllocation(
                            unitID: payerID,
                            amount: Money(minorUnits: 5_000, currency: .eur)
                        ),
                        ExpenseAllocation(
                            unitID: beneficiaryID,
                            amount: Money(minorUnits: 5_000, currency: .eur)
                        ),
                    ]
                )
            ))
        )
    }
}

func syncTestUUID(_ value: UInt16) -> UUID {
    UUID(uuid: (
        0, 0, 0, 0, 0, 0,
        0x70, 0,
        0x80, 0, 0, 0, 0, 0,
        UInt8(truncatingIfNeeded: value >> 8),
        UInt8(truncatingIfNeeded: value)
    ))
}
