import Foundation
import NumaSharedCore

public enum SyncConnectionState: Hashable, Sendable {
    case connecting
    case connected
}

public enum SyncTransportError: Error, Equatable, Sendable {
    case retryable(code: String)
    case terminal(code: String)

    public var code: String {
        switch self {
        case let .retryable(code), let .terminal(code): code
        }
    }
}

public enum SyncAuthenticationFailureDisposition: Equatable, Sendable {
    case signInRequired
    case configurationInvalid
}

/// Exact contract for authentication failures emitted by `convex/lib/access.ts`.
/// Keep this list synchronized with the backend contract test so no new code
/// silently falls through to a generic retry action.
public enum SyncAuthenticationFailureCodeContract {
    public static let signInRequiredCodes: Set<String> = [
        "AUTH_REQUIRED",
        "AUTH_SESSION_REQUIRED",
        "AUTH_SESSION_REVOKED",
    ]
    public static let configurationInvalidCodes: Set<String> = [
        "AUTH_AUDIENCE_REJECTED",
        "AUTH_ISSUER_REJECTED",
        "AUTH_TOKEN_USE_REJECTED",
    ]
    public static let allBackendCodes =
        signInRequiredCodes.union(configurationInvalidCodes)

    public static func disposition(
        for code: String
    ) -> SyncAuthenticationFailureDisposition? {
        if signInRequiredCodes.contains(code) { return .signInRequired }
        if configurationInvalidCodes.contains(code) { return .configurationInvalid }
        return nil
    }
}

public struct EventAcknowledgement: Hashable, Sendable {
    public let eventID: EventID
    public let serverSequence: Int64

    public init(eventID: EventID, serverSequence: Int64) {
        self.eventID = eventID
        self.serverSequence = serverSequence
    }
}

public struct SyncEventPage: Hashable, Sendable {
    public let events: [HydratedWireEventV1]
    public let hasMore: Bool
    public let nextAfterSequence: Int64

    public init(
        events: [HydratedWireEventV1],
        hasMore: Bool,
        nextAfterSequence: Int64
    ) {
        self.events = events
        self.hasMore = hasMore
        self.nextAfterSequence = nextAfterSequence
    }
}

public struct TextRedactionChange: Hashable, Sendable {
    public let eventID: EventID
    public let field: WireTextFieldV1
    public let revision: Int64

    public init(
        eventID: EventID,
        field: WireTextFieldV1,
        revision: Int64
    ) {
        self.eventID = eventID
        self.field = field
        self.revision = revision
    }
}

public struct SyncTextChangePage: Hashable, Sendable {
    public let changes: [TextRedactionChange]
    public let skippedRevisions: [Int64]
    public let hasMore: Bool
    public let nextAfterRevision: Int64

    public init(
        changes: [TextRedactionChange],
        hasMore: Bool,
        nextAfterRevision: Int64,
        skippedRevisions: [Int64] = []
    ) {
        self.changes = changes
        self.skippedRevisions = skippedRevisions
        self.hasMore = hasMore
        self.nextAfterRevision = nextAfterRevision
    }
}

extension SyncTextChangePage {
    func validatedRevisions(after current: Int64) throws -> [Int64] {
        let visible = changes.map(\.revision)
        guard visible == visible.sorted(), skippedRevisions == skippedRevisions.sorted() else {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
        let revisions = (visible + skippedRevisions).sorted()
        var expected = current
        for revision in revisions {
            guard expected < Int64.max, revision == expected + 1 else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            expected = revision
        }
        guard nextAfterRevision == expected, !hasMore || !revisions.isEmpty else {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
        return revisions
    }
}

public struct RemotePotDescriptor: Hashable, Sendable {
    public let configuration: PotConfiguration
    public let currentKnownUnitIDs: [UnitID]
    public let hasInitialUnitBaseline: Bool
    public let memberID: MemberID
    public let role: MemberRole
    public let minimumReaderSchemaVersion: UInt16
    public let lastSequence: Int64
    public let lastTextRevision: Int64

    public init(
        configuration: PotConfiguration,
        memberID: MemberID,
        role: MemberRole,
        minimumReaderSchemaVersion: UInt16,
        lastSequence: Int64,
        lastTextRevision: Int64 = 0,
        currentKnownUnitIDs: [UnitID]? = nil,
        hasInitialUnitBaseline: Bool = true
    ) {
        self.configuration = configuration
        self.currentKnownUnitIDs = currentKnownUnitIDs ?? configuration.orderedUnitIDs
        self.hasInitialUnitBaseline = hasInitialUnitBaseline
        self.memberID = memberID
        self.role = role
        self.minimumReaderSchemaVersion = minimumReaderSchemaVersion
        self.lastSequence = lastSequence
        self.lastTextRevision = lastTextRevision
    }
}

public struct LocalPotPromotionRequest: Hashable, Sendable {
    public let configuration: PotConfiguration
    public let ownerMemberID: MemberID
    public let ownerDisplayName: String
    public let minimumReaderSchemaVersion: UInt16
    public let events: [WireEventV1]
    public let budgetGroupPromotion: BudgetGroupPromotion?

    public init(
        configuration: PotConfiguration,
        ownerMemberID: MemberID,
        ownerDisplayName: String,
        minimumReaderSchemaVersion: UInt16,
        events: [WireEventV1],
        budgetGroupPromotion: BudgetGroupPromotion? = nil
    ) {
        self.configuration = configuration
        self.ownerMemberID = ownerMemberID
        self.ownerDisplayName = ownerDisplayName
        self.minimumReaderSchemaVersion = minimumReaderSchemaVersion
        self.events = events
        self.budgetGroupPromotion = budgetGroupPromotion
    }
}

public struct InviteClaimEventMetadata: Hashable, Sendable {
    public let eventID: EventID
    public let occurredAtMillis: Int64
    public let originatingTimeZone: IANATimeZone
    public let schemaVersion: UInt16

    public init(
        eventID: EventID,
        occurredAtMillis: Int64,
        originatingTimeZone: IANATimeZone,
        schemaVersion: UInt16
    ) {
        self.eventID = eventID
        self.occurredAtMillis = occurredAtMillis
        self.originatingTimeZone = originatingTimeZone
        self.schemaVersion = schemaVersion
    }
}

public enum InviteClaimRequest: Hashable, Sendable {
    case perMember(ticket: String, event: InviteClaimEventMetadata)
    case potLink(ticket: String, chosenMemberID: MemberID?)
}

public enum InviteClaimOutcome: Hashable, Sendable {
    case joined(potID: PotID, memberID: MemberID, serverSequence: Int64)
    case pendingApproval
}

public protocol InviteClaimTransport: Sendable {
    func claimInvite(_ request: InviteClaimRequest) async throws -> InviteClaimOutcome
}

public extension InviteClaimTransport {
    func claimInvite(_ request: InviteClaimRequest) async throws -> InviteClaimOutcome {
        _ = request
        throw SyncTransportError.terminal(code: "INVITES_UNAVAILABLE")
    }
}

public enum InviteAdministrationKind: String, Codable, Hashable, Sendable {
    case perMember
    case potLink
}

/// The only point where raw invite credentials enter the sync layer. Both
/// values are retained by the issuing device only; the server stores digests.
public struct InviteCredentialPair: Hashable, Sendable {
    public let token: String
    public let code: String

    public init?(token: String, code: String) {
        guard (32 ... 512).contains(token.utf8.count),
              token.utf8.allSatisfy({ byte in
                  byte == 45 || byte == 95
                      || (48 ... 57).contains(byte)
                      || (65 ... 90).contains(byte)
                      || (97 ... 122).contains(byte)
              }),
              code.utf8.count == 6,
              code.utf8.allSatisfy({ byte in
                  (48 ... 57).contains(byte) || (65 ... 90).contains(byte)
              })
        else { return nil }
        self.token = token
        self.code = code
    }
}

public struct InviteIssueRequest: Hashable, Sendable {
    public let potID: PotID
    public let inviteID: UUID
    public let kind: InviteAdministrationKind
    public let pendingMemberID: MemberID?
    public let credentials: InviteCredentialPair
    public let expiresAtMillis: Int64

    public init?(
        potID: PotID,
        inviteID: UUID,
        kind: InviteAdministrationKind,
        pendingMemberID: MemberID?,
        credentials: InviteCredentialPair,
        expiresAtMillis: Int64
    ) {
        guard UUIDv7.timestampMilliseconds(of: inviteID) != nil,
              expiresAtMillis > 0,
              expiresAtMillis <= 9_007_199_254_740_991,
              (kind == .perMember) == (pendingMemberID != nil)
        else { return nil }
        self.potID = potID
        self.inviteID = inviteID
        self.kind = kind
        self.pendingMemberID = pendingMemberID
        self.credentials = credentials
        self.expiresAtMillis = expiresAtMillis
    }
}

public struct ManagedInvite: Hashable, Sendable {
    public let inviteID: UUID
    public let kind: InviteAdministrationKind
    public let pendingMemberID: MemberID?
    public let expiresAtMillis: Int64
    public let createdAtMillis: Int64

    public init(
        inviteID: UUID,
        kind: InviteAdministrationKind,
        pendingMemberID: MemberID?,
        expiresAtMillis: Int64,
        createdAtMillis: Int64
    ) {
        self.inviteID = inviteID
        self.kind = kind
        self.pendingMemberID = pendingMemberID
        self.expiresAtMillis = expiresAtMillis
        self.createdAtMillis = createdAtMillis
    }
}

public protocol InviteAdministrationTransport: Sendable {
    func listManagedInvites(potID: PotID) async throws -> [ManagedInvite]
    func issueInvite(_ request: InviteIssueRequest) async throws -> UUID
    func revokeInvite(potID: PotID, inviteID: UUID) async throws
}

public extension InviteAdministrationTransport {
    func listManagedInvites(potID: PotID) async throws -> [ManagedInvite] {
        _ = potID
        throw SyncTransportError.terminal(code: "INVITES_UNAVAILABLE")
    }

    func issueInvite(_ request: InviteIssueRequest) async throws -> UUID {
        _ = request
        throw SyncTransportError.terminal(code: "INVITES_UNAVAILABLE")
    }

    func revokeInvite(potID: PotID, inviteID: UUID) async throws {
        _ = potID
        _ = inviteID
        throw SyncTransportError.terminal(code: "INVITES_UNAVAILABLE")
    }
}

public struct APNsDeviceToken: RawRepresentable, Hashable, Sendable {
    public let hex: String

    public init?(hex: String) {
        let normalized = hex.lowercased()
        guard (64 ... 200).contains(normalized.utf8.count),
              normalized.utf8.count.isMultiple(of: 2),
              normalized.utf8.allSatisfy({ byte in
                  (48 ... 57).contains(byte) || (97 ... 102).contains(byte)
              })
        else { return nil }
        self.hex = normalized
    }

    public init?(rawValue: String) {
        self.init(hex: rawValue)
    }

    public var rawValue: String { hex }
}

public enum PushNotificationEnvironment: String, Hashable, Sendable {
    case sandbox
    case production
}

public struct PushTokenRegistration: Hashable, Sendable {
    public let token: APNsDeviceToken
    public let environment: PushNotificationEnvironment
    public let timeZone: IANATimeZone

    public init(
        token: APNsDeviceToken,
        environment: PushNotificationEnvironment,
        timeZone: IANATimeZone
    ) {
        self.token = token
        self.environment = environment
        self.timeZone = timeZone
    }
}

public protocol PushNotificationTransport: Sendable {
    func registerPushToken(_ registration: PushTokenRegistration) async throws
    func unregisterPushToken(_ token: APNsDeviceToken) async throws
    func getPotMute(potID: PotID) async throws -> Bool
    func setPotMute(potID: PotID, muted: Bool) async throws -> Bool
}

public extension PushNotificationTransport {
    func registerPushToken(_ registration: PushTokenRegistration) async throws {
        _ = registration
        throw SyncTransportError.terminal(code: "PUSH_NOTIFICATIONS_UNAVAILABLE")
    }

    func unregisterPushToken(_ token: APNsDeviceToken) async throws {
        _ = token
        throw SyncTransportError.terminal(code: "PUSH_NOTIFICATIONS_UNAVAILABLE")
    }

    func getPotMute(potID: PotID) async throws -> Bool {
        _ = potID
        throw SyncTransportError.terminal(code: "PUSH_NOTIFICATIONS_UNAVAILABLE")
    }

    func setPotMute(potID: PotID, muted: Bool) async throws -> Bool {
        _ = potID
        _ = muted
        throw SyncTransportError.terminal(code: "PUSH_NOTIFICATIONS_UNAVAILABLE")
    }
}

public struct PendingInviteClaimID: RawRepresentable, Hashable, Sendable {
    public let rawValue: String

    public init?(_ rawValue: String) {
        guard (8 ... 128).contains(rawValue.utf8.count),
              rawValue.utf8.allSatisfy({ byte in
                  byte == 45 || byte == 95
                      || (48 ... 57).contains(byte)
                      || (65 ... 90).contains(byte)
                      || (97 ... 122).contains(byte)
              })
        else { return nil }
        self.rawValue = rawValue
    }

    public init?(rawValue: String) {
        self.init(rawValue)
    }
}

public struct PendingInviteClaim: Hashable, Sendable {
    public let id: PendingInviteClaimID
    public let inviteID: UUID
    public let chosenMemberID: MemberID?
    public let createdAtMillis: Int64

    public init(
        id: PendingInviteClaimID,
        inviteID: UUID,
        chosenMemberID: MemberID?,
        createdAtMillis: Int64
    ) {
        self.id = id
        self.inviteID = inviteID
        self.chosenMemberID = chosenMemberID
        self.createdAtMillis = createdAtMillis
    }
}

public struct PendingInviteClaimApproval: Hashable, Sendable {
    public let claimID: PendingInviteClaimID
    public let event: WireEventV1

    public init(claimID: PendingInviteClaimID, event: WireEventV1) {
        self.claimID = claimID
        self.event = event
    }
}

public enum PotMemberState: String, Decodable, Hashable, Sendable {
    case pending
    case active
    case archived
}

public struct PotMemberProfile: Hashable, Sendable {
    public let memberID: MemberID
    public let unitID: UnitID?
    public let budgetUnitID: UnitID?
    public let displayName: String?
    public let role: MemberRole
    public let state: PotMemberState

    public init(
        memberID: MemberID,
        unitID: UnitID?,
        displayName: String?,
        role: MemberRole,
        state: PotMemberState,
        budgetUnitID: UnitID? = nil
    ) {
        self.memberID = memberID
        self.unitID = unitID
        self.budgetUnitID = budgetUnitID
        self.displayName = displayName
        self.role = role
        self.state = state
    }
}

public struct PendingMemberAddition: Hashable, Sendable {
    public let displayName: String
    public let event: WireEventV1

    public init(displayName: String, event: WireEventV1) {
        self.displayName = displayName
        self.event = event
    }
}

public struct PotLeaveRequest: Hashable, Sendable {
    public let archiveEvent: WireEventV1
    public let transferEventID: EventID

    public init(archiveEvent: WireEventV1, transferEventID: EventID) {
        self.archiveEvent = archiveEvent
        self.transferEventID = transferEventID
    }
}

public struct PotLeaveAcknowledgement: Hashable, Sendable {
    public let archive: EventAcknowledgement
    public let ownershipTransfer: EventAcknowledgement?
    public let successorMemberID: MemberID?

    public init(
        archive: EventAcknowledgement,
        ownershipTransfer: EventAcknowledgement?,
        successorMemberID: MemberID?
    ) {
        self.archive = archive
        self.ownershipTransfer = ownershipTransfer
        self.successorMemberID = successorMemberID
    }
}

public protocol MemberAdministrationTransport: Sendable {
    func listMemberRoster(potID: PotID) async throws -> [PotMemberProfile]
    func bindOwnerUnit(_ event: WireEventV1) async throws -> EventAcknowledgement
    func bindPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement
    func renamePot(_ event: WireEventV1) async throws -> EventAcknowledgement
    func addPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement
    func anonymizePendingMember(
        potID: PotID,
        memberID: MemberID
    ) async throws
    func listPendingInviteClaims(
        potID: PotID
    ) async throws -> [PendingInviteClaim]
    func approvePendingInviteClaim(
        _ request: PendingInviteClaimApproval
    ) async throws -> EventAcknowledgement
    func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws
    func reassignMemberClaim(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement
    func archiveMember(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement
    func leavePot(
        _ request: PotLeaveRequest
    ) async throws -> PotLeaveAcknowledgement
    func transferOwnership(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement
}

public extension MemberAdministrationTransport {
    func listMemberRoster(potID: PotID) async throws -> [PotMemberProfile] {
        _ = potID
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func bindOwnerUnit(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        _ = event
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func bindPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        _ = request
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func renamePot(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        _ = event
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func addPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        _ = request
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func anonymizePendingMember(
        potID: PotID,
        memberID: MemberID
    ) async throws {
        _ = potID
        _ = memberID
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func listPendingInviteClaims(
        potID: PotID
    ) async throws -> [PendingInviteClaim] {
        _ = potID
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func approvePendingInviteClaim(
        _ request: PendingInviteClaimApproval
    ) async throws -> EventAcknowledgement {
        _ = request
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws {
        _ = claimID
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func reassignMemberClaim(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        _ = event
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func archiveMember(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        _ = event
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func leavePot(
        _ request: PotLeaveRequest
    ) async throws -> PotLeaveAcknowledgement {
        _ = request
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }

    func transferOwnership(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        _ = event
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }
}

public protocol SyncTransport: Sendable {
    func connectionStates() async -> AsyncStream<SyncConnectionState>
    func listPots() async throws -> [RemotePotDescriptor]
    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement]
    func changeBudgetGroups(_ event: WireEventV1, expectedTopologyRevision: Int64) async throws -> EventAcknowledgement
    func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement]
    func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage
    func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage
}

public extension SyncTransport {
    func changeBudgetGroups(_ event: WireEventV1, expectedTopologyRevision: Int64) async throws -> EventAcknowledgement {
        throw SyncTransportError.terminal(code: "MEMBER_ADMIN_UNAVAILABLE")
    }
}
