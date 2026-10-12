import ConvexMobile
import Foundation
import NumaSharedCore
import NumaSharedSync

nonisolated struct NumaSyncConfiguration: Equatable, Sendable {
    let deploymentURL: URL
    let siteURL: URL

    @MainActor
    static func bundled(_ bundle: Bundle = .main) -> NumaSyncConfiguration? {
        guard let deployment = bundle.object(
            forInfoDictionaryKey: "NumaSharedConvexURL"
        ) as? String,
              let site = bundle.object(
                forInfoDictionaryKey: "NumaSharedSiteURL"
              ) as? String,
              let deploymentURL = validatedHTTPSURL(deployment),
              let siteURL = validatedHTTPSURL(site)
        else { return nil }
        return NumaSyncConfiguration(
            deploymentURL: deploymentURL,
            siteURL: siteURL
        )
    }

    private static func validatedHTTPSURL(_ value: String) -> URL? {
        guard let url = URL(string: value),
              url.scheme == "https",
              url.host?.isEmpty == false,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil
        else { return nil }
        return url
    }
}

nonisolated enum SyncPresentation: Equatable, Sendable {
    case local
    case signingIn
    case offline(pendingCount: Int)
    case syncing(pendingCount: Int)
    case paused(pendingCount: Int, code: String)
    case synced

    nonisolated enum Action: Equatable, Sendable {
        case none
        case enableSync
        case signIn
        case retry
    }

    nonisolated enum PauseDisposition: Equatable, Sendable {
        case updateRequired
        case signInRequired
        case configurationInvalid
        case accessRemoved
        case terminal
    }

    var title: String {
        switch self {
        case .local: String(localized: "Enable sync")
        case .signingIn: String(localized: "Connecting")
        case .offline: String(localized: "Offline")
        case .syncing: String(localized: "Syncing")
        case let .paused(_, code):
            switch Self.pauseDisposition(for: code) {
            case .updateRequired: String(localized: "Update required")
            case .signInRequired: String(localized: "Sign in required")
            case .configurationInvalid: String(localized: "Sync setup issue")
            case .accessRemoved: String(localized: "Access changed")
            case .terminal: String(localized: "Sync paused")
            }
        case .synced: String(localized: "Synced")
        }
    }

    var detail: String? {
        let count: Int
        switch self {
        case let .offline(pending), let .syncing(pending), let .paused(pending, _):
            count = pending
        case .local, .signingIn, .synced:
            return nil
        }
        guard count > 0 else { return nil }
        if count == 1 { return String(localized: "1 record waiting") }
        return localizedFormat("%lld records waiting", Int64(count))
    }

    var isSyncEnabled: Bool {
        if case .local = self { return false }
        return true
    }

    var dismissesAutomatically: Bool {
        if case .synced = self { return true }
        return false
    }

    var action: Action {
        switch self {
        case .local:
            .enableSync
        case .offline:
            .retry
        case let .paused(_, code)
            where Self.pauseDisposition(for: code) == .signInRequired:
            .signIn
        case let .paused(_, code)
            where Self.pauseDisposition(for: code) == .terminal:
            .retry
        case .signingIn, .syncing, .paused, .synced:
            .none
        }
    }

    var actionTitle: String? {
        if action == .retry { return String(localized: "Retry") }
        return nil
    }

    var pauseDisposition: PauseDisposition? {
        guard case let .paused(_, code) = self else { return nil }
        return Self.pauseDisposition(for: code)
    }

    private static func pauseDisposition(for code: String) -> PauseDisposition {
        if let authentication = SyncAuthenticationFailureCodeContract
            .disposition(for: code) {
            switch authentication {
            case .signInRequired:
                return .signInRequired
            case .configurationInvalid:
                return .configurationInvalid
            }
        }
        return switch code {
        case "READER_UPDATE_REQUIRED", "UNSUPPORTED_READER_SCHEMA",
             "UNSUPPORTED_EVENT_KIND", "UNSUPPORTED_WIRE_EVENT":
            .updateRequired
        case "ACCOUNT_IDENTITY_MISMATCH", "INVALID_ACCOUNT_ID",
             "SESSION_REVOKED",
             "REFRESH_TOKEN_EXPIRED", "REFRESH_TOKEN_INVALID",
             "REFRESH_TOKEN_REUSED":
            .signInRequired
        case "NOT_MEMBER", "MEMBERSHIP_ARCHIVED", "POT_MEMBERSHIP_REQUIRED":
            .accessRemoved
        default:
            .terminal
        }
    }
}

@MainActor
protocol NumaAuthenticatedSyncClient:
    SyncTransport,
    InviteClaimTransport,
    InviteAdministrationTransport,
    MemberAdministrationTransport,
    PushNotificationTransport
{
    func login() async -> Result<NumaSession, any Error>
    func loginFromCache() async -> Result<NumaSession, any Error>
    func logout() async
}

extension SerializedAuthenticatedConvexClient: NumaAuthenticatedSyncClient
where AuthResult == NumaSession {}

@MainActor
final class AppSyncRuntime {
    typealias UpdateHandler = @MainActor (
        SyncPresentation,
        SyncRunReport?,
        AppLedgerSnapshot?,
        String?
    ) -> Void

    private let repository: AppLedgerRepository
    private var context: AppLedgerSyncContext
    private let authProvider: NumaAuthProvider
    private let client: any NumaAuthenticatedSyncClient
    private let coordinator: SyncCoordinator
    private let healthyPollingIntervalMilliseconds: Int
    private let retryPollingBaseDelayMilliseconds: Int
    private var pollTask: Task<Void, Never>?
    private var needsPromotion = true
    private var lastReport: SyncRunReport?
    private var lastErrorCode: String?
    private var lastPresentation: SyncPresentation = .local
    private var lastAccountID: String?
    private var pendingAccountID: String?
    private var didResolvePotSelection = false
    private var pendingPerMemberClaim: (
        ticket: String,
        metadata: InviteClaimEventMetadata
    )?
    private enum PendingMemberAdministrationKey: Hashable {
        case approve(PendingInviteClaimID, MemberID)
        case reassign(MemberID)
        case archive(MemberID)
        case leave(MemberID)
        case transfer(MemberID)
    }
    private var pendingMemberAdministrationEvents: [
        PendingMemberAdministrationKey: WireEventV1
    ] = [:]
    private var pendingPotLeaveTransferEventID: EventID?
    private enum PendingInviteIssueKey: Hashable {
        case perMember(MemberID)
        case potLink
    }
    private var pendingInviteIssues: [
        PendingInviteIssueKey: InviteIssueRequest
    ] = [:]
    private var registeredPushToken: PushTokenRegistration?
    private var consecutiveRetryableFailures = 0
    private var automaticPollingEnabled = false
    var onUpdate: UpdateHandler?

    init(
        configuration: NumaSyncConfiguration,
        repository: AppLedgerRepository,
        refreshTokens: any RefreshTokenStoring = KeychainRefreshTokenStore()
    ) async throws {
        self.repository = repository
        context = try await repository.syncContext()
        let server = NumaSessionHTTPClient(siteURL: configuration.siteURL)
        authProvider = NumaAuthProvider(
            server: server,
            refreshTokens: refreshTokens
        )
        let client = SerializedAuthenticatedConvexClient(
            deploymentURL: configuration.deploymentURL,
            authProvider: authProvider
        )
        self.client = client
        coordinator = SyncCoordinator(
            store: context.store,
            transport: client
        )
        healthyPollingIntervalMilliseconds = 2_000
        retryPollingBaseDelayMilliseconds = 1_000
        authProvider.setSessionValidator { [repository] session in
            guard let accountID = Self.normalizedAccountID(session.accountID) else {
                throw AppLedgerRepositoryError.invalidAccountIdentifier
            }
            try await repository.validateAccountBinding(accountID)
        }
        await coordinator.startConnectionMonitoring()
    }

#if DEBUG
    init(
        repository: AppLedgerRepository,
        authProvider: NumaAuthProvider,
        client: any NumaAuthenticatedSyncClient,
        healthyPollingIntervalMilliseconds: Int = 2_000,
        retryPollingBaseDelayMilliseconds: Int = 1_000
    ) async throws {
        precondition((1..<5_000).contains(healthyPollingIntervalMilliseconds))
        precondition(retryPollingBaseDelayMilliseconds > 0)
        self.repository = repository
        context = try await repository.syncContext()
        self.authProvider = authProvider
        self.client = client
        coordinator = SyncCoordinator(
            store: context.store,
            transport: client
        )
        self.healthyPollingIntervalMilliseconds = healthyPollingIntervalMilliseconds
        self.retryPollingBaseDelayMilliseconds = retryPollingBaseDelayMilliseconds
        authProvider.setSessionValidator { [repository] session in
            guard let accountID = Self.normalizedAccountID(session.accountID) else {
                throw AppLedgerRepositoryError.invalidAccountIdentifier
            }
            try await repository.validateAccountBinding(accountID)
        }
        await coordinator.startConnectionMonitoring()
    }
#endif

    deinit {
        pollTask?.cancel()
    }

    func isBound(to repository: AppLedgerRepository) -> Bool {
        self.repository === repository
    }

    func retire() {
        stopAutomaticPolling()
        onUpdate = nil
    }

    func restoreCachedSession() async {
        guard await authProvider.hasCachedSession() else { return }
        publish(.signingIn)
        switch await client.loginFromCache() {
        case let .success(session):
            await finishAuthentication(session, invalidPresentation: .local)
        case let .failure(error):
            let code = Self.errorCode(error)
            if Self.isRetryable(error) {
                recordRetryableFailure()
                publish(
                    .offline(pendingCount: pendingCount()),
                    errorCode: code
                )
                startPolling()
            } else {
                publish(
                    .paused(pendingCount: pendingCount(), code: code),
                    errorCode: code
                )
                stopAutomaticPolling()
            }
        }
    }

    func login(with credential: NumaAppleCredential) async {
        authProvider.prepareAppleLogin(credential)
        publish(.signingIn)
        switch await client.login() {
        case let .success(session):
            await finishAuthentication(session, invalidPresentation: .local)
        case let .failure(error):
            if let repositoryError = error as? AppLedgerRepositoryError {
                switch repositoryError {
                case .accountIdentityMismatch, .invalidAccountIdentifier:
                    publish(
                        Self.failurePresentation(error, pendingCount: pendingCount()),
                        errorCode: Self.errorCode(error)
                    )
                    return
                default:
                    break
                }
            }
            publish(.local, errorCode: Self.errorCode(error))
        }
    }

    /// Authenticates an invite claimant without resolving or promoting the
    /// current local pot. The invite must be claimed first so a clean Join
    /// path cannot create an unrelated server pot as a side effect of login.
    func loginForInvite(with credential: NumaAppleCredential) async -> Bool {
        stopAutomaticPolling()
        lastAccountID = nil
        pendingAccountID = nil
        didResolvePotSelection = false
        authProvider.prepareAppleLogin(credential)
        publish(.signingIn)
        switch await client.login() {
        case let .success(session):
            guard let accountID = Self.normalizedAccountID(session.accountID) else {
                await client.logout()
                publish(.local, errorCode: "INVALID_SERVER_RESPONSE")
                return false
            }
            lastAccountID = accountID
            pendingAccountID = accountID
            didResolvePotSelection = false
            lastErrorCode = nil
            return true
        case let .failure(error):
            publish(
                Self.failurePresentation(error, pendingCount: pendingCount()),
                errorCode: Self.errorCode(error)
            )
            return false
        }
    }

    func claimInvite(
        ticket: String,
        kind: InviteKind,
        now: Date = Date(),
        timeZone: IANATimeZone,
        targetSchemaVersion: UInt16? = nil
    ) async throws -> InviteClaimOutcome {
        guard let accountID = lastAccountID else {
            throw SyncTransportError.terminal(code: "AUTH_SESSION_REQUIRED")
        }
        let request: InviteClaimRequest
        switch kind {
        case .perMember:
            guard let targetSchemaVersion, (1...context.store.readerSchemaVersion).contains(targetSchemaVersion) else {
                throw SyncTransportError.terminal(code: "INVITE_READER_UPDATE_REQUIRED")
            }
            let metadata: InviteClaimEventMetadata
            if let pendingPerMemberClaim,
               pendingPerMemberClaim.ticket == ticket {
                metadata = pendingPerMemberClaim.metadata
            } else {
                let milliseconds = now.timeIntervalSince1970 * 1_000
                guard milliseconds.isFinite,
                      milliseconds >= 0,
                      milliseconds <= Double(Int64.max)
                else {
                    throw SyncTransportError.terminal(
                        code: "INVALID_INVITE_CLAIM_REQUEST"
                    )
                }
                metadata = InviteClaimEventMetadata(
                    eventID: EventID.generate(at: now),
                    occurredAtMillis: Int64(milliseconds.rounded(.down)),
                    originatingTimeZone: timeZone,
                    schemaVersion: targetSchemaVersion
                )
                pendingPerMemberClaim = (ticket, metadata)
            }
            request = .perMember(
                ticket: ticket,
                event: metadata
            )
        case .potLink:
            request = .potLink(ticket: ticket, chosenMemberID: nil)
        }

        let outcome: InviteClaimOutcome
        do {
            outcome = try await client.claimInvite(request)
        } catch {
            lastErrorCode = Self.errorCode(error)
            throw error
        }
        switch outcome {
        case let .joined(potID, memberID, _):
            let matching = try await client.listPots().filter {
                $0.configuration.id == potID
            }
            guard matching.count == 1,
                  let descriptor = matching.first,
                  descriptor.memberID == memberID
            else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            context = try await repository.activateRemotePot(
                descriptor,
                accountID: accountID
            )
            pendingAccountID = accountID
            didResolvePotSelection = true
            needsPromotion = false
            lastErrorCode = nil
            if pendingPerMemberClaim?.ticket == ticket {
                pendingPerMemberClaim = nil
            }
            await runSync()
            if permitsAutomaticPolling { startPolling() }
        case .pendingApproval:
            publish(.local)
            stopAutomaticPolling()
        }
        return outcome
    }

#if DEBUG
    func loginE2E(accountKey: String, bootstrapSecret: String) async {
        lastAccountID = nil
        pendingAccountID = nil
        didResolvePotSelection = false
        authProvider.prepareE2ELogin(
            accountKey: accountKey,
            bootstrapSecret: bootstrapSecret
        )
        publish(.signingIn)
        switch await client.login() {
        case let .success(session):
            await finishAuthentication(
                session,
                invalidPresentation: .offline(pendingCount: pendingCount())
            )
        case let .failure(error):
            publish(
                Self.failurePresentation(error, pendingCount: pendingCount()),
                errorCode: Self.errorCode(error)
            )
        }
    }

    func loginE2EForInvite(
        accountKey: String,
        bootstrapSecret: String
    ) async -> Bool {
        stopAutomaticPolling()
        lastAccountID = nil
        pendingAccountID = nil
        didResolvePotSelection = false
        authProvider.prepareE2ELogin(
            accountKey: accountKey,
            bootstrapSecret: bootstrapSecret
        )
        publish(.signingIn)
        switch await client.login() {
        case let .success(session):
            guard let accountID = Self.normalizedAccountID(session.accountID) else {
                await client.logout()
                publish(.local, errorCode: "INVALID_SERVER_RESPONSE")
                return false
            }
            lastAccountID = accountID
            pendingAccountID = accountID
            lastErrorCode = nil
            publish(.local)
            return true
        case let .failure(error):
            publish(
                Self.failurePresentation(error, pendingCount: pendingCount()),
                errorCode: Self.errorCode(error)
            )
            return false
        }
    }

    func assertE2EPendingAccessDenied(to potID: PotID) async throws {
        guard lastAccountID != nil else {
            throw SyncTransportError.terminal(code: "AUTH_SESSION_REQUIRED")
        }
        let visiblePots = try await client.listPots()
        guard !visiblePots.contains(where: { $0.configuration.id == potID }) else {
            throw SyncTransportError.terminal(code: "E2E_PENDING_POT_VISIBLE")
        }
        do {
            _ = try await client.listEvents(potID: potID, afterSequence: 0)
            throw SyncTransportError.terminal(code: "E2E_PENDING_READ_ALLOWED")
        } catch let error as SyncTransportError {
            guard error.code == "NOT_MEMBER" else { throw error }
        }
        do {
            _ = try await client.appendEvents(potID: potID, events: [])
            throw SyncTransportError.terminal(code: "E2E_PENDING_WRITE_ALLOWED")
        } catch let error as SyncTransportError {
            guard error.code == "NOT_MEMBER" else { throw error }
        }
    }
#endif

    private func finishAuthentication(
        _ session: NumaSession,
        invalidPresentation: SyncPresentation
    ) async {
        lastAccountID = nil
        pendingAccountID = nil
        didResolvePotSelection = false
        guard let accountID = Self.normalizedAccountID(session.accountID) else {
            await client.logout()
            publish(invalidPresentation, errorCode: "INVALID_SERVER_RESPONSE")
            return
        }
        await didAuthenticate(session, accountID: accountID)
    }

    func synchronizeNow(userInitiated: Bool = false) async {
        if lastAccountID == nil {
            if userInitiated, await authProvider.hasCachedSession() {
                await restoreCachedSession()
            }
            return
        }
        if userInitiated {
            _ = try? context.store.makeRetryEligible(potID: context.configuration.id)
        }
        await runSync()
        if permitsAutomaticPolling { startPolling() }
    }

    func refreshMemberAdministration() async throws -> [PendingInviteClaim] {
        try requireAuthenticatedPot()
        let roster = try await client.listMemberRoster(
            potID: context.configuration.id
        )
        let snapshot = try await repository.replaceAuthoritativeMemberRoster(roster)
        publish(
            lastPresentation,
            report: lastReport,
            snapshot: snapshot,
            errorCode: lastErrorCode
        )
        guard snapshot.currentMemberProfile?.role == .owner,
              snapshot.currentMemberProfile?.state == .active
        else { return [] }
        return try await client.listPendingInviteClaims(
            potID: context.configuration.id
        )
    }

    func listManagedInvites() async throws -> [ManagedInvite] {
        _ = try await requireCurrentOwnerMemberID()
        return try await client.listManagedInvites(
            potID: context.configuration.id
        )
    }

    /// Retains the full request until the server confirms the exact UUID. A
    /// timeout can therefore retry without issuing a second live credential.
    func issueInvite(
        kind: InviteAdministrationKind,
        pendingMemberID: MemberID?,
        credentials: InviteCredentialPair,
        now: Date = Date()
    ) async throws -> InviteIssueRequest {
        _ = try await requireCurrentOwnerMemberID()
        let key: PendingInviteIssueKey
        switch (kind, pendingMemberID) {
        case let (.perMember, memberID?):
            key = .perMember(memberID)
        case (.potLink, nil):
            key = .potLink
        case (.perMember, nil), (.potLink, _?):
            throw SyncTransportError.terminal(
                code: "INVALID_INVITE_ADMIN_REQUEST"
            )
        }
        let request: InviteIssueRequest
        if let pending = pendingInviteIssues[key] {
            request = pending
        } else {
            let expiresAt = now.addingTimeInterval(30 * 24 * 60 * 60)
                .timeIntervalSince1970 * 1_000
            guard expiresAt.isFinite,
                  expiresAt > 0,
                  expiresAt <= 9_007_199_254_740_991,
                  let created = InviteIssueRequest(
                    potID: context.configuration.id,
                    inviteID: UUIDv7.generate(at: now),
                    kind: kind,
                    pendingMemberID: pendingMemberID,
                    credentials: credentials,
                    expiresAtMillis: Int64(expiresAt.rounded(.down))
                  )
            else {
                throw SyncTransportError.terminal(
                    code: "INVALID_INVITE_ADMIN_REQUEST"
                )
            }
            pendingInviteIssues[key] = created
            request = created
        }
        let confirmedID = try await client.issueInvite(request)
        guard confirmedID == request.inviteID else {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
        pendingInviteIssues[key] = nil
        return request
    }

    func discardPendingInviteIssue(
        kind: InviteAdministrationKind,
        pendingMemberID: MemberID?
    ) {
        switch (kind, pendingMemberID) {
        case let (.perMember, memberID?):
            pendingInviteIssues[.perMember(memberID)] = nil
        case (.potLink, nil):
            pendingInviteIssues[.potLink] = nil
        case (.perMember, nil), (.potLink, _?):
            break
        }
    }

    func revokeInvite(_ inviteID: UUID) async throws -> [ManagedInvite] {
        _ = try await requireCurrentOwnerMemberID()
        try await client.revokeInvite(
            potID: context.configuration.id,
            inviteID: inviteID
        )
        return try await client.listManagedInvites(
            potID: context.configuration.id
        )
    }

    func registerPushToken(
        _ registration: PushTokenRegistration
    ) async throws {
        try requireAuthenticatedPot()
        guard registeredPushToken != registration else { return }
        try await client.registerPushToken(registration)
        registeredPushToken = registration
    }

    func unregisterPushToken(_ token: APNsDeviceToken) async throws {
        guard lastAccountID != nil else {
            throw SyncTransportError.terminal(code: "AUTH_SESSION_REQUIRED")
        }
        try await client.unregisterPushToken(token)
        if registeredPushToken?.token == token {
            registeredPushToken = nil
        }
    }

    func signOut(unregistering token: APNsDeviceToken?) async throws {
        stopAutomaticPolling()
        do {
            if let token, lastAccountID != nil {
                try await client.unregisterPushToken(token)
            }
            try await authProvider.logout()
            await client.logout()
            resetAfterSessionEnd()
        } catch {
            if lastAccountID != nil { startPolling() }
            throw error
        }
    }

    func accountDeletionPreview() async throws -> NumaAccountDeletionPreview {
        guard lastAccountID != nil else {
            throw SyncTransportError.terminal(code: "AUTH_SESSION_REQUIRED")
        }
        return try await authProvider.accountDeletionPreview()
    }

    func appConfiguration() async throws -> NumaAppConfiguration {
        try await authProvider.appConfiguration()
    }

    func deleteAccount(requestID: UUID, originatingTimeZone: IANATimeZone) async throws {
        pollTask?.cancel()
        pollTask = nil
        do {
            try await authProvider.deleteAccount(
                requestID: requestID.uuidString.lowercased(),
                originatingTimeZone: originatingTimeZone.identifier
            )
            resetAfterSessionEnd()
        } catch {
            stopAutomaticPolling()
            throw error
        }
    }

    func clearAccountDeletionCredential() async throws {
        try await authProvider.clearAccountDeletionCredential()
        resetAfterSessionEnd()
    }

    private func resetAfterSessionEnd() {
        registeredPushToken = nil
        lastAccountID = nil
        pendingAccountID = nil
        lastReport = nil
        lastErrorCode = nil
        lastPresentation = .local
        needsPromotion = true
        didResolvePotSelection = false
    }

    func getPotMute() async throws -> Bool {
        try requireAuthenticatedPot()
        return try await client.getPotMute(
            potID: context.configuration.id
        )
    }

    func setPotMute(_ muted: Bool) async throws -> Bool {
        try requireAuthenticatedPot()
        return try await client.setPotMute(
            potID: context.configuration.id,
            muted: muted
        )
    }

    func openNotificationPot(_ potID: PotID) async throws -> AppLedgerSnapshot {
        try requireAuthenticatedPot()
        guard let accountID = lastAccountID else {
            throw SyncTransportError.terminal(code: "AUTH_SESSION_REQUIRED")
        }
        let matching = try await coordinator.registerRemotePots().filter {
            $0.configuration.id == potID
        }
        guard matching.count == 1, let descriptor = matching.first else {
            throw SyncTransportError.terminal(code: "NOT_MEMBER")
        }
        if context.configuration.id != potID {
            context = try await repository.activateRemotePot(
                descriptor,
                accountID: accountID
            )
            pendingAccountID = accountID
            didResolvePotSelection = true
            needsPromotion = false
        }
        await runSync()
        return try await repository.refreshSnapshot()
    }

    func approvePendingInviteClaim(
        _ claimID: PendingInviteClaimID,
        memberID: MemberID,
        now: Date = Date()
    ) async throws -> [PendingInviteClaim] {
        _ = try await requireCurrentOwnerMemberID()
        let key = PendingMemberAdministrationKey.approve(claimID, memberID)
        let event = try memberAdministrationEvent(
            for: key,
            actorMemberID: memberID,
            payload: .memberClaimed(MemberClaimedPayload(memberID: memberID)),
            now: now
        )
        let acknowledgement = try await client.approvePendingInviteClaim(
            PendingInviteClaimApproval(claimID: claimID, event: event)
        )
        return try await finishMemberAdministrationEvent(
            key: key,
            event: event,
            acknowledgement: acknowledgement
        )
    }

    func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws -> [PendingInviteClaim] {
        _ = try await requireCurrentOwnerMemberID()
        try await client.rejectPendingInviteClaim(claimID)
        return try await refreshMemberAdministration()
    }

    func reassignMemberClaim(
        _ memberID: MemberID,
        now: Date = Date()
    ) async throws -> [PendingInviteClaim] {
        let ownerMemberID = try await requireCurrentOwnerMemberID()
        let key = PendingMemberAdministrationKey.reassign(memberID)
        let event = try memberAdministrationEvent(
            for: key,
            actorMemberID: ownerMemberID,
            payload: .memberClaimReassigned(MemberClaimReassignedPayload(
                memberID: memberID
            )),
            now: now
        )
        let acknowledgement = try await client.reassignMemberClaim(event)
        return try await finishMemberAdministrationEvent(
            key: key,
            event: event,
            acknowledgement: acknowledgement
        )
    }

    func archiveMember(
        _ memberID: MemberID,
        now: Date = Date()
    ) async throws -> [PendingInviteClaim] {
        let ownerMemberID = try await requireCurrentOwnerMemberID()
        let key = PendingMemberAdministrationKey.archive(memberID)
        let event = try memberAdministrationEvent(
            for: key,
            actorMemberID: ownerMemberID,
            payload: .memberArchived(MemberArchivedPayload(memberID: memberID)),
            now: now
        )
        let acknowledgement = try await client.archiveMember(event)
        return try await finishMemberAdministrationEvent(
            key: key,
            event: event,
            acknowledgement: acknowledgement
        )
    }

    func leaveCurrentPot(now: Date = Date()) async throws {
        let memberID = try await requireCurrentActiveMemberID()
        let key = PendingMemberAdministrationKey.leave(memberID)
        let archiveEvent = try memberAdministrationEvent(
            for: key,
            actorMemberID: memberID,
            payload: .memberArchived(MemberArchivedPayload(memberID: memberID)),
            now: now
        )
        let transferEventID: EventID
        if let pendingPotLeaveTransferEventID {
            transferEventID = pendingPotLeaveTransferEventID
        } else {
            transferEventID = EventID.generate(at: now)
            pendingPotLeaveTransferEventID = transferEventID
        }
        let acknowledgement = try await client.leavePot(
            PotLeaveRequest(
                archiveEvent: archiveEvent,
                transferEventID: transferEventID
            )
        )
        try Self.validateSetupAcknowledgement(
            acknowledgement.archive,
            eventID: archiveEvent.eventId
        )
        if let transfer = acknowledgement.ownershipTransfer {
            try Self.validateSetupAcknowledgement(
                transfer,
                eventID: transferEventID
            )
            guard acknowledgement.successorMemberID != nil,
                  transfer.serverSequence == acknowledgement.archive.serverSequence - 1
            else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
        } else if acknowledgement.successorMemberID != nil {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
        await runSync()
        let snapshot = try await repository.refreshSnapshot()
        guard snapshot.currentMemberProfile?.state == .archived else {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
        pendingMemberAdministrationEvents[key] = nil
        pendingPotLeaveTransferEventID = nil
    }

    func transferOwnership(
        to memberID: MemberID,
        now: Date = Date()
    ) async throws -> [PendingInviteClaim] {
        let ownerMemberID = try await requireCurrentOwnerMemberID()
        let key = PendingMemberAdministrationKey.transfer(memberID)
        let event = try memberAdministrationEvent(
            for: key,
            actorMemberID: ownerMemberID,
            payload: .ownershipTransferred(OwnershipTransferredPayload(
                fromMemberID: ownerMemberID,
                toMemberID: memberID
            )),
            now: now
        )
        let acknowledgement = try await client.transferOwnership(event)
        return try await finishMemberAdministrationEvent(
            key: key,
            event: event,
            acknowledgement: acknowledgement
        )
    }

    func anonymizePendingMember(
        _ memberID: MemberID
    ) async throws -> [PendingInviteClaim] {
        _ = try await requireCurrentOwnerMemberID()
        try await client.anonymizePendingMember(
            potID: context.configuration.id,
            memberID: memberID
        )
        return try await refreshMemberAdministration()
    }

    func diagnosticState() -> (
        presentation: SyncPresentation,
        report: SyncRunReport?,
        errorCode: String?,
        accountID: String?,
        automaticallyPolling: Bool
    ) {
        (
            lastPresentation,
            lastReport,
            lastErrorCode,
            lastAccountID,
            automaticPollingEnabled
        )
    }

    private func didAuthenticate(
        _ session: NumaSession,
        accountID: String
    ) async {
        _ = session
        pendingAccountID = accountID
        didResolvePotSelection = false
        do {
            try await repository.validateAccountBinding(accountID)
            lastAccountID = accountID
            if requiresReaderUpdate {
                await publishReaderUpdateRequired()
                return
            }
            try await resolvePotSelection()
            lastErrorCode = nil
            await runSync()
        } catch {
            lastErrorCode = Self.errorCode(error)
            if Self.isRetryable(error) { recordRetryableFailure() }
            do {
                let snapshot = try await repository.refreshSnapshot()
                publish(
                    Self.failurePresentation(
                        error,
                        pendingCount: pendingCount()
                    ),
                    snapshot: snapshot,
                    errorCode: lastErrorCode
                )
            } catch {
                let code = "LOCAL_PERSISTENCE_FAILURE"
                lastErrorCode = code
                publish(
                    .paused(pendingCount: pendingCount(), code: code),
                    errorCode: code
                )
                stopAutomaticPolling()
                return
            }
            if Self.isRetryable(error) {
                startPolling()
            } else {
                stopAutomaticPolling()
            }
            return
        }
        if permitsAutomaticPolling { startPolling() }
    }

    private func resolvePotSelection() async throws {
        guard !didResolvePotSelection else { return }
        guard let accountID = pendingAccountID else {
            throw AppLedgerRepositoryError.invalidAccountIdentifier
        }
        try await repository.validateAccountBinding(accountID)
        let remotePots = try await coordinator.registerRemotePots()
        let localEventCount = try context.store.loadStoredEvents(
            for: context.configuration.id
        ).count
        switch SyncPotSelection.decide(
            localPotID: context.configuration.id,
            localEventCount: localEventCount,
            remotePots: remotePots
        ) {
        case let .useLocal(promotion):
            needsPromotion = promotion
            context = try await repository.bindActiveIdentity(
                to: accountID,
                minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
            )
        case let .adoptRemote(remote):
            context = try await repository.activateRemotePot(
                remote,
                accountID: accountID
            )
            needsPromotion = false
        }
        didResolvePotSelection = true
    }

    private var permitsAutomaticPolling: Bool {
        if lastPresentation.pauseDisposition == nil { return true }
        guard case let .paused(_, code) = lastPresentation else { return false }
        return code == "MEMBERSHIP_ARCHIVED" || SyncCoordinator.allowsReadOnlyRefresh(code: code)
    }

    /// Offline archived history remains exportable, but the caller must disclose
    /// that remote erasure freshness could not be checked.
    func refreshPrivacyBeforeExport() async throws -> Bool {
        guard try await repository.refreshSnapshot().isCurrentMemberArchived else { return true }
        guard lastAccountID != nil else { return false }
        do {
            _ = try await refreshArchivedPrivacy()
            return true
        } catch {
            if Self.isRetryable(error) { return false }
            throw error
        }
    }

    @discardableResult
    private func refreshArchivedPrivacy() async throws -> Int {
        let applied: Int
        do {
            applied = try await coordinator.refreshAuthoredText(for: context.configuration.id)
        } catch {
            // Earlier pages may already have committed erasures. Publish that
            // durable state even if a later page fails, invalidating stale UI
            // and prepared exports before the caller handles the original error.
            let snapshot = try await repository.refreshSnapshot()
            publish(
                lastPresentation,
                report: lastReport,
                snapshot: snapshot,
                errorCode: lastErrorCode
            )
            throw error
        }
        let snapshot = applied > 0 ? try await repository.refreshSnapshot() : nil
        consecutiveRetryableFailures = 0
        publish(.paused(pendingCount: pendingCount(), code: "MEMBERSHIP_ARCHIVED"), snapshot: snapshot)
        return applied
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        automaticPollingEnabled = true
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard self.automaticPollingEnabled else { return }
                do {
                    try await Task.sleep(for: self.pollDelay)
                } catch {
                    return
                }
                guard self.automaticPollingEnabled else { return }
                if self.lastAccountID == nil,
                   await self.authProvider.hasCachedSession() {
                    await self.restoreCachedSession()
                } else {
                    await self.runSync()
                }
            }
        }
    }

    private func stopAutomaticPolling() {
        automaticPollingEnabled = false
        pollTask?.cancel()
        pollTask = nil
    }

    private func runSync() async {
        do {
            if requiresReaderUpdate {
                await publishReaderUpdateRequired()
                return
            }
            try await resolvePotSelection()
            if requiresReaderUpdate {
                await publishReaderUpdateRequired()
                return
            }
            context = try await repository.syncContext()
            if try await repository.refreshSnapshot().isCurrentMemberArchived {
                _ = try await refreshArchivedPrivacy()
                return
            }
            let promotion: LocalPotPromotion?
            if needsPromotion {
                guard let ownerDisplayName = context.ownerDisplayName else {
                    throw AppLedgerRepositoryError.localSetupIncomplete
                }
                promotion = LocalPotPromotion(
                    ownerMemberID: context.ownerMemberID,
                    ownerDisplayName: ownerDisplayName,
                    minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
                )
            } else {
                promotion = nil
            }
            var report = try await coordinator.synchronize(
                PotSyncRequest(
                    potID: context.configuration.id,
                    promotion: promotion
                )
            )
            lastReport = report
            if needsPromotion, case .completed = report.outcome {
                try await reconcilePromotedLocalSetup()
                report = try await coordinator.synchronize(
                    PotSyncRequest(
                        potID: context.configuration.id,
                        promotion: nil
                    )
                )
                lastReport = report
            }
            switch report.outcome {
            case .completed:
                needsPromotion = false
                lastErrorCode = nil
                consecutiveRetryableFailures = 0
            case .alreadyRunning:
                break
            case .retryScheduled:
                if report.isWaitingForLocalReadiness {
                    lastErrorCode = nil
                    consecutiveRetryableFailures = 0
                } else {
                    lastErrorCode = "TRANSPORT_UNAVAILABLE"
                    recordRetryableFailure()
                }
            case let .paused(_, code):
                lastErrorCode = code
            }
            let refreshAuthorizedRoster: Bool
            switch report.outcome {
            case .completed: refreshAuthorizedRoster = true
            case let .paused(_, code): refreshAuthorizedRoster = SyncCoordinator.allowsReadOnlyRefresh(code: code)
            default: refreshAuthorizedRoster = false
            }
            let snapshot: AppLedgerSnapshot
            if refreshAuthorizedRoster {
                let synchronized = try await repository.refreshSnapshot()
                if synchronized.isCurrentMemberArchived {
                    snapshot = synchronized
                } else {
                    let roster = try await client.listMemberRoster(
                        potID: context.configuration.id
                    )
                    snapshot = try await repository.replaceAuthoritativeMemberRoster(
                        roster
                    )
                }
            } else {
                snapshot = try await repository.refreshSnapshot()
            }
            let status = try await coordinator.status(for: context.configuration.id)
            publish(
                presentation(for: status),
                report: report,
                snapshot: snapshot,
                errorCode: lastErrorCode
            )
            if !permitsAutomaticPolling { stopAutomaticPolling() }
        } catch is CancellationError {
            return
        } catch {
            lastErrorCode = Self.errorCode(error)
            if Self.isRetryable(error) { recordRetryableFailure() }
            do {
                let snapshot = try await repository.refreshSnapshot()
                publish(
                    Self.failurePresentation(error, pendingCount: pendingCount()),
                    report: lastReport,
                    snapshot: snapshot,
                    errorCode: lastErrorCode
                )
            } catch {
                let code = "LOCAL_PERSISTENCE_FAILURE"
                lastErrorCode = code
                publish(
                    .paused(pendingCount: pendingCount(), code: code),
                    report: lastReport,
                    errorCode: code
                )
            }
            if case .paused = lastPresentation { stopAutomaticPolling() }
        }
    }

    private func reconcilePromotedLocalSetup() async throws {
        // Schema-2 prerequisites are already original ledger rows, acknowledged atomically before money.
        if try context.store.hasLocalBudgetGroupSetup(for: context.configuration.id) { return }
        let potID = context.configuration.id
        guard var setup = try context.store.localPotSetup(for: potID),
              setup.isComplete
        else {
            throw AppLedgerRepositoryError.localSetupIncomplete
        }
        if !setup.isRenameConfirmed {
            let acknowledgement = try await client.renamePot(setup.renameEvent)
            try Self.validateSetupAcknowledgement(
                acknowledgement,
                eventID: setup.renameEvent.eventId
            )
            setup = try context.store.confirmLocalPotRename(
                potID: potID,
                eventID: setup.renameEvent.eventId
            )
        }
        for binding in setup.bindings where !binding.isConfirmed {
            let acknowledgement: EventAcknowledgement
            switch binding.profile.role {
            case .owner:
                guard binding.profile.memberID == setup.ownerMemberID,
                      binding.profile.state == .active
                else {
                    throw LocalPotSetupError.corruptStoredSetup(potID)
                }
                acknowledgement = try await client.bindOwnerUnit(binding.event)
            case .member:
                guard let displayName = binding.profile.displayName,
                      binding.profile.state == .pending
                else {
                    throw LocalPotSetupError.corruptStoredSetup(potID)
                }
                acknowledgement = try await client.bindPendingMember(
                    PendingMemberAddition(
                        displayName: displayName,
                        event: binding.event
                    )
                )
            }
            try Self.validateSetupAcknowledgement(
                acknowledgement,
                eventID: binding.event.eventId
            )
            setup = try context.store.confirmLocalMemberBinding(
                potID: potID,
                eventID: binding.event.eventId
            )
        }
        guard setup.isRenameConfirmed,
              setup.bindings.allSatisfy(\.isConfirmed)
        else {
            throw LocalPotSetupError.corruptStoredSetup(potID)
        }
    }

    private func requireAuthenticatedPot() throws {
        guard lastAccountID != nil, didResolvePotSelection else {
            throw SyncTransportError.terminal(code: "AUTH_SESSION_REQUIRED")
        }
    }

    private func requireCurrentOwnerMemberID() async throws -> MemberID {
        try requireAuthenticatedPot()
        let snapshot = try await repository.refreshSnapshot()
        guard let profile = snapshot.currentMemberProfile,
              profile.role == .owner,
              profile.state == .active
        else {
            throw SyncTransportError.terminal(code: "NOT_OWNER")
        }
        return profile.memberID
    }

    private func requireCurrentActiveMemberID() async throws -> MemberID {
        try requireAuthenticatedPot()
        let snapshot = try await repository.refreshSnapshot()
        guard let profile = snapshot.currentMemberProfile,
              profile.state == .active
        else {
            throw SyncTransportError.terminal(code: "MEMBERSHIP_ARCHIVED")
        }
        return profile.memberID
    }

    private func memberAdministrationEvent(
        for key: PendingMemberAdministrationKey,
        actorMemberID: MemberID,
        payload: EventPayload,
        now: Date
    ) throws -> WireEventV1 {
        if let pending = pendingMemberAdministrationEvents[key] {
            return pending
        }
        let timeZone: IANATimeZone
        if let current = try? IANATimeZone(TimeZone.current.identifier) {
            timeZone = current
        } else {
            timeZone = try IANATimeZone("UTC")
        }
        let event = try WireEventV1(EventEnvelope(
            id: EventID.generate(at: now),
            potID: context.configuration.id,
            actorMemberID: actorMemberID,
            occurredAt: now,
            originatingTimeZone: timeZone,
            schemaVersion: try context.store.reduction(for: context.configuration.id).projection.structure.minimumSchemaVersion,
            payload: payload
        ))
        pendingMemberAdministrationEvents[key] = event
        return event
    }

    private func finishMemberAdministrationEvent(
        key: PendingMemberAdministrationKey,
        event: WireEventV1,
        acknowledgement: EventAcknowledgement
    ) async throws -> [PendingInviteClaim] {
        try Self.validateSetupAcknowledgement(
            acknowledgement,
            eventID: event.eventId
        )
        pendingMemberAdministrationEvents[key] = nil
        await runSync()
        return try await refreshMemberAdministration()
    }

    private nonisolated static func validateSetupAcknowledgement(
        _ acknowledgement: EventAcknowledgement,
        eventID: EventID
    ) throws {
        guard acknowledgement.eventID == eventID,
              acknowledgement.serverSequence > 0
        else {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    private func presentation(for status: PotSyncStatus) -> SyncPresentation {
        switch status {
        case let .offline(pending):
            return .offline(pendingCount: pending)
        case let .syncing(pending):
            return .syncing(pendingCount: pending)
        case .synced:
            return .synced
        case let .paused(pending, code):
            return .paused(pendingCount: pending, code: code)
        }
    }

    private var requiresReaderUpdate: Bool {
        guard let minimum = context.minimumReaderSchemaVersion else { return false }
        return minimum > context.store.readerSchemaVersion
    }

    private var pollDelay: Duration {
        guard consecutiveRetryableFailures > 0 else {
            return .milliseconds(healthyPollingIntervalMilliseconds)
        }
        let cappedFailures = min(consecutiveRetryableFailures - 1, 5)
        let multiplier = 1 << cappedFailures
        return .milliseconds(min(
            30_000,
            retryPollingBaseDelayMilliseconds * multiplier
        ))
    }

    private func recordRetryableFailure() {
        consecutiveRetryableFailures = min(consecutiveRetryableFailures + 1, 5)
    }

    private func publishReaderUpdateRequired() async {
        let code = "READER_UPDATE_REQUIRED"
        let snapshot = try? await repository.refreshSnapshot()
        publish(
            .paused(pendingCount: pendingCount(), code: code),
            report: lastReport,
            snapshot: snapshot,
            errorCode: code
        )
        stopAutomaticPolling()
    }

    private func pendingCount() -> Int {
        (try? context.store.pendingDeliveryEventCount(
            for: context.configuration.id
        )) ?? 0
    }

    private func publish(
        _ presentation: SyncPresentation,
        report: SyncRunReport? = nil,
        snapshot: AppLedgerSnapshot? = nil,
        errorCode: String? = nil
    ) {
        lastPresentation = presentation
        lastErrorCode = errorCode
        onUpdate?(presentation, report, snapshot, errorCode)
    }

    private static func errorCode(_ error: Error) -> String {
        if let transport = error as? SyncTransportError { return transport.code }
        if let session = error as? NumaSessionError {
            if case let .server(code, _) = session { return code }
            return String(describing: session)
        }
        if let repository = error as? AppLedgerRepositoryError {
            switch repository {
            case .accountIdentityMismatch:
                return "ACCOUNT_IDENTITY_MISMATCH"
            case .invalidAccountIdentifier:
                return "INVALID_ACCOUNT_ID"
            case .localSetupIncomplete:
                return "LOCAL_SETUP_INCOMPLETE"
            default:
                break
            }
        }
        return "SYNC_UNAVAILABLE"
    }

    private static func normalizedAccountID(_ value: String?) -> String? {
        guard let value, let uuid = UUID(uuidString: value) else { return nil }
        return uuid.uuidString.lowercased()
    }

    private static func failurePresentation(
        _ error: Error,
        pendingCount: Int
    ) -> SyncPresentation {
        if isRetryable(error) {
            return .offline(pendingCount: pendingCount)
        }
        if let transport = error as? SyncTransportError,
           case .terminal = transport {
            return .paused(pendingCount: pendingCount, code: errorCode(error))
        }
        if let session = error as? NumaSessionError,
           case let .server(_, retryable) = session,
           !retryable {
            return .paused(pendingCount: pendingCount, code: errorCode(error))
        }
        if let repository = error as? AppLedgerRepositoryError {
            switch repository {
            case .accountIdentityMismatch, .invalidAccountIdentifier:
                return .paused(pendingCount: pendingCount, code: errorCode(error))
            default:
                break
            }
        }
        return .paused(pendingCount: pendingCount, code: errorCode(error))
    }

    private static func isRetryable(_ error: Error) -> Bool {
        if let transport = error as? SyncTransportError,
           case .retryable = transport {
            return true
        }
        if let session = error as? NumaSessionError,
           case let .server(_, retryable) = session {
            return retryable
        }
        if let session = error as? NumaSessionError,
           case .transportUnavailable = session {
            return true
        }
        return false
    }

}
