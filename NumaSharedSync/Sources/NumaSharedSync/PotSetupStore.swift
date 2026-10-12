import Foundation
import GRDB
import NumaSharedCore

public struct LocalPotSetupMember: Hashable, Sendable {
    public let memberID: MemberID
    public let unitID: UnitID
    public let displayName: String
    public let role: MemberRole

    public init(
        memberID: MemberID,
        unitID: UnitID,
        displayName: String,
        role: MemberRole
    ) {
        self.memberID = memberID
        self.unitID = unitID
        self.displayName = displayName
        self.role = role
    }
}

public struct LocalPotMemberBinding: Hashable, Sendable {
    public let profile: PotMemberProfile
    public let event: WireEventV1
    public let isConfirmed: Bool

    public init(
        profile: PotMemberProfile,
        event: WireEventV1,
        isConfirmed: Bool
    ) {
        self.profile = profile
        self.event = event
        self.isConfirmed = isConfirmed
    }
}

public struct LocalPotSetup: Hashable, Sendable {
    public let potID: PotID
    public let potName: String
    public let ownerMemberID: MemberID
    public let isComplete: Bool
    public let renameEvent: WireEventV1
    public let isRenameConfirmed: Bool
    public let bindings: [LocalPotMemberBinding]

    public init(
        potID: PotID,
        potName: String,
        ownerMemberID: MemberID,
        isComplete: Bool,
        renameEvent: WireEventV1,
        isRenameConfirmed: Bool,
        bindings: [LocalPotMemberBinding]
    ) {
        self.potID = potID
        self.potName = potName
        self.ownerMemberID = ownerMemberID
        self.isComplete = isComplete
        self.renameEvent = renameEvent
        self.isRenameConfirmed = isRenameConfirmed
        self.bindings = bindings
    }

    public var ownerDisplayName: String? {
        bindings.first(where: {
            $0.profile.memberID == ownerMemberID && $0.profile.role == .owner
        })?.profile.displayName
    }
}

public enum LocalPotSetupError: Error, Equatable, Sendable {
    case potNotRegistered(PotID)
    case invalidPotName
    case invalidMemberName(MemberID)
    case invalidMemberTopology
    case setupConflict(PotID)
    case operationConflict(PotID)
    case corruptStoredSetup(PotID)
}

public extension LedgerStore {
    func saveLocalPotSetup(
        potID: PotID,
        potName: String,
        ownerMemberID: MemberID,
        members: [LocalPotSetupMember],
        originatingTimeZone: IANATimeZone,
        at date: Date = Date(),
        budgetGroups: [SettlementGroupSnapshot]? = nil
    ) throws -> LocalPotSetup {
        guard let configuration = try potConfiguration(for: potID) else {
            throw LocalPotSetupError.potNotRegistered(potID)
        }
        guard ConvexSyncTransport.isValidDisplayName(potName) else {
            throw LocalPotSetupError.invalidPotName
        }
        guard (1 ... 64).contains(members.count),
              members.filter({ $0.role == .owner }).count == 1,
              members.contains(where: {
                  $0.memberID == ownerMemberID && $0.role == .owner
              }),
              Set(members.map(\.memberID)).count == members.count,
              Set(members.map(\.unitID)).count == members.count,
              Set(members.map(\.unitID)).isSubset(
                  of: Set(configuration.orderedUnitIDs)
              )
        else {
            throw LocalPotSetupError.invalidMemberTopology
        }
        for member in members
        where !ConvexSyncTransport.isValidDisplayName(member.displayName) {
            throw LocalPotSetupError.invalidMemberName(member.memberID)
        }

        if budgetGroups != nil && readerSchemaVersion < EventEnvelope.budgetGroupSchemaVersion {
            throw LocalPotSetupError.invalidMemberTopology
        }
        let storedAtMillis = try PersistenceCoding.milliseconds(date)
        let renameEvent = try WireEventV1(EventEnvelope(
            potID: potID,
            actorMemberID: ownerMemberID,
            occurredAt: date,
            originatingTimeZone: originatingTimeZone,
            payload: .potRenamed(PotRenamedPayload(name: potName))
        ))
        let candidateBindings = try members.map { member in
            LocalPotMemberBinding(
                profile: PotMemberProfile(
                    memberID: member.memberID,
                    unitID: member.unitID,
                    displayName: member.displayName,
                    role: member.role,
                    state: member.role == .owner ? .active : .pending
                ),
                event: try WireEventV1(EventEnvelope(
                    potID: potID,
                    actorMemberID: ownerMemberID,
                    occurredAt: date,
                    originatingTimeZone: originatingTimeZone,
                    payload: .memberAdded(MemberAddedPayload(
                        memberID: member.memberID,
                        unitID: member.unitID,
                        role: member.role
                    ))
                )),
                isConfirmed: false
            )
        }

        return try databaseQueue.write { db in
            if let existing = try Self.localPotSetup(for: potID, in: db) {
                let existingMembers = try existing.bindings.map { binding in
                    guard let unitID = binding.profile.unitID,
                          let displayName = binding.profile.displayName
                    else {
                        throw LocalPotSetupError.corruptStoredSetup(potID)
                    }
                    return LocalPotSetupMember(
                        memberID: binding.profile.memberID,
                        unitID: unitID,
                        displayName: displayName,
                        role: binding.profile.role
                    )
                }
                guard existing.potName == potName,
                      existing.ownerMemberID == ownerMemberID,
                      existingMembers == members
                else {
                    throw LocalPotSetupError.setupConflict(potID)
                }
                if let budgetGroups {
                    guard let activationID: String = try String.fetchOne(db,
                        sql: "SELECT budgetGroupActivationEventID FROM local_pot_setup WHERE potID = ?",
                        arguments: [potID.description]),
                        let blob: Data = try Data.fetchOne(db,
                        sql: "SELECT envelopeBlob FROM ledger_events WHERE eventID = ?", arguments: [activationID]),
                        case let .groupChanged(payload) = try PersistenceCoding.decode(WireEventV1.self, from: blob).localEnvelope().payload,
                        payload.groups == budgetGroups else { throw LocalPotSetupError.setupConflict(potID) }
                }
                return existing
            }

            if budgetGroups != nil {
                let count = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM ledger_events WHERE potID = ?", arguments: [potID.description]) ?? 0
                guard count == 0 else { throw LocalPotSetupError.setupConflict(potID) }
            }
            try db.execute(
                sql: """
                    INSERT INTO local_pot_setup (
                        potID, potName, ownerMemberID, isComplete, renameEventID,
                        renameEventBlob, renameConfirmed, createdAtMillis,
                        updatedAtMillis
                    ) VALUES (?, ?, ?, 1, ?, ?, 0, ?, ?)
                    """,
                arguments: [
                    potID.description,
                    potName,
                    ownerMemberID.description,
                    renameEvent.eventId.description,
                    try PersistenceCoding.encode(renameEvent),
                    storedAtMillis,
                    storedAtMillis,
                ]
            )
            for (index, binding) in candidateBindings.enumerated() {
                try db.execute(
                    sql: """
                        INSERT INTO local_pot_member_profiles (
                            potID, memberID, unitID, displayName, role, state,
                            sortOrdinal, bindingEventID, bindingEventBlob,
                            bindingConfirmed, createdAtMillis, updatedAtMillis
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                        """,
                    arguments: [
                        potID.description,
                        binding.profile.memberID.description,
                        binding.profile.unitID?.description,
                        binding.profile.displayName,
                        binding.profile.role.rawValue,
                        binding.profile.state.rawValue,
                        index,
                        binding.event.eventId.description,
                        try PersistenceCoding.encode(binding.event),
                        storedAtMillis,
                        storedAtMillis,
                    ]
                )
            }
            if let budgetGroups {
                let activation = EventEnvelope(potID: potID, actorMemberID: ownerMemberID,
                    occurredAt: date, originatingTimeZone: originatingTimeZone,
                    schemaVersion: EventEnvelope.budgetGroupSchemaVersion,
                    payload: .groupChanged(GroupChangedPayload(groups: budgetGroups)))
                let prerequisites = try [renameEvent].map { try $0.localEnvelope() }
                    + candidateBindings.map { try $0.event.localEnvelope() } + [activation]
                guard LedgerReducer(supportedSchemaVersion: readerSchemaVersion)
                    .reduce(pot: configuration, events: prerequisites).access == .readWrite
                else { throw LocalPotSetupError.invalidMemberTopology }
                for event in prerequisites { _ = try appendLocalEvent(event, savedAt: date, in: db) }
                try db.execute(sql: "INSERT INTO local_budget_group_operations VALUES (?, ?)",
                    arguments: [activation.id.description, prerequisites.count - 1])
                try db.execute(sql: "UPDATE local_pot_setup SET budgetGroupActivationEventID = ? WHERE potID = ?",
                    arguments: [activation.id.description, potID.description])
            }
            guard let stored = try Self.localPotSetup(for: potID, in: db) else {
                throw LocalPotSetupError.corruptStoredSetup(potID)
            }
            return stored
        }
    }

    func localPotSetup(for potID: PotID) throws -> LocalPotSetup? {
        try databaseQueue.read { db in
            try Self.localPotSetup(for: potID, in: db)
        }
    }

    func confirmLocalPotRename(
        potID: PotID,
        eventID: EventID,
        at date: Date = Date()
    ) throws -> LocalPotSetup {
        try databaseQueue.write { db in
            let storedEventID: String? = try String.fetchOne(
                db,
                sql: "SELECT renameEventID FROM local_pot_setup WHERE potID = ?",
                arguments: [potID.description]
            )
            guard storedEventID == eventID.description else {
                throw LocalPotSetupError.operationConflict(potID)
            }
            try db.execute(
                sql: """
                    UPDATE local_pot_setup
                    SET renameConfirmed = 1, updatedAtMillis = ?
                    WHERE potID = ? AND renameEventID = ?
                    """,
                arguments: [
                    try PersistenceCoding.milliseconds(date),
                    potID.description,
                    eventID.description,
                ]
            )
            guard let stored = try Self.localPotSetup(for: potID, in: db) else {
                throw LocalPotSetupError.corruptStoredSetup(potID)
            }
            return stored
        }
    }

    func confirmLocalMemberBinding(
        potID: PotID,
        eventID: EventID,
        at date: Date = Date()
    ) throws -> LocalPotSetup {
        try databaseQueue.write { db in
            let memberID: String? = try String.fetchOne(
                db,
                sql: """
                    SELECT memberID
                    FROM local_pot_member_profiles
                    WHERE potID = ? AND bindingEventID = ?
                    """,
                arguments: [potID.description, eventID.description]
            )
            guard memberID != nil else {
                throw LocalPotSetupError.operationConflict(potID)
            }
            try db.execute(
                sql: """
                    UPDATE local_pot_member_profiles
                    SET bindingConfirmed = 1, updatedAtMillis = ?
                    WHERE potID = ? AND bindingEventID = ?
                    """,
                arguments: [
                    try PersistenceCoding.milliseconds(date),
                    potID.description,
                    eventID.description,
                ]
            )
            guard let stored = try Self.localPotSetup(for: potID, in: db) else {
                throw LocalPotSetupError.corruptStoredSetup(potID)
            }
            return stored
        }
    }
}

extension LedgerStore {
    static func localPotSetup(
        for potID: PotID,
        in db: Database
    ) throws -> LocalPotSetup? {
        guard let setup = try Row.fetchOne(
            db,
            sql: """
                SELECT potName, ownerMemberID, isComplete, renameEventID,
                       renameEventBlob, renameConfirmed
                FROM local_pot_setup
                WHERE potID = ?
                """,
            arguments: [potID.description]
        ) else { return nil }
        let ownerMemberID: MemberID
        do {
            guard let ownerUUID = UUID(uuidString: setup["ownerMemberID"]) else {
                throw LocalPotSetupError.corruptStoredSetup(potID)
            }
            ownerMemberID = try MemberID(validating: ownerUUID)
        } catch {
            throw LocalPotSetupError.corruptStoredSetup(potID)
        }
        let renameEvent: WireEventV1
        do {
            renameEvent = try PersistenceCoding.decode(
                WireEventV1.self,
                from: setup["renameEventBlob"]
            )
        } catch {
            throw LocalPotSetupError.corruptStoredSetup(potID)
        }
        let renameEventID: String = setup["renameEventID"]
        let rows = try Row.fetchAll(
            db,
            sql: """
                SELECT memberID, unitID, displayName, role, state,
                       bindingEventID, bindingEventBlob, bindingConfirmed
                FROM local_pot_member_profiles
                WHERE potID = ?
                ORDER BY sortOrdinal
                """,
            arguments: [potID.description]
        )
        let bindings = try rows.map { row -> LocalPotMemberBinding in
            guard let memberUUID = UUID(uuidString: row["memberID"]),
                  let unitUUID = UUID(uuidString: row["unitID"]),
                  let role = MemberRole(rawValue: row["role"]),
                  let state = PotMemberState(rawValue: row["state"]),
                  let bindingEventID: String = row["bindingEventID"],
                  let eventBlob: Data = row["bindingEventBlob"]
            else {
                throw LocalPotSetupError.corruptStoredSetup(potID)
            }
            do {
                let event = try PersistenceCoding.decode(
                    WireEventV1.self,
                    from: eventBlob
                )
                guard event.eventId.description == bindingEventID else {
                    throw LocalPotSetupError.corruptStoredSetup(potID)
                }
                return LocalPotMemberBinding(
                    profile: PotMemberProfile(
                        memberID: try MemberID(validating: memberUUID),
                        unitID: try UnitID(validating: unitUUID),
                        displayName: row["displayName"],
                        role: role,
                        state: state
                    ),
                    event: event,
                    isConfirmed: row["bindingConfirmed"]
                )
            } catch {
                throw LocalPotSetupError.corruptStoredSetup(potID)
            }
        }
        let value = LocalPotSetup(
            potID: potID,
            potName: setup["potName"],
            ownerMemberID: ownerMemberID,
            isComplete: setup["isComplete"],
            renameEvent: renameEvent,
            isRenameConfirmed: setup["renameConfirmed"],
            bindings: bindings
        )
        guard value.renameEvent.potId == potID,
              value.renameEvent.eventId.description == renameEventID,
              value.renameEvent.actorMemberId == ownerMemberID,
              case let .potRenamed(name) = value.renameEvent.payload,
              name == value.potName,
              value.ownerDisplayName != nil,
              value.bindings.allSatisfy({ binding in
                  guard binding.event.potId == potID,
                        binding.event.actorMemberId == ownerMemberID,
                        let unitID = binding.profile.unitID,
                        case let .memberAdded(memberID, eventUnitID, _) =
                            binding.event.payload
                  else { return false }
                  return memberID == binding.profile.memberID
                      && eventUnitID == unitID
              })
        else {
            throw LocalPotSetupError.corruptStoredSetup(potID)
        }
        return value
    }
}
