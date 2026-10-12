import Combine
@preconcurrency import ConvexMobile
import Foundation
import NumaSharedCore

extension LocalPotPromotionRequest {
    /// The promotion event array in exact wire shape: encoded events plus the
    /// legacy-migration re-authorization subset, shared by every promotion
    /// call site and pinned byte-for-byte by the wire contract tests.
    var encodedPromotionEvents: (events: [ConvexWireArgument], legacyMigrationEventIds: [ConvexWireArgument]) {
        get throws {
            let events: [ConvexWireArgument]
            do {
                events = try self.events.map(ConvexWireArguments.event)
            } catch {
                throw SyncTransportError.terminal(code: "UNSUPPORTED_WIRE_EVENT")
            }
            return (
                events,
                self.events.compactMap { event in
                    event.legacyAuthoredText
                        ? .string(event.eventId.description) : nil
                }
            )
        }
    }
}

/// Main-actor ownership keeps the non-Sendable SDK client behind one
/// compiler-enforced isolation boundary.
@MainActor
public final class ConvexSyncTransport:
    SyncTransport,
    InviteClaimTransport,
    InviteAdministrationTransport,
    MemberAdministrationTransport,
    PushNotificationTransport
{
    private static let defaultQueryTimeout: Duration = .seconds(15)

    private let client: PreConcurrencyConvexClientBox
    private let queryTimeout: Duration

    public init(deploymentURL: URL) {
        client = PreConcurrencyConvexClientBox(
            ConvexClient(deploymentUrl: deploymentURL.absoluteString)
        )
        queryTimeout = Self.defaultQueryTimeout
    }

    /// Accepts `ConvexClientWithAuth` through its `ConvexClient` base class so
    /// authentication and transport can share one SDK connection.
    public init(client: ConvexClient) {
        self.client = PreConcurrencyConvexClientBox(client)
        queryTimeout = Self.defaultQueryTimeout
    }

    public func connectionStates() async -> AsyncStream<SyncConnectionState> {
        Self.connectionStateStream(from: client.watchWebSocketState())
    }

    static func connectionStateStream(
        from publisher: AnyPublisher<WebSocketState, Never>
    ) -> AsyncStream<SyncConnectionState> {
        return AsyncStream { continuation in
            let lifetime = CancellableLifetime()
            lifetime.install(
                publisher
                    // Convex emits from its Rust Tokio worker. The enclosing
                    // transport is MainActor-isolated, so downstream delivery
                    // must hop before Swift enters the sink closure.
                    .receive(on: DispatchQueue.main)
                    .sink { state in
                        switch state {
                        case .connected:
                            continuation.yield(.connected)
                        case .connecting:
                            continuation.yield(.connecting)
                        }
                    }
            )
            continuation.onTermination = { _ in lifetime.cancel() }
        }
    }

    public func listPots() async throws -> [RemotePotDescriptor] {
        let value = try await query("pots:listMyPots", arguments: nil)
        do {
            let response = try ConvexWireArguments.decode(
                [RemotePotResponse].self,
                from: value
            )
            return try response.map { try $0.descriptor }
        } catch {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    public func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        let arguments = try Self.promotionArguments(request)
        let value = try await mutation(
            "pots:promoteLocalPot",
            arguments: arguments
        )
        return try acknowledgements(from: value)
    }

    nonisolated static func promotionArguments(
        _ request: LocalPotPromotionRequest
    ) throws -> [String: ConvexWireArgument] {
        guard Self.isValidDisplayName(request.ownerDisplayName) else {
            throw SyncTransportError.terminal(code: "INVALID_OWNER_DISPLAY_NAME")
        }
        let encodedEvents = try request.encodedPromotionEvents
        var arguments: [String: ConvexWireArgument] = [
            "configuration": ConvexWireArguments.configuration(request),
            "ownerDisplayName": .string(request.ownerDisplayName),
            "events": .array(encodedEvents.events),
            "legacyMigrationEventIds": .array(encodedEvents.legacyMigrationEventIds),
        ]
        if let promotion = request.budgetGroupPromotion {
            arguments["budgetGroupPromotion"] = .object([
                "ownerBindingEventId": .string(promotion.ownerBindingEventID.description),
                "startingSequence": .int64(promotion.startingSequence),
                "members": .array(promotion.members.map { member in
                    var fields: [String: ConvexWireArgument] = ["memberId": .string(member.memberID.description)]
                    if let name = member.displayName { fields["displayName"] = .string(name) }
                    return .object(fields)
                }),
            ])
        }
        return arguments
    }

    nonisolated private static func encodedEventArray(
        _ events: [WireEventV1]
    ) throws -> [ConvexWireArgument] {
        do {
            return try events.map(ConvexWireArguments.event)
        } catch {
            throw SyncTransportError.terminal(code: "UNSUPPORTED_WIRE_EVENT")
        }
    }

    nonisolated static func isValidDisplayName(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && value.utf16.count <= 128
            && value != WireEventV1.redactedTextPlaceholder
    }

    public func changeBudgetGroups(_ event: WireEventV1, expectedTopologyRevision: Int64) async throws -> EventAcknowledgement {
        let value = try await mutation("members:changeBudgetGroups", arguments: [
            "potId": ConvexWireArgument.string(event.potId.description),
            "event": try ConvexWireArguments.event(event),
            "expectedTopologyRevision": ConvexWireArgument.int64(expectedTopologyRevision),
        ])
        struct Receipt: Decodable { let sequence: Int64 }
        let receipt = try ConvexWireArguments.decode(Receipt.self, from: value)
        return EventAcknowledgement(eventID: event.eventId, serverSequence: receipt.sequence)
    }

    public func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        let encodedEvents = try Self.encodedEventArray(events)
        let value = try await mutation("events:appendEvents", arguments: [
            "potId": ConvexWireArgument.string(potID.description),
            "events": ConvexWireArgument.array(encodedEvents),
        ])
        return try acknowledgements(from: value)
    }

    public func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage {
        let value = try await query("events:listEvents", arguments: [
            "potId": ConvexWireArgument.string(potID.description),
            "afterSequence": ConvexWireArgument.int64(afterSequence),
        ])
        do {
            let response = try ConvexWireArguments.decode(
                EventPageResponse.self,
                from: value
            )
            return SyncEventPage(
                events: response.events,
                hasMore: response.hasMore,
                nextAfterSequence: response.nextAfterSequence
            )
        } catch {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    public func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        let arguments: [String: ConvexWireArgument] = [
            "potId": .string(potID.description), "afterRevision": .int64(afterRevision),
        ]
        let value: ConvexDecodedValue
        let allowsLegacyResponse: Bool
        do {
            value = try await query("events:listTextChangesWithSkippedRevisions", arguments: arguments)
            allowsLegacyResponse = false
        } catch SyncTransportError.terminal(code: "TEXT_REDACTION_BACKEND_UPDATE_REQUIRED") {
            // Only an explicitly missing new endpoint permits fallback. Legacy
            // pages still undergo strict cursor validation, including archived gaps.
            value = try await query("events:listTextChanges", arguments: arguments)
            allowsLegacyResponse = true
        }
        return try Self.textChangePage(from: value, allowsLegacyResponse: allowsLegacyResponse)
    }

    nonisolated static func textChangePage(
        from value: ConvexDecodedValue, allowsLegacyResponse: Bool = false
    ) throws -> SyncTextChangePage {
        do {
            let response = try ConvexWireArguments.decode(
                TextChangePageResponse.self,
                from: value
            )
            guard response.nextAfterRevision >= 0,
                  response.skippedRevisions != nil || allowsLegacyResponse,
                  (response.skippedRevisions ?? []).allSatisfy({ $0 > 0 }) else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            let changes = try response.changes.map { change in
                guard change.revision > 0, change.state == "redacted" else {
                    throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
                }
                return TextRedactionChange(
                    eventID: try parseID(EventID.self, value: change.eventId),
                    field: change.field,
                    revision: change.revision
                )
            }
            return SyncTextChangePage(
                changes: changes,
                hasMore: response.hasMore,
                nextAfterRevision: response.nextAfterRevision,
                skippedRevisions: response.skippedRevisions ?? []
            )
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func claimInvite(
        _ request: InviteClaimRequest
    ) async throws -> InviteClaimOutcome {
        let prepared = try Self.preparedInviteClaim(request)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            switch request {
            case .perMember:
                let response = try ConvexWireArguments.decode(
                    PerMemberInviteClaimResponse.self,
                    from: value
                )
                guard response.sequence > 0 else {
                    throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
                }
                return .joined(
                    potID: try parseID(PotID.self, value: response.potId),
                    memberID: try parseID(MemberID.self, value: response.memberId),
                    serverSequence: response.sequence
                )
            case .potLink:
                let response = try ConvexWireArguments.decode(
                    PotLinkInviteClaimResponse.self,
                    from: value
                )
                guard response.status == "pending" else {
                    throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
                }
                return .pendingApproval
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func listManagedInvites(
        potID: PotID
    ) async throws -> [ManagedInvite] {
        let value = try await query("members:listInvites", arguments: [
            "potId": .string(potID.description),
        ])
        return try Self.managedInvites(from: value)
    }

    public func issueInvite(_ request: InviteIssueRequest) async throws -> UUID {
        let prepared = try Self.preparedInviteIssue(request)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            let response = try ConvexWireArguments.decode(
                InviteIssueResponse.self,
                from: value
            )
            guard let inviteID = Self.canonicalUUIDv7(response.inviteId),
                  inviteID == request.inviteID
            else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            return inviteID
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func revokeInvite(potID: PotID, inviteID: UUID) async throws {
        let prepared = try Self.preparedInviteRevocation(
            potID: potID,
            inviteID: inviteID
        )
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            let response = try ConvexWireArguments.decode(
                InviteRevocationResponse.self,
                from: value
            )
            guard response.status == "revoked" else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func registerPushToken(
        _ registration: PushTokenRegistration
    ) async throws {
        let prepared = Self.preparedPushTokenRegistration(registration)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            let response = try ConvexWireArguments.decode(
                PushTokenRegistrationResponse.self,
                from: value
            )
            guard response.registered else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func unregisterPushToken(_ token: APNsDeviceToken) async throws {
        let prepared = Self.preparedPushTokenRemoval(token)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            _ = try ConvexWireArguments.decode(
                PushTokenRemovalResponse.self,
                from: value
            )
        } catch {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    public func getPotMute(potID: PotID) async throws -> Bool {
        let prepared = Self.preparedPotMuteLookup(potID: potID)
        let value = try await query(prepared.name, arguments: prepared.arguments)
        return try Self.potMute(from: value)
    }

    public func setPotMute(potID: PotID, muted: Bool) async throws -> Bool {
        let prepared = Self.preparedPotMuteChange(potID: potID, muted: muted)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        let confirmed = try Self.potMute(from: value)
        guard confirmed == muted else {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
        return confirmed
    }

    public func listMemberRoster(
        potID: PotID
    ) async throws -> [PotMemberProfile] {
        let value = try await query("members:listRoster", arguments: [
            "potId": .string(potID.description),
        ])
        return try Self.memberRoster(from: value)
    }

    public func bindOwnerUnit(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedOwnerUnitBinding(event)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        return try Self.memberEventAcknowledgement(
            from: value,
            eventID: event.eventId
        )
    }

    public func bindPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedPendingMemberBinding(request)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        return try Self.memberEventAcknowledgement(
            from: value,
            eventID: request.event.eventId
        )
    }

    public func renamePot(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedPotRename(event)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        return try Self.memberEventAcknowledgement(
            from: value,
            eventID: event.eventId
        )
    }

    public func addPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedPendingMemberAddition(request)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        return try Self.memberEventAcknowledgement(
            from: value,
            eventID: request.event.eventId
        )
    }

    public func anonymizePendingMember(
        potID: PotID,
        memberID: MemberID
    ) async throws {
        let prepared = Self.preparedPendingMemberAnonymization(
            potID: potID,
            memberID: memberID
        )
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            let response = try ConvexWireArguments.decode(
                PendingMemberAnonymizationResponse.self,
                from: value
            )
            guard response.status == "anonymized" else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func listPendingInviteClaims(
        potID: PotID
    ) async throws -> [PendingInviteClaim] {
        let value = try await query("members:listPendingClaims", arguments: [
            "potId": .string(potID.description),
        ])
        return try Self.pendingInviteClaims(from: value)
    }

    public func approvePendingInviteClaim(
        _ request: PendingInviteClaimApproval
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedPendingInviteApproval(request)
        guard case let .memberClaimed(memberID) = request.event.payload else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            let response = try ConvexWireArguments.decode(
                PendingInviteApprovalResponse.self,
                from: value
            )
            guard response.sequence > 0,
                  response.memberId == memberID.description
            else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            return EventAcknowledgement(
                eventID: request.event.eventId,
                serverSequence: response.sequence
            )
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws {
        let prepared = Self.preparedPendingInviteRejection(claimID)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            let response = try ConvexWireArguments.decode(
                PendingInviteRejectionResponse.self,
                from: value
            )
            guard response.status == "rejected" else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func reassignMemberClaim(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedMemberClaimReassignment(event)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        return try Self.memberEventAcknowledgement(
            from: value,
            eventID: event.eventId
        )
    }

    public func archiveMember(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedMemberArchive(event)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        return try Self.memberEventAcknowledgement(
            from: value,
            eventID: event.eventId
        )
    }

    public func leavePot(
        _ request: PotLeaveRequest
    ) async throws -> PotLeaveAcknowledgement {
        let prepared = try Self.preparedPotLeave(request)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        do {
            let response = try ConvexWireArguments.decode(
                PotLeaveResponse.self,
                from: value
            )
            let successor = try response.successorMemberId.map {
                try parseID(MemberID.self, value: $0)
            }
            guard response.archiveSequence > 0,
                  (response.transferSequence != nil) == (successor != nil),
                  response.transferSequence.map({
                      $0 > 0 && $0 == response.archiveSequence - 1
                  }) ?? true
            else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            return PotLeaveAcknowledgement(
                archive: EventAcknowledgement(
                    eventID: request.archiveEvent.eventId,
                    serverSequence: response.archiveSequence
                ),
                ownershipTransfer: response.transferSequence.map {
                    EventAcknowledgement(
                        eventID: request.transferEventID,
                        serverSequence: $0
                    )
                },
                successorMemberID: successor
            )
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    public func transferOwnership(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        let prepared = try Self.preparedOwnershipTransfer(event)
        let value = try await mutation(prepared.name, arguments: prepared.arguments)
        return try Self.memberEventAcknowledgement(
            from: value,
            eventID: event.eventId
        )
    }

    struct PreparedInviteClaim {
        let name: String
        let arguments: [String: ConvexWireArgument]
    }

    nonisolated static func preparedInviteClaim(
        _ request: InviteClaimRequest
    ) throws -> PreparedInviteClaim {
        let ticket: String
        switch request {
        case let .perMember(value, event):
            ticket = value
            guard event.occurredAtMillis >= 0, (1...EventEnvelope.maximumSupportedSchemaVersion).contains(event.schemaVersion) else {
                throw SyncTransportError.terminal(
                    code: "INVALID_INVITE_CLAIM_REQUEST"
                )
            }
            try validateInviteTicket(ticket)
            return PreparedInviteClaim(
                name: "members:claimPerMemberInviteWithTicket",
                arguments: [
                    "ticket": .string(ticket),
                    "event": .object([
                        "eventId": .string(event.eventID.description),
                        "occurredAtMillis": .int64(event.occurredAtMillis),
                        "originatingTimeZone": .string(
                            event.originatingTimeZone.identifier
                        ),
                        "schemaVersion": .int64(Int64(event.schemaVersion)),
                    ]),
                ]
            )
        case let .potLink(value, chosenMemberID):
            ticket = value
            try validateInviteTicket(ticket)
            var arguments: [String: ConvexWireArgument] = [
                "ticket": .string(ticket),
            ]
            if let chosenMemberID {
                arguments["chosenMemberId"] = .string(chosenMemberID.description)
            }
            return PreparedInviteClaim(
                name: "members:claimPotLinkInviteWithTicket",
                arguments: arguments
            )
        }
    }

    struct PreparedMemberAdministrationMutation {
        let name: String
        let arguments: [String: ConvexWireArgument]
    }

    nonisolated static func preparedInviteIssue(
        _ request: InviteIssueRequest
    ) throws -> PreparedMemberAdministrationMutation {
        guard UUIDv7.timestampMilliseconds(of: request.inviteID) != nil,
              request.expiresAtMillis > 0,
              request.expiresAtMillis <= 9_007_199_254_740_991,
              (request.kind == .perMember) == (request.pendingMemberID != nil)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_INVITE_ADMIN_REQUEST"
            )
        }
        var arguments: [String: ConvexWireArgument] = [
            "potId": .string(request.potID.description),
            "inviteId": .string(request.inviteID.uuidString.lowercased()),
            "kind": .string(request.kind.rawValue),
            "token": .string(request.credentials.token),
            "code": .string(request.credentials.code),
            "expiresAt": .float(Double(request.expiresAtMillis)),
        ]
        if let pendingMemberID = request.pendingMemberID {
            arguments["pendingMemberId"] = .string(pendingMemberID.description)
        }
        return PreparedMemberAdministrationMutation(
            name: "members:issueInvite",
            arguments: arguments
        )
    }

    nonisolated static func preparedInviteRevocation(
        potID: PotID,
        inviteID: UUID
    ) throws -> PreparedMemberAdministrationMutation {
        guard UUIDv7.timestampMilliseconds(of: inviteID) != nil else {
            throw SyncTransportError.terminal(
                code: "INVALID_INVITE_ADMIN_REQUEST"
            )
        }
        return PreparedMemberAdministrationMutation(
            name: "members:revokeInvite",
            arguments: [
                "potId": .string(potID.description),
                "inviteId": .string(inviteID.uuidString.lowercased()),
            ]
        )
    }

    nonisolated static func preparedPushTokenRegistration(
        _ registration: PushTokenRegistration
    ) -> PreparedMemberAdministrationMutation {
        PreparedMemberAdministrationMutation(
            name: "notifications:registerPushToken",
            arguments: [
                "deviceToken": .string(registration.token.hex),
                "environment": .string(registration.environment.rawValue),
                "timeZone": .string(registration.timeZone.identifier),
            ]
        )
    }

    nonisolated static func preparedPushTokenRemoval(
        _ token: APNsDeviceToken
    ) -> PreparedMemberAdministrationMutation {
        PreparedMemberAdministrationMutation(
            name: "notifications:unregisterPushToken",
            arguments: ["deviceToken": .string(token.hex)]
        )
    }

    nonisolated static func preparedPotMuteLookup(
        potID: PotID
    ) -> PreparedMemberAdministrationMutation {
        PreparedMemberAdministrationMutation(
            name: "notifications:getPotMute",
            arguments: ["potId": .string(potID.description)]
        )
    }

    nonisolated static func preparedPotMuteChange(
        potID: PotID,
        muted: Bool
    ) -> PreparedMemberAdministrationMutation {
        PreparedMemberAdministrationMutation(
            name: "notifications:setPotMute",
            arguments: [
                "potId": .string(potID.description),
                "muted": .bool(muted),
            ]
        )
    }

    nonisolated static func preparedPendingMemberAddition(
        _ request: PendingMemberAddition
    ) throws -> PreparedMemberAdministrationMutation {
        try preparedPendingMemberMutation(
            request,
            name: "members:addPendingMember"
        )
    }

    nonisolated static func preparedPendingMemberBinding(
        _ request: PendingMemberAddition
    ) throws -> PreparedMemberAdministrationMutation {
        try preparedPendingMemberMutation(
            request,
            name: "members:bindPendingMember"
        )
    }

    nonisolated static func preparedOwnerUnitBinding(
        _ event: WireEventV1
    ) throws -> PreparedMemberAdministrationMutation {
        guard case let .memberAdded(memberID, _, .owner) = event.payload,
              event.actorMemberId == memberID,
              isExactTextFreeCurrentEvent(event)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        let encodedEvent = try Self.encodedAdminEvent(event)
        return PreparedMemberAdministrationMutation(
            name: "members:bindOwnerUnit",
            arguments: [
                "potId": .string(event.potId.description),
                "event": encodedEvent,
            ]
        )
    }

    nonisolated static func preparedPotRename(
        _ event: WireEventV1
    ) throws -> PreparedMemberAdministrationMutation {
        guard case let .potRenamed(name) = event.payload,
              isValidDisplayName(name),
              isExactTextFreeCurrentEvent(event)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        let encodedEvent = try Self.encodedAdminEvent(event)
        return PreparedMemberAdministrationMutation(
            name: "members:renamePot",
            arguments: [
                "potId": .string(event.potId.description),
                "event": encodedEvent,
            ]
        )
    }

    nonisolated private static func encodedAdminEvent(
        _ event: WireEventV1
    ) throws -> ConvexWireArgument {
        do {
            return try ConvexWireArguments.event(event)
        } catch {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
    }

    nonisolated private static func preparedPendingMemberMutation(
        _ request: PendingMemberAddition,
        name: String
    ) throws -> PreparedMemberAdministrationMutation {
        let event = request.event
        guard isValidDisplayName(request.displayName),
              case .memberAdded(_, _, .member) = event.payload,
              isExactTextFreeCurrentEvent(event)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        let encodedEvent = try Self.encodedAdminEvent(event)
        return PreparedMemberAdministrationMutation(
            name: name,
            arguments: [
                "potId": .string(event.potId.description),
                "displayName": .string(request.displayName),
                "event": encodedEvent,
            ]
        )
    }

    nonisolated static func preparedPendingMemberAnonymization(
        potID: PotID,
        memberID: MemberID
    ) -> PreparedMemberAdministrationMutation {
        PreparedMemberAdministrationMutation(
            name: "members:anonymizePendingMember",
            arguments: [
                "potId": .string(potID.description),
                "memberId": .string(memberID.description),
            ]
        )
    }

    nonisolated private static func isExactTextFreeCurrentEvent(
        _ event: WireEventV1
    ) -> Bool {
        (1 ... EventEnvelope.maximumSupportedSchemaVersion).contains(event.schemaVersion)
            && event.occurredAtMillis >= 0
            && event.textFields.isEmpty
            && event.authoredText.isEmpty
            && !event.legacyAuthoredText
            && event.opaqueFutureOriginatingTimeZoneIdentifier == nil
            && event.opaqueFutureTextFields == nil
    }

    nonisolated static func memberRoster(
        from value: ConvexDecodedValue
    ) throws -> [PotMemberProfile] {
        do {
            let response = try ConvexWireArguments.decode(
                [PotMemberProfileResponse].self,
                from: value
            )
            guard (1 ... 64).contains(response.count) else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            var memberIDs = Set<MemberID>()
            var unitIDs = Set<UnitID>()
            let profiles = try response.map { value in
                let memberID = try parseID(MemberID.self, value: value.memberId)
                let unitID = try value.unitId.map {
                    try parseID(UnitID.self, value: $0)
                }
                guard memberIDs.insert(memberID).inserted,
                      unitID.map({ unitIDs.insert($0).inserted }) ?? true,
                      value.displayName.map(isValidDisplayName) ?? true,
                      value.role != .owner || value.state == .active,
                      value.state != .pending || value.role == .member,
                      value.role == .owner || unitID != nil
                else {
                    throw SyncTransportError.terminal(
                        code: "INVALID_SERVER_RESPONSE"
                    )
                }
                return PotMemberProfile(
                    memberID: memberID,
                    unitID: unitID,
                    displayName: value.displayName,
                    role: value.role,
                    state: value.state,
                    budgetUnitID: try value.budgetUnitId.map { value in
                        guard let uuid = UUID(uuidString: value) else { throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE") }
                        return try UnitID(validating: uuid)
                    }
                )
            }
            guard profiles.filter({
                $0.role == .owner && $0.state == .active
            }).count == 1 else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            return profiles
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    nonisolated private static func memberEventAcknowledgement(
        from value: ConvexDecodedValue,
        eventID: EventID
    ) throws -> EventAcknowledgement {
        do {
            let response = try ConvexWireArguments.decode(
                MemberEventResponse.self,
                from: value
            )
            guard response.sequence > 0 else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            return EventAcknowledgement(
                eventID: eventID,
                serverSequence: response.sequence
            )
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    nonisolated static func preparedPendingInviteApproval(
        _ request: PendingInviteClaimApproval
    ) throws -> PreparedMemberAdministrationMutation {
        let event = request.event
        guard case let .memberClaimed(memberID) = event.payload,
              event.actorMemberId == memberID,
              (1...EventEnvelope.maximumSupportedSchemaVersion).contains(event.schemaVersion),
              event.occurredAtMillis >= 0,
              event.textFields.isEmpty,
              event.authoredText.isEmpty,
              !event.legacyAuthoredText,
              event.opaqueFutureOriginatingTimeZoneIdentifier == nil,
              event.opaqueFutureTextFields == nil
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        let encodedEvent = try Self.encodedAdminEvent(event)
        return PreparedMemberAdministrationMutation(
            name: "members:approvePotLinkClaim",
            arguments: [
                "claimId": .string(request.claimID.rawValue),
                "memberId": .string(memberID.description),
                "event": encodedEvent,
            ]
        )
    }

    nonisolated static func preparedPendingInviteRejection(
        _ claimID: PendingInviteClaimID
    ) -> PreparedMemberAdministrationMutation {
        PreparedMemberAdministrationMutation(
            name: "members:rejectPotLinkClaim",
            arguments: ["claimId": .string(claimID.rawValue)]
        )
    }

    nonisolated static func preparedMemberClaimReassignment(
        _ event: WireEventV1
    ) throws -> PreparedMemberAdministrationMutation {
        guard case let .memberClaimReassigned(memberID) = event.payload,
              event.actorMemberId != memberID,
              isExactTextFreeCurrentEvent(event)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        return try preparedLifecycleMutation(
            event,
            name: "members:reassignClaim"
        )
    }

    nonisolated static func preparedMemberArchive(
        _ event: WireEventV1
    ) throws -> PreparedMemberAdministrationMutation {
        guard case let .memberArchived(memberID) = event.payload,
              event.actorMemberId != memberID,
              isExactTextFreeCurrentEvent(event)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        return try preparedLifecycleMutation(
            event,
            name: "members:archiveMember"
        )
    }

    nonisolated static func preparedPotLeave(
        _ request: PotLeaveRequest
    ) throws -> PreparedMemberAdministrationMutation {
        let event = request.archiveEvent
        guard case let .memberArchived(memberID) = event.payload,
              event.actorMemberId == memberID,
              isExactTextFreeCurrentEvent(event)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        let encodedEvent = try Self.encodedAdminEvent(event)
        return PreparedMemberAdministrationMutation(
            name: "members:leavePot",
            arguments: [
                "potId": .string(event.potId.description),
                "archiveEvent": encodedEvent,
                "transferEventId": .string(request.transferEventID.description),
            ]
        )
    }

    nonisolated static func preparedOwnershipTransfer(
        _ event: WireEventV1
    ) throws -> PreparedMemberAdministrationMutation {
        guard case let .ownershipTransferred(fromMemberID, toMemberID) = event.payload,
              event.actorMemberId == fromMemberID,
              fromMemberID != toMemberID,
              isExactTextFreeCurrentEvent(event)
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_MEMBER_ADMIN_REQUEST"
            )
        }
        return try preparedLifecycleMutation(
            event,
            name: "members:transferOwnership"
        )
    }

    nonisolated private static func preparedLifecycleMutation(
        _ event: WireEventV1,
        name: String
    ) throws -> PreparedMemberAdministrationMutation {
        let encodedEvent = try Self.encodedAdminEvent(event)
        return PreparedMemberAdministrationMutation(
            name: name,
            arguments: [
                "potId": .string(event.potId.description),
                "event": encodedEvent,
            ]
        )
    }

    nonisolated static func pendingInviteClaims(
        from value: ConvexDecodedValue
    ) throws -> [PendingInviteClaim] {
        do {
            let response = try ConvexWireArguments.decode(
                [PendingInviteClaimResponse].self,
                from: value
            )
            var seenClaimIDs = Set<PendingInviteClaimID>()
            let claims = try response.map { claim in
                guard let claimID = PendingInviteClaimID(claim.claimId),
                      seenClaimIDs.insert(claimID).inserted,
                      let inviteID = canonicalUUIDv7(claim.inviteId),
                      claim.createdAt.isFinite,
                      claim.createdAt >= 0,
                      claim.createdAt <= Double(Int64.max),
                      claim.createdAt.rounded(.towardZero) == claim.createdAt
                else {
                    throw SyncTransportError.terminal(
                        code: "INVALID_SERVER_RESPONSE"
                    )
                }
                let chosenMemberID = try claim.chosenMemberId.map {
                    try parseID(MemberID.self, value: $0)
                }
                return PendingInviteClaim(
                    id: claimID,
                    inviteID: inviteID,
                    chosenMemberID: chosenMemberID,
                    createdAtMillis: Int64(claim.createdAt)
                )
            }
            return claims.sorted {
                if $0.createdAtMillis != $1.createdAtMillis {
                    return $0.createdAtMillis < $1.createdAtMillis
                }
                return $0.id.rawValue < $1.id.rawValue
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    nonisolated static func managedInvites(
        from value: ConvexDecodedValue
    ) throws -> [ManagedInvite] {
        do {
            let response = try ConvexWireArguments.decode(
                [ManagedInviteResponse].self,
                from: value
            )
            var seenInviteIDs = Set<UUID>()
            let invites = try response.map { invite in
                guard let inviteID = canonicalUUIDv7(invite.inviteId),
                      seenInviteIDs.insert(inviteID).inserted,
                      invite.expiresAt.isFinite,
                      invite.createdAt.isFinite,
                      invite.expiresAt > 0,
                      invite.createdAt >= 0,
                      invite.expiresAt <= 9_007_199_254_740_991,
                      invite.createdAt <= 9_007_199_254_740_991,
                      invite.expiresAt.rounded(.towardZero) == invite.expiresAt,
                      invite.createdAt.rounded(.towardZero) == invite.createdAt,
                      invite.expiresAt > invite.createdAt,
                      (invite.kind == .perMember)
                        == (invite.pendingMemberId != nil)
                else {
                    throw SyncTransportError.terminal(
                        code: "INVALID_SERVER_RESPONSE"
                    )
                }
                return ManagedInvite(
                    inviteID: inviteID,
                    kind: invite.kind,
                    pendingMemberID: try invite.pendingMemberId.map {
                        try parseID(MemberID.self, value: $0)
                    },
                    expiresAtMillis: Int64(invite.expiresAt),
                    createdAtMillis: Int64(invite.createdAt)
                )
            }
            return invites.sorted {
                if $0.createdAtMillis != $1.createdAtMillis {
                    return $0.createdAtMillis < $1.createdAtMillis
                }
                return $0.inviteID.uuidString < $1.inviteID.uuidString
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    nonisolated static func potMute(
        from value: ConvexDecodedValue
    ) throws -> Bool {
        do {
            return try ConvexWireArguments.decode(
                PotMuteResponse.self,
                from: value
            ).muted
        } catch {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    nonisolated private static func canonicalUUIDv7(_ value: String) -> UUID? {
        let bytes = Array(value.lowercased().utf8)
        guard bytes.count == 36,
              bytes[8] == 45, bytes[13] == 45,
              bytes[18] == 45, bytes[23] == 45,
              bytes[14] == 55,
              [56, 57, 97, 98].contains(bytes[19]),
              let uuid = UUID(uuidString: value)
        else { return nil }
        return uuid
    }

    nonisolated private static func validateInviteTicket(_ ticket: String) throws {
        guard (32 ... 2_048).contains(ticket.utf8.count),
              ticket.utf8.allSatisfy({ (33 ... 126).contains($0) })
        else {
            throw SyncTransportError.terminal(
                code: "INVALID_INVITE_CLAIM_REQUEST"
            )
        }
    }

    /// Response validation failures keep their terminal identity; anything
    /// else the decoders surface is an unparseable server response.
    nonisolated static func serverResponseFailure(
        _ error: any Error
    ) -> SyncTransportError {
        error as? SyncTransportError
            ?? .terminal(code: "INVALID_SERVER_RESPONSE")
    }

    private func acknowledgements(
        from value: ConvexDecodedValue
    ) throws -> [EventAcknowledgement] {
        do {
            let response = try ConvexWireArguments.decode(
                AcknowledgementResponse.self,
                from: value
            )
            return try response.events.map { acknowledgement in
                EventAcknowledgement(
                    eventID: try parseID(
                        EventID.self,
                        value: acknowledgement.eventId
                    ),
                    serverSequence: acknowledgement.sequence
                )
            }
        } catch {
            throw Self.serverResponseFailure(error)
        }
    }

    private func mutation(
        _ name: String,
        arguments: [String: ConvexWireArgument]
    ) async throws -> ConvexDecodedValue {
        do {
            return try await client.mutation(name, arguments: arguments)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw Self.transportError(from: error)
        }
    }

    private func query(
        _ name: String,
        arguments: [String: ConvexWireArgument]?
    ) async throws -> ConvexDecodedValue {
        do {
            let publisher: AnyPublisher<ConvexDecodedValue, ClientError> = client.subscribe(
                to: name,
                arguments: arguments
            )
            return try await Self.firstValue(
                from: publisher,
                timeout: queryTimeout
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw Self.transportError(from: error)
        }
    }

    static func firstValue(
        from publisher: AnyPublisher<ConvexDecodedValue, ClientError>,
        timeout: Duration
    ) async throws -> ConvexDecodedValue {
        let race = FirstValueRace()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                race.start(
                    publisher: publisher,
                    timeout: timeout,
                    continuation: continuation
                )
            }
        } onCancel: {
            race.cancel()
        }
    }

    private static func transportError(from error: Error) -> SyncTransportError {
        if let transport = error as? SyncTransportError { return transport }
        guard let clientError = error as? ClientError else {
            if error is DecodingError || error is ConvexWireCodingError {
                return .terminal(code: "INVALID_SERVER_RESPONSE")
            }
            return .retryable(code: "TRANSPORT_UNAVAILABLE")
        }
        switch clientError {
        case let .ConvexError(data):
            return convexApplicationError(data)
        case let .ServerError(message):
            if message.contains("Could not find public function for 'events:listTextChangesWithSkippedRevisions'") {
                return .terminal(code: "TEXT_REDACTION_BACKEND_UPDATE_REQUIRED")
            }
            return .retryable(code: "TRANSPORT_UNAVAILABLE")
        case .InternalError:
            return .retryable(code: "TRANSPORT_UNAVAILABLE")
        }
    }

    nonisolated static func convexApplicationError(_ data: String) -> SyncTransportError {
        guard let bytes = data.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: bytes),
              let payload = findFailurePayload(in: object)
        else {
            // An opaque SDK/application error is not evidence that the
            // attempted immutable event is invalid. Fail the pot closed so a
            // valid local record is never terminalized by an unparseable
            // server response.
            return .terminal(code: "INVALID_SERVER_RESPONSE")
        }
        return payload.retryable
            ? .retryable(code: payload.code)
            : .terminal(code: payload.code)
    }

    nonisolated private static func findFailurePayload(
        in value: Any
    ) -> (code: String, retryable: Bool)? {
        if let object = value as? [String: Any],
           let rawCode = object["code"] as? String,
           let code = sanitizedFailureCode(rawCode),
           let retryable = object["retryable"] as? Bool {
            return (code, retryable)
        }
        if let object = value as? [String: Any] {
            for key in object.keys.sorted() {
                guard let nested = object[key] else { continue }
                if let payload = findFailurePayload(in: nested) { return payload }
            }
        }
        if let values = value as? [Any] {
            for nested in values {
                if let payload = findFailurePayload(in: nested) { return payload }
            }
        }
        return nil
    }

    nonisolated private static func sanitizedFailureCode(_ code: String) -> String? {
        guard (1 ... 64).contains(code.utf8.count),
              code.utf8.allSatisfy({ byte in
                  byte == 95 || (48 ... 57).contains(byte) || (65 ... 90).contains(byte)
              })
        else { return nil }
        return code
    }
}

/// Compatibility boundary for the official Convex Swift 0.8.1 client, whose
/// public classes predate `Sendable` annotations. The box is private, never
/// exposes the SDK object, accepts only immutable `Sendable` arguments, and is
/// reached through `SerializedAuthenticatedConvexClient`'s FIFO gate.
private final class PreConcurrencyConvexClientBox: @unchecked Sendable {
    private let client: ConvexClient

    init(_ client: ConvexClient) {
        self.client = client
    }

    func watchWebSocketState() -> AnyPublisher<WebSocketState, Never> {
        client.watchWebSocketState()
    }

    func subscribe(
        to name: String,
        arguments: [String: ConvexWireArgument]?
    ) -> AnyPublisher<ConvexDecodedValue, ClientError> {
        client.subscribe(
            to: name,
            with: arguments.map(Self.erase),
            yielding: ConvexDecodedValue.self
        )
    }

    func mutation(
        _ name: String,
        arguments: [String: ConvexWireArgument]
    ) async throws -> ConvexDecodedValue {
        try await client.mutation(name, with: Self.erase(arguments))
    }

    private static func erase(
        _ arguments: [String: ConvexWireArgument]
    ) -> [String: (any ConvexEncodable)?] {
        Dictionary(uniqueKeysWithValues: arguments.map { key, value in
            (key, value as (any ConvexEncodable)?)
        })
    }
}

private struct AcknowledgementResponse: Decodable {
    let events: [Acknowledgement]

    struct Acknowledgement: Decodable {
        let eventId: String
        let sequence: Int64
    }
}

private struct PerMemberInviteClaimResponse: Decodable {
    let sequence: Int64
    let memberId: String
    let potId: String
}

private struct PotLinkInviteClaimResponse: Decodable {
    let status: String
}

private struct InviteIssueResponse: Decodable {
    let inviteId: String
}

private struct InviteRevocationResponse: Decodable {
    let status: String
}

private struct PushTokenRegistrationResponse: Decodable {
    let registered: Bool
}

private struct PushTokenRemovalResponse: Decodable {
    let removed: Bool
}

private struct PotMuteResponse: Decodable {
    let muted: Bool
}

private struct ManagedInviteResponse: Decodable {
    let inviteId: String
    let kind: InviteAdministrationKind
    let pendingMemberId: String?
    let expiresAt: Double
    let createdAt: Double
}

private struct PendingInviteClaimResponse: Decodable {
    let claimId: String
    let inviteId: String
    let chosenMemberId: String?
    let createdAt: Double
}

private struct PendingInviteApprovalResponse: Decodable {
    let sequence: Int64
    let memberId: String
}

private struct PendingInviteRejectionResponse: Decodable {
    let status: String
}

private struct PotMemberProfileResponse: Decodable {
    let memberId: String
    let unitId: String?
    let budgetUnitId: String?
    let displayName: String?
    let role: MemberRole
    let state: PotMemberState
}

private struct MemberEventResponse: Decodable {
    let sequence: Int64
}

private struct PotLeaveResponse: Decodable {
    let archiveSequence: Int64
    let successorMemberId: String?
    let transferSequence: Int64?
}

private struct PendingMemberAnonymizationResponse: Decodable {
    let status: String
}

private struct EventPageResponse: Decodable {
    let events: [HydratedWireEventV1]
    let hasMore: Bool
    let nextAfterSequence: Int64
}

private struct TextChangePageResponse: Decodable {
    let changes: [Change]
    let skippedRevisions: [Int64]?
    let hasMore: Bool
    let nextAfterRevision: Int64

    struct Change: Decodable {
        let eventId: String
        let field: WireTextFieldV1
        let revision: Int64
        let state: String
    }
}

private struct RemotePotResponse: Decodable {
    let potId: String
    let currency: RemoteCurrency
    let orderedUnitIds: [String]
    let initialOrderedUnitIds: [String]?
    let memberId: String
    let role: MemberRole
    let minimumReaderSchemaVersion: Int64
    let lastSequence: Int64
    let lastTextRevision: Int64

    var descriptor: RemotePotDescriptor {
        get throws {
            guard let exponent = Int(exactly: currency.exponent),
                  let minimumVersion = UInt16(exactly: minimumReaderSchemaVersion),
                  lastSequence >= 0,
                  lastTextRevision >= 0
            else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            let potID = try parseID(PotID.self, value: potId)
            let unitIDs = try orderedUnitIds.map { try parseID(UnitID.self, value: $0) }
            let baseline = try initialOrderedUnitIds?.map { try parseID(UnitID.self, value: $0) }
            guard (1 ... 64).contains(unitIDs.count), Set(unitIDs).count == unitIDs.count,
                  baseline.map({ unitIDs.starts(with: $0) }) ?? true else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            return RemotePotDescriptor(
                configuration: try PotConfiguration(
                    id: potID,
                    currency: Currency(code: currency.code, exponent: exponent),
                    orderedUnitIDs: baseline ?? unitIDs
                ),
                memberID: try parseID(MemberID.self, value: memberId),
                role: role,
                minimumReaderSchemaVersion: minimumVersion,
                lastSequence: lastSequence,
                lastTextRevision: lastTextRevision,
                currentKnownUnitIDs: unitIDs,
                hasInitialUnitBaseline: baseline != nil || minimumVersion < 2
            )
        }
    }

    struct RemoteCurrency: Decodable {
        let code: String
        let exponent: Int64
    }
}

private func parseID<Tag>(
    _ type: TaggedID<Tag>.Type,
    value: String
) throws -> TaggedID<Tag> {
    guard let uuid = UUID(uuidString: value) else {
        throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
    }
    return try TaggedID<Tag>(validating: uuid)
}

private final class CancellableLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var cancellable: AnyCancellable?
    private var isCancelled = false

    func install(_ cancellable: AnyCancellable) {
        lock.lock()
        if isCancelled {
            lock.unlock()
            cancellable.cancel()
            return
        }
        self.cancellable = cancellable
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        isCancelled = true
        let cancellable = cancellable
        self.cancellable = nil
        lock.unlock()
        cancellable?.cancel()
    }
}

private final class FirstValueRace: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<ConvexDecodedValue, any Error>?
    private var cancellable: AnyCancellable?
    private var timeoutTask: Task<Void, Never>?
    private var isResolved = false

    func start(
        publisher: AnyPublisher<ConvexDecodedValue, ClientError>,
        timeout: Duration,
        continuation: CheckedContinuation<ConvexDecodedValue, any Error>
    ) {
        lock.lock()
        guard !isResolved else {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        lock.unlock()

        let timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: timeout)
            } catch {
                return
            }
            self?.resolve(.failure(
                SyncTransportError.retryable(code: "TRANSPORT_TIMEOUT")
            ))
        }
        install(timeoutTask: timeoutTask)

        let cancellable = publisher.first().sink(
            receiveCompletion: { [weak self] completion in
                switch completion {
                case .finished:
                    self?.resolve(.failure(
                        SyncTransportError.retryable(code: "TRANSPORT_UNAVAILABLE")
                    ))
                case let .failure(error):
                    self?.resolve(.failure(error))
                }
            },
            receiveValue: { [weak self] value in
                self?.resolve(.success(value))
            }
        )
        install(cancellable: cancellable)
    }

    func cancel() {
        resolve(.failure(CancellationError()))
    }

    private func install(cancellable: AnyCancellable) {
        lock.lock()
        guard !isResolved else {
            lock.unlock()
            cancellable.cancel()
            return
        }
        self.cancellable = cancellable
        lock.unlock()
    }

    private func install(timeoutTask: Task<Void, Never>) {
        lock.lock()
        guard !isResolved else {
            lock.unlock()
            timeoutTask.cancel()
            return
        }
        self.timeoutTask = timeoutTask
        lock.unlock()
    }

    private func resolve(
        _ result: Result<ConvexDecodedValue, any Error>
    ) {
        lock.lock()
        guard !isResolved else {
            lock.unlock()
            return
        }
        isResolved = true
        let continuation = continuation
        let cancellable = cancellable
        let timeoutTask = timeoutTask
        self.continuation = nil
        self.cancellable = nil
        self.timeoutTask = nil
        lock.unlock()

        cancellable?.cancel()
        timeoutTask?.cancel()
        continuation?.resume(with: result)
    }
}
