import Foundation
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class InviteClaimTransportTests: XCTestCase {
    func testPerMemberClaimUsesTicketAndOnlyClientAuthoredEventMetadata() throws {
        let request = InviteClaimRequest.perMember(
            ticket: "v1.01890f5e-7b00-7000-9000-000000000001.signature",
            event: InviteClaimEventMetadata(
                eventID: try EventID(validating: XCTUnwrap(UUID(
                    uuidString: "018bcfe5-6800-7000-8000-000000000000"
                ))),
                occurredAtMillis: 1_700_000_000_000,
                originatingTimeZone: try IANATimeZone("Europe/Madrid"),
                schemaVersion: EventEnvelope.currentSchemaVersion
            )
        )

        let mutation = try ConvexSyncTransport.preparedInviteClaim(request)

        XCTAssertEqual(mutation.name, "members:claimPerMemberInviteWithTicket")
        XCTAssertEqual(
            try mutation.arguments["ticket"]?.convexEncode(),
            #""v1.01890f5e-7b00-7000-9000-000000000001.signature""#
        )
        XCTAssertNil(mutation.arguments["token"])
        XCTAssertNil(mutation.arguments["potId"])
        XCTAssertNil(mutation.arguments["memberId"])
        let encodedEvent = try XCTUnwrap(mutation.arguments["event"]?.convexEncode())
        let eventObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(encodedEvent.utf8))
                as? [String: Any]
        )
        XCTAssertEqual(
            Set(eventObject.keys),
            ["eventId", "occurredAtMillis", "originatingTimeZone", "schemaVersion"]
        )
        XCTAssertEqual(
            eventObject["eventId"] as? String,
            "018bcfe5-6800-7000-8000-000000000000"
        )
        XCTAssertEqual(eventObject["originatingTimeZone"] as? String, "Europe/Madrid")
        XCTAssertNotNil(eventObject["occurredAtMillis"] as? [String: String])
        XCTAssertNotNil(eventObject["schemaVersion"] as? [String: String])
    }

    func testPotLinkClaimCreatesOnlyPendingRequestWithOptionalChosenIdentity() throws {
        let memberID = MemberID.generate(at: Date(timeIntervalSince1970: 1_700_000_100))
        let request = InviteClaimRequest.potLink(
            ticket: "v1.01890f5e-7b00-7000-9000-000000000001.signature",
            chosenMemberID: memberID
        )

        let mutation = try ConvexSyncTransport.preparedInviteClaim(request)

        XCTAssertEqual(mutation.name, "members:claimPotLinkInviteWithTicket")
        XCTAssertEqual(
            try mutation.arguments["chosenMemberId"]?.convexEncode(),
            try memberID.description.convexEncode()
        )
        XCTAssertNil(mutation.arguments["event"])
    }

    func testMalformedTicketsFailBeforeReachingTheSDK() throws {
        let malformed = InviteClaimRequest.potLink(
            ticket: "contains whitespace",
            chosenMemberID: nil
        )

        XCTAssertThrowsError(try ConvexSyncTransport.preparedInviteClaim(malformed)) {
            XCTAssertEqual(
                $0 as? SyncTransportError,
                .terminal(code: "INVALID_INVITE_CLAIM_REQUEST")
            )
        }
    }

    @MainActor
    func testSerializedAuthenticatedClientForwardsInviteClaimThroughItsMutationLease() async throws {
        let driver = InviteClaimDriver()
        let client = SerializedAuthenticatedConvexClient(driver: driver)
        let request = InviteClaimRequest.potLink(
            ticket: "v1.01890f5e-7b00-7000-9000-000000000001.signature",
            chosenMemberID: nil
        )

        let outcome = try await client.claimInvite(request)

        XCTAssertEqual(outcome, .pendingApproval)
        XCTAssertEqual(driver.requests, [request])
    }
}

@MainActor
private final class InviteClaimDriver: AuthenticatedConvexDriving {
    typealias AuthResult = Bool
    var requests: [InviteClaimRequest] = []

    func login() async -> Result<Bool, any Error> { .success(true) }
    func loginFromCache() async -> Result<Bool, any Error> { .success(true) }
    func logout() async {}
    func connectionStates() async -> AsyncStream<SyncConnectionState> {
        AsyncStream { $0.finish() }
    }
    func listPots() async throws -> [RemotePotDescriptor] { [] }
    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        _ = request
        return []
    }
    func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        _ = potID
        _ = events
        return []
    }
    func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage {
        _ = potID
        return SyncEventPage(events: [], hasMore: false, nextAfterSequence: afterSequence)
    }
    func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        _ = potID
        return SyncTextChangePage(
            changes: [],
            hasMore: false,
            nextAfterRevision: afterRevision
        )
    }
    func claimInvite(_ request: InviteClaimRequest) async throws -> InviteClaimOutcome {
        requests.append(request)
        return .pendingApproval
    }
}
