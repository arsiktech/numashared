import Foundation
import NumaSharedCore

public struct LocalPotPromotion: Hashable, Sendable {
    public let ownerMemberID: MemberID
    public let ownerDisplayName: String
    public let minimumReaderSchemaVersion: UInt16

    public init(
        ownerMemberID: MemberID,
        ownerDisplayName: String,
        minimumReaderSchemaVersion: UInt16
    ) {
        self.ownerMemberID = ownerMemberID
        self.ownerDisplayName = ownerDisplayName
        self.minimumReaderSchemaVersion = minimumReaderSchemaVersion
    }
}

public struct PotSyncRequest: Hashable, Sendable {
    public let potID: PotID
    public let promotion: LocalPotPromotion?

    public init(
        potID: PotID,
        promotion: LocalPotPromotion? = nil
    ) {
        self.potID = potID
        self.promotion = promotion
    }
}

public enum SyncRetryPolicyError: Error, Equatable, Sendable {
    case nonFiniteDelay
    case nonPositiveBaseDelay
    case maximumBeforeBase
}

public struct SyncRetryPolicy: Hashable, Sendable {
    public static let standard = SyncRetryPolicy(
        validatedBaseDelay: 2,
        maximumDelay: 5 * 60
    )

    public let baseDelay: TimeInterval
    public let maximumDelay: TimeInterval

    public init(
        baseDelay: TimeInterval,
        maximumDelay: TimeInterval
    ) throws {
        guard baseDelay.isFinite, maximumDelay.isFinite else {
            throw SyncRetryPolicyError.nonFiniteDelay
        }
        guard baseDelay > 0 else {
            throw SyncRetryPolicyError.nonPositiveBaseDelay
        }
        guard maximumDelay >= baseDelay else {
            throw SyncRetryPolicyError.maximumBeforeBase
        }
        self.baseDelay = baseDelay
        self.maximumDelay = maximumDelay
    }

    private init(
        validatedBaseDelay baseDelay: TimeInterval,
        maximumDelay: TimeInterval
    ) {
        self.baseDelay = baseDelay
        self.maximumDelay = maximumDelay
    }

    public func retryDate(
        afterAttempt attempt: Int,
        relativeTo date: Date
    ) -> Date {
        var delay = baseDelay
        if attempt > 1 {
            for _ in 1 ..< attempt {
                delay = min(maximumDelay, delay * 2)
                if delay == maximumDelay { break }
            }
        }
        return date.addingTimeInterval(delay)
    }
}

public enum SyncRunOutcome: Equatable, Sendable {
    case completed
    case alreadyRunning
    case retryScheduled(eventID: EventID?, retryAt: Date)
    case paused(eventID: EventID?, code: String)
}

public struct SyncRunReport: Equatable, Sendable {
    public let outcome: SyncRunOutcome
    public let dispatchedEventCount: Int
    public let ingestedEventCount: Int
    public let isWaitingForLocalReadiness: Bool

    public init(
        outcome: SyncRunOutcome,
        dispatchedEventCount: Int,
        ingestedEventCount: Int,
        isWaitingForLocalReadiness: Bool = false
    ) {
        self.outcome = outcome
        self.dispatchedEventCount = dispatchedEventCount
        self.ingestedEventCount = ingestedEventCount
        self.isWaitingForLocalReadiness = isWaitingForLocalReadiness
    }
}

public enum PotSyncStatus: Equatable, Sendable {
    case offline(pendingEventCount: Int)
    case syncing(pendingEventCount: Int)
    case synced(lastServerSequence: Int64)
    case paused(pendingEventCount: Int, code: String)
}

public actor SyncCoordinator {
    private let store: LedgerStore
    private let transport: any SyncTransport
    private let retryPolicy: SyncRetryPolicy
    private var connectionState = SyncConnectionState.connecting
    private var activePots = Set<PotID>()
    private var terminalFailures = [PotID: String]()
    private var connectionTask: Task<Void, Never>?

    public init(
        store: LedgerStore,
        transport: any SyncTransport,
        retryPolicy: SyncRetryPolicy = .standard
    ) {
        self.store = store
        self.transport = transport
        self.retryPolicy = retryPolicy
    }

    public func startConnectionMonitoring() {
        guard connectionTask == nil else { return }
        let transport = transport
        connectionTask = Task { [weak self] in
            let states = await transport.connectionStates()
            for await state in states {
                guard !Task.isCancelled else { return }
                await self?.recordConnectionState(state)
            }
        }
    }

    public func stopConnectionMonitoring() {
        connectionTask?.cancel()
        connectionTask = nil
    }

    /// Discovers this account's server pots and creates only their immutable
    /// local configurations. Event history is pulled separately by `synchronize`.
    @discardableResult
    public func registerRemotePots(
        at date: Date = Date()
    ) async throws -> [RemotePotDescriptor] {
        do {
            let pots = try await transport.listPots()
            connectionState = .connected
            for pot in pots where pot.hasInitialUnitBaseline {
                if try store.potConfiguration(for: pot.configuration.id) == nil {
                    try store.registerPot(pot.configuration, at: date)
                }
            }
            return pots
        } catch let failure as SyncTransportError {
            connectionState = .connecting
            throw failure
        }
    }

    public func synchronize(
        _ request: PotSyncRequest,
        now: Date = Date()
    ) async throws -> SyncRunReport {
        guard activePots.insert(request.potID).inserted else {
            return SyncRunReport(
                outcome: .alreadyRunning,
                dispatchedEventCount: 0,
                ingestedEventCount: 0
            )
        }
        defer { activePots.remove(request.potID) }
        let persistedPause = try store.persistedSyncPause(for: request.potID)
        terminalFailures[request.potID] = nil

        _ = try store.expireHeldEvents(now: now)
        var dispatched = 0
        var ingested = 0

        if let promotion = request.promotion, persistedPause == nil {
            guard let configuration = try store.potConfiguration(for: request.potID) else {
                throw LedgerStoreError.potNotRegistered(request.potID)
            }
            let isBudgetGroupPromotion = try store.hasLocalBudgetGroupSetup(for: request.potID)
            if isBudgetGroupPromotion && store.readerSchemaVersion < 2 {
                return try pause({ (request.potID, nil, "READER_UPDATE_REQUIRED", 0, 0) }, at: now)
            }
            promotionLoop: while true {
                let emptyPromotionRequired = try store.syncState(for: request.potID)?
                    .emptyPromotionRequired ?? false
                let pending = emptyPromotionRequired
                    ? []
                    : try promotableEvents(for: request.potID, at: now)
                let storedEvents = try store.loadStoredEvents(for: request.potID)
                let acknowledged = storedEvents.compactMap(\.delivery.serverSequence).max() ?? 0
                let startingSequence = isBudgetGroupPromotion ? acknowledged + 1 : 1
                let typedPromotion = isBudgetGroupPromotion
                    ? try store.budgetGroupPromotion(for: request.potID, startingSequence: startingSequence) : nil
                if isBudgetGroupPromotion && acknowledged == 0 && !pending.contains(where: {
                    if case .groupChanged = $0.event.payload { return true }
                    return false
                }) {
                    // No pot exists yet: do not pull or upload a partial bootstrap while its
                    // original prerequisite prefix remains held/delayed. This is not a network failure.
                    let blocker = storedEvents.sorted { $0.localOrdinal < $1.localOrdinal }.first {
                        $0.delivery.state == .held || ($0.delivery.state == .ready
                            && ($0.delivery.nextRetryAt.map { $0 > now } ?? false))
                    }
                    if let blocker, let readyAt = blocker.delivery.nextRetryAt ?? blocker.delivery.undoDeadline {
                        return SyncRunReport(outcome: .retryScheduled(eventID: blocker.event.id, retryAt: readyAt),
                            dispatchedEventCount: 0, ingestedEventCount: 0, isWaitingForLocalReadiness: true)
                    }
                    return try pause({ (request.potID, nil, "PROMOTION_PREREQUISITES_REQUIRED", 0, 0) }, at: now)
                }
                if isBudgetGroupPromotion && pending.isEmpty { break promotionLoop }
                let wires: [WireEventV1]
                do {
                    wires = try pending.map { try Self.outboundWire(for: $0) }
                } catch {
                    let eventID = pending.first {
                        (try? Self.outboundWire(for: $0)) == nil
                    }?.event.id
                    guard let eventID else {
                        return try pause({ (request.potID, nil, "INVALID_SERVER_RESPONSE", dispatched, ingested) }, at: now)
                    }
                    if isBudgetGroupPromotion {
                        try store.setPersistedSyncPause("UNSUPPORTED_WIRE_EVENT", for: request.potID)
                        return try pause({ (request.potID, eventID, "UNSUPPORTED_WIRE_EVENT", dispatched, ingested) }, at: now)
                    }
                    _ = try store.markTerminal(
                        eventID: eventID,
                        reason: "UNSUPPORTED_WIRE_EVENT",
                        at: now
                    )
                    continue promotionLoop
                }
                do {
                    let acknowledgements = try await transport.promoteLocalPot(
                        LocalPotPromotionRequest(
                            configuration: configuration,
                            ownerMemberID: promotion.ownerMemberID,
                            ownerDisplayName: promotion.ownerDisplayName,
                            minimumReaderSchemaVersion: promotion.minimumReaderSchemaVersion,
                            events: wires,
                            budgetGroupPromotion: typedPromotion
                        )
                    )
                    guard acknowledgements.count == pending.count,
                          acknowledgements.enumerated().allSatisfy({ index, acknowledgement in
                              acknowledgement.eventID == pending[index].event.id
                                  && acknowledgement.serverSequence == startingSequence + Int64(index)
                          })
                    else {
                        return try pause({ (request.potID, pending.first?.event.id, "INVALID_SERVER_RESPONSE", dispatched, ingested) }, at: now)
                    }
                    if emptyPromotionRequired {
                        try store.acknowledgeEmptyPromotion(
                            potID: request.potID,
                            at: now
                        )
                    } else {
                        _ = try store.acknowledgePromotionBatch(acknowledgements, at: now)
                    }
                    dispatched += acknowledgements.count
                    connectionState = .connected
                    break promotionLoop
                } catch let failure as SyncTransportError {
                    switch failure {
                    case .retryable:
                        return try networkFailureReport(
                            failure,
                            potID: request.potID,
                            eventID: nil,
                            attempt: 1,
                            now: now,
                            dispatched: dispatched,
                            ingested: ingested
                        )
                    case .terminal where Self.eventTerminalCodes.contains(failure.code):
                        guard !pending.isEmpty else {
                            return try pause({ (request.potID, nil, failure.code, dispatched, ingested) }, at: now)
                        }
                        if isBudgetGroupPromotion {
                            try store.setPersistedSyncPause(failure.code, for: request.potID)
                            return try pause({ (request.potID, pending.first?.event.id, failure.code, dispatched, ingested) }, at: now)
                        }
                        _ = try store.markPromotionBatchTerminalAndRequireEmptyPromotion(
                            eventIDs: pending.map(\.event.id),
                            potID: request.potID,
                            reason: failure.code,
                            at: now
                        )
                        continue promotionLoop
                    case .terminal:
                        return try pause({ (request.potID, nil, failure.code, dispatched, ingested) }, at: now)
                    }
                }
            }
        }

        let midPull = try await pulling(
            request.potID,
            receivedAt: now,
            dispatched: dispatched,
            ingested: ingested
        )
        ingested = midPull.ingested
        if midPull.report.outcome != .completed {
            return midPull.report
        }

        // A write conflict must not stop authorized remote history/redaction reads.
        if let persistedPause {
            return SyncRunReport(outcome: .paused(eventID: nil, code: persistedPause),
                dispatchedEventCount: dispatched, ingestedEventCount: ingested)
        }
        if case let .readOnly(issue) = try store.reduction(for: request.potID).access {
            return try pause({ (request.potID, issue.eventID, "READER_UPDATE_REQUIRED", dispatched, ingested) }, at: now)
        }

        while let pending = try store.readyEvents(for: request.potID, at: now).first {
            let dispatch = try store.markDispatching(eventID: pending.event.id, at: now)
            let wire: WireEventV1
            do {
                wire = try Self.outboundWire(for: pending)
            } catch {
                _ = try store.markTerminal(
                    eventID: pending.event.id,
                    reason: "UNSUPPORTED_WIRE_EVENT",
                    at: now
                )
                continue
            }

            do {
                let acknowledgements: [EventAcknowledgement]
                if case .groupChanged = wire.payload,
                   let expected = try store.expectedTopologyRevision(for: wire.eventId) {
                    acknowledgements = [try await transport.changeBudgetGroups(wire, expectedTopologyRevision: expected)]
                } else {
                    acknowledgements = try await transport.appendEvents(potID: request.potID, events: [wire])
                }
                connectionState = .connected
                guard acknowledgements.count == 1,
                      let acknowledgement = acknowledgements.first,
                      acknowledgement.eventID == pending.event.id,
                      acknowledgement.serverSequence > 0
                else {
                    return try pause({ (request.potID, pending.event.id, "INVALID_SERVER_RESPONSE", dispatched, ingested) }, at: now)
                }
                _ = try store.acknowledge(
                    eventID: pending.event.id,
                    serverSequence: acknowledgement.serverSequence,
                    at: now
                )
                dispatched += 1
            } catch LedgerStoreError.serverSequenceConflict {
                return try pause({ (request.potID, pending.event.id, "INVALID_SERVER_RESPONSE", dispatched, ingested) }, at: now)
            } catch is CancellationError {
                _ = try store.scheduleRetry(
                    eventID: pending.event.id,
                    noEarlierThan: now,
                    at: now
                )
                throw CancellationError()
            } catch let failure as SyncTransportError {
                switch failure {
                case .retryable:
                    let retryAt = retryPolicy.retryDate(
                        afterAttempt: dispatch.attemptCount,
                        relativeTo: now
                    )
                    _ = try store.scheduleRetry(
                        eventID: pending.event.id,
                        noEarlierThan: retryAt,
                        at: now
                    )
                    connectionState = .connecting
                    return SyncRunReport(
                        outcome: .retryScheduled(
                            eventID: pending.event.id,
                            retryAt: retryAt
                        ),
                        dispatchedEventCount: dispatched,
                        ingestedEventCount: ingested
                    )
                case .terminal:
                    if Self.eventTerminalCodes.contains(failure.code) {
                        _ = try store.markTerminal(
                            eventID: pending.event.id,
                            reason: failure.code,
                            at: now
                        )
                        continue
                    }
                    return try pause({ (request.potID, pending.event.id, failure.code, dispatched, ingested) }, at: now)
                }
            }
        }

        let pulledReport = try await pulling(
            request.potID,
            receivedAt: now,
            dispatched: dispatched,
            ingested: ingested
        )
        ingested = pulledReport.ingested
        if pulledReport.report.outcome != .completed {
            return pulledReport.report
        }

        return SyncRunReport(
            outcome: .completed,
            dispatchedEventCount: dispatched,
            ingestedEventCount: ingested
        )
    }

    /// Events are fetched forwards by server sequence in contiguous pages
    /// and text tombstones forwards by revision; all fetch errors funnel
    /// through `networkFailureReport` exactly as before consolidation.
    private func pulling(
        _ potID: PotID,
        receivedAt: Date,
        dispatched: Int,
        ingested: Int
    ) async throws -> (ingested: Int, report: SyncRunReport) {
        do {
            var total = try await pullAllEvents(for: potID, receivedAt: receivedAt)
            total += try await pullAllTextChanges(for: potID, receivedAt: receivedAt)
            return (ingested + total, SyncRunReport(
                outcome: .completed,
                dispatchedEventCount: dispatched,
                ingestedEventCount: ingested + total
            ))
        } catch let failure as SyncTransportError {
            return (ingested, try networkFailureReport(
                failure,
                potID: potID,
                eventID: nil,
                attempt: 1,
                now: receivedAt,
                dispatched: dispatched,
                ingested: ingested
            ))
        }
    }

    /// Promotion must create the remote pot and its eligible accountless
    /// outbox prefix in one backend transaction. A held or delayed head still
    /// blocks every later local event, matching the ordinary single-flight queue.
    private func promotableEvents(
        for potID: PotID,
        at date: Date
    ) throws -> [StoredLedgerEvent] {
        let outbound = try store.loadStoredEvents(for: potID)
            .filter { $0.delivery.state != .acknowledged && $0.delivery.state != .terminal }
            .sorted { $0.localOrdinal < $1.localOrdinal }
        var result: [StoredLedgerEvent] = []
        for stored in outbound {
            guard stored.delivery.state == .ready,
                  stored.delivery.nextRetryAt.map({ $0 <= date }) ?? true
            else { break }
            result.append(stored)
            if result.count == Self.maximumPromotionBatchSize { break }
        }
        return result
    }

    public func status(for potID: PotID) throws -> PotSyncStatus {
        let storedEvents = try store.loadStoredEvents(for: potID)
        let pending = try store.pendingDeliveryEventCount(for: potID)
        let persistedPotFailure = storedEvents.lazy
            .compactMap(\.delivery.terminalReason)
            .first(where: { !Self.eventTerminalCodes.contains($0) })
        let persistedPause = try store.persistedSyncPause(for: potID)
        if let failure = terminalFailures[potID] ?? persistedPause ?? persistedPotFailure {
            return .paused(pendingEventCount: pending, code: failure)
        }
        if activePots.contains(potID) {
            return .syncing(pendingEventCount: pending)
        }
        guard connectionState == .connected else {
            return .offline(pendingEventCount: pending)
        }
        if pending > 0 {
            return .syncing(pendingEventCount: pending)
        }
        return .synced(
            lastServerSequence: try store.syncState(for: potID)?.lastServerSequence ?? 0
        )
    }

    private func pullAllEvents(
        for potID: PotID,
        receivedAt: Date
    ) async throws -> Int {
        do {
            var afterSequence = try store.syncState(for: potID)?.lastServerSequence ?? 0
            var ingested = 0
            while true {
                let page = try await transport.listEvents(
                    potID: potID,
                    afterSequence: afterSequence
                )
                connectionState = .connected
                try validate(page, potID: potID, afterSequence: afterSequence)
                for event in page.events {
                    _ = try store.ingestRemoteEvent(event, receivedAt: receivedAt)
                    ingested += 1
                }
                afterSequence = page.nextAfterSequence
                if !page.hasMore { return ingested }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let failure as SyncTransportError {
            throw failure
        } catch {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    private func validate(
        _ page: SyncEventPage,
        potID: PotID,
        afterSequence: Int64
    ) throws {
        var expectedSequence = afterSequence
        for hydrated in page.events {
            let event = try hydrated.eventEnvelope()
            guard expectedSequence < Int64.max else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
            expectedSequence += 1
            guard event.potID == potID,
                  hydrated.serverSequence == expectedSequence
            else {
                throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
            }
        }
        guard page.nextAfterSequence == expectedSequence,
              !page.hasMore || !page.events.isEmpty
        else {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    /// Refreshes erasure only: no promotion, financial reads or outgoing writes.
    public func refreshAuthoredText(for potID: PotID, at date: Date = Date()) async throws -> Int {
        guard activePots.insert(potID).inserted else {
            throw SyncTransportError.retryable(code: "SYNC_IN_PROGRESS")
        }
        defer { activePots.remove(potID) }
        return try await pullAllTextChanges(for: potID, receivedAt: date)
    }

    private func pullAllTextChanges(
        for potID: PotID,
        receivedAt: Date
    ) async throws -> Int {
        do {
            var afterRevision = try store.syncState(for: potID)?.lastTextRevision ?? 0
            var applied = 0
            while true {
                let page = try await transport.listTextChanges(
                    potID: potID,
                    afterRevision: afterRevision
                )
                connectionState = .connected
                try validate(page, afterRevision: afterRevision)
                _ = try store.ingestTextChangePage(page, in: potID, at: receivedAt)
                applied += page.changes.count
                afterRevision = page.nextAfterRevision
                if !page.hasMore { return applied }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let failure as SyncTransportError {
            throw failure
        } catch let failure as LedgerStoreError
        where failure.isEventNotFound {
            // Convex queries are individually consistent, but the text-change
            // snapshot can be newer than the event snapshot fetched just
            // before it. Keep both cursors and all text untouched, then retry
            // so the missing event can become visible before its tombstone.
            throw SyncTransportError.retryable(code: "TEXT_EVENT_NOT_VISIBLE")
        } catch {
            throw SyncTransportError.terminal(code: "INVALID_SERVER_RESPONSE")
        }
    }

    private func validate(
        _ page: SyncTextChangePage,
        afterRevision: Int64
    ) throws {
        _ = try page.validatedRevisions(after: afterRevision)
    }

    private func networkFailureReport(
        _ failure: SyncTransportError,
        potID: PotID,
        eventID: EventID?,
        attempt: Int,
        now: Date,
        dispatched: Int,
        ingested: Int
    ) throws -> SyncRunReport {
        switch failure {
        case .retryable:
            connectionState = .connecting
            return SyncRunReport(
                outcome: .retryScheduled(
                    eventID: eventID,
                    retryAt: retryPolicy.retryDate(
                        afterAttempt: attempt,
                        relativeTo: now
                    )
                ),
                dispatchedEventCount: dispatched,
                ingestedEventCount: ingested
            )
        case .terminal:
            return try pause(
                potID: potID,
                eventID: eventID,
                code: failure.code,
                at: now,
                dispatched: dispatched,
                ingested: ingested
            )
        }
    }

    /// The postfix form preserves original validation order: each suffix
    /// closure reproduces exactly the argument list the direct form validated.
    private func pause(
        _ postfix: () -> (
            potID: PotID, eventID: EventID?, code: String,
            dispatched: Int, ingested: Int
        ),
        at now: Date
    ) throws -> SyncRunReport {
        let (potID, eventID, code, dispatched, ingested) = postfix()
        return try pause(
            potID: potID,
            eventID: eventID,
            code: code,
            at: now,
            dispatched: dispatched,
            ingested: ingested
        )
    }

    private func pause(
        potID: PotID,
        eventID: EventID?,
        code: String,
        at now: Date,
        dispatched: Int,
        ingested: Int
    ) throws -> SyncRunReport {
        if let eventID,
                  try store.loadStoredEvents(for: potID).first(where: {
                      $0.event.id == eventID
                  })?.delivery.state == .dispatching {
            _ = try store.scheduleRetry(
                eventID: eventID,
                noEarlierThan: now,
                at: now
            )
        }
        if Self.reconciliationCodes.contains(code) { try store.setPersistedSyncPause(code, for: potID) }
        terminalFailures[potID] = code
        return SyncRunReport(
            outcome: .paused(eventID: eventID, code: code),
            dispatchedEventCount: dispatched,
            ingestedEventCount: ingested
        )
    }

    private func recordConnectionState(_ state: SyncConnectionState) {
        connectionState = state
    }

    public nonisolated static func allowsReadOnlyRefresh(code: String) -> Bool {
        reconciliationCodes.contains(code)
            && !["NOT_MEMBER", "MEMBERSHIP_ARCHIVED"].contains(code)
    }

    public func resumeAfterReconciliation(potID: PotID) throws {
        try store.setPersistedSyncPause(nil, for: potID)
        terminalFailures[potID] = nil
    }

    static let reconciliationCodes: Set<String> = [
        "TOPOLOGY_REVISION_CONFLICT", "SCHEMA_DOWNGRADE", "BUDGET_GROUPS_LOCKED",
        "BUDGET_GROUP_ACTIVATION_REQUIRED", "OWNER_UNIT_NOT_BOUND", "INACTIVE_UNIT",
        "INVALID_PAYER_MEMBER", "TOPOLOGY_REBUILD_LIMIT", "TOPOLOGY_PROJECTION_INCOMPATIBLE",
        "HISTORICAL_SETTLEMENT_VALIDATION_LIMIT", "PROMOTION_SEQUENCE_CONFLICT",
        "PROMOTION_PREREQUISITES_REQUIRED", "PROMOTION_CONFLICT", "NOT_OWNER", "NOT_MEMBER", "MEMBERSHIP_ARCHIVED",
    ]

    private static let maximumPromotionBatchSize = 100

    private static func outboundWire(for stored: StoredLedgerEvent) throws -> WireEventV1 {
        if stored.legacyAuthoredText {
            return try WireEventV1(grandfatheredStoredEvent: stored.event)
        }
        return try WireEventV1(stored.event)
    }

    /// Closed, authoritative list of immutable-record rejections. Any new or
    /// malformed terminal code defaults to a pot pause so valid local records
    /// cannot be discarded merely because the client does not recognize it.
    static let eventTerminalCodes: Set<String> = [
        "ACTOR_MISMATCH",
        "ALLOCATION_SUM_MISMATCH",
        "ALLOCATION_SUM_OVERFLOW",
        "AUTHORED_TEXT_MANIFEST_MISMATCH",
        "BLANK_CATEGORY",
        "BLANK_NOTE",
        "BLANK_REASON",
        "BLANK_TITLE",
        "CURRENCY_EXPONENT_MISMATCH",
        "CURRENCY_MISMATCH",
        "DUPLICATE_ALLOCATION_UNIT",
        "DUPLICATE_BATCH_EVENT",
        "DUPLICATE_GROUP_ID",
        "DUPLICATE_GROUP_MEMBER",
        "DUPLICATE_GROUP_UNIT_ID",
        "DUPLICATE_OPENING_BALANCE_UNIT",
        "DUPLICATE_PRESET_UNIT",
        "DUPLICATE_RECORD",
        "DUPLICATE_TEXT_FIELD",
        "DUPLICATE_UNIT_ID",
        "EMPTY_ALLOCATIONS",
        "EMPTY_GROUP_MEMBERS",
        "EMPTY_OPENING_BALANCE",
        "EMPTY_PRESET_UNITS",
        "EMPTY_UNIT_ORDER",
        "EVENT_ID_CONFLICT",
        "EVENT_POT_MISMATCH",
        "EVENT_TEXT_CONFLICT",
        "IDENTICAL_OWNERSHIP_MEMBERS",
        "IDENTICAL_SETTLEMENT_UNITS",
        "IMMUTABLE_SETTLEMENT",
        "INVALID_ACTOR_MEMBER_ID",
        "INVALID_ALLOCATION_AMOUNT",
        "INVALID_CURRENCY_CODE",
        "INVALID_CURRENCY_EXPONENT",
        "INVALID_EVENT_ID",
        "INVALID_EXPENSE_AMOUNT",
        "INVALID_GROUP_ID",
        "INVALID_GROUP_SHARE_WEIGHT",
        "INVALID_LEGACY_MIGRATION_EVENT",
        "INVALID_MEMBER_ID",
        "INVALID_OCCURRED_AT",
        "INVALID_OWNER_MEMBER_ID",
        "INVALID_PARENT_EVENT_ID",
        "INVALID_PERSONAL_ALLOCATIONS",
        "INVALID_POT_ID",
        "INVALID_PRESET_NAME",
        "INVALID_POT_NAME",
        "INVALID_POT_NAME_TOO_LONG",
        "INVALID_RECORD_ID",
        "INVALID_PRESET_NAME_TOO_LONG",
        "INVALID_RESOLUTION",
        "INVALID_RESOLUTION_EVENT_ID",
        "INVALID_SETTLEMENT_AMOUNT",
        "INVALID_TIME_ZONE",
        "INVALID_UNIT_ID",
        "MISSING_RECORD",
        "NEGATIVE_CONTRIBUTION_BUDGET_EXCEEDED",
        "NONCANONICAL_REVISION_PAIR",
        "NONCANONICAL_TEXT_FIELDS",
        "NON_SETTLEMENT_FLAG_TARGET",
        "OPENING_BALANCE_NOT_ZERO_SUM",
        "PAYER_ATTRIBUTION_REQUIRES_SCHEMA_2",
        "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
        "RECORD_KIND_CHANGED",
        "RESERVED_REDACTED_TEXT",
        "SETTLEMENT_REVERSAL_DIRECTION_MISMATCH",
        "SETTLEMENT_REVERSAL_EXCEEDS_ORIGINAL",
        "SETTLEMENT_REVERSAL_SELF_TARGET",
        "SETTLEMENT_REVERSAL_TARGET_INVALID",
        "SETTLEMENT_REVERSAL_TARGET_MISSING",
        "SETTLEMENT_REVERSAL_TARGET_NOT_FLAGGED",
        "STRUCTURAL_EVENT_NOT_AVAILABLE",
        "TEXT_FIELD_NOT_ALLOWED_CATEGORY",
        "TEXT_FIELD_NOT_ALLOWED_NOTE",
        "TEXT_FIELD_NOT_ALLOWED_REASON",
        "TEXT_FIELD_NOT_ALLOWED_TITLE",
        "TEXT_FIELD_REQUIRED_CATEGORY",
        "TEXT_FIELD_REQUIRED_NOTE",
        "TEXT_FIELD_REQUIRED_REASON",
        "TEXT_FIELD_REQUIRED_TITLE",
        "TEXT_TOO_LONG_CATEGORY",
        "TEXT_TOO_LONG_NOTE",
        "TEXT_TOO_LONG_REASON",
        "TEXT_TOO_LONG_TITLE",
        "TOO_MANY_GROUPS",
        "TOO_MANY_UNITS",
        "UNKNOWN_REVISION",
        "UNKNOWN_UNIT",
        "UNSUPPORTED_CURRENCY_CODE",
        "UNSUPPORTED_SCHEMA_VERSION",
        "UNSUPPORTED_WIRE_EVENT",
    ]
}

private extension ReductionIssue {
    var eventID: EventID? {
        switch self {
        case let .unsupportedSchema(eventID, _, _),
             let .unsupportedEventKind(eventID, _),
             let .invalidEvent(eventID, _):
            eventID
        case .unsupportedTopologySchema, .settlementPlanningFailed:
            nil
        }
    }
}
