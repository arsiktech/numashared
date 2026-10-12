import ConvexMobile
import Combine
import Foundation
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class ConvexWireCodingTests: XCTestCase {
    @MainActor
    func testConnectionStatePublisherHopsToTheMainExecutorBeforeSink() async {
        let subject = PassthroughSubject<WebSocketState, Never>()
        let stream = ConvexSyncTransport.connectionStateStream(
            from: subject.eraseToAnyPublisher()
        )
        let received = expectation(description: "connection state received")
        let consumer = Task { @MainActor in
            for await state in stream {
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertEqual(state, .connected)
                received.fulfill()
                return
            }
        }
        let sendableSubject = UncheckedSendableBox(subject)

        DispatchQueue.global(qos: .userInitiated).async {
            sendableSubject.value.send(.connected)
        }

        await fulfillment(of: [received], timeout: 1)
        consumer.cancel()
    }

    func testEveryCurrentWireShapeHasAnExactConvexArgumentMapping() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let fixtureURL = repositoryRoot
            .appendingPathComponent("NumaSharedCore")
            .appendingPathComponent("Tests/NumaSharedCoreTests/Fixtures/wire-events-v1.json")
        let fixtureData = try Data(contentsOf: fixtureURL)
        let events = try JSONDecoder().decode([WireEventV1].self, from: fixtureData)

        let encoded = try events.map { event in
            let value = try ConvexWireArguments.event(event).convexEncode()
            return try JSONSerialization.jsonObject(with: Data(value.utf8))
        }
        let normalized = try encoded.map(normalizeConvexIntegers)

        XCTAssertEqual(events.count, 17)
        XCTAssertEqual(
            normalized as NSArray,
            try JSONSerialization.jsonObject(with: fixtureData) as? NSArray
        )
    }

    func testUploadEncodesEveryIntegerAsAConvexInt64() throws {
        let fixture = try SyncFixture()
        let event = try fixture.event(id: 841)
        let wire = try WireEventV1(event)

        let encoded = try ConvexWireArguments.event(wire).convexEncode()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]
        )
        XCTAssertEqual(try decodeConvexInt(object["occurredAtMillis"]), wire.occurredAtMillis)
        XCTAssertEqual(try decodeConvexInt(object["schemaVersion"]), 1)
        let payload = try XCTUnwrap(object["payload"] as? [String: Any])
        let content = try XCTUnwrap(payload["content"] as? [String: Any])
        let amount = try XCTUnwrap(content["amount"] as? [String: Any])
        XCTAssertEqual(try decodeConvexInt(amount["minorUnits"]), 10_000)
        let currency = try XCTUnwrap(amount["currency"] as? [String: Any])
        XCTAssertEqual(try decodeConvexInt(currency["exponent"]), 2)
        XCTAssertNil(object["serverSequence"])
    }

    func testPromotionCarriesAValidatedPerPotOwnerDisplayName() throws {
        let fixture = try SyncFixture()
        let request = LocalPotPromotionRequest(
            configuration: fixture.configuration,
            ownerMemberID: fixture.actorID,
            ownerDisplayName: "Arseny",
            minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion,
            events: [try WireEventV1(fixture.event(id: 845))]
        )

        let arguments = try ConvexSyncTransport.promotionArguments(request)

        XCTAssertEqual(
            try arguments["ownerDisplayName"]?.convexEncode(),
            try "Arseny".convexEncode()
        )
        XCTAssertNotNil(arguments["configuration"])
        XCTAssertNotNil(arguments["events"])

        for invalid in ["\u{200B}", String(repeating: "x", count: 129), "[redacted]"] {
            let rejected = LocalPotPromotionRequest(
                configuration: fixture.configuration,
                ownerMemberID: fixture.actorID,
                ownerDisplayName: invalid,
                minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion,
                events: []
            )
            XCTAssertThrowsError(
                try ConvexSyncTransport.promotionArguments(rejected)
            ) {
                XCTAssertEqual(
                    $0 as? SyncTransportError,
                    .terminal(code: "INVALID_OWNER_DISPLAY_NAME")
                )
            }
        }
    }

    func testDownloadedIntegersBeyondJSONSafeRangeRemainExact() throws {
        let fixture = try SyncFixture()
        let source = try fixture.event(id: 851)
        let wire = try WireEventV1(source)
        let unsafeSequence: Int64 = 9_007_199_254_740_993
        let unsafeMinorUnits: Int64 = 9_007_199_254_740_995
        let response = try ConvexTestValues.hydratedEventJSON(
            wire: wire,
            sequence: unsafeSequence,
            replacementMinorUnits: unsafeMinorUnits
        )

        let decoded = try JSONDecoder().decode(ConvexDecodedValue.self, from: response)
        let hydrated = try ConvexWireArguments.decode(
            HydratedWireEventV1.self,
            from: decoded
        )
        let event = try hydrated.eventEnvelope()

        XCTAssertEqual(hydrated.serverSequence, unsafeSequence)
        guard case let .expenseAdded(expense) = event.payload else {
            return XCTFail("Expected an expense")
        }
        XCTAssertEqual(expense.content.amount.minorUnits, unsafeMinorUnits)
    }

    func testStructuredConvexFailuresPreserveOnlyCodeAndRetryability() {
        XCTAssertEqual(
            ConvexSyncTransport.convexApplicationError(
                #"{"code":"RATE_LIMITED","retryable":true,"message":"sensitive"}"#
            ),
            .retryable(code: "RATE_LIMITED")
        )
        XCTAssertEqual(
            ConvexSyncTransport.convexApplicationError(
                #"{"data":{"code":"NOT_MEMBER","retryable":false,"detail":"sensitive"}}"#
            ),
            .terminal(code: "NOT_MEMBER")
        )
        XCTAssertEqual(
            ConvexSyncTransport.convexApplicationError("not-json"),
            .terminal(code: "INVALID_SERVER_RESPONSE")
        )
        XCTAssertEqual(
            ConvexSyncTransport.convexApplicationError(
                #"{"code":"private@example.com","retryable":false}"#
            ),
            .terminal(code: "INVALID_SERVER_RESPONSE")
        )
    }

    func testFirstValueTimeoutIsRetryableAndCancelsSubscription() async {
        let cancelled = expectation(description: "subscription cancelled")
        let publisher = Empty<ConvexDecodedValue, ClientError>(completeImmediately: false)
            .handleEvents(receiveCancel: { cancelled.fulfill() })
            .eraseToAnyPublisher()

        do {
            _ = try await ConvexSyncTransport.firstValue(
                from: publisher,
                timeout: .milliseconds(20)
            )
            XCTFail("Expected timeout")
        } catch {
            XCTAssertEqual(
                error as? SyncTransportError,
                .retryable(code: "TRANSPORT_TIMEOUT")
            )
        }
        await fulfillment(of: [cancelled], timeout: 1)
    }

    func testFirstValueCancellationRemainsControlFlowAndCancelsSubscription() async {
        let subscribed = expectation(description: "subscription started")
        let cancelled = expectation(description: "subscription cancelled")
        let publisher = Empty<ConvexDecodedValue, ClientError>(completeImmediately: false)
            .handleEvents(
                receiveSubscription: { _ in subscribed.fulfill() },
                receiveCancel: { cancelled.fulfill() }
            )
            .eraseToAnyPublisher()
        let task = Task { @MainActor [publisher] in
            try await ConvexSyncTransport.firstValue(
                from: publisher,
                timeout: .seconds(60)
            )
        }

        await fulfillment(of: [subscribed], timeout: 1)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        await fulfillment(of: [cancelled], timeout: 1)
    }

    private func decodeConvexInt(_ value: Any?) throws -> Int64 {
        let object = try XCTUnwrap(value as? [String: String])
        let encoded = try XCTUnwrap(object["$integer"])
        let bytes = try XCTUnwrap(Data(base64Encoded: encoded))
        XCTAssertEqual(bytes.count, 8)
        var bits: UInt64 = 0
        for (offset, byte) in bytes.enumerated() {
            bits |= UInt64(byte) << UInt64(offset * 8)
        }
        return Int64(bitPattern: bits)
    }

    private func normalizeConvexIntegers(_ value: Any) throws -> Any {
        if let object = value as? [String: Any] {
            if object.keys.count == 1, object["$integer"] != nil {
                return try decodeConvexInt(object)
            }
            return try Dictionary(uniqueKeysWithValues: object.map { key, nested in
                (key, try normalizeConvexIntegers(nested))
            })
        }
        if let array = value as? [Any] {
            return try array.map(normalizeConvexIntegers)
        }
        return value
    }
}

private final class UncheckedSendableBox<Value>: @unchecked Sendable {
    let value: Value

    init(_ value: Value) {
        self.value = value
    }
}

private enum ConvexTestValues {
    static func hydratedEventJSON(
        wire: WireEventV1,
        sequence: Int64,
        replacementMinorUnits: Int64
    ) throws -> Data {
        var event = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(wire.arithmeticOnly))
                as? [String: Any]
        )
        event["occurredAtMillis"] = convexInt(wire.occurredAtMillis)
        event["schemaVersion"] = convexInt(Int64(wire.schemaVersion))
        var payload = try XCTUnwrap(event["payload"] as? [String: Any])
        var content = try XCTUnwrap(payload["content"] as? [String: Any])
        var amount = try XCTUnwrap(content["amount"] as? [String: Any])
        amount["minorUnits"] = convexInt(replacementMinorUnits)
        var currency = try XCTUnwrap(amount["currency"] as? [String: Any])
        currency["exponent"] = convexInt(2)
        amount["currency"] = currency
        content["amount"] = amount
        let allocations = try XCTUnwrap(content["allocations"] as? [[String: Any]])
        content["allocations"] = try allocations.map { allocation in
            var changed = allocation
            var allocationAmount = try XCTUnwrap(changed["amount"] as? [String: Any])
            allocationAmount["minorUnits"] = convexInt(5_000)
            var allocationCurrency = try XCTUnwrap(
                allocationAmount["currency"] as? [String: Any]
            )
            allocationCurrency["exponent"] = convexInt(2)
            allocationAmount["currency"] = allocationCurrency
            changed["amount"] = allocationAmount
            return changed
        }
        payload["content"] = content
        event["payload"] = payload
        return try JSONSerialization.data(withJSONObject: [
            "event": event,
            "serverSequence": convexInt(sequence),
            "textStates": wire.authoredText.map { text in
                ["field": text.field.rawValue, "state": "present", "value": text.value]
            },
        ])
    }

    private static func convexInt(_ value: Int64) -> [String: String] {
        var bits = UInt64(bitPattern: value)
        var bytes = Data()
        for _ in 0 ..< 8 {
            bytes.append(UInt8(truncatingIfNeeded: bits))
            bits >>= 8
        }
        return ["$integer": bytes.base64EncodedString()]
    }
}
