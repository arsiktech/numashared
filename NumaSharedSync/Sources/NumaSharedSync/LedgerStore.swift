import Foundation
import GRDB
import NumaSharedCore

public enum DeliveryState: String, Codable, Hashable, Sendable {
    case held
    case ready
    case dispatching
    case acknowledged
    case terminal
}

public enum EventOrigin: String, Codable, Hashable, Sendable {
    case local
    case remote
}

public struct EventDelivery: Codable, Hashable, Sendable {
    public let eventID: EventID
    public let potID: PotID
    public let state: DeliveryState
    public let undoDeadline: Date?
    public let firstDispatchedAt: Date?
    public let attemptCount: Int
    public let nextRetryAt: Date?
    public let serverSequence: Int64?
    public let terminalReason: String?

    public init(
        eventID: EventID,
        potID: PotID,
        state: DeliveryState,
        undoDeadline: Date?,
        firstDispatchedAt: Date?,
        attemptCount: Int,
        nextRetryAt: Date?,
        serverSequence: Int64?,
        terminalReason: String?
    ) {
        self.eventID = eventID
        self.potID = potID
        self.state = state
        self.undoDeadline = undoDeadline
        self.firstDispatchedAt = firstDispatchedAt
        self.attemptCount = attemptCount
        self.nextRetryAt = nextRetryAt
        self.serverSequence = serverSequence
        self.terminalReason = terminalReason
    }
}

public struct StoredLedgerEvent: Hashable, Sendable {
    public let localOrdinal: Int64
    public let origin: EventOrigin
    public let event: EventEnvelope
    /// True only for rows admitted by the pre-v2 database and migrated without
    /// retroactively applying newer authored-text value policy.
    public let legacyAuthoredText: Bool
    public let savedAt: Date
    public let delivery: EventDelivery

    public init(
        localOrdinal: Int64,
        origin: EventOrigin,
        event: EventEnvelope,
        legacyAuthoredText: Bool = false,
        savedAt: Date,
        delivery: EventDelivery
    ) {
        self.localOrdinal = localOrdinal
        self.origin = origin
        self.event = event
        self.legacyAuthoredText = legacyAuthoredText
        self.savedAt = savedAt
        self.delivery = delivery
    }
}

public struct PotSyncState: Codable, Hashable, Sendable {
    public let potID: PotID
    /// Highest server sequence present without a gap from sequence one.
    public let lastServerSequence: Int64
    /// Highest applied authored-text change without a revision gap from one.
    public let lastTextRevision: Int64
    /// A rejected atomic promotion prefix must be followed by one successful
    /// empty promotion before any remaining records use ordinary appends.
    public let emptyPromotionRequired: Bool
    public let updatedAt: Date

    public init(
        potID: PotID,
        lastServerSequence: Int64,
        lastTextRevision: Int64 = 0,
        emptyPromotionRequired: Bool = false,
        updatedAt: Date
    ) {
        self.potID = potID
        self.lastServerSequence = lastServerSequence
        self.lastTextRevision = lastTextRevision
        self.emptyPromotionRequired = emptyPromotionRequired
        self.updatedAt = updatedAt
    }
}

/// One transactionally consistent view of every value needed to build the app
/// projection. Delivery transitions and remote ingest cannot interleave its
/// reduction, activity order, cursor, failure rows, or pending count.
public struct LedgerStoreSnapshot: Sendable {
    public let reduction: ReductionResult
    public let reductionOrderedEvents: [StoredLedgerEvent]
    public let storedEvents: [StoredLedgerEvent]
    public let syncState: PotSyncState?
    public let pendingDeliveryEventCount: Int
    public let unsyncedEventCount: Int

    public init(
        reduction: ReductionResult,
        reductionOrderedEvents: [StoredLedgerEvent],
        storedEvents: [StoredLedgerEvent],
        syncState: PotSyncState?,
        pendingDeliveryEventCount: Int,
        unsyncedEventCount: Int
    ) {
        self.reduction = reduction
        self.reductionOrderedEvents = reductionOrderedEvents
        self.storedEvents = storedEvents
        self.syncState = syncState
        self.pendingDeliveryEventCount = pendingDeliveryEventCount
        self.unsyncedEventCount = unsyncedEventCount
    }
}

public enum RemoteIngestResult: Hashable, Sendable {
    case inserted
    case acknowledgedExistingLocal
    case alreadyPresent
}

public enum DatabaseFileProtection: Hashable, Sendable {
    case none
    case completeUntilFirstUserAuthentication
}

public enum LedgerStoreError: Error, Equatable, Sendable {
    case potNotRegistered(PotID)
    case potConfigurationConflict(PotID)
    case potCurrencyAlreadyInUse(PotID)
    case eventHasServerSequence(EventID)
    case duplicateEventID(EventID)
    case eventNotFound(EventID)
    case invalidServerSequence(Int64)
    case immutableEventConflict(EventID)
    case serverSequenceConflict(potID: PotID, sequence: Int64)
    case invalidDeliveryTransition(
        eventID: EventID,
        from: DeliveryState,
        to: DeliveryState
    )
    case eventNotDispatchable(EventID)
    case attemptCountOverflow(EventID)
    case emptyTerminalReason
    case dateOutOfRange
    case corruptDeliveryState(String)
    case corruptEventOrigin(String)
    case corruptTextField(String)
    case invalidTextRedaction(EventID)
    case nonContiguousTextRevision(expected: Int64, actual: Int64)
}

extension LedgerStoreError {
    var isEventNotFound: Bool {
        if case .eventNotFound = self { return true }
        return false
    }
}

private struct ReductionEventOrder {
    let storedEvents: [StoredLedgerEvent]
    let optimisticEventIDs: Set<EventID>

    var envelopes: [EventEnvelope] {
        storedEvents.map { stored in
            guard optimisticEventIDs.contains(stored.event.id) else {
                return stored.event
            }
            return PersistenceCoding.overlay(serverSequence: nil, on: stored.event)
        }
    }
}

/// A transactionally consistent SQLite store for immutable ledger events and
/// their separately mutable transport state. It never logs payloads or text.
public final class LedgerStore: Sendable {
    let databaseQueue: DatabaseQueue
    public let readerSchemaVersion: UInt16

    // MARK: - Initialization and file protection

    public init(
        path: String,
        fileProtection: DatabaseFileProtection = .completeUntilFirstUserAuthentication,
        now: Date = Date(),
        readerSchemaVersion: UInt16 = EventEnvelope.currentSchemaVersion
    ) throws {
        self.readerSchemaVersion = min(readerSchemaVersion, EventEnvelope.maximumSupportedSchemaVersion)
        try Self.prepareDatabaseFile(
            atPath: path,
            fileProtection: fileProtection
        )
        var configuration = Configuration()
        configuration.journalMode = .wal
        databaseQueue = try DatabaseQueue(
            path: path,
            configuration: configuration
        )
        try Self.migrator.migrate(databaseQueue)
        try releaseRecoverableEvents(now: now)
        try Self.apply(fileProtection: fileProtection, toDatabaseAtPath: path)
    }

    init(databaseQueue: DatabaseQueue, now: Date = Date(), readerSchemaVersion: UInt16 = EventEnvelope.currentSchemaVersion) throws {
        self.readerSchemaVersion = min(readerSchemaVersion, EventEnvelope.maximumSupportedSchemaVersion)
        self.databaseQueue = databaseQueue
        try Self.migrator.migrate(databaseQueue)
        try releaseRecoverableEvents(now: now)
    }

    public static func inMemory(now: Date = Date(), readerSchemaVersion: UInt16 = EventEnvelope.currentSchemaVersion) throws -> LedgerStore {
        try LedgerStore(databaseQueue: DatabaseQueue(), now: now, readerSchemaVersion: readerSchemaVersion)
    }

    /// Reapplies iOS data protection to the database and any existing sidecars.
    /// Call after moving/restoring a database file; normal path initialization
    /// applies it automatically.
    public static func apply(
        fileProtection: DatabaseFileProtection,
        toDatabaseAtPath path: String
    ) throws {
        #if os(iOS) || os(tvOS) || os(watchOS)
        let protectionType: FileProtectionType = switch fileProtection {
        case .none: .none
        case .completeUntilFirstUserAuthentication: .completeUntilFirstUserAuthentication
        }
        for candidate in [path, path + "-wal", path + "-shm", path + "-journal"]
        where FileManager.default.fileExists(atPath: candidate) {
            try FileManager.default.setAttributes(
                [.protectionKey: protectionType],
                ofItemAtPath: candidate
            )
        }
        #else
        _ = fileProtection
        _ = path
        #endif
    }

    // MARK: - Pot registration and sync state

    public func registerPot(
        _ configuration: PotConfiguration,
        at date: Date = Date()
    ) throws {
        let blob = try PersistenceCoding.encode(configuration)
        let createdAt = try PersistenceCoding.milliseconds(date)
        try databaseQueue.write { db in
            if let existing: Data = try Data.fetchOne(
                db,
                sql: "SELECT configurationBlob FROM pot_configurations WHERE potID = ?",
                arguments: [configuration.id.description]
            ) {
                let storedConfiguration = try PersistenceCoding.decode(
                    PotConfiguration.self,
                    from: existing
                )
                guard storedConfiguration == configuration else {
                    throw LedgerStoreError.potConfigurationConflict(configuration.id)
                }
                return
            }
            try db.execute(
                sql: """
                    INSERT INTO pot_configurations (
                        potID, currencyCode, currencyExponent, configurationBlob, createdAtMillis
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                arguments: [
                    configuration.id.description,
                    configuration.currency.code,
                    configuration.currency.exponent,
                    blob,
                    createdAt,
                ]
            )
            try db.execute(
                sql: """
                    INSERT INTO pot_sync_state (potID, lastServerSequence, updatedAtMillis)
                    VALUES (?, 0, ?)
                    """,
                arguments: [configuration.id.description, createdAt]
            )
        }
    }

    public func potConfiguration(for potID: PotID) throws -> PotConfiguration? {
        try databaseQueue.read { db in
            guard let blob: Data = try Data.fetchOne(
                db,
                sql: "SELECT configurationBlob FROM pot_configurations WHERE potID = ?",
                arguments: [potID.description]
            ) else { return nil }
            return try PersistenceCoding.decode(PotConfiguration.self, from: blob)
        }
    }

    /// Confirms the creation-time pot currency. Once setup or ledger history
    /// exists, changing it would be a conversion and is forbidden in v1.
    public func confirmPotCurrency(
        _ currency: Currency,
        for potID: PotID,
        orderedUnitIDs: [UnitID]? = nil
    ) throws {
        try databaseQueue.write { db in
            guard let blob: Data = try Data.fetchOne(
                db,
                sql: "SELECT configurationBlob FROM pot_configurations WHERE potID = ?",
                arguments: [potID.description]
            ) else { throw LedgerStoreError.potNotRegistered(potID) }
            let existing = try PersistenceCoding.decode(
                PotConfiguration.self,
                from: blob
            )
            if existing.currency == currency, orderedUnitIDs == nil || orderedUnitIDs == existing.orderedUnitIDs { return }
            let hasEvents = try Bool.fetchOne(
                db,
                sql: "SELECT EXISTS(SELECT 1 FROM ledger_events WHERE potID = ?)",
                arguments: [potID.description]
            ) ?? false
            let hasSetup = try Bool.fetchOne(
                db,
                sql: "SELECT EXISTS(SELECT 1 FROM local_pot_setup WHERE potID = ?)",
                arguments: [potID.description]
            ) ?? false
            guard !hasEvents, !hasSetup else {
                throw LedgerStoreError.potCurrencyAlreadyInUse(potID)
            }
            let confirmed = try PotConfiguration(
                id: existing.id,
                currency: currency,
                topology: try orderedUnitIDs.map { try PotConfiguration(id: potID, currency: currency, orderedUnitIDs: $0).topology } ?? existing.topology
            )
            let createdAt: Int64 = try Int64.fetchOne(
                db,
                sql: "SELECT createdAtMillis FROM pot_configurations WHERE potID = ?",
                arguments: [potID.description]
            ) ?? 0
            // The schema intentionally rejects configuration UPDATEs. Replace
            // the unused provisional row atomically so that post-creation
            // configuration remains immutable at the database boundary.
            try db.execute(
                sql: "DELETE FROM pot_sync_state WHERE potID = ?",
                arguments: [potID.description]
            )
            try db.execute(
                sql: "DELETE FROM pot_configurations WHERE potID = ?",
                arguments: [potID.description]
            )
            try db.execute(
                sql: """
                    INSERT INTO pot_configurations (
                        potID, currencyCode, currencyExponent, configurationBlob, createdAtMillis
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                arguments: [
                    potID.description,
                    currency.code,
                    currency.exponent,
                    try PersistenceCoding.encode(confirmed),
                    createdAt,
                ]
            )
            try db.execute(
                sql: """
                    INSERT INTO pot_sync_state (potID, lastServerSequence, updatedAtMillis)
                    VALUES (?, 0, ?)
                    """,
                arguments: [potID.description, createdAt]
            )
        }
    }

    public func potConfigurations() throws -> [PotConfiguration] {
        try databaseQueue.read { db in
            let blobs = try Data.fetchAll(
                db,
                sql: """
                    SELECT configurationBlob FROM pot_configurations
                    ORDER BY createdAtMillis, potID
                    """
            )
            return try blobs.map {
                try PersistenceCoding.decode(PotConfiguration.self, from: $0)
            }
        }
    }

    public func syncState(for potID: PotID) throws -> PotSyncState? {
        try databaseQueue.read { db in
            guard let row = try Row.fetchOne(
                db,
                sql: """
                    SELECT lastServerSequence, lastTextRevision,
                           emptyPromotionRequired, updatedAtMillis
                    FROM pot_sync_state WHERE potID = ?
                    """,
                arguments: [potID.description]
            ) else { return nil }
            let updatedAtMillis: Int64 = row["updatedAtMillis"]
            return PotSyncState(
                potID: potID,
                lastServerSequence: row["lastServerSequence"],
                lastTextRevision: row["lastTextRevision"],
                emptyPromotionRequired: (row["emptyPromotionRequired"] as Int64) == 1,
                updatedAt: PersistenceCoding.date(milliseconds: updatedAtMillis) ?? .distantPast
            )
        }
    }

    public func snapshot(
        for potID: PotID,
        reducer: LedgerReducer? = nil
    ) throws -> LedgerStoreSnapshot {
        let reducer = reducer ?? LedgerReducer(supportedSchemaVersion: readerSchemaVersion)
        return try databaseQueue.read { db in
            guard let configurationBlob: Data = try Data.fetchOne(
                db,
                sql: "SELECT configurationBlob FROM pot_configurations WHERE potID = ?",
                arguments: [potID.description]
            ) else {
                throw LedgerStoreError.potNotRegistered(potID)
            }
            let pot = try PersistenceCoding.decode(
                PotConfiguration.self,
                from: configurationBlob
            )
            let order = try makeReductionEventOrder(
                for: potID,
                reducer: reducer,
                in: db
            )
            let reductionEvents = try Self.reductionEvents(
                potID: potID,
                order: order.envelopes,
                in: db
            )
            let rows = try Row.fetchAll(
                db,
                sql: Self.eventSelectionSQL + "\n" + """
                    WHERE e.potID = ?
                    ORDER BY
                        CASE WHEN d.serverSequence IS NULL THEN 1 ELSE 0 END,
                        d.serverSequence,
                        e.localOrdinal
                    """,
                arguments: [potID.description]
            )
            let storedEvents = try rows.map {
                try PersistenceCoding.storedEvent(from: $0, in: db)
            }
            let syncRow = try Row.fetchOne(
                db,
                sql: """
                    SELECT lastServerSequence, lastTextRevision,
                           emptyPromotionRequired, updatedAtMillis
                    FROM pot_sync_state WHERE potID = ?
                    """,
                arguments: [potID.description]
            )
            let syncState: PotSyncState? = syncRow.map { row in
                let updatedAtMillis: Int64 = row["updatedAtMillis"]
                return PotSyncState(
                    potID: potID,
                    lastServerSequence: row["lastServerSequence"],
                    lastTextRevision: row["lastTextRevision"],
                    emptyPromotionRequired: (row["emptyPromotionRequired"] as Int64) == 1,
                    updatedAt: PersistenceCoding.date(milliseconds: updatedAtMillis)
                        ?? .distantPast
                )
            }
            let pending = try Int.fetchOne(
                db,
                sql: """
                    SELECT COUNT(*) FROM event_delivery
                    WHERE potID = ? AND state IN ('held', 'ready', 'dispatching')
                    """,
                arguments: [potID.description]
            ) ?? 0
            let unsynced = try Int.fetchOne(
                db,
                sql: """
                    SELECT COUNT(*) FROM event_delivery
                    WHERE potID = ? AND state <> 'acknowledged'
                    """,
                arguments: [potID.description]
            ) ?? 0
            return LedgerStoreSnapshot(
                reduction: reducer.reduce(pot: pot, events: reductionEvents),
                reductionOrderedEvents: order.storedEvents,
                storedEvents: storedEvents,
                syncState: syncState,
                pendingDeliveryEventCount: pending,
                unsyncedEventCount: unsynced
            )
        }
    }

    /// Removes every pot, event, delivery row, text sidecar, roster, and setup
    /// value from this device in one transaction. Account sign-out and deletion
    /// call this only after an explicit user confirmation.
    public func eraseAllLocalData() throws {
        try databaseQueue.write { db in
            try db.execute(sql: "PRAGMA secure_delete = ON")
            try db.execute(sql: "DELETE FROM ledger_events")
            try db.execute(sql: "DELETE FROM pot_sync_state")
            try db.execute(sql: "DELETE FROM cached_pot_member_profiles")
            try db.execute(sql: "DELETE FROM local_pot_member_profiles")
            try db.execute(sql: "DELETE FROM local_pot_setup")
            try db.execute(sql: "DELETE FROM pot_configurations")
            try db.execute(
                sql: "DELETE FROM sqlite_sequence WHERE name = 'ledger_events'"
            )
        }
    }

    // MARK: - Immutable event log and reduction

    @discardableResult
    public func appendHeldLocalEvent(
        _ event: EventEnvelope,
        savedAt: Date = Date()
    ) throws -> StoredLedgerEvent {
        try databaseQueue.write { db in
            try appendLocalEvent(event, savedAt: savedAt, in: db)
        }
    }

    /// Shared transaction boundary for setup prerequisites and dependent money.
    func appendLocalEvent(_ event: EventEnvelope, savedAt: Date, in db: Database) throws -> StoredLedgerEvent {
        guard event.serverSequence == nil else {
            throw LedgerStoreError.eventHasServerSequence(event.id)
        }
        let canonical = PersistenceCoding.canonicalEnvelope(event)
        let prepared = try PersistenceCoding.prepareForStorage(canonical)
        let savedAtMillis = try PersistenceCoding.milliseconds(savedAt)
        let deadlineMillis = try PersistenceCoding.milliseconds(
            savedAt.addingTimeInterval(UndoPolicy.window)
        )
        let fields = PersistenceCoding.fields(for: event.payload)

            try requireRegisteredPot(event.potID, in: db)
            guard try !eventExists(event.id, in: db) else {
                throw LedgerStoreError.duplicateEventID(event.id)
            }
            let localOrdinal = try insertImmutableEvent(
                canonical,
                origin: .local,
                blob: prepared.arithmeticBlob,
                fields: fields,
                savedAtMillis: savedAtMillis,
                in: db
            )
            try insertErasureSidecars(
                prepared,
                eventID: event.id,
                in: db
            )
            try db.execute(
                sql: """
                    INSERT INTO event_delivery (
                        eventID, potID, state, undoDeadlineMillis, firstDispatchedAtMillis,
                        attemptCount, nextRetryAtMillis, serverSequence, terminalReason,
                        updatedAtMillis
                    ) VALUES (?, ?, 'held', ?, NULL, 0, NULL, NULL, NULL, ?)
                    """,
                arguments: [
                    event.id.description,
                    event.potID.description,
                    deadlineMillis,
                    savedAtMillis,
                ]
            )
            return StoredLedgerEvent(
                localOrdinal: localOrdinal,
                origin: .local,
                event: canonical,
                legacyAuthoredText: false,
                savedAt: savedAt,
                delivery: EventDelivery(
                    eventID: event.id,
                    potID: event.potID,
                    state: .held,
                    undoDeadline: savedAt.addingTimeInterval(UndoPolicy.window),
                    firstDispatchedAt: nil,
                    attemptCount: 0,
                    nextRetryAt: nil,
                    serverSequence: nil,
                    terminalReason: nil
                )
            )
    }

    public func loadEvents(for potID: PotID) throws -> [EventEnvelope] {
        try loadStoredEvents(for: potID).map(\.event)
    }

    public func loadStoredEvents(for potID: PotID) throws -> [StoredLedgerEvent] {
        try databaseQueue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: Self.eventSelectionSQL + "\n" + """
                    WHERE e.potID = ?
                    ORDER BY
                        CASE WHEN d.serverSequence IS NULL THEN 1 ELSE 0 END,
                        d.serverSequence,
                        e.localOrdinal
                    """,
                arguments: [potID.description]
            )
            return try rows.map { try PersistenceCoding.storedEvent(from: $0, in: db) }
        }
    }

    /// Returns the exact stored-event order used to rebuild a projection:
    /// contiguous acknowledged prefix, the earliest incompatible acknowledged
    /// event above a gap (if any), then the local optimistic tail.
    ///
    /// Callers can use this for activity ordering without reimplementing sync
    /// cursor semantics. A custom reducer must be passed here as well as to
    /// `reduction(for:reducer:)` so its schema ceiling selects the same barrier.
    public func reductionOrderedEvents(
        for potID: PotID,
        reducer: LedgerReducer? = nil
    ) throws -> [StoredLedgerEvent] {
        let reducer = reducer ?? LedgerReducer(supportedSchemaVersion: readerSchemaVersion)
        return try databaseQueue.read { db in
            try makeReductionEventOrder(
                for: potID,
                reducer: reducer,
                in: db
            ).storedEvents
        }
    }

    public func reduction(
        for potID: PotID,
        reducer: LedgerReducer? = nil
    ) throws -> ReductionResult {
        let reducer = reducer ?? LedgerReducer(supportedSchemaVersion: readerSchemaVersion)
        return try databaseQueue.read { db in
            guard let configurationBlob: Data = try Data.fetchOne(
                db,
                sql: "SELECT configurationBlob FROM pot_configurations WHERE potID = ?",
                arguments: [potID.description]
            ) else {
                throw LedgerStoreError.potNotRegistered(potID)
            }
            let pot = try PersistenceCoding.decode(
                PotConfiguration.self,
                from: configurationBlob
            )
            let order = try makeReductionEventOrder(
                for: potID,
                reducer: reducer,
                in: db
            )
            let events = try Self.reductionEvents(
                potID: potID,
                order: order.envelopes,
                in: db
            )
            return reducer.reduce(pot: pot, events: events)
        }
    }

    private static func reductionEvents(
        potID: PotID,
        order: [EventEnvelope],
        in db: Database
    ) throws -> [EventEnvelope] {
        guard let setup = try localPotSetup(for: potID, in: db) else {
            return order
        }
        let storedIDs = Set(order.map(\.id))
        let pendingBindings: [EventEnvelope] = try setup.bindings.compactMap { binding in
            guard !storedIDs.contains(binding.event.eventId) else { return nil }
            return try binding.event.eventEnvelope(
                serverSequence: nil,
                textStates: []
            )
        }
        return pendingBindings + order
    }

    // MARK: - Undo and outbound delivery

    @discardableResult
    public func undoHeldLocalEvent(
        eventID: EventID,
        now: Date = Date(),
        undoSessionIsActive: Bool
    ) throws -> Bool {
        try databaseQueue.write { db in
            guard let row = try Row.fetchOne(
                db,
                sql: Self.eventSelectionSQL + " WHERE e.eventID = ?",
                arguments: [eventID.description]
            ) else { throw LedgerStoreError.eventNotFound(eventID) }
            let event = try PersistenceCoding.storedEvent(from: row, in: db)
            let dispatchState: EventDispatchState = switch event.delivery.state {
            case .held: .heldLocally
            case .ready, .dispatching: .dispatching
            case .acknowledged, .terminal: .dispatched
            }
            guard event.delivery.firstDispatchedAt == nil,
                  event.delivery.serverSequence == nil,
                  UndoPolicy.canDeleteLocalEvent(
                      savedAt: event.savedAt,
                      now: now,
                      dispatchState: dispatchState,
                      undoSessionIsActive: undoSessionIsActive
                  )
            else { return false }
            try db.execute(
                sql: "DELETE FROM ledger_events WHERE eventID = ?",
                arguments: [eventID.description]
            )
            return db.changesCount == 1
        }
    }

    @discardableResult
    public func expireHeldEvents(now: Date = Date()) throws -> Int {
        let nowMillis = try PersistenceCoding.milliseconds(now)
        return try databaseQueue.write { db in
            try db.execute(
                sql: """
                    UPDATE event_delivery
                    SET state = 'ready', updatedAtMillis = ?
                    WHERE state = 'held' AND undoDeadlineMillis <= ?
                    """,
                arguments: [nowMillis, nowMillis]
            )
            return db.changesCount
        }
    }

    /// Recovery at open time: request death returns dispatching rows to the
    /// queue, and the end of every in-memory undo session makes persisted held
    /// events eligible for the per-pot single-flight queue immediately.
    private func releaseRecoverableEvents(now: Date) throws {
        let nowMillis = try PersistenceCoding.milliseconds(now)
        try databaseQueue.write { db in
            try db.execute(
                sql: """
                    UPDATE event_delivery
                    SET state = 'ready', nextRetryAtMillis = NULL, updatedAtMillis = ?
                    WHERE state = 'dispatching'
                    """,
                arguments: [nowMillis]
            )
            try db.execute(
                sql: """
                    UPDATE event_delivery
                    SET state = 'ready', updatedAtMillis = ?
                    WHERE state = 'held'
                    """,
                arguments: [nowMillis]
            )
        }
    }
    /// Returns at most the single eligible head of the per-pot outbound queue.
    /// A later event never passes a held, retrying, or in-flight predecessor.
    public func readyEvents(
        for potID: PotID,
        at date: Date = Date()
    ) throws -> [StoredLedgerEvent] {
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.read { db in
            guard let row = try Row.fetchOne(
                db,
                sql: Self.eventSelectionSQL + "\n" + """
                    WHERE e.potID = ?
                      AND d.state NOT IN ('acknowledged', 'terminal')
                    ORDER BY e.localOrdinal
                    LIMIT 1
                    """,
                arguments: [potID.description]
            ) else { return [] }
            let stored = try PersistenceCoding.storedEvent(from: row, in: db)
            let nextRetryAtMillis: Int64? = row["nextRetryAtMillis"]
            guard stored.delivery.state == .ready,
                  nextRetryAtMillis.map({ $0 <= nowMillis }) ?? true
            else { return [] }
            return [stored]
        }
    }

    // MARK: - Dispatch, acknowledgement, and rejection

    @discardableResult
    public func markDispatching(
        eventID: EventID,
        at date: Date = Date()
    ) throws -> EventDelivery {
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            try markDispatching(
                eventID: eventID,
                at: date,
                nowMillis: nowMillis,
                in: db
            )
        }
    }

    @discardableResult
    public func scheduleRetry(
        eventID: EventID,
        noEarlierThan retryDate: Date,
        at date: Date = Date()
    ) throws -> EventDelivery {
        let retryMillis = try PersistenceCoding.milliseconds(retryDate)
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            let current = try requireDelivery(eventID, in: db)
            guard current.state == .dispatching else {
                throw LedgerStoreError.invalidDeliveryTransition(
                    eventID: eventID,
                    from: current.state,
                    to: .ready
                )
            }
            try db.execute(
                sql: """
                    UPDATE event_delivery
                    SET state = 'ready', nextRetryAtMillis = ?, updatedAtMillis = ?
                    WHERE eventID = ?
                    """,
                arguments: [retryMillis, nowMillis, eventID.description]
            )
            return try requireDelivery(eventID, in: db)
        }
    }

    /// Makes only retry-delayed ready rows eligible for an explicit user retry.
    /// It never changes queue state, attempt history, held undo, or terminal rows.
    @discardableResult
    public func makeRetryEligible(
        potID: PotID,
        at date: Date = Date()
    ) throws -> Int {
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            try requireRegisteredPot(potID, in: db)
            try db.execute(
                sql: """
                    UPDATE event_delivery
                    SET nextRetryAtMillis = NULL, updatedAtMillis = ?
                    WHERE potID = ? AND state = 'ready' AND nextRetryAtMillis IS NOT NULL
                    """,
                arguments: [nowMillis, potID.description]
            )
            return db.changesCount
        }
    }

    @discardableResult
    public func acknowledge(
        eventID: EventID,
        serverSequence: Int64,
        at date: Date = Date()
    ) throws -> EventDelivery {
        guard serverSequence > 0 else {
            throw LedgerStoreError.invalidServerSequence(serverSequence)
        }
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            try acknowledge(
                eventID: eventID,
                serverSequence: serverSequence,
                nowMillis: nowMillis,
                in: db
            )
        }
    }

    /// Commits a successful accountless-pot promotion as one local
    /// transaction. Any invalid transition or sequence conflict rolls every
    /// delivery row back to its pre-promotion state.
    @discardableResult
    public func acknowledgePromotionBatch(
        _ acknowledgements: [EventAcknowledgement],
        at date: Date = Date()
    ) throws -> [EventDelivery] {
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            var deliveries: [EventDelivery] = []
            deliveries.reserveCapacity(acknowledgements.count)
            for acknowledgement in acknowledgements {
                _ = try markDispatching(
                    eventID: acknowledgement.eventID,
                    at: date,
                    nowMillis: nowMillis,
                    in: db
                )
                deliveries.append(try acknowledge(
                    eventID: acknowledgement.eventID,
                    serverSequence: acknowledgement.serverSequence,
                    nowMillis: nowMillis,
                    in: db
                ))
            }
            return deliveries
        }
    }

    @discardableResult
    public func ingestRemoteEvent(
        _ event: EventEnvelope,
        receivedAt: Date = Date()
    ) throws -> RemoteIngestResult {
        guard let serverSequence = event.serverSequence, serverSequence > 0 else {
            throw LedgerStoreError.invalidServerSequence(event.serverSequence ?? 0)
        }
        let canonical = PersistenceCoding.canonicalEnvelope(event)
        let prepared = try PersistenceCoding.prepareForStorage(canonical)
        return try ingestPreparedRemoteEvent(
            canonical,
            prepared: prepared,
            serverSequence: serverSequence,
            redactedFields: [],
            receivedAt: receivedAt
        )
    }

    @discardableResult
    public func ingestRemoteEvent(
        _ hydrated: HydratedWireEventV1,
        receivedAt: Date = Date()
    ) throws -> RemoteIngestResult {
        let event = try hydrated.eventEnvelope()
        let presentText: [WireAuthoredTextV1] = hydrated.textStates.compactMap { state in
            guard case let .present(field, value) = state else { return nil }
            return WireAuthoredTextV1(field: field, value: value)
        }
        let prepared: PreparedStoredEvent
        if case let .unsupported(kind, payload) = event.payload {
            prepared = PreparedStoredEvent(
                arithmeticBlob: try PersistenceCoding.encode(StoredUnsupportedEventV1(
                    event: event,
                    kind: kind,
                    textFields: hydrated.event.textFields,
                    opaqueFutureOriginatingTimeZoneIdentifier:
                        hydrated.event.opaqueFutureOriginatingTimeZoneIdentifier,
                    opaqueFutureTextFields: hydrated.event.opaqueFutureTextFields
                )),
                authoredText: presentText,
                opaquePayloadBlob: try PersistenceCoding.encode(payload),
                opaqueFutureTextStatesBlob: try hydrated.opaqueFutureTextStates.map {
                    try PersistenceCoding.encode($0)
                }
            )
        } else {
            prepared = PreparedStoredEvent(
                arithmeticBlob: try PersistenceCoding.encode(hydrated.event.arithmeticOnly),
                authoredText: presentText,
                opaquePayloadBlob: nil,
                opaqueFutureTextStatesBlob: nil
            )
        }
        let redactedFields: [WireTextFieldV1] = hydrated.textStates.compactMap { state in
            guard case let .redacted(field) = state else { return nil }
            return field
        }
        return try ingestPreparedRemoteEvent(
            PersistenceCoding.canonicalEnvelope(event),
            prepared: prepared,
            serverSequence: hydrated.serverSequence,
            redactedFields: redactedFields,
            receivedAt: receivedAt
        )
    }

    private func ingestPreparedRemoteEvent(
        _ canonical: EventEnvelope,
        prepared: PreparedStoredEvent,
        serverSequence: Int64,
        redactedFields: [WireTextFieldV1],
        receivedAt: Date
    ) throws -> RemoteIngestResult {
        let receivedAtMillis = try PersistenceCoding.milliseconds(receivedAt)
        let fields = PersistenceCoding.fields(for: canonical.payload)

        return try databaseQueue.write { db in
            try requireRegisteredPot(canonical.potID, in: db)
            if let row = try Row.fetchOne(
                db,
                sql: Self.eventSelectionSQL + " WHERE e.eventID = ?",
                arguments: [canonical.id.description]
            ) {
                let existingBlob: Data = row["envelopeBlob"]
                guard existingBlob == prepared.arithmeticBlob else {
                    throw LedgerStoreError.immutableEventConflict(canonical.id)
                }
                try reconcileExistingErasureSidecars(
                    prepared,
                    redactedFields: redactedFields,
                    eventID: canonical.id,
                    in: db
                )
                let existing = try PersistenceCoding.storedEvent(from: row, in: db)
                if existing.delivery.state == .acknowledged {
                    guard existing.delivery.serverSequence == serverSequence else {
                        throw LedgerStoreError.serverSequenceConflict(
                            potID: canonical.potID,
                            sequence: serverSequence
                        )
                    }
                    return .alreadyPresent
                }
                try requireSequenceAvailable(
                    serverSequence,
                    potID: canonical.potID,
                    excluding: canonical.id,
                    in: db
                )
                try setAcknowledged(
                    eventID: canonical.id,
                    potID: canonical.potID,
                    serverSequence: serverSequence,
                    nowMillis: receivedAtMillis,
                    in: db
                )
                return .acknowledgedExistingLocal
            }

            try requireSequenceAvailable(
                serverSequence,
                potID: canonical.potID,
                excluding: nil,
                in: db
            )
            _ = try insertImmutableEvent(
                canonical,
                origin: .remote,
                blob: prepared.arithmeticBlob,
                fields: fields,
                savedAtMillis: receivedAtMillis,
                in: db
            )
            try insertErasureSidecars(
                prepared,
                eventID: canonical.id,
                in: db
            )
            try db.execute(
                sql: """
                    INSERT INTO event_delivery (
                        eventID, potID, state, undoDeadlineMillis, firstDispatchedAtMillis,
                        attemptCount, nextRetryAtMillis, serverSequence, terminalReason,
                        updatedAtMillis
                    ) VALUES (?, ?, 'acknowledged', NULL, NULL, 0, NULL, ?, NULL, ?)
                    """,
                arguments: [
                    canonical.id.description,
                    canonical.potID.description,
                    serverSequence,
                    receivedAtMillis,
                ]
            )
            try advanceSyncCursor(
                potID: canonical.potID,
                nowMillis: receivedAtMillis,
                in: db
            )
            return .inserted
        }
    }

    @discardableResult
    public func markTerminal(
        eventID: EventID,
        reason: String,
        at date: Date = Date()
    ) throws -> EventDelivery {
        guard !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LedgerStoreError.emptyTerminalReason
        }
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            let current = try requireDelivery(eventID, in: db)
            guard current.state == .ready || current.state == .dispatching else {
                throw LedgerStoreError.invalidDeliveryTransition(
                    eventID: eventID,
                    from: current.state,
                    to: .terminal
                )
            }
            try db.execute(
                sql: """
                    UPDATE event_delivery
                    SET state = 'terminal', terminalReason = ?, nextRetryAtMillis = NULL,
                        updatedAtMillis = ?
                    WHERE eventID = ?
                    """,
                arguments: [reason, nowMillis, eventID.description]
            )
            return try requireDelivery(eventID, in: db)
        }
    }

    /// Records an atomically rejected promotion attempt and the durable need
    /// to create the remote pot with an empty promotion. Every selected row
    /// and the recovery marker commit together or none do.
    @discardableResult
    public func markPromotionBatchTerminalAndRequireEmptyPromotion(
        eventIDs: [EventID],
        potID: PotID,
        reason: String,
        at date: Date = Date()
    ) throws -> [EventDelivery] {
        guard !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LedgerStoreError.emptyTerminalReason
        }
        let nowMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            try requireRegisteredPot(potID, in: db)
            var deliveries: [EventDelivery] = []
            deliveries.reserveCapacity(eventIDs.count)
            for eventID in eventIDs {
                let current = try requireDelivery(eventID, in: db)
                guard current.potID == potID else {
                    throw LedgerStoreError.eventNotFound(eventID)
                }
                guard current.state == .ready || current.state == .dispatching else {
                    throw LedgerStoreError.invalidDeliveryTransition(
                        eventID: eventID,
                        from: current.state,
                        to: .terminal
                    )
                }
                try db.execute(
                    sql: """
                        UPDATE event_delivery
                        SET state = 'terminal', terminalReason = ?, nextRetryAtMillis = NULL,
                            updatedAtMillis = ?
                        WHERE eventID = ?
                        """,
                    arguments: [reason, nowMillis, eventID.description]
                )
                deliveries.append(try requireDelivery(eventID, in: db))
            }
            try db.execute(
                sql: """
                    UPDATE pot_sync_state
                    SET emptyPromotionRequired = 1, updatedAtMillis = ?
                    WHERE potID = ?
                    """,
                arguments: [nowMillis, potID.description]
            )
            return deliveries
        }
    }

    /// Clears the recovery marker only after the server has successfully
    /// accepted the empty promotion. A failed or interrupted request leaves it
    /// set for the next process.
    public func acknowledgeEmptyPromotion(
        potID: PotID,
        at date: Date = Date()
    ) throws {
        let nowMillis = try PersistenceCoding.milliseconds(date)
        try databaseQueue.write { db in
            try requireRegisteredPot(potID, in: db)
            try db.execute(
                sql: """
                    UPDATE pot_sync_state
                    SET emptyPromotionRequired = 0, updatedAtMillis = ?
                    WHERE potID = ?
                    """,
                arguments: [nowMillis, potID.description]
            )
        }
    }

    public func unsyncedEventCount(for potID: PotID) throws -> Int {
        try databaseQueue.read { db in
            try Int.fetchOne(
                db,
                sql: """
                    SELECT COUNT(*) FROM event_delivery
                    WHERE potID = ? AND state <> 'acknowledged'
                    """,
                arguments: [potID.description]
            ) ?? 0
        }
    }

    /// Delivery work that can still progress. Terminal attempts remain in
    /// `unsyncedEventCount` for loss/sign-out guards, but must never be
    /// described to the user as waiting or retryable.
    public func pendingDeliveryEventCount(for potID: PotID) throws -> Int {
        try databaseQueue.read { db in
            try Int.fetchOne(
                db,
                sql: """
                    SELECT COUNT(*) FROM event_delivery
                    WHERE potID = ? AND state IN ('held', 'ready', 'dispatching')
                    """,
                arguments: [potID.description]
            ) ?? 0
        }
    }

    // MARK: - Storage helpers

    public func textStates(for eventID: EventID) throws -> [WireTextStateV1] {
        try databaseQueue.read { db in
            guard let data: Data = try Data.fetchOne(
                db,
                sql: "SELECT envelopeBlob FROM ledger_events WHERE eventID = ?",
                arguments: [eventID.description]
            ) else { throw LedgerStoreError.eventNotFound(eventID) }
            switch try PersistenceCoding.storedArithmeticEvent(from: data) {
            case let .wire(wire):
                return try PersistenceCoding.textStates(for: wire, in: db)
            case let .unsupported(unsupported):
                return try PersistenceCoding.textStates(for: unsupported, in: db)
            }
        }
    }

    /// Hard-deletes authored values while the immutable manifest remains as
    /// the redaction tombstone used by every later hydration and replay.
    /// Hard-deletes authored values and every erasure-capable sidecar for the
    /// selected fields while the immutable manifest remains as the redaction
    /// tombstone used by every later hydration and replay. Passing no fields
    /// redacts the whole manifest, which leaves nothing erasure-capable.
    @discardableResult
    public func redactAuthoredText(
        for eventID: EventID,
        fields: [WireTextFieldV1]? = nil
    ) throws -> Int {
        let eraseEverything = fields == nil
        let selectedFields = fields.map { Set($0) }
        return try databaseQueue.write { db -> Int in
            guard let data: Data = try Data.fetchOne(
                db,
                sql: "SELECT envelopeBlob FROM ledger_events WHERE eventID = ?",
                arguments: [eventID.description]
            ) else { throw LedgerStoreError.eventNotFound(eventID) }
            let manifest: [WireTextFieldV1] = switch try PersistenceCoding
                .storedArithmeticEvent(from: data) {
            case let .wire(wire): wire.textFields
            case let .unsupported(unsupported): unsupported.textFields
            }
            let selected = selectedFields ?? Set(manifest)
            var deleted = 0
            for field in manifest where selected.contains(field) {
                try db.execute(
                    sql: "DELETE FROM event_text_sidecars WHERE eventID = ? AND field = ?",
                    arguments: [eventID.description, field.rawValue]
                )
                deleted += db.changesCount
            }
            if eraseEverything {
                try db.execute(
                    sql: "DELETE FROM event_opaque_sidecars WHERE eventID = ?",
                    arguments: [eventID.description]
                )
                deleted += db.changesCount
                try db.execute(
                    sql: "DELETE FROM event_future_text_sidecars WHERE eventID = ?",
                    arguments: [eventID.description]
                )
                deleted += db.changesCount
            }
            try redactOpaqueFutureTextStates(
                eventID: eventID,
                fields: selected,
                in: db
            )
            return deleted
        }
    }

    /// Applies one server text tombstone and advances its independent cursor
    /// in the same transaction. Replays and gaps fail before deleting text.
    @discardableResult
    public func redactAuthoredText(
        for eventID: EventID,
        field: WireTextFieldV1,
        in potID: PotID,
        advancingToTextRevision revision: Int64,
        at date: Date = Date()
    ) throws -> Int {
        let updatedAtMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            try redactAuthoredText(for: eventID, field: field, in: potID,
                advancingToTextRevision: revision, updatedAtMillis: updatedAtMillis, database: db)
        }
    }

    /// Applies a fully accounted-for revision page atomically. Explicit skips
    /// advance the cursor without exposing or requiring inaccessible events.
    @discardableResult
    public func ingestTextChangePage(
        _ page: SyncTextChangePage,
        in potID: PotID,
        at date: Date = Date()
    ) throws -> Int {
        let updatedAtMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            try requireRegisteredPot(potID, in: db)
            let current = try Int64.fetchOne(db,
                sql: "SELECT lastTextRevision FROM pot_sync_state WHERE potID = ?",
                arguments: [potID.description]) ?? 0
            let revisions = try page.validatedRevisions(after: current)
            let changes = Dictionary(uniqueKeysWithValues: page.changes.map { ($0.revision, $0) })
            var deleted = 0
            for revision in revisions {
                if let change = changes[revision] {
                    deleted += try redactAuthoredText(for: change.eventID, field: change.field,
                        in: potID, advancingToTextRevision: revision,
                        updatedAtMillis: updatedAtMillis, database: db)
                } else {
                    try db.execute(sql: """
                        UPDATE pot_sync_state SET lastTextRevision = ?, updatedAtMillis = ? WHERE potID = ?
                        """, arguments: [revision, updatedAtMillis, potID.description])
                }
            }
            return deleted
        }
    }

    private func redactAuthoredText(
        for eventID: EventID,
        field: WireTextFieldV1,
        in potID: PotID,
        advancingToTextRevision revision: Int64,
        updatedAtMillis: Int64,
        database db: Database
    ) throws -> Int {
        try requireRegisteredPot(potID, in: db)
        guard let row = try Row.fetchOne(
            db,
            sql: """
                SELECT e.envelopeBlob, e.potID, d.state, d.serverSequence
                FROM ledger_events e
                JOIN event_delivery d ON d.eventID = e.eventID
                WHERE e.eventID = ?
                """,
            arguments: [eventID.description]
        ) else { throw LedgerStoreError.eventNotFound(eventID) }
        let storedPotID: String = row["potID"]
        let state: String = row["state"]
        let serverSequence: Int64? = row["serverSequence"]
        guard storedPotID == potID.description,
              state == DeliveryState.acknowledged.rawValue,
              serverSequence != nil
        else {
            throw LedgerStoreError.invalidTextRedaction(eventID)
        }

        let current = try Int64.fetchOne(
            db,
            sql: "SELECT lastTextRevision FROM pot_sync_state WHERE potID = ?",
            arguments: [potID.description]
        ) ?? 0
        let (expected, overflow) = current.addingReportingOverflow(1)
        guard !overflow, revision == expected else {
            throw LedgerStoreError.nonContiguousTextRevision(
                expected: overflow ? current : expected,
                actual: revision
            )
        }

        let data: Data = row["envelopeBlob"]
        let manifest: [WireTextFieldV1] = switch try PersistenceCoding
            .storedArithmeticEvent(from: data) {
        case let .wire(wire): wire.textFields
        case let .unsupported(unsupported): unsupported.textFields
        }
        if !manifest.contains(field) {
            throw LedgerStoreError.invalidTextRedaction(eventID)
        }
        try db.execute(
            sql: "DELETE FROM event_text_sidecars WHERE eventID = ? AND field = ?",
            arguments: [eventID.description, field.rawValue]
        )
        let deleted = db.changesCount
        try redactOpaqueFutureTextStates(
            eventID: eventID,
            fields: [field],
            in: db
        )
        try db.execute(
            sql: """
                UPDATE pot_sync_state
                SET lastTextRevision = ?, updatedAtMillis = ?
                WHERE potID = ?
                """,
            arguments: [revision, updatedAtMillis, potID.description]
        )
        return deleted
    }


    func canonicalEnvelopeData(for eventID: EventID) throws -> Data {
        try databaseQueue.read { db in
            guard let data: Data = try Data.fetchOne(
                db,
                sql: "SELECT envelopeBlob FROM ledger_events WHERE eventID = ?",
                arguments: [eventID.description]
            ) else { throw LedgerStoreError.eventNotFound(eventID) }
            return data
        }
    }

    private static let eventSelectionSQL = """
        SELECT e.localOrdinal, e.origin, e.envelopeBlob, e.savedAtMillis,
               d.state, d.undoDeadlineMillis, d.firstDispatchedAtMillis,
               d.attemptCount, d.nextRetryAtMillis, d.serverSequence,
               d.terminalReason
        FROM ledger_events e
        JOIN event_delivery d ON d.eventID = e.eventID
        """

    private func makeReductionEventOrder(
        for potID: PotID,
        reducer: LedgerReducer,
        in db: Database
    ) throws -> ReductionEventOrder {
        try requireRegisteredPot(potID, in: db)
        let cursor = try Int64.fetchOne(
            db,
            sql: "SELECT lastServerSequence FROM pot_sync_state WHERE potID = ?",
            arguments: [potID.description]
        ) ?? 0
        let rows = try Row.fetchAll(
            db,
            sql: Self.eventSelectionSQL + " WHERE e.potID = ?",
            arguments: [potID.description]
        )
        let storedEvents = try rows.map {
            try PersistenceCoding.storedEvent(from: $0, in: db)
        }
            .filter { $0.delivery.state != .terminal }
        let authoritative = storedEvents
            .filter {
                $0.delivery.state == .acknowledged
                    && ($0.delivery.serverSequence.map { $0 <= cursor } ?? false)
            }
            .sorted(by: Self.canonicalServerOrder)
        let compatibilityBarrier = storedEvents
            .filter {
                $0.delivery.state == .acknowledged
                    && ($0.delivery.serverSequence.map { $0 > cursor } ?? false)
                    && Self.requiresNewerReducer($0.event, reducer: reducer)
            }
            .min(by: Self.canonicalServerOrder)
        let barrierEventID = compatibilityBarrier?.event.id
        let optimistic = storedEvents
            .filter {
                guard $0.origin == .local, $0.event.id != barrierEventID else {
                    return false
                }
                return $0.delivery.serverSequence.map { $0 > cursor } ?? true
            }
            .sorted { $0.localOrdinal < $1.localOrdinal }
        return ReductionEventOrder(
            storedEvents: authoritative + [compatibilityBarrier].compactMap { $0 } + optimistic,
            optimisticEventIDs: Set(optimistic.map { $0.event.id })
        )
    }

    private static func canonicalServerOrder(
        _ lhs: StoredLedgerEvent,
        _ rhs: StoredLedgerEvent
    ) -> Bool {
        let lhsSequence = lhs.delivery.serverSequence ?? .max
        let rhsSequence = rhs.delivery.serverSequence ?? .max
        return lhsSequence == rhsSequence
            ? lhs.localOrdinal < rhs.localOrdinal
            : lhsSequence < rhsSequence
    }

    private static func requiresNewerReducer(
        _ event: EventEnvelope,
        reducer: LedgerReducer
    ) -> Bool {
        if event.schemaVersion > reducer.supportedSchemaVersion { return true }
        if case .unsupported = event.kind { return true }
        return false
    }

    private func requireRegisteredPot(_ potID: PotID, in db: Database) throws {
        let exists = try Bool.fetchOne(
            db,
            sql: "SELECT EXISTS(SELECT 1 FROM pot_configurations WHERE potID = ?)",
            arguments: [potID.description]
        ) ?? false
        guard exists else { throw LedgerStoreError.potNotRegistered(potID) }
    }


    public func purgeErasureSidecars(for eventID: EventID) throws -> Int {
        try databaseQueue.write { db in
            guard try eventExists(eventID, in: db) else {
                throw LedgerStoreError.eventNotFound(eventID)
            }
            try db.execute(
                sql: "DELETE FROM event_text_sidecars WHERE eventID = ?",
                arguments: [eventID.description]
            )
            let textCount = db.changesCount
            try db.execute(
                sql: "DELETE FROM event_opaque_sidecars WHERE eventID = ?",
                arguments: [eventID.description]
            )
            let opaqueCount = db.changesCount
            try db.execute(
                sql: "DELETE FROM event_future_text_sidecars WHERE eventID = ?",
                arguments: [eventID.description]
            )
            return textCount + opaqueCount + db.changesCount
        }
    }

    private func eventExists(_ eventID: EventID, in db: Database) throws -> Bool {
        try Bool.fetchOne(
            db,
            sql: "SELECT EXISTS(SELECT 1 FROM ledger_events WHERE eventID = ?)",
            arguments: [eventID.description]
        ) ?? false
    }

    private func isOutboundQueueHead(
        _ eventID: EventID,
        potID: PotID,
        in db: Database
    ) throws -> Bool {
        let headEventID: String? = try String.fetchOne(
            db,
            sql: """
                SELECT e.eventID
                FROM ledger_events e
                JOIN event_delivery d ON d.eventID = e.eventID
                WHERE e.potID = ?
                  AND d.state NOT IN ('acknowledged', 'terminal')
                ORDER BY e.localOrdinal
                LIMIT 1
                """,
            arguments: [potID.description]
        )
        return headEventID == eventID.description
    }

    private func insertImmutableEvent(
        _ event: EventEnvelope,
        origin: EventOrigin,
        blob: Data,
        fields: EventStorageFields,
        savedAtMillis: Int64,
        in db: Database
    ) throws -> Int64 {
        try db.execute(
            sql: """
                INSERT INTO ledger_events (
                    eventID, potID, origin, recordID, kind, schemaVersion, actorMemberID,
                    occurredAtMillis, originatingTimeZone, currencyCode, parentEventID,
                    resolutionHeadOne, resolutionHeadTwo, envelopeBlob, savedAtMillis
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
            arguments: [
                event.id.description,
                event.potID.description,
                origin.rawValue,
                fields.recordID,
                event.kind.rawValue,
                Int(event.schemaVersion),
                event.actorMemberID.description,
                try PersistenceCoding.milliseconds(event.occurredAt),
                event.originatingTimeZone.identifier,
                fields.currencyCode,
                fields.parentEventID,
                fields.resolutionHeadOne,
                fields.resolutionHeadTwo,
                blob,
                savedAtMillis,
            ]
        )
        return db.lastInsertedRowID
    }

    private func insertErasureSidecars(
        _ prepared: PreparedStoredEvent,
        eventID: EventID,
        in db: Database
    ) throws {
        for text in prepared.authoredText {
            try db.execute(
                sql: """
                    INSERT INTO event_text_sidecars (eventID, field, value)
                    VALUES (?, ?, ?)
                    """,
                arguments: [eventID.description, text.field.rawValue, text.value]
            )
        }
        if let opaquePayloadBlob = prepared.opaquePayloadBlob {
            try db.execute(
                sql: """
                    INSERT INTO event_opaque_sidecars (eventID, payloadBlob)
                    VALUES (?, ?)
                    """,
                arguments: [eventID.description, opaquePayloadBlob]
            )
        }
        if let opaqueFutureTextStatesBlob = prepared.opaqueFutureTextStatesBlob {
            try db.execute(
                sql: """
                    INSERT INTO event_future_text_sidecars (eventID, metadataBlob)
                    VALUES (?, ?)
                    """,
                arguments: [eventID.description, opaqueFutureTextStatesBlob]
            )
        }
    }

    private func reconcileExistingErasureSidecars(
        _ prepared: PreparedStoredEvent,
        redactedFields: [WireTextFieldV1],
        eventID: EventID,
        in db: Database
    ) throws {
        for text in prepared.authoredText {
            if let existing: String = try String.fetchOne(
                db,
                sql: "SELECT value FROM event_text_sidecars WHERE eventID = ? AND field = ?",
                arguments: [eventID.description, text.field.rawValue]
            ), existing != text.value {
                throw LedgerStoreError.immutableEventConflict(eventID)
            }
        }
        if let incomingOpaque = prepared.opaquePayloadBlob,
           let existingOpaque: Data = try Data.fetchOne(
               db,
               sql: "SELECT payloadBlob FROM event_opaque_sidecars WHERE eventID = ?",
               arguments: [eventID.description]
           ),
           existingOpaque != incomingOpaque {
            throw LedgerStoreError.immutableEventConflict(eventID)
        }
        for field in redactedFields {
            try db.execute(
                sql: "DELETE FROM event_text_sidecars WHERE eventID = ? AND field = ?",
                arguments: [eventID.description, field.rawValue]
            )
        }
        try redactOpaqueFutureTextStates(
            eventID: eventID,
            fields: Set(redactedFields),
            in: db
        )
    }

    private func redactOpaqueFutureTextStates(
        eventID: EventID,
        fields: Set<WireTextFieldV1>,
        in db: Database
    ) throws {
        guard !fields.isEmpty,
              let existing: Data = try Data.fetchOne(
                  db,
                  sql: "SELECT metadataBlob FROM event_future_text_sidecars WHERE eventID = ?",
                  arguments: [eventID.description]
              )
        else { return }
        let raw = try PersistenceCoding.decode(JSONValue.self, from: existing)
        guard case let .array(states) = raw else { return }
        let redacted = JSONValue.array(states.map { state in
            guard case let .object(object) = state,
                  case let .string(rawField)? = object["field"],
                  let field = WireTextFieldV1(rawValue: rawField),
                  fields.contains(field)
            else { return state }
            return .object([
                "field": .string(field.rawValue),
                "state": .string("redacted"),
            ])
        })
        let replacement = try PersistenceCoding.encode(redacted)
        guard replacement != existing else { return }
        try db.execute(
            sql: "DELETE FROM event_future_text_sidecars WHERE eventID = ?",
            arguments: [eventID.description]
        )
        try db.execute(
            sql: """
                INSERT INTO event_future_text_sidecars (eventID, metadataBlob)
                VALUES (?, ?)
                """,
            arguments: [eventID.description, replacement]
        )
    }

    private func requireDelivery(_ eventID: EventID, in db: Database) throws -> EventDelivery {
        guard let row = try Row.fetchOne(
            db,
            sql: Self.eventSelectionSQL + " WHERE e.eventID = ?",
            arguments: [eventID.description]
        ) else { throw LedgerStoreError.eventNotFound(eventID) }
        return try PersistenceCoding.delivery(from: row)
    }

    private func markDispatching(
        eventID: EventID,
        at date: Date,
        nowMillis: Int64,
        in db: Database
    ) throws -> EventDelivery {
        let current = try requireDelivery(eventID, in: db)
        guard current.state == .ready else {
            throw LedgerStoreError.invalidDeliveryTransition(
                eventID: eventID,
                from: current.state,
                to: .dispatching
            )
        }
        guard current.attemptCount < Int.max else {
            throw LedgerStoreError.attemptCountOverflow(eventID)
        }
        guard current.nextRetryAt.map({ $0 <= date }) ?? true else {
            throw LedgerStoreError.eventNotDispatchable(eventID)
        }
        guard try isOutboundQueueHead(
            eventID,
            potID: current.potID,
            in: db
        ) else {
            throw LedgerStoreError.eventNotDispatchable(eventID)
        }
        try db.execute(
            sql: """
                UPDATE event_delivery
                SET state = 'dispatching',
                    firstDispatchedAtMillis = COALESCE(firstDispatchedAtMillis, ?),
                    attemptCount = attemptCount + 1,
                    nextRetryAtMillis = NULL,
                    updatedAtMillis = ?
                WHERE eventID = ?
                """,
            arguments: [nowMillis, nowMillis, eventID.description]
        )
        return try requireDelivery(eventID, in: db)
    }

    private func acknowledge(
        eventID: EventID,
        serverSequence: Int64,
        nowMillis: Int64,
        in db: Database
    ) throws -> EventDelivery {
        guard serverSequence > 0 else {
            throw LedgerStoreError.invalidServerSequence(serverSequence)
        }
        let current = try requireDelivery(eventID, in: db)
        if current.state == .acknowledged {
            guard current.serverSequence == serverSequence else {
                throw LedgerStoreError.serverSequenceConflict(
                    potID: current.potID,
                    sequence: serverSequence
                )
            }
            return current
        }
        guard current.state == .dispatching else {
            throw LedgerStoreError.invalidDeliveryTransition(
                eventID: eventID,
                from: current.state,
                to: .acknowledged
            )
        }
        try requireSequenceAvailable(
            serverSequence,
            potID: current.potID,
            excluding: eventID,
            in: db
        )
        try setAcknowledged(
            eventID: eventID,
            potID: current.potID,
            serverSequence: serverSequence,
            nowMillis: nowMillis,
            in: db
        )
        return try requireDelivery(eventID, in: db)
    }

    private func requireSequenceAvailable(
        _ serverSequence: Int64,
        potID: PotID,
        excluding eventID: EventID?,
        in db: Database
    ) throws {
        let conflictingID: String? = try String.fetchOne(
            db,
            sql: """
                SELECT eventID FROM event_delivery
                WHERE potID = ? AND serverSequence = ?
                  AND (? IS NULL OR eventID <> ?)
                """,
            arguments: [
                potID.description,
                serverSequence,
                eventID?.description,
                eventID?.description,
            ]
        )
        guard conflictingID == nil else {
            throw LedgerStoreError.serverSequenceConflict(
                potID: potID,
                sequence: serverSequence
            )
        }
    }

    private func setAcknowledged(
        eventID: EventID,
        potID: PotID,
        serverSequence: Int64,
        nowMillis: Int64,
        in db: Database
    ) throws {
        try db.execute(
            sql: """
                UPDATE event_delivery
                SET state = 'acknowledged', serverSequence = ?, undoDeadlineMillis = NULL,
                    nextRetryAtMillis = NULL, terminalReason = NULL, updatedAtMillis = ?
                WHERE eventID = ?
                """,
            arguments: [serverSequence, nowMillis, eventID.description]
        )
        try advanceSyncCursor(
            potID: potID,
            nowMillis: nowMillis,
            in: db
        )
    }

    private func advanceSyncCursor(
        potID: PotID,
        nowMillis: Int64,
        in db: Database
    ) throws {
        let current = try Int64.fetchOne(
            db,
            sql: "SELECT lastServerSequence FROM pot_sync_state WHERE potID = ?",
            arguments: [potID.description]
        ) ?? 0
        var contiguous = current
        while true {
            let (expected, overflow) = contiguous.addingReportingOverflow(1)
            guard !overflow else { break }
            let exists = try Bool.fetchOne(
                db,
                sql: """
                    SELECT EXISTS(
                        SELECT 1 FROM event_delivery
                        WHERE potID = ? AND state = 'acknowledged' AND serverSequence = ?
                    )
                    """,
                arguments: [potID.description, expected]
            ) ?? false
            guard exists else { break }
            contiguous = expected
        }
        try db.execute(
            sql: """
                UPDATE pot_sync_state SET lastServerSequence = ?, updatedAtMillis = ?
                WHERE potID = ?
                """,
            arguments: [contiguous, nowMillis, potID.description]
        )
    }

    private static func prepareDatabaseFile(
        atPath path: String,
        fileProtection: DatabaseFileProtection
    ) throws {
        #if os(iOS) || os(tvOS) || os(watchOS)
        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: path) {
            do {
                try Data().write(
                    to: URL(fileURLWithPath: path),
                    options: .withoutOverwriting
                )
            } catch let error as CocoaError where error.code == .fileWriteFileExists {
                // Another opener won the exclusive create; apply protection below.
            }
        }
        try apply(fileProtection: fileProtection, toDatabaseAtPath: path)
        #else
        _ = path
        _ = fileProtection
        #endif
    }
}
