import Foundation
import XCTest
@testable import NumaSharedCore

final class EventEnvelopeTests: XCTestCase {
    func testEnvelopeRoundTripsRealDateIANAZoneSchemaAndSequence() throws {
        let fixture = try CoreFixture()
        let event = fixture.canonicalEvents[0]
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970

        let decoded = try decoder.decode(
            EventEnvelope.self,
            from: encoder.encode(event)
        )

        XCTAssertEqual(decoded, event)
        XCTAssertEqual(decoded.originatingTimeZone.identifier, "Europe/Madrid")
        XCTAssertEqual(decoded.schemaVersion, 1)
        XCTAssertEqual(decoded.serverSequence, 1)
        XCTAssertThrowsError(try IANATimeZone("Today"))
    }

    func testUnknownWireKindStillDecodesForReducerSafety() throws {
        let fixture = try CoreFixture()
        let event = fixture.canonicalEvents[0]
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let encoded = try encoder.encode(event)
        let json = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        let changed = json.replacingOccurrences(
            of: "\"expenseAdded\"",
            with: "\"futureFinancialEvent\""
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970

        let decoded = try decoder.decode(
            EventEnvelope.self,
            from: Data(changed.utf8)
        )

        XCTAssertEqual(decoded.id, event.id)
        XCTAssertEqual(decoded.kind, .unsupported("futureFinancialEvent"))
        guard case let .unsupported(_, opaquePayload) = decoded.payload else {
            return XCTFail("Expected an opaque future payload")
        }
        let redecoded = try decoder.decode(
            EventEnvelope.self,
            from: encoder.encode(decoded)
        )
        guard case let .unsupported(_, reencodedPayload) = redecoded.payload else {
            return XCTFail("Expected an opaque future payload after re-encoding")
        }
        XCTAssertEqual(reencodedPayload, opaquePayload)
    }

    func testEveryBindingShipListKindHasTypedPayloadRepresentation() throws {
        let fixture = try CoreFixture()
        let member = MemberID(unchecked: testUUID(70))
        let group = GroupID(unchecked: testUUID(71))
        let groupUnit = UnitID(unchecked: testUUID(72))
        let pot = try PotConfiguration(
            id: fixture.potID,
            currency: .eur,
            topology: StructuralProjection(
                members: [
                    fixture.actorID: MemberTopology(
                        personalUnitID: fixture.am,
                        unitID: fixture.am,
                        role: .owner
                    ),
                ],
                claimedMemberIDs: [fixture.actorID],
                archivedMemberIDs: [],
                groups: [],
                presets: [],
                knownUnitIDs: [fixture.am, fixture.sam, fixture.leo]
            )
        )
        let structuralPayloads: [EventPayload] = [
            .memberAdded(MemberAddedPayload(
                memberID: member,
                unitID: fixture.sam,
                role: .member
            )),
            .memberClaimed(MemberClaimedPayload(memberID: member)),
            .memberClaimReassigned(MemberClaimReassignedPayload(memberID: member)),
            .groupChanged(GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: group,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, member],
                    defaultShareWeight: 2
                ),
            ])),
            .presetChanged(PresetChangedPayload(
                name: "Everyone",
                orderedUnitIDs: [groupUnit, fixture.leo]
            )),
            .ownershipTransferred(OwnershipTransferredPayload(
                fromMemberID: fixture.actorID,
                toMemberID: member
            )),
            .memberArchived(MemberArchivedPayload(memberID: fixture.actorID)),
            .potRenamed(PotRenamedPayload(name: "Casa Mar")),
            .potArchived(PotArchivedPayload(reason: "Household closed")),
        ]

        XCTAssertEqual(
            structuralPayloads.map { $0.kind.rawValue },
            [
                "memberAdded", "memberClaimed", "memberClaimReassigned",
                "groupChanged", "presetChanged", "ownershipTransferred",
                "memberArchived", "potRenamed", "potArchived",
            ]
        )

        let events = structuralPayloads.enumerated().map { index, payload in
            fixture.event(Int64(index + 1), id: UInt16(600 + index), payload: payload)
        }
        let result = LedgerReducer().reduce(pot: pot, events: events)

        XCTAssertEqual(result.access, .readWrite)
        XCTAssertEqual(result.projection.auditOnlyEventIDs.count, structuralPayloads.count)
        XCTAssertEqual(result.projection.latestPotName, "Casa Mar")
        XCTAssertTrue(result.projection.isArchived)
    }
}
