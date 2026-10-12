import Foundation
import GRDB
import NumaSharedCore

public enum MemberRosterCacheError: Error, Equatable, Sendable {
    case potNotRegistered(PotID)
    case invalidRoster(PotID)
    case corruptRoster(PotID)
}

public extension LedgerStore {
    @discardableResult
    func replaceCachedMemberRoster(
        _ profiles: [PotMemberProfile],
        for potID: PotID,
        at date: Date = Date()
    ) throws -> [PotMemberProfile] {
        guard try potConfiguration(for: potID) != nil else {
            throw MemberRosterCacheError.potNotRegistered(potID)
        }
        guard Self.isValidMemberRoster(profiles) else {
            throw MemberRosterCacheError.invalidRoster(potID)
        }
        let updatedAtMillis = try PersistenceCoding.milliseconds(date)
        return try databaseQueue.write { db in
            try db.execute(
                sql: "DELETE FROM cached_pot_member_profiles WHERE potID = ?",
                arguments: [potID.description]
            )
            for (index, profile) in profiles.enumerated() {
                if profile.displayName == nil {
                    try db.execute(sql: "UPDATE local_pot_member_profiles SET displayName = NULL WHERE potID = ? AND memberID = ?",
                        arguments: [potID.description, profile.memberID.description])
                }
                try db.execute(
                    sql: """
                        INSERT INTO cached_pot_member_profiles (
                            potID, memberID, unitID, displayName, role, state,
                            sortOrdinal, updatedAtMillis, budgetUnitID
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                    arguments: [
                        potID.description,
                        profile.memberID.description,
                        profile.unitID?.description,
                        profile.displayName,
                        profile.role.rawValue,
                        profile.state.rawValue,
                        index,
                        updatedAtMillis,
                        profile.budgetUnitID?.description,
                    ]
                )
            }
            return try Self.cachedMemberRoster(for: potID, in: db)
        }
    }

    func cachedMemberRoster(for potID: PotID) throws -> [PotMemberProfile] {
        try databaseQueue.read { db in
            try Self.cachedMemberRoster(for: potID, in: db)
        }
    }
}

private extension LedgerStore {
    static func cachedMemberRoster(
        for potID: PotID,
        in db: Database
    ) throws -> [PotMemberProfile] {
        let rows = try Row.fetchAll(
            db,
            sql: """
                SELECT memberID, unitID, displayName, role, state, budgetUnitID
                FROM cached_pot_member_profiles
                WHERE potID = ?
                ORDER BY sortOrdinal
                """,
            arguments: [potID.description]
        )
        let profiles: [PotMemberProfile]
        do {
            profiles = try rows.map { row in
                guard let memberUUID = UUID(uuidString: row["memberID"]),
                      let role = MemberRole(rawValue: row["role"]),
                      let state = PotMemberState(rawValue: row["state"])
                else {
                    throw MemberRosterCacheError.corruptRoster(potID)
                }
                let unitID: UnitID?
                let unitValue: String? = row["unitID"]
                if let unitValue {
                    guard let unitUUID = UUID(uuidString: unitValue) else {
                        throw MemberRosterCacheError.corruptRoster(potID)
                    }
                    unitID = try UnitID(validating: unitUUID)
                } else {
                    unitID = nil
                }
                return PotMemberProfile(
                    memberID: try MemberID(validating: memberUUID),
                    unitID: unitID,
                    displayName: row["displayName"],
                    role: role,
                    state: state,
                    budgetUnitID: try (row["budgetUnitID"] as String?).map { value in
                        guard let uuid = UUID(uuidString: value) else { throw MemberRosterCacheError.corruptRoster(potID) }
                        return try UnitID(validating: uuid)
                    }
                )
            }
        } catch let error as MemberRosterCacheError {
            throw error
        } catch {
            throw MemberRosterCacheError.corruptRoster(potID)
        }
        guard profiles.isEmpty || isValidMemberRoster(profiles) else {
            throw MemberRosterCacheError.corruptRoster(potID)
        }
        return profiles
    }

    static func isValidMemberRoster(_ profiles: [PotMemberProfile]) -> Bool {
        guard (1 ... 64).contains(profiles.count),
              Set(profiles.map(\.memberID)).count == profiles.count,
              profiles.filter({ $0.role == .owner }).count == 1,
              profiles.first(where: { $0.role == .owner })?.state == .active,
              profiles.allSatisfy({ profile in
                  profile.role != .owner || profile.state == .active
              })
        else { return false }
        let unitIDs = profiles.compactMap(\.unitID)
        guard Set(unitIDs).count == unitIDs.count else { return false }
        return profiles.allSatisfy { profile in
            profile.displayName.map(ConvexSyncTransport.isValidDisplayName) ?? true
        }
    }
}

/// Distinct spelling of the same ingest loop step, kept aligned with the
/// coordinator's unified pull loop.
extension LedgerStore {
    func ingest(_ event: HydratedWireEventV1, receivedAt: Date) throws {
        _ = try ingestRemoteEvent(event, receivedAt: receivedAt)
    }

    func ingest(
        _ change: TextRedactionChange,
        in potID: PotID,
        at date: Date
    ) throws {
        _ = try redactAuthoredText(
            for: change.eventID,
            field: change.field,
            in: potID,
            advancingToTextRevision: change.revision,
            at: date
        )
    }
}
