import ConvexMobile
import Foundation
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class MemberAdministrationTransportTests: XCTestCase {
    func testRosterDecodesTypedProfilesAndRejectsInvalidIdentityState() throws {
        let fixture = try Fixture()
        let pendingMemberID = MemberID.generate(
            at: fixture.date.addingTimeInterval(1)
        )
        let pendingUnitID = UnitID.generate(
            at: fixture.date.addingTimeInterval(1)
        )
        let value = try decodedValue(
            """
            [
              {
                "memberId": "\(fixture.memberID.description)",
                "unitId": "\(fixture.unitID.description)",
                "displayName": "Arseny",
                "role": "owner",
                "state": "active"
              },
              {
                "memberId": "\(pendingMemberID.description)",
                "unitId": "\(pendingUnitID.description)",
                "displayName": null,
                "role": "member",
                "state": "pending"
              }
            ]
            """
        )

        XCTAssertEqual(
            try ConvexSyncTransport.memberRoster(from: value),
            [
                PotMemberProfile(
                    memberID: fixture.memberID,
                    unitID: fixture.unitID,
                    displayName: "Arseny",
                    role: .owner,
                    state: .active
                ),
                PotMemberProfile(
                    memberID: pendingMemberID,
                    unitID: pendingUnitID,
                    displayName: nil,
                    role: .member,
                    state: .pending
                ),
            ]
        )

        let impossible = try decodedValue(
            """
            [{
              "memberId": "\(pendingMemberID.description)",
              "unitId": "\(pendingUnitID.description)",
              "displayName": "Maya",
              "role": "owner",
              "state": "pending"
            }]
            """
        )
        XCTAssertThrowsError(try ConvexSyncTransport.memberRoster(from: impossible)) {
            XCTAssertEqual(
                $0 as? SyncTransportError,
                .terminal(code: "INVALID_SERVER_RESPONSE")
            )
        }
    }

    func testPendingMemberCreationAndAnonymizationUseTypedMinimalArguments() throws {
        let fixture = try Fixture()
        let added = PendingMemberAddition(
            displayName: "Maya",
            event: fixture.memberAddedEvent
        )

        let create = try ConvexSyncTransport.preparedPendingMemberAddition(added)
        XCTAssertEqual(create.name, "members:addPendingMember")
        XCTAssertEqual(
            try create.arguments["displayName"]?.convexEncode(),
            try "Maya".convexEncode()
        )
        XCTAssertEqual(
            try create.arguments["potId"]?.convexEncode(),
            try fixture.potID.description.convexEncode()
        )
        XCTAssertNotNil(create.arguments["event"])

        let anonymize = ConvexSyncTransport.preparedPendingMemberAnonymization(
            potID: fixture.potID,
            memberID: fixture.memberID
        )
        XCTAssertEqual(anonymize.name, "members:anonymizePendingMember")
        XCTAssertEqual(Set(anonymize.arguments.keys), ["potId", "memberId"])

        for invalid in ["\u{200B}", String(repeating: "x", count: 129), "[redacted]"] {
            XCTAssertThrowsError(
                try ConvexSyncTransport.preparedPendingMemberAddition(
                    PendingMemberAddition(
                        displayName: invalid,
                        event: fixture.memberAddedEvent
                    )
                )
            ) {
                XCTAssertEqual(
                    $0 as? SyncTransportError,
                    .terminal(code: "INVALID_MEMBER_ADMIN_REQUEST")
                )
            }
        }
    }

    func testExistingUnitBindingsUseRoleSpecificTypedMutations() throws {
        let fixture = try Fixture()
        let ownerEvent = try WireEventV1(EventEnvelope(
            id: EventID.generate(at: fixture.date.addingTimeInterval(2)),
            potID: fixture.potID,
            actorMemberID: fixture.memberID,
            occurredAt: fixture.date,
            originatingTimeZone: fixture.timeZone,
            payload: .memberAdded(MemberAddedPayload(
                memberID: fixture.memberID,
                unitID: fixture.unitID,
                role: .owner
            ))
        ))

        let owner = try ConvexSyncTransport.preparedOwnerUnitBinding(ownerEvent)
        XCTAssertEqual(owner.name, "members:bindOwnerUnit")
        XCTAssertEqual(Set(owner.arguments.keys), ["potId", "event"])

        let pending = try ConvexSyncTransport.preparedPendingMemberBinding(
            PendingMemberAddition(
                displayName: "Sam",
                event: fixture.memberAddedEvent
            )
        )
        XCTAssertEqual(pending.name, "members:bindPendingMember")
        XCTAssertEqual(
            try pending.arguments["displayName"]?.convexEncode(),
            try "Sam".convexEncode()
        )

        let renameEvent = try WireEventV1(EventEnvelope(
            id: EventID.generate(at: fixture.date.addingTimeInterval(3)),
            potID: fixture.potID,
            actorMemberID: fixture.memberID,
            occurredAt: fixture.date,
            originatingTimeZone: fixture.timeZone,
            payload: .potRenamed(PotRenamedPayload(name: "Casa Mar"))
        ))
        let rename = try ConvexSyncTransport.preparedPotRename(renameEvent)
        XCTAssertEqual(rename.name, "members:renamePot")
        XCTAssertEqual(Set(rename.arguments.keys), ["potId", "event"])

        XCTAssertThrowsError(
            try ConvexSyncTransport.preparedOwnerUnitBinding(
                fixture.memberAddedEvent
            )
        ) {
            XCTAssertEqual(
                $0 as? SyncTransportError,
                .terminal(code: "INVALID_MEMBER_ADMIN_REQUEST")
            )
        }
    }

    func testPendingClaimsDecodeFailClosedAndSortOldestFirst() throws {
        let firstClaimID = try XCTUnwrap(PendingInviteClaimID(
            "jx7f3a9b2c4d6e8g0h1k3m5n7p9r2t4v"
        ))
        let secondClaimID = try XCTUnwrap(PendingInviteClaimID(
            "kx8g4b0c3d5e7f9h1j2m4n6p8r0t3v5w"
        ))
        let chosenMemberID = MemberID.generate(
            at: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let value = try decodedValue(
            """
            [
              {
                "claimId": "\(secondClaimID.rawValue)",
                "inviteId": "018bcfe5-6800-7000-8000-000000000002",
                "chosenMemberId": null,
                "createdAt": 1700000000200
              },
              {
                "claimId": "\(firstClaimID.rawValue)",
                "inviteId": "018bcfe5-6800-7000-8000-000000000001",
                "chosenMemberId": "\(chosenMemberID.description)",
                "createdAt": 1700000000100
              }
            ]
            """
        )
        let claims = try ConvexSyncTransport.pendingInviteClaims(from: value)

        XCTAssertEqual(claims.map(\.id), [firstClaimID, secondClaimID])
        XCTAssertEqual(claims.first?.chosenMemberID, chosenMemberID)
        XCTAssertEqual(claims.first?.createdAtMillis, 1_700_000_000_100)
        XCTAssertNil(claims.last?.chosenMemberID)
    }

    func testPendingClaimsRejectMalformedOpaqueAndTypedIdentifiers() throws {
        let malformedClaim = try decodedValue(
            """
            [{
              "claimId": "contains whitespace",
              "inviteId": "018bcfe5-6800-7000-8000-000000000001",
              "chosenMemberId": null,
              "createdAt": 1700000000100
            }]
            """
        )
        let malformedInvite = try decodedValue(
            """
            [{
              "claimId": "jx7f3a9b2c4d6e8g0h1k3m5n7p9r2t4v",
              "inviteId": "not-a-v7-id",
              "chosenMemberId": null,
              "createdAt": 1700000000100
            }]
            """
        )

        for value in [malformedClaim, malformedInvite] {
            XCTAssertThrowsError(
                try ConvexSyncTransport.pendingInviteClaims(from: value)
            ) {
                XCTAssertEqual(
                    $0 as? SyncTransportError,
                    .terminal(code: "INVALID_SERVER_RESPONSE")
                )
            }
        }
    }

    func testBudgetGroupApprovalEncodesSchemaTwoWithoutTranslatingLegacyOrUnknown() throws {
        let fixture = try Fixture()
        for version: UInt16 in [1, 2, 3] {
            let event = try WireEventV1(EventEnvelope(potID: fixture.potID, actorMemberID: fixture.memberID,
                occurredAt: fixture.date, originatingTimeZone: fixture.timeZone, schemaVersion: version,
                payload: .memberClaimed(MemberClaimedPayload(memberID: fixture.memberID))))
            let request = PendingInviteClaimApproval(claimID: fixture.claimID, event: event)
            if version <= 2 {
                let prepared = try ConvexSyncTransport.preparedPendingInviteApproval(request)
                XCTAssertEqual(prepared.name, "members:approvePotLinkClaim")
                XCTAssertEqual(try prepared.arguments["event"]?.convexEncode(), try ConvexWireArguments.event(event).convexEncode())
            } else { XCTAssertThrowsError(try ConvexSyncTransport.preparedPendingInviteApproval(request)) }
        }
    }

    func testApprovalDerivesMemberFromExactClaimEvent() throws {
        let fixture = try Fixture()
        let request = PendingInviteClaimApproval(
            claimID: fixture.claimID,
            event: fixture.claimEvent
        )

        let mutation = try ConvexSyncTransport.preparedPendingInviteApproval(request)

        XCTAssertEqual(mutation.name, "members:approvePotLinkClaim")
        XCTAssertEqual(
            try mutation.arguments["claimId"]?.convexEncode(),
            try fixture.claimID.rawValue.convexEncode()
        )
        XCTAssertEqual(
            try mutation.arguments["memberId"]?.convexEncode(),
            try fixture.memberID.description.convexEncode()
        )
        XCTAssertNil(mutation.arguments["potId"])
        let encodedEvent = try XCTUnwrap(mutation.arguments["event"]?.convexEncode())
        let eventObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(encodedEvent.utf8))
                as? [String: Any]
        )
        XCTAssertEqual(
            eventObject["actorMemberId"] as? String,
            fixture.memberID.description
        )
        XCTAssertEqual(
            (eventObject["payload"] as? [String: Any])?["kind"] as? String,
            "memberClaimed"
        )
    }

    func testApprovalRejectsMismatchedOrWrongKindEventsBeforeSDK() throws {
        let fixture = try Fixture()
        let wrongMember = MemberID.generate(
            at: Date(timeIntervalSince1970: 1_700_000_010)
        )
        let mismatched = PendingInviteClaimApproval(
            claimID: fixture.claimID,
            event: try WireEventV1(EventEnvelope(
                id: fixture.eventID,
                potID: fixture.potID,
                actorMemberID: fixture.memberID,
                occurredAt: fixture.date,
                originatingTimeZone: fixture.timeZone,
                payload: .memberClaimed(MemberClaimedPayload(memberID: wrongMember))
            ))
        )
        let wrongKind = PendingInviteClaimApproval(
            claimID: fixture.claimID,
            event: try WireEventV1(EventEnvelope(
                id: fixture.eventID,
                potID: fixture.potID,
                actorMemberID: fixture.memberID,
                occurredAt: fixture.date,
                originatingTimeZone: fixture.timeZone,
                payload: .memberArchived(MemberArchivedPayload(
                    memberID: fixture.memberID
                ))
            ))
        )

        for request in [mismatched, wrongKind] {
            XCTAssertThrowsError(
                try ConvexSyncTransport.preparedPendingInviteApproval(request)
            ) {
                XCTAssertEqual(
                    $0 as? SyncTransportError,
                    .terminal(code: "INVALID_MEMBER_ADMIN_REQUEST")
                )
            }
        }
    }

    func testRejectionUsesOnlyOpaqueClaimID() throws {
        let fixture = try Fixture()

        let mutation = ConvexSyncTransport.preparedPendingInviteRejection(
            fixture.claimID
        )

        XCTAssertEqual(mutation.name, "members:rejectPotLinkClaim")
        XCTAssertEqual(Set(mutation.arguments.keys), ["claimId"])
    }

    func testLifecycleEventsUseRoleSpecificTypedMutations() throws {
        let fixture = try Fixture()
        let targetMemberID = MemberID.generate(
            at: fixture.date.addingTimeInterval(4)
        )
        let reassignment = try fixture.event(
            offset: 4,
            payload: .memberClaimReassigned(MemberClaimReassignedPayload(
                memberID: targetMemberID
            ))
        )
        let archive = try fixture.event(
            offset: 5,
            payload: .memberArchived(MemberArchivedPayload(
                memberID: targetMemberID
            ))
        )
        let transfer = try fixture.event(
            offset: 6,
            payload: .ownershipTransferred(OwnershipTransferredPayload(
                fromMemberID: fixture.memberID,
                toMemberID: targetMemberID
            ))
        )

        let preparedReassignment = try ConvexSyncTransport
            .preparedMemberClaimReassignment(reassignment)
        let preparedArchive = try ConvexSyncTransport
            .preparedMemberArchive(archive)
        let preparedTransfer = try ConvexSyncTransport
            .preparedOwnershipTransfer(transfer)

        XCTAssertEqual(preparedReassignment.name, "members:reassignClaim")
        XCTAssertEqual(preparedArchive.name, "members:archiveMember")
        XCTAssertEqual(preparedTransfer.name, "members:transferOwnership")
        for mutation in [preparedReassignment, preparedArchive, preparedTransfer] {
            XCTAssertEqual(Set(mutation.arguments.keys), ["potId", "event"])
        }
        XCTAssertThrowsError(
            try ConvexSyncTransport.preparedMemberArchive(reassignment)
        ) {
            XCTAssertEqual(
                $0 as? SyncTransportError,
                .terminal(code: "INVALID_MEMBER_ADMIN_REQUEST")
            )
        }
    }

    func testVoluntaryLeaveUsesAtomicTypedMutation() throws {
        let fixture = try Fixture()
        let archive = try fixture.event(
            offset: 7,
            payload: .memberArchived(MemberArchivedPayload(
                memberID: fixture.memberID
            ))
        )
        let transferEventID = EventID.generate(
            at: fixture.date.addingTimeInterval(8)
        )
        let prepared = try ConvexSyncTransport.preparedPotLeave(
            PotLeaveRequest(
                archiveEvent: archive,
                transferEventID: transferEventID
            )
        )

        XCTAssertEqual(prepared.name, "members:leavePot")
        XCTAssertEqual(
            Set(prepared.arguments.keys),
            ["potId", "archiveEvent", "transferEventId"]
        )
    }

    @MainActor
    func testSerializedClientForwardsOwnerDecisionsThroughOneBoundary() async throws {
        let fixture = try Fixture()
        let claim = PendingInviteClaim(
            id: fixture.claimID,
            inviteID: fixture.inviteID,
            chosenMemberID: fixture.memberID,
            createdAtMillis: 1_700_000_000_100
        )
        let driver = MemberAdministrationDriver(
            claim: claim,
            profile: PotMemberProfile(
                memberID: fixture.memberID,
                unitID: fixture.unitID,
                displayName: "Arseny",
                role: .owner,
                state: .active
            )
        )
        let client = SerializedAuthenticatedConvexClient(driver: driver)
        let approval = PendingInviteClaimApproval(
            claimID: fixture.claimID,
            event: fixture.claimEvent
        )
        let addition = PendingMemberAddition(
            displayName: "Maya",
            event: fixture.memberAddedEvent
        )
        let ownerEvent = try WireEventV1(EventEnvelope(
            id: EventID.generate(at: fixture.date.addingTimeInterval(2)),
            potID: fixture.potID,
            actorMemberID: fixture.memberID,
            occurredAt: fixture.date,
            originatingTimeZone: fixture.timeZone,
            payload: .memberAdded(MemberAddedPayload(
                memberID: fixture.memberID,
                unitID: fixture.unitID,
                role: .owner
            ))
        ))
        let renameEvent = try WireEventV1(EventEnvelope(
            id: EventID.generate(at: fixture.date.addingTimeInterval(3)),
            potID: fixture.potID,
            actorMemberID: fixture.memberID,
            occurredAt: fixture.date,
            originatingTimeZone: fixture.timeZone,
            payload: .potRenamed(PotRenamedPayload(name: "Casa Mar"))
        ))
        let credentials = try XCTUnwrap(InviteCredentialPair(
            token: "serialized_token_0123456789abcdef0123456789abcdef",
            code: "SER234"
        ))
        let inviteRequest = try XCTUnwrap(InviteIssueRequest(
            potID: fixture.potID,
            inviteID: fixture.inviteID,
            kind: .perMember,
            pendingMemberID: fixture.memberID,
            credentials: credentials,
            expiresAtMillis: 1_702_592_000_000
        ))
        let pushToken = try XCTUnwrap(APNsDeviceToken(
            hex: String(repeating: "ab", count: 32)
        ))
        let pushRegistration = PushTokenRegistration(
            token: pushToken,
            environment: .sandbox,
            timeZone: fixture.timeZone
        )

        let roster = try await client.listMemberRoster(potID: fixture.potID)
        let renamed = try await client.renamePot(renameEvent)
        let ownerBound = try await client.bindOwnerUnit(ownerEvent)
        let pendingBound = try await client.bindPendingMember(addition)
        let added = try await client.addPendingMember(addition)
        try await client.anonymizePendingMember(
            potID: fixture.potID,
            memberID: fixture.memberID
        )
        let listed = try await client.listPendingInviteClaims(potID: fixture.potID)
        let acknowledged = try await client.approvePendingInviteClaim(approval)
        let targetMemberID = MemberID.generate(
            at: fixture.date.addingTimeInterval(4)
        )
        let reassignment = try fixture.event(
            offset: 4,
            payload: .memberClaimReassigned(MemberClaimReassignedPayload(
                memberID: targetMemberID
            ))
        )
        let archive = try fixture.event(
            offset: 5,
            payload: .memberArchived(MemberArchivedPayload(
                memberID: targetMemberID
            ))
        )
        let transfer = try fixture.event(
            offset: 6,
            payload: .ownershipTransferred(OwnershipTransferredPayload(
                fromMemberID: fixture.memberID,
                toMemberID: targetMemberID
            ))
        )
        _ = try await client.reassignMemberClaim(reassignment)
        _ = try await client.archiveMember(archive)
        _ = try await client.transferOwnership(transfer)
        let managedInvites = try await client.listManagedInvites(
            potID: fixture.potID
        )
        let issuedInviteID = try await client.issueInvite(inviteRequest)
        try await client.revokeInvite(
            potID: fixture.potID,
            inviteID: fixture.inviteID
        )
        try await client.registerPushToken(pushRegistration)
        let initiallyMuted = try await client.getPotMute(potID: fixture.potID)
        let confirmedMute = try await client.setPotMute(
            potID: fixture.potID,
            muted: true
        )
        try await client.unregisterPushToken(pushToken)

        XCTAssertEqual(roster, [driver.profile])
        XCTAssertEqual(
            renamed,
            EventAcknowledgement(eventID: renameEvent.eventId, serverSequence: 12)
        )
        XCTAssertEqual(
            ownerBound,
            EventAcknowledgement(eventID: ownerEvent.eventId, serverSequence: 10)
        )
        XCTAssertEqual(
            pendingBound,
            EventAcknowledgement(
                eventID: fixture.memberAddedEvent.eventId,
                serverSequence: 11
            )
        )
        XCTAssertEqual(
            added,
            EventAcknowledgement(
                eventID: fixture.memberAddedEvent.eventId,
                serverSequence: 9
            )
        )
        XCTAssertEqual(listed, [claim])
        XCTAssertEqual(
            acknowledged,
            EventAcknowledgement(eventID: fixture.eventID, serverSequence: 8)
        )
        try await client.rejectPendingInviteClaim(fixture.claimID)

        XCTAssertEqual(driver.additions, [addition])
        XCTAssertEqual(driver.renames, [renameEvent])
        XCTAssertEqual(driver.ownerBindings, [ownerEvent])
        XCTAssertEqual(driver.pendingBindings, [addition])
        XCTAssertEqual(driver.anonymizedMemberIDs, [fixture.memberID])
        XCTAssertEqual(driver.approvals, [approval])
        XCTAssertEqual(driver.rejections, [fixture.claimID])
        XCTAssertEqual(driver.claimReassignments, [reassignment])
        XCTAssertEqual(driver.memberArchives, [archive])
        XCTAssertEqual(driver.ownershipTransfers, [transfer])
        XCTAssertEqual(managedInvites.map(\.inviteID), [fixture.inviteID])
        XCTAssertEqual(issuedInviteID, fixture.inviteID)
        XCTAssertEqual(driver.inviteIssues, [inviteRequest])
        XCTAssertEqual(driver.inviteRevocations, [fixture.inviteID])
        XCTAssertEqual(driver.pushRegistrations, [pushRegistration])
        XCTAssertEqual(driver.pushTokenRemovals, [pushToken])
        XCTAssertFalse(initiallyMuted)
        XCTAssertTrue(confirmedMute)
        XCTAssertEqual(driver.potMuteChanges, [true])
    }

    func testInviteIssuanceAndRevocationUseTypedMinimalArguments() throws {
        let fixture = try Fixture()
        let credentials = try XCTUnwrap(InviteCredentialPair(
            token: "invite_token_0123456789abcdef0123456789abcdef",
            code: "SAM234"
        ))
        let request = try XCTUnwrap(InviteIssueRequest(
            potID: fixture.potID,
            inviteID: fixture.inviteID,
            kind: .perMember,
            pendingMemberID: fixture.memberID,
            credentials: credentials,
            expiresAtMillis: 1_702_592_000_000
        ))

        let issue = try ConvexSyncTransport.preparedInviteIssue(request)
        XCTAssertEqual(issue.name, "members:issueInvite")
        XCTAssertEqual(
            Set(issue.arguments.keys),
            ["potId", "inviteId", "kind", "pendingMemberId", "token", "code", "expiresAt"]
        )
        XCTAssertEqual(
            try issue.arguments["token"]?.convexEncode(),
            try credentials.token.convexEncode()
        )

        let revoke = try ConvexSyncTransport.preparedInviteRevocation(
            potID: fixture.potID,
            inviteID: fixture.inviteID
        )
        XCTAssertEqual(revoke.name, "members:revokeInvite")
        XCTAssertEqual(Set(revoke.arguments.keys), ["potId", "inviteId"])

        let nonV7InviteID = try XCTUnwrap(UUID(
            uuidString: "550e8400-e29b-41d4-a716-446655440000"
        ))
        XCTAssertThrowsError(
            try ConvexSyncTransport.preparedInviteRevocation(
                potID: fixture.potID,
                inviteID: nonV7InviteID
            )
        ) {
            XCTAssertEqual(
                $0 as? SyncTransportError,
                .terminal(code: "INVALID_INVITE_ADMIN_REQUEST")
            )
        }

        XCTAssertNil(InviteIssueRequest(
            potID: fixture.potID,
            inviteID: fixture.inviteID,
            kind: .potLink,
            pendingMemberID: fixture.memberID,
            credentials: credentials,
            expiresAtMillis: 1_702_592_000_000
        ))
    }

    func testManagedInvitesDecodeTypedSummariesAndRejectImpossibleShapes() throws {
        let fixture = try Fixture()
        let secondInviteID = try XCTUnwrap(UUID(
            uuidString: "018bcfe5-6800-7000-8000-000000000002"
        ))
        let value = try decodedValue(
            """
            [
              {
                "inviteId": "\(fixture.inviteID.uuidString.lowercased())",
                "kind": "perMember",
                "pendingMemberId": "\(fixture.memberID.description)",
                "expiresAt": 1702592000000,
                "createdAt": 1700000000000
              },
              {
                "inviteId": "\(secondInviteID.uuidString.lowercased())",
                "kind": "potLink",
                "pendingMemberId": null,
                "expiresAt": 1702592001000,
                "createdAt": 1700000001000
              }
            ]
            """
        )

        XCTAssertEqual(
            try ConvexSyncTransport.managedInvites(from: value),
            [
                ManagedInvite(
                    inviteID: fixture.inviteID,
                    kind: .perMember,
                    pendingMemberID: fixture.memberID,
                    expiresAtMillis: 1_702_592_000_000,
                    createdAtMillis: 1_700_000_000_000
                ),
                ManagedInvite(
                    inviteID: secondInviteID,
                    kind: .potLink,
                    pendingMemberID: nil,
                    expiresAtMillis: 1_702_592_001_000,
                    createdAtMillis: 1_700_000_001_000
                ),
            ]
        )

        let impossible = try decodedValue(
            """
            [{
              "inviteId": "\(secondInviteID.uuidString.lowercased())",
              "kind": "perMember",
              "pendingMemberId": null,
              "expiresAt": 1702592001000,
              "createdAt": 1700000001000
            }]
            """
        )
        XCTAssertThrowsError(
            try ConvexSyncTransport.managedInvites(from: impossible)
        ) {
            XCTAssertEqual(
                $0 as? SyncTransportError,
                .terminal(code: "INVALID_SERVER_RESPONSE")
            )
        }
    }

    func testPushRegistrationAndMuteUseTypedMinimalContracts() throws {
        let fixture = try Fixture()
        XCTAssertNil(APNsDeviceToken(hex: "not-hex"))
        let token = try XCTUnwrap(APNsDeviceToken(
            hex: String(repeating: "AB", count: 32)
        ))
        XCTAssertEqual(token.hex, String(repeating: "ab", count: 32))
        let registration = PushTokenRegistration(
            token: token,
            environment: .sandbox,
            timeZone: fixture.timeZone
        )

        let register = ConvexSyncTransport.preparedPushTokenRegistration(
            registration
        )
        XCTAssertEqual(register.name, "notifications:registerPushToken")
        XCTAssertEqual(
            Set(register.arguments.keys),
            ["deviceToken", "environment", "timeZone"]
        )
        XCTAssertEqual(
            try register.arguments["timeZone"]?.convexEncode(),
            try "Europe/Madrid".convexEncode()
        )

        let unregister = ConvexSyncTransport.preparedPushTokenRemoval(token)
        XCTAssertEqual(unregister.name, "notifications:unregisterPushToken")
        XCTAssertEqual(Set(unregister.arguments.keys), ["deviceToken"])

        let read = ConvexSyncTransport.preparedPotMuteLookup(
            potID: fixture.potID
        )
        XCTAssertEqual(read.name, "notifications:getPotMute")
        XCTAssertEqual(Set(read.arguments.keys), ["potId"])

        let write = ConvexSyncTransport.preparedPotMuteChange(
            potID: fixture.potID,
            muted: true
        )
        XCTAssertEqual(write.name, "notifications:setPotMute")
        XCTAssertEqual(Set(write.arguments.keys), ["potId", "muted"])
        XCTAssertTrue(try ConvexSyncTransport.potMute(from: decodedValue(
            "{\"muted\":true}"
        )))
        XCTAssertThrowsError(try ConvexSyncTransport.potMute(from: decodedValue(
            "{\"muted\":\"yes\"}"
        )))
    }

    private func decodedValue(_ json: String) throws -> ConvexDecodedValue {
        try JSONDecoder().decode(
            ConvexDecodedValue.self,
            from: Data(json.utf8)
        )
    }

    private struct Fixture {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let potID: PotID
        let memberID: MemberID
        let unitID: UnitID
        let eventID: EventID
        let claimID: PendingInviteClaimID
        let inviteID: UUID
        let timeZone: IANATimeZone
        let claimEvent: WireEventV1
        let memberAddedEvent: WireEventV1

        init() throws {
            potID = PotID.generate(at: date)
            memberID = MemberID.generate(at: date)
            unitID = UnitID.generate(at: date)
            eventID = EventID.generate(at: date)
            claimID = try XCTUnwrap(PendingInviteClaimID(
                "jx7f3a9b2c4d6e8g0h1k3m5n7p9r2t4v"
            ))
            inviteID = try XCTUnwrap(UUID(
                uuidString: "018bcfe5-6800-7000-8000-000000000001"
            ))
            timeZone = try IANATimeZone("Europe/Madrid")
            claimEvent = try WireEventV1(EventEnvelope(
                id: eventID,
                potID: potID,
                actorMemberID: memberID,
                occurredAt: date,
                originatingTimeZone: timeZone,
                payload: .memberClaimed(MemberClaimedPayload(memberID: memberID))
            ))
            memberAddedEvent = try WireEventV1(EventEnvelope(
                id: EventID.generate(at: date.addingTimeInterval(1)),
                potID: potID,
                actorMemberID: memberID,
                occurredAt: date,
                originatingTimeZone: timeZone,
                payload: .memberAdded(MemberAddedPayload(
                    memberID: MemberID.generate(at: date.addingTimeInterval(1)),
                    unitID: UnitID.generate(at: date.addingTimeInterval(1)),
                    role: .member
                ))
            ))
        }

        func event(offset: TimeInterval, payload: EventPayload) throws -> WireEventV1 {
            let occurredAt = date.addingTimeInterval(offset)
            return try WireEventV1(EventEnvelope(
                id: EventID.generate(at: occurredAt),
                potID: potID,
                actorMemberID: memberID,
                occurredAt: occurredAt,
                originatingTimeZone: timeZone,
                payload: payload
            ))
        }
    }
}

@MainActor
private final class MemberAdministrationDriver: AuthenticatedConvexDriving {
    typealias AuthResult = Bool

    let claim: PendingInviteClaim
    let profile: PotMemberProfile
    var renames: [WireEventV1] = []
    var ownerBindings: [WireEventV1] = []
    var pendingBindings: [PendingMemberAddition] = []
    var additions: [PendingMemberAddition] = []
    var anonymizedMemberIDs: [MemberID] = []
    var approvals: [PendingInviteClaimApproval] = []
    var rejections: [PendingInviteClaimID] = []
    var claimReassignments: [WireEventV1] = []
    var memberArchives: [WireEventV1] = []
    var ownershipTransfers: [WireEventV1] = []
    var inviteIssues: [InviteIssueRequest] = []
    var inviteRevocations: [UUID] = []
    var pushRegistrations: [PushTokenRegistration] = []
    var pushTokenRemovals: [APNsDeviceToken] = []
    var potMuteChanges: [Bool] = []
    var potMuted = false

    init(claim: PendingInviteClaim, profile: PotMemberProfile) {
        self.claim = claim
        self.profile = profile
    }

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
        return SyncEventPage(
            events: [],
            hasMore: false,
            nextAfterSequence: afterSequence
        )
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
    func listMemberRoster(potID: PotID) async throws -> [PotMemberProfile] {
        _ = potID
        return [profile]
    }
    func listManagedInvites(potID: PotID) async throws -> [ManagedInvite] {
        _ = potID
        return [ManagedInvite(
            inviteID: claim.inviteID,
            kind: .perMember,
            pendingMemberID: profile.memberID,
            expiresAtMillis: 1_702_592_000_000,
            createdAtMillis: 1_700_000_000_000
        )]
    }
    func issueInvite(_ request: InviteIssueRequest) async throws -> UUID {
        inviteIssues.append(request)
        return request.inviteID
    }
    func revokeInvite(potID: PotID, inviteID: UUID) async throws {
        _ = potID
        inviteRevocations.append(inviteID)
    }
    func registerPushToken(
        _ registration: PushTokenRegistration
    ) async throws {
        pushRegistrations.append(registration)
    }
    func unregisterPushToken(_ token: APNsDeviceToken) async throws {
        pushTokenRemovals.append(token)
    }
    func getPotMute(potID: PotID) async throws -> Bool {
        _ = potID
        return potMuted
    }
    func setPotMute(potID: PotID, muted: Bool) async throws -> Bool {
        _ = potID
        potMuteChanges.append(muted)
        potMuted = muted
        return muted
    }
    func renamePot(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        renames.append(event)
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 12)
    }
    func bindOwnerUnit(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        ownerBindings.append(event)
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 10)
    }
    func bindPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        pendingBindings.append(request)
        return EventAcknowledgement(
            eventID: request.event.eventId,
            serverSequence: 11
        )
    }
    func addPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        additions.append(request)
        return EventAcknowledgement(
            eventID: request.event.eventId,
            serverSequence: 9
        )
    }
    func anonymizePendingMember(
        potID: PotID,
        memberID: MemberID
    ) async throws {
        _ = potID
        anonymizedMemberIDs.append(memberID)
    }
    func listPendingInviteClaims(
        potID: PotID
    ) async throws -> [PendingInviteClaim] {
        _ = potID
        return [claim]
    }
    func approvePendingInviteClaim(
        _ request: PendingInviteClaimApproval
    ) async throws -> EventAcknowledgement {
        approvals.append(request)
        return EventAcknowledgement(
            eventID: request.event.eventId,
            serverSequence: 8
        )
    }
    func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws {
        rejections.append(claimID)
    }
    func reassignMemberClaim(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        claimReassignments.append(event)
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 13)
    }
    func archiveMember(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        memberArchives.append(event)
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 14)
    }
    func transferOwnership(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        ownershipTransfers.append(event)
        return EventAcknowledgement(eventID: event.eventId, serverSequence: 15)
    }
}
