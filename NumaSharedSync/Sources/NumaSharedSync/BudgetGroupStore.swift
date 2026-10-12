import Foundation
import GRDB
import NumaSharedCore

/// Explicit schema-2 opt-in. Names are mutable profile data, never group/event identity.
public struct BudgetGroupPromotion: Hashable, Sendable {
    public let ownerBindingEventID: EventID
    public let startingSequence: Int64
    public let members: [PotMemberProfile]

    public init(ownerBindingEventID: EventID, startingSequence: Int64, members: [PotMemberProfile]) {
        self.ownerBindingEventID = ownerBindingEventID
        self.startingSequence = startingSequence
        self.members = members
    }
}

public extension LedgerStore {
    func hasLocalBudgetGroupSetup(for potID: PotID) throws -> Bool {
        try databaseQueue.read { db in
            try String.fetchOne(db, sql: "SELECT budgetGroupActivationEventID FROM local_pot_setup WHERE potID = ?",
                arguments: [potID.description]) != nil
        }
    }

    func budgetGroupPromotion(for potID: PotID, startingSequence: Int64) throws -> BudgetGroupPromotion? {
        guard try hasLocalBudgetGroupSetup(for: potID), let setup = try localPotSetup(for: potID),
              let owner = setup.bindings.first(where: { $0.profile.memberID == setup.ownerMemberID }) else { return nil }
        return BudgetGroupPromotion(ownerBindingEventID: owner.event.eventId,
            startingSequence: startingSequence, members: setup.bindings.map(\.profile))
    }

    func expectedTopologyRevision(for eventID: EventID) throws -> Int64? {
        try databaseQueue.read { db in
            try Int64.fetchOne(db, sql: "SELECT expectedTopologyRevision FROM local_budget_group_operations WHERE eventID = ?",
                arguments: [eventID.description])
        }
    }

    /// Later UI supplies the observed revision; it is never refreshed behind a queued request.
    @discardableResult
    func appendBudgetGroupChange(_ event: EventEnvelope, expectedTopologyRevision: Int64,
                                 savedAt: Date = Date()) throws -> StoredLedgerEvent {
        guard readerSchemaVersion >= 2, event.schemaVersion == 2, expectedTopologyRevision >= 0,
              case .groupChanged = event.payload else { throw LocalPotSetupError.invalidMemberTopology }
        let before = try snapshot(for: event.potID)
        guard let configuration = try potConfiguration(for: event.potID) else { throw LocalPotSetupError.potNotRegistered(event.potID) }
        guard LedgerReducer(supportedSchemaVersion: readerSchemaVersion)
            .reduce(pot: configuration, events: before.reductionOrderedEvents.map(\.event) + [event]).access == .readWrite
        else { throw LocalPotSetupError.invalidMemberTopology }
        return try databaseQueue.write { db in
            let count = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM ledger_events WHERE potID = ?", arguments: [event.potID.description]) ?? 0
            guard count == before.storedEvents.count else { throw LocalPotSetupError.operationConflict(event.potID) }
            let stored = try appendLocalEvent(event, savedAt: savedAt, in: db)
            try db.execute(sql: "INSERT INTO local_budget_group_operations VALUES (?, ?)",
                arguments: [event.id.description, expectedTopologyRevision])
            return stored
        }
    }

    func persistedSyncPause(for potID: PotID) throws -> String? {
        try databaseQueue.read { db in
            try String.fetchOne(db, sql: "SELECT pauseCode FROM pot_sync_state WHERE potID = ?", arguments: [potID.description])
        }
    }

    /// Explicit reconciliation may retry unchanged requests; it must not rewrite queued money.
    func setPersistedSyncPause(_ code: String?, for potID: PotID) throws {
        try databaseQueue.write { db in
            try db.execute(sql: "UPDATE pot_sync_state SET pauseCode = ? WHERE potID = ?", arguments: [code, potID.description])
        }
    }

    /// Resolve a known payer from erasable profiles, never from the recording author.
    func payerDisplayName(memberID: MemberID?, potID: PotID) throws -> String? {
        guard let memberID else { return nil }
        if let cached = try cachedMemberRoster(for: potID).first(where: { $0.memberID == memberID }) {
            return cached.displayName ?? "Former member"
        }
        return try localPotSetup(for: potID)?.bindings.first(where: { $0.profile.memberID == memberID })?.profile.displayName
    }
}

extension WireEventV1 {
    func localEnvelope() throws -> EventEnvelope {
        try eventEnvelope(serverSequence: nil, textStates: authoredText.map { .present(field: $0.field, value: $0.value) })
    }
}
