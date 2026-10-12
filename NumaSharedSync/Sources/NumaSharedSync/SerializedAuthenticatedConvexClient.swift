@preconcurrency import ConvexMobile
import Foundation
import NumaSharedCore

/// Drives one authenticated Convex SDK connection from a single compiler-
/// enforced executor. Transport operations borrow their feature-unavailable
/// defaults from the public transport protocols below; conformers that own a
/// real connection override them.
@MainActor
protocol AuthenticatedConvexDriving<AuthResult>: AnyObject,
    SyncTransport,
    InviteClaimTransport,
    InviteAdministrationTransport,
    MemberAdministrationTransport,
    PushNotificationTransport
{
    associatedtype AuthResult: Sendable

    func login() async -> Result<AuthResult, any Error>
    func loginFromCache() async -> Result<AuthResult, any Error>
    func logout() async
}

/// Owns the authenticated Convex SDK client behind a serialized FIFO gate.
///
/// Main-actor isolation prevents the non-Sendable SDK object from crossing
/// into coordinator tasks. The explicit FIFO gate also spans suspension
/// points, so actor reentrancy cannot overlap login, cached refresh, or sync
/// operations.
@MainActor
public final class SerializedAuthenticatedConvexClient<AuthResult: Sendable>:
    SyncTransport,
    InviteClaimTransport,
    InviteAdministrationTransport,
    MemberAdministrationTransport,
    PushNotificationTransport
{
    private let driver: any AuthenticatedConvexDriving<AuthResult>
    private let mutationTimeout: Duration
    private var operationIsActive = false
    private var waiters: [Waiter] = []
    private var nextWaiterID: UInt64 = 0

    public init(
        deploymentURL: URL,
        authProvider: any AuthProvider<AuthResult>
    ) {
        driver = SDKAuthenticatedConvexDriver(
            deploymentURL: deploymentURL,
            authProvider: authProvider
        )
        mutationTimeout = .seconds(30)
    }

    init(
        driver: any AuthenticatedConvexDriving<AuthResult>,
        mutationTimeout: Duration = .seconds(30)
    ) {
        precondition(mutationTimeout > .zero)
        self.driver = driver
        self.mutationTimeout = mutationTimeout
    }

    // MARK: Authentication

    public func login() async -> Result<AuthResult, any Error> {
        do { return try await serialized { await driver.login() } }
        catch { return .failure(error) }
    }

    public func loginFromCache() async -> Result<AuthResult, any Error> {
        do { return try await serialized { await driver.loginFromCache() } }
        catch { return .failure(error) }
    }

    public func logout() async {
        try? await serialized { await driver.logout() }
    }

    public func connectionStates() async -> AsyncStream<SyncConnectionState> {
        do { return try await serialized { await driver.connectionStates() } }
        catch { return AsyncStream { $0.finish() } }
    }

    // MARK: Transport forwarding

    /// Runs a read-only gate operation against the owned driver.
    private func read<Value: Sendable>(
        _ operation: @escaping @MainActor @Sendable (
            any AuthenticatedConvexDriving<AuthResult>
        ) async throws -> Value
    ) async throws -> Value {
        try await serialized { try await operation(self.driver) }
    }

    /// Runs a mutation through the caller-decoupled gate: the lease is held
    /// for the SDK operation's full lifetime even if the caller times out,
    /// because the SDK mutation may already have reached Convex. Retrying the
    /// same event IDs after the lease releases is safe because the server
    /// deduplicates appends by event ID.
    private func mutate<Value: Sendable>(
        _ operation: @escaping @MainActor @Sendable (
            any AuthenticatedConvexDriving<AuthResult>
        ) async throws -> Value
    ) async throws -> Value {
        try await serializedMutation {
            try await operation(self.driver)
        }
    }

    public func listPots() async throws -> [RemotePotDescriptor] {
        try await read { try await $0.listPots() }
    }
    public func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        try await mutate { try await $0.promoteLocalPot(request) }
    }
    public func changeBudgetGroups(
        _ event: WireEventV1, expectedTopologyRevision: Int64
    ) async throws -> EventAcknowledgement {
        try await mutate {
            try await $0.changeBudgetGroups(event, expectedTopologyRevision: expectedTopologyRevision)
        }
    }
    public func appendEvents(
        potID: PotID, events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        try await mutate { try await $0.appendEvents(potID: potID, events: events) }
    }
    public func listEvents(
        potID: PotID, afterSequence: Int64
    ) async throws -> SyncEventPage {
        try await read { try await $0.listEvents(potID: potID, afterSequence: afterSequence) }
    }
    public func listTextChanges(
        potID: PotID, afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        try await read { try await $0.listTextChanges(potID: potID, afterRevision: afterRevision) }
    }
    public func claimInvite(
        _ request: InviteClaimRequest
    ) async throws -> InviteClaimOutcome {
        try await mutate { try await $0.claimInvite(request) }
    }
    public func listManagedInvites(
        potID: PotID
    ) async throws -> [ManagedInvite] {
        try await read { try await $0.listManagedInvites(potID: potID) }
    }
    public func issueInvite(
        _ request: InviteIssueRequest
    ) async throws -> UUID {
        try await mutate { try await $0.issueInvite(request) }
    }
    public func revokeInvite(
        potID: PotID, inviteID: UUID
    ) async throws {
        try await mutate { try await $0.revokeInvite(potID: potID, inviteID: inviteID) }
    }
    public func registerPushToken(
        _ registration: PushTokenRegistration
    ) async throws {
        try await mutate { try await $0.registerPushToken(registration) }
    }
    public func unregisterPushToken(
        _ token: APNsDeviceToken
    ) async throws {
        try await mutate { try await $0.unregisterPushToken(token) }
    }
    public func getPotMute(
        potID: PotID
    ) async throws -> Bool {
        try await read { try await $0.getPotMute(potID: potID) }
    }
    public func setPotMute(
        potID: PotID, muted: Bool
    ) async throws -> Bool {
        try await mutate { try await $0.setPotMute(potID: potID, muted: muted) }
    }
    public func listMemberRoster(
        potID: PotID
    ) async throws -> [PotMemberProfile] {
        try await read { try await $0.listMemberRoster(potID: potID) }
    }
    public func bindOwnerUnit(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.bindOwnerUnit(event) }
    }
    public func bindPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.bindPendingMember(request) }
    }
    public func renamePot(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.renamePot(event) }
    }
    public func addPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.addPendingMember(request) }
    }
    public func anonymizePendingMember(
        potID: PotID, memberID: MemberID
    ) async throws {
        try await mutate { try await $0.anonymizePendingMember(potID: potID, memberID: memberID) }
    }
    public func listPendingInviteClaims(
        potID: PotID
    ) async throws -> [PendingInviteClaim] {
        try await read { try await $0.listPendingInviteClaims(potID: potID) }
    }
    public func approvePendingInviteClaim(
        _ request: PendingInviteClaimApproval
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.approvePendingInviteClaim(request) }
    }
    public func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws {
        try await mutate { try await $0.rejectPendingInviteClaim(claimID) }
    }
    public func reassignMemberClaim(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.reassignMemberClaim(event) }
    }
    public func archiveMember(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.archiveMember(event) }
    }
    public func leavePot(
        _ request: PotLeaveRequest
    ) async throws -> PotLeaveAcknowledgement {
        try await mutate { try await $0.leavePot(request) }
    }
    public func transferOwnership(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await mutate { try await $0.transferOwnership(event) }
    }

    // MARK: FIFO gate

    private func serialized<Value>(
        _ operation: @MainActor () async throws -> Value
    ) async throws -> Value {
        try await acquireOperation()
        defer { releaseOperation() }
        try Task.checkCancellation()
        return try await operation()
    }

    private func serializedMutation<Value: Sendable>(
        _ operation: @escaping @MainActor @Sendable () async throws -> Value
    ) async throws -> Value {
        try await acquireOperation()
        do {
            try Task.checkCancellation()
        } catch {
            releaseOperation()
            throw error
        }

        let race = MutationDeadlineRace<Value>()
        Task { @MainActor [self] in
            let result: Result<Value, any Error>
            do {
                result = .success(try await operation())
            } catch {
                result = .failure(error)
            }
            releaseOperation()
            race.settle(result)
        }

        return try await race.value(timeout: mutationTimeout)
    }

    private func acquireOperation() async throws {
        try Task.checkCancellation()
        if !operationIsActive {
            operationIsActive = true
            do {
                try Task.checkCancellation()
            } catch {
                releaseOperation()
                throw error
            }
            return
        }

        nextWaiterID &+= 1
        let waiterID = nextWaiterID
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters.append(Waiter(id: waiterID, continuation: continuation))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.cancelWaiter(waiterID)
            }
        }

        do {
            try Task.checkCancellation()
        } catch {
            releaseOperation()
            throw error
        }
    }

    private func releaseOperation() {
        guard !waiters.isEmpty else {
            operationIsActive = false
            return
        }
        waiters.removeFirst().continuation.resume()
    }

    private func cancelWaiter(_ id: UInt64) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else {
            return
        }
        waiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }

    private struct Waiter {
        let id: UInt64
        let continuation: CheckedContinuation<Void, any Error>
    }
}

/// Caller-lifetime race with no ownership of the mutation task: timeout and
/// cancellation settle only the awaiting caller, while the SDK operation
/// stays alive and releases the serialized lease itself.
private final class MutationDeadlineRace<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, any Error>?
    private var timeoutTask: Task<Void, Never>?
    private var result: Result<Value, any Error>?

    func value(timeout: Duration) async throws -> Value {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Value, any Error>) in
                install(timeout: timeout, continuation: continuation)
            }
        } onCancel: {
            settle(.failure(CancellationError()))
        }
    }

    func settle(_ result: Result<Value, any Error>) {
        lock.lock()
        guard self.result == nil else { return lock.unlock() }
        self.result = result
        let continuation = continuation
        let timeoutTask = timeoutTask
        self.continuation = nil
        self.timeoutTask = nil
        lock.unlock()
        timeoutTask?.cancel()
        continuation?.resume(with: result)
    }

    private func install(
        timeout: Duration,
        continuation: CheckedContinuation<Value, any Error>
    ) {
        lock.lock()
        if let result {
            lock.unlock()
            continuation.resume(with: result)
            return
        }
        self.continuation = continuation
        timeoutTask = Task { [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            self?.settle(.failure(
                SyncTransportError.retryable(code: "TRANSPORT_TIMEOUT")
            ))
        }
        lock.unlock()
    }
}

/// The real authenticated driver: one `ConvexClientWithAuth` connection shared
/// by login/logout and the live transport.
@MainActor
private final class SDKAuthenticatedConvexDriver<AuthResult: Sendable>:
    AuthenticatedConvexDriving
{
    private let client: ConvexClientWithAuth<AuthResult>
    private let transport: ConvexSyncTransport

    init(
        deploymentURL: URL,
        authProvider: any AuthProvider<AuthResult>
    ) {
        client = ConvexClientWithAuth(
            deploymentUrl: deploymentURL.absoluteString,
            authProvider: authProvider
        )
        transport = ConvexSyncTransport(client: client)
    }

    func login() async -> Result<AuthResult, any Error> { await client.login() }
    func loginFromCache() async -> Result<AuthResult, any Error> { await client.loginFromCache() }
    func logout() async { await client.logout() }

    func connectionStates() async -> AsyncStream<SyncConnectionState> {
        await transport.connectionStates()
    }
    func listPots() async throws -> [RemotePotDescriptor] { try await transport.listPots() }
    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        try await transport.promoteLocalPot(request)
    }
    func changeBudgetGroups(
        _ event: WireEventV1, expectedTopologyRevision: Int64
    ) async throws -> EventAcknowledgement {
        try await transport.changeBudgetGroups(event, expectedTopologyRevision: expectedTopologyRevision)
    }
    func appendEvents(
        potID: PotID, events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        try await transport.appendEvents(potID: potID, events: events)
    }
    func listEvents(
        potID: PotID, afterSequence: Int64
    ) async throws -> SyncEventPage {
        try await transport.listEvents(potID: potID, afterSequence: afterSequence)
    }
    func listTextChanges(
        potID: PotID, afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        try await transport.listTextChanges(potID: potID, afterRevision: afterRevision)
    }
    func claimInvite(
        _ request: InviteClaimRequest
    ) async throws -> InviteClaimOutcome {
        try await transport.claimInvite(request)
    }
    func listManagedInvites(
        potID: PotID
    ) async throws -> [ManagedInvite] {
        try await transport.listManagedInvites(potID: potID)
    }
    func issueInvite(
        _ request: InviteIssueRequest
    ) async throws -> UUID {
        try await transport.issueInvite(request)
    }
    func revokeInvite(
        potID: PotID, inviteID: UUID
    ) async throws {
        try await transport.revokeInvite(potID: potID, inviteID: inviteID)
    }
    func registerPushToken(
        _ registration: PushTokenRegistration
    ) async throws {
        try await transport.registerPushToken(registration)
    }
    func unregisterPushToken(
        _ token: APNsDeviceToken
    ) async throws {
        try await transport.unregisterPushToken(token)
    }
    func getPotMute(
        potID: PotID
    ) async throws -> Bool {
        try await transport.getPotMute(potID: potID)
    }
    func setPotMute(
        potID: PotID, muted: Bool
    ) async throws -> Bool {
        try await transport.setPotMute(potID: potID, muted: muted)
    }
    func listMemberRoster(
        potID: PotID
    ) async throws -> [PotMemberProfile] {
        try await transport.listMemberRoster(potID: potID)
    }
    func bindOwnerUnit(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await transport.bindOwnerUnit(event)
    }
    func bindPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        try await transport.bindPendingMember(request)
    }
    func renamePot(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await transport.renamePot(event)
    }
    func addPendingMember(
        _ request: PendingMemberAddition
    ) async throws -> EventAcknowledgement {
        try await transport.addPendingMember(request)
    }
    func anonymizePendingMember(
        potID: PotID, memberID: MemberID
    ) async throws {
        try await transport.anonymizePendingMember(potID: potID, memberID: memberID)
    }
    func listPendingInviteClaims(
        potID: PotID
    ) async throws -> [PendingInviteClaim] {
        try await transport.listPendingInviteClaims(potID: potID)
    }
    func approvePendingInviteClaim(
        _ request: PendingInviteClaimApproval
    ) async throws -> EventAcknowledgement {
        try await transport.approvePendingInviteClaim(request)
    }
    func rejectPendingInviteClaim(
        _ claimID: PendingInviteClaimID
    ) async throws {
        try await transport.rejectPendingInviteClaim(claimID)
    }
    func reassignMemberClaim(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await transport.reassignMemberClaim(event)
    }
    func archiveMember(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await transport.archiveMember(event)
    }
    func leavePot(
        _ request: PotLeaveRequest
    ) async throws -> PotLeaveAcknowledgement {
        try await transport.leavePot(request)
    }
    func transferOwnership(
        _ event: WireEventV1
    ) async throws -> EventAcknowledgement {
        try await transport.transferOwnership(event)
    }
}
