import Foundation
import XCTest
@testable import NumaSharedCore

final class WireEventV1Tests: XCTestCase {
    func testAuthoredTextBlankParityMatchesFoundationAndWireDecoder() throws {
        let fixtureURL = try XCTUnwrap(
            Bundle.module.url(
                forResource: "authored-text-blank-parity",
                withExtension: "json"
            )
        )
        let parityCases = try JSONDecoder().decode(
            [AuthoredTextBlankParityCase].self,
            from: Data(contentsOf: fixtureURL)
        )
        let contractEvents = try wireContractEvents()
        let uploads = [
            (try WireEventV1(contractEvents[0]), WireTextFieldV1.title),
            (try WireEventV1(contractEvents[3]), WireTextFieldV1.reason),
        ]

        for parityCase in parityCases {
            let foundationResult = parityCase.value
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty
            XCTAssertEqual(
                foundationResult,
                parityCase.isBlank,
                parityCase.name
            )

            for (upload, field) in uploads {
                var object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: JSONEncoder().encode(upload))
                        as? [String: Any]
                )
                var authoredText = try XCTUnwrap(
                    object["authoredText"] as? [[String: Any]]
                )
                let fieldIndex = try XCTUnwrap(
                    authoredText.firstIndex { $0["field"] as? String == field.rawValue }
                )
                authoredText[fieldIndex]["value"] = parityCase.value
                object["authoredText"] = authoredText
                let encoded = try JSONSerialization.data(withJSONObject: object)
                let textStates = upload.authoredText.map { authored in
                    WireTextStateV1.present(
                        field: authored.field,
                        value: authored.field == field ? parityCase.value : authored.value
                    )
                }

                if parityCase.isBlank {
                    XCTAssertThrowsError(
                        try JSONDecoder().decode(WireEventV1.self, from: encoded),
                        "\(field.rawValue): \(parityCase.name)"
                    ) { error in
                        XCTAssertEqual(
                            error as? WireEventV1Error,
                            .blankAuthoredText(field),
                            parityCase.name
                        )
                    }
                    XCTAssertThrowsError(
                        try HydratedWireEventV1(
                            event: upload.arithmeticOnly,
                            serverSequence: 1,
                            textStates: textStates
                        ),
                        "\(field.rawValue): \(parityCase.name)"
                    ) { error in
                        XCTAssertEqual(
                            error as? WireEventV1Error,
                            .blankAuthoredText(field),
                            parityCase.name
                        )
                    }
                } else {
                    XCTAssertNoThrow(
                        try JSONDecoder().decode(WireEventV1.self, from: encoded),
                        "\(field.rawValue): \(parityCase.name)"
                    )
                    XCTAssertNoThrow(
                        try HydratedWireEventV1(
                            event: upload.arithmeticOnly,
                            serverSequence: 1,
                            textStates: textStates
                        ),
                        "\(field.rawValue): \(parityCase.name)"
                    )
                }
            }
        }
    }

    func testTimeZoneIdentifierParityMatchesFoundationAndWireDecoder() throws {
        let fixtureURL = try XCTUnwrap(
            Bundle.module.url(
                forResource: "time-zone-identifier-parity",
                withExtension: "json"
            )
        )
        let parityCases = try JSONDecoder().decode(
            [TimeZoneIdentifierParityCase].self,
            from: Data(contentsOf: fixtureURL)
        )
        let upload = try WireEventV1(wireContractEvents()[0])
        let baseline = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(upload))
                as? [String: Any]
        )

        for parityCase in parityCases {
            let foundationResult = parityCase.value == "UTC"
                || TimeZone.knownTimeZoneIdentifiers.contains(parityCase.value)
            XCTAssertEqual(foundationResult, parityCase.isValid, parityCase.name)

            var object = baseline
            object["originatingTimeZone"] = parityCase.value
            let encoded = try JSONSerialization.data(withJSONObject: object)
            if parityCase.isValid {
                XCTAssertNoThrow(
                    try JSONDecoder().decode(WireEventV1.self, from: encoded),
                    parityCase.name
                )
            } else {
                XCTAssertThrowsError(
                    try JSONDecoder().decode(WireEventV1.self, from: encoded),
                    parityCase.name
                )
            }
        }
    }

    func testExpenseUploadSeparatesArithmeticFromAuthoredText() throws {
        let fixture = try CoreFixture()
        let source = fixture.event(
            41,
            id: 701,
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: fixture.groceryRecordID,
                content: ExpenseContent(
                    kind: .shared,
                    title: "Groceries",
                    amount: Money(minorUnits: 8_640, currency: .eur),
                    payerUnitID: fixture.am,
                    allocations: [
                        ExpenseAllocation(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 4_320, currency: .eur)
                        ),
                        ExpenseAllocation(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: 4_320, currency: .eur)
                        ),
                    ],
                    category: "Food"
                )
            )))

        let wire = try WireEventV1(source)

        XCTAssertEqual(wire.textFields, [.title, .category])
        XCTAssertEqual(wire.authoredText, [
            WireAuthoredTextV1(field: .title, value: "Groceries"),
            WireAuthoredTextV1(field: .category, value: "Food"),
        ])
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(wire)) as? [String: Any]
        )
        XCTAssertNil(object["serverSequence"])
        let payload = try XCTUnwrap(object["payload"] as? [String: Any])
        let content = try XCTUnwrap(payload["content"] as? [String: Any])
        XCTAssertNil(content["title"])
        XCTAssertNil(content["category"])
        XCTAssertEqual(payload["kind"] as? String, "expenseAdded")
    }

    func testSettlementReversalLinkSurvivesWireSeparationAndHydration() throws {
        let fixture = try CoreFixture()
        let targetRecordID = RecordID(unchecked: testUUID(760))
        let source = fixture.event(42, id: 761, payload: .settlementRecorded(
            fixture.settlement(
                recordID: RecordID(unchecked: testUUID(762)),
                title: "Partial reversal",
                amount: 500,
                from: fixture.am,
                to: fixture.sam,
                reversalOf: targetRecordID
            )
        ))

        let wire = try WireEventV1(source)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(wire))
                as? [String: Any]
        )
        let payload = try XCTUnwrap(object["payload"] as? [String: Any])
        let content = try XCTUnwrap(payload["content"] as? [String: Any])
        XCTAssertEqual(
            content["reversalOfRecordId"] as? String,
            targetRecordID.description
        )

        let hydrated = try HydratedWireEventV1(
            event: wire.arithmeticOnly,
            serverSequence: 42,
            textStates: [.present(field: .title, value: "Partial reversal")]
        ).eventEnvelope()
        guard case let .settlementRecorded(projected) = hydrated.payload else {
            return XCTFail("Expected a hydrated settlement")
        }
        XCTAssertEqual(projected.content.reversalOfRecordID, targetRecordID)
    }

    func testEveryActiveKindMatchesGoldenJSONAndHydratesWithoutLoss() throws {
        let source = try wireContractEvents()
        let uploads = try source.map { try WireEventV1($0) }
        let fixtureURL = try XCTUnwrap(
            Bundle.module.url(forResource: "wire-events-v1", withExtension: "json")
        )
        let fixtureData = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode([WireEventV1].self, from: fixtureData)

        XCTAssertEqual(uploads, fixture)
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(uploads)) as? NSArray,
            try JSONSerialization.jsonObject(with: fixtureData) as? NSArray
        )
        XCTAssertEqual(Set(source.map(\.kind)), Set(EventKind.supportedCases))

        for (offset, pair) in zip(source, uploads).enumerated() {
            let sequence = Int64(offset + 1)
            let textStates = pair.1.authoredText.map {
                WireTextStateV1.present(field: $0.field, value: $0.value)
            }
            let hydrated = try HydratedWireEventV1(
                event: pair.1.arithmeticOnly,
                serverSequence: sequence,
                textStates: textStates
            ).eventEnvelope()
            let expected = EventEnvelope(
                id: pair.0.id,
                potID: pair.0.potID,
                actorMemberID: pair.0.actorMemberID,
                occurredAt: pair.0.occurredAt,
                originatingTimeZone: pair.0.originatingTimeZone,
                schemaVersion: pair.0.schemaVersion,
                serverSequence: sequence,
                payload: pair.0.payload
            )
            XCTAssertEqual(hydrated, expected, "Mismatch at fixture index \(offset)")
        }
    }

    func testHydrationRejectsAuthoredPlaceholderAndKeepsRedactionExplicit() throws {
        let upload = try WireEventV1(wireContractEvents()[0])
        XCTAssertThrowsError(try HydratedWireEventV1(
            event: upload.arithmeticOnly,
            serverSequence: 1,
            textStates: [
                .present(field: .title, value: WireEventV1.redactedTextPlaceholder),
                .present(field: .category, value: "Food"),
            ]
        )) { error in
            XCTAssertEqual(
                error as? WireEventV1Error,
                .reservedRedactedText(.title)
            )
        }
        let redacted = try HydratedWireEventV1(
            event: upload.arithmeticOnly,
            serverSequence: 1,
            textStates: [
                .redacted(field: .title),
                .present(field: .category, value: "Food"),
            ]
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(redacted))
                as? [String: Any]
        )
        let states = try XCTUnwrap(object["textStates"] as? [[String: Any]])
        XCTAssertEqual(states[0]["state"] as? String, "redacted")
        XCTAssertNil(states[0]["value"])

        guard case let .expenseAdded(payload) = try redacted.eventEnvelope().payload else {
            return XCTFail("Expected an expense")
        }
        XCTAssertEqual(payload.content.title, WireEventV1.redactedTextPlaceholder)
        XCTAssertEqual(payload.content.category, "Food")
        XCTAssertThrowsError(try HydratedWireEventV1(
            event: upload,
            serverSequence: 1,
            textStates: redacted.textStates
        )) { error in
            XCTAssertEqual(
                error as? WireEventV1Error,
                .hydrationRequiresArithmeticOnlyEvent
            )
        }
    }

    func testUploadUsesPersistenceMillisecondTruncation() throws {
        let source = try wireContractEvents()[0]
        let timestamp = Date(timeIntervalSince1970: 1_783_815_101.9996)
        let event = EventEnvelope(
            id: source.id,
            potID: source.potID,
            actorMemberID: source.actorMemberID,
            occurredAt: timestamp,
            originatingTimeZone: source.originatingTimeZone,
            schemaVersion: source.schemaVersion,
            serverSequence: nil,
            payload: source.payload
        )

        XCTAssertEqual(try WireEventV1(event).occurredAtMillis, 1_783_815_101_999)
    }

    func testDecoderRejectsNonCanonicalManifestOrder() throws {
        let upload = try WireEventV1(wireContractEvents()[0])
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(upload)) as? [String: Any]
        )
        object["textFields"] = ["category", "title"]
        let changed = try JSONSerialization.data(withJSONObject: object)

        XCTAssertThrowsError(try JSONDecoder().decode(WireEventV1.self, from: changed)) {
            error in
            XCTAssertEqual(error as? WireEventV1Error, .nonCanonicalTextFields)
        }
    }

    func testUnsupportedAndCutKindsCannotBecomeV1Uploads() throws {
        let fixture = try CoreFixture()
        let source = fixture.event(
            nil,
            id: 718,
            payload: .unsupported(kind: "refundAdded", payload: .object([:]))
        )

        XCTAssertThrowsError(try WireEventV1(source)) { error in
            XCTAssertEqual(
                error as? WireEventV1Error,
                .unsupportedEventKind("refundAdded")
            )
        }
    }

    func testUnknownDownloadRetainsCanonicalTextManifestAndMakesCoreReadOnly() throws {
        let fixture = try CoreFixture()
        let upload = try WireEventV1(wireContractEvents()[0]).arithmeticOnly
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(upload)) as? [String: Any]
        )
        object["textFields"] = ["title", "note"]
        object["authoredText"] = []
        object["payload"] = [
            "kind": "expenseImported",
            "source": "future-client",
            "rows": [1, 2, 3],
        ]
        let sourceData = try JSONSerialization.data(withJSONObject: object)
        let downloaded = try JSONDecoder().decode(
            WireEventV1.self,
            from: sourceData
        )
        let roundTripped = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(downloaded))
                as? [String: Any]
        )
        XCTAssertEqual(
            roundTripped["payload"] as? NSDictionary,
            object["payload"] as? NSDictionary
        )
        let hydrated = try HydratedWireEventV1(
            event: downloaded,
            serverSequence: 1,
            textStates: [
                .present(field: .title, value: "Imported expense"),
                .redacted(field: .note),
            ]
        ).eventEnvelope()

        guard case let .unsupported(kind, payload) = hydrated.payload else {
            return XCTFail("Expected unsupported download payload")
        }
        XCTAssertEqual(kind, "expenseImported")
        XCTAssertEqual(payload, .object([
            "rows": .array([.number(1), .number(2), .number(3)]),
            "source": .string("future-client"),
        ]))
        let reduction = LedgerReducer().reduce(pot: fixture.pot, events: [hydrated])
        XCTAssertEqual(
            reduction.access,
            .readOnly(.unsupportedEventKind(
                eventID: hydrated.id,
                kind: "expenseImported"
            ))
        )
        XCTAssertTrue(reduction.projection.appliedEventIDs.isEmpty)
        XCTAssertThrowsError(try WireEventV1(hydrated)) { error in
            XCTAssertEqual(
                error as? WireEventV1Error,
                .unsupportedEventKind("expenseImported")
            )
        }
    }

    func testFutureSchemaPreservesIncompatibleKnownKindAndAdditivePayloadFields() throws {
        let upload = try WireEventV1(wireContractEvents()[0]).arithmeticOnly
        var eventObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(upload)) as? [String: Any]
        )
        eventObject["schemaVersion"] = 3
        eventObject["payload"] = [
            "kind": "expenseAdded",
            "recordId": upload.eventId.description,
            "content": "future-incompatible-shape",
            "futureField": ["nested": true],
        ]
        eventObject["textFields"] = ["futureCaption"]
        eventObject["authoredText"] = [[
            "field": "futureCaption",
            "value": "opaque future text",
        ]]
        let hydratedObject: [String: Any] = [
            "event": eventObject,
            "serverSequence": 7,
            "textStates": [[
                "field": "futureCaption",
                "state": "present",
                "value": "opaque future text",
            ]],
        ]
        let decoded = try JSONDecoder().decode(
            HydratedWireEventV1.self,
            from: JSONSerialization.data(withJSONObject: hydratedObject)
        )

        let envelope = try decoded.eventEnvelope()
        XCTAssertEqual(envelope.schemaVersion, 3)
        XCTAssertEqual(envelope.serverSequence, 7)
        guard case let .unsupported(kind, payload) = envelope.payload else {
            return XCTFail("Expected a future compatibility barrier")
        }
        XCTAssertEqual(kind, "expenseAdded")
        XCTAssertEqual(payload, .object([
            "recordId": .string(upload.eventId.description),
            "content": .string("future-incompatible-shape"),
            "futureField": .object(["nested": .bool(true)]),
        ]))

        let roundTrip = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(decoded.event)
        ) as? [String: Any]
        XCTAssertEqual(
            try XCTUnwrap(roundTrip?["payload"] as? NSDictionary),
            try XCTUnwrap(eventObject["payload"] as? NSDictionary)
        )
    }

    private func wireContractEvents() throws -> [EventEnvelope] {
        let fixture = try CoreFixture()
        let member = MemberID(unchecked: testUUID(70))
        let group = GroupID(unchecked: testUUID(71))
        let groupUnit = UnitID(unchecked: testUUID(72))
        let openingRecord = RecordID(unchecked: testUUID(73))
        let resolution = try RevisionPair(
            EventID(unchecked: testUUID(650)),
            EventID(unchecked: testUUID(651))
        )

        return [
            fixture.event(101, id: 701, payload: .expenseAdded(ExpenseAddedPayload(
                recordID: fixture.groceryRecordID,
                content: ExpenseContent(
                    kind: .shared,
                    title: "Groceries",
                    amount: Money(minorUnits: 8_640, currency: .eur),
                    payerUnitID: fixture.am,
                    allocations: [
                        ExpenseAllocation(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: 4_320, currency: .eur)
                        ),
                        ExpenseAllocation(
                            unitID: fixture.leo,
                            amount: Money(minorUnits: 4_320, currency: .eur)
                        ),
                    ],
                    category: "Food"
                )
            ))),
            fixture.event(102, id: 702, payload: .expenseRevised(ExpenseRevisedPayload(
                recordID: fixture.groceryRecordID,
                basis: .resolution(resolution),
                content: .expense(ExpenseContent(
                    kind: .personal,
                    title: "Pharmacy",
                    amount: Money(minorUnits: 2_500, currency: .eur),
                    payerUnitID: fixture.am,
                    allocations: [ExpenseAllocation(
                        unitID: fixture.leo,
                        amount: Money(minorUnits: 2_500, currency: .eur)
                    )]
                ))
            ))),
            fixture.event(103, id: 703, payload: .expenseRevised(ExpenseRevisedPayload(
                recordID: openingRecord,
                basis: .parent(EventID(unchecked: testUUID(652))),
                content: .openingBalance(OpeningBalanceContent(
                    title: "Imported opening balance",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: 12_000, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: -12_000, currency: .eur)
                        ),
                    ],
                    note: "Corrected from statement"
                ))
            ))),
            fixture.event(104, id: 704, payload: .recordVoided(RecordVoidedPayload(
                recordID: fixture.groceryRecordID,
                reason: "Duplicate"
            ))),
            fixture.event(105, id: 705, payload: .recordRestored(RecordRestoredPayload(
                recordID: fixture.groceryRecordID
            ))),
            fixture.event(106, id: 706, payload: .settlementRecorded(SettlementRecordedPayload(
                recordID: fixture.samSettlementID,
                content: SettlementContent(
                    title: "Sam paid the household",
                    amount: Money(minorUnits: 7_500, currency: .eur),
                    fromUnitID: fixture.sam,
                    toUnitID: fixture.am
                )
            ))),
            fixture.event(107, id: 707, payload: .settlementFlagged(SettlementFlaggedPayload(
                recordID: fixture.samSettlementID,
                reason: "Wrong bank transfer"
            ))),
            fixture.event(108, id: 708, payload: .openingBalanceSet(OpeningBalanceSetPayload(
                recordID: openingRecord,
                content: OpeningBalanceContent(
                    title: "Opening balance",
                    entries: [
                        OpeningBalanceEntry(
                            unitID: fixture.am,
                            amount: Money(minorUnits: 10_000, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: fixture.sam,
                            amount: Money(minorUnits: -10_000, currency: .eur)
                        ),
                    ],
                    note: "Imported from Splitwise"
                )
            ))),
            fixture.event(109, id: 709, payload: .memberAdded(MemberAddedPayload(
                memberID: member,
                unitID: fixture.sam,
                role: .member
            ))),
            fixture.event(110, id: 710, payload: .memberClaimed(MemberClaimedPayload(
                memberID: member
            ))),
            fixture.event(111, id: 711, payload: .memberClaimReassigned(
                MemberClaimReassignedPayload(memberID: member)
            )),
            fixture.event(112, id: 712, payload: .memberArchived(MemberArchivedPayload(
                memberID: member,
                reason: "Moved out"
            ))),
            fixture.event(113, id: 713, payload: .ownershipTransferred(
                OwnershipTransferredPayload(
                    fromMemberID: fixture.actorID,
                    toMemberID: member
                )
            )),
            fixture.event(114, id: 714, payload: .groupChanged(GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: group,
                    unitID: groupUnit,
                    orderedMemberIDs: [fixture.actorID, member],
                    defaultShareWeight: 2
                ),
            ]))),
            fixture.event(115, id: 715, payload: .presetChanged(PresetChangedPayload(
                name: "Everyone",
                orderedUnitIDs: [fixture.am, fixture.sam, fixture.leo]
            ))),
            fixture.event(116, id: 716, payload: .potRenamed(PotRenamedPayload(
                name: "Casa Mar"
            ))),
            fixture.event(117, id: 717, payload: .potArchived(PotArchivedPayload(
                reason: "Household closed"
            ))),
        ]
    }
}

private struct AuthoredTextBlankParityCase: Decodable {
    let name: String
    let value: String
    let isBlank: Bool
}

private struct TimeZoneIdentifierParityCase: Decodable {
    let name: String
    let value: String
    let isValid: Bool
}
