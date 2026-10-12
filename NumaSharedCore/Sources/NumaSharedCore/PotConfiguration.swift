import Foundation

// MARK: - Pot configuration

/// Validation failures for static pot metadata supplied to the reducer.
public enum PotConfigurationError: Error, Equatable, Sendable {
    case emptyUnitList
    case duplicateUnit(UnitID)
    case duplicatePersonalUnit(UnitID)
    case unknownMemberUnit(memberID: MemberID, unitID: UnitID)
    case unknownStructuralMember(MemberID)
    case duplicateStructuralMember(MemberID)
    case invalidInitialGroup(GroupID)
    case unknownPresetUnit(UnitID)
    case duplicateInitialPreset(String)
    case inconsistentMemberUnit(MemberID)
    case invalidActiveUnit(UnitID)
    case multipleOwners
    case activeOwnerRequired
    case unsupportedTopologySchemaVersion(UInt16)
}

/// A member's original individual unit, current settlement unit, and role.
public struct MemberTopology: Codable, Hashable, Sendable {
    public let personalUnitID: UnitID
    public let unitID: UnitID
    public let role: MemberRole

    public init(personalUnitID: UnitID, unitID: UnitID, role: MemberRole) {
        self.personalUnitID = personalUnitID
        self.unitID = unitID
        self.role = role
    }
}

/// The latest participant preset with its deterministic unit order.
public struct ParticipantPresetSnapshot: Codable, Hashable, Sendable {
    public let name: String
    public let orderedUnitIDs: [UnitID]

    public init(name: String, orderedUnitIDs: [UnitID]) {
        self.name = name
        self.orderedUnitIDs = orderedUnitIDs
    }
}

/// Rebuildable household structure at a particular event boundary.
public struct StructuralProjection: Codable, Hashable, Sendable {
    public let members: [MemberID: MemberTopology]
    public let claimedMemberIDs: [MemberID]
    public let archivedMemberIDs: [MemberID]
    public let groups: [SettlementGroupSnapshot]
    public let groupUnitIDsByGroupID: [GroupID: UnitID]
    public let presets: [ParticipantPresetSnapshot]
    public let knownUnitIDs: [UnitID]
    public let activeUnitIDs: [UnitID]
    /// Monotonic compatibility boundary and financial-history lock, including
    /// voided records. These must survive a structural checkpoint.
    public let minimumSchemaVersion: UInt16
    public let hasFinancialHistory: Bool

    public init(
        members: [MemberID: MemberTopology],
        claimedMemberIDs: [MemberID],
        archivedMemberIDs: [MemberID],
        groups: [SettlementGroupSnapshot],
        groupUnitIDsByGroupID: [GroupID: UnitID]? = nil,
        presets: [ParticipantPresetSnapshot],
        knownUnitIDs: [UnitID],
        activeUnitIDs: [UnitID]? = nil,
        minimumSchemaVersion: UInt16 = 1,
        hasFinancialHistory: Bool = false
    ) {
        self.members = members
        self.minimumSchemaVersion = minimumSchemaVersion
        self.hasFinancialHistory = hasFinancialHistory
        self.claimedMemberIDs = claimedMemberIDs
        self.archivedMemberIDs = archivedMemberIDs
        self.groups = groups
        if let groupUnitIDsByGroupID {
            self.groupUnitIDsByGroupID = groupUnitIDsByGroupID
        } else {
            var bindings = [GroupID: UnitID]()
            for group in groups where bindings[group.groupID] == nil {
                bindings[group.groupID] = group.unitID
            }
            self.groupUnitIDsByGroupID = bindings
        }
        self.presets = presets
        self.knownUnitIDs = knownUnitIDs
        if let activeUnitIDs {
            self.activeUnitIDs = activeUnitIDs
        } else if members.isEmpty {
            self.activeUnitIDs = knownUnitIDs
        } else {
            let archived = Set(archivedMemberIDs)
            let managedUnitIDs = Set(members.values.map(\.personalUnitID))
                .union(self.groupUnitIDsByGroupID.values)
            let currentMemberUnitIDs = Set(members.compactMap { memberID, member in
                archived.contains(memberID) ? nil : member.unitID
            })
            self.activeUnitIDs = knownUnitIDs.filter {
                !managedUnitIDs.contains($0) || currentMemberUnitIDs.contains($0)
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case members
        case claimedMemberIDs
        case archivedMemberIDs
        case groups
        case groupUnitIDsByGroupID
        case presets
        case knownUnitIDs
        case activeUnitIDs
        case minimumSchemaVersion
        case hasFinancialHistory
        case budgetGroupMembers
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decodeIfPresent(UInt16.self, forKey: .minimumSchemaVersion) ?? 1
        guard (1...EventEnvelope.maximumSupportedSchemaVersion).contains(version) else { throw PotConfigurationError.unsupportedTopologySchemaVersion(version) }
        let knownUnitIDs = try container.decode([UnitID].self, forKey: .knownUnitIDs)
        self.init(
            members: try container.decode(
                [MemberID: MemberTopology].self,
                forKey: version >= 2 ? .budgetGroupMembers : .members
            ),
            claimedMemberIDs: try container.decode([MemberID].self, forKey: .claimedMemberIDs),
            archivedMemberIDs: try container.decode([MemberID].self, forKey: .archivedMemberIDs),
            groups: try container.decode([SettlementGroupSnapshot].self, forKey: .groups),
            groupUnitIDsByGroupID: try container.decodeIfPresent(
                [GroupID: UnitID].self,
                forKey: .groupUnitIDsByGroupID
            ),
            presets: try container.decode([ParticipantPresetSnapshot].self, forKey: .presets),
            knownUnitIDs: knownUnitIDs,
            activeUnitIDs: try container.decodeIfPresent(
                [UnitID].self,
                forKey: .activeUnitIDs
            ),
            minimumSchemaVersion: version,
            // Older checkpoints cannot prove that no financial record preceded
            // them. Keep schema-1 replay intact, but fail closed on new coupling.
            hasFinancialHistory: try container.decodeIfPresent(Bool.self, forKey: .hasFinancialHistory) ?? true
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // Deliberately omit the legacy required `members` key for schema 2.
        // A schema-1-only snapshot reader must fail rather than ignore the marker.
        try container.encode(members, forKey: minimumSchemaVersion >= 2 ? .budgetGroupMembers : .members)
        try container.encode(claimedMemberIDs, forKey: .claimedMemberIDs)
        try container.encode(archivedMemberIDs, forKey: .archivedMemberIDs)
        try container.encode(groups, forKey: .groups)
        try container.encode(groupUnitIDsByGroupID, forKey: .groupUnitIDsByGroupID)
        try container.encode(presets, forKey: .presets)
        try container.encode(knownUnitIDs, forKey: .knownUnitIDs)
        try container.encode(activeUnitIDs, forKey: .activeUnitIDs)
        try container.encode(minimumSchemaVersion, forKey: .minimumSchemaVersion)
        try container.encode(hasFinancialHistory, forKey: .hasFinancialHistory)
    }
}

/// Stable topology at the boundary immediately before the supplied event log.
public struct PotConfiguration: Codable, Hashable, Sendable {
    public let id: PotID
    public let currency: Currency
    public let orderedUnitIDs: [UnitID]
    public let topology: StructuralProjection

    public init(id: PotID, currency: Currency, orderedUnitIDs: [UnitID]) throws {
        try self.init(
            id: id,
            currency: currency,
            topology: StructuralProjection(
                members: [:],
                claimedMemberIDs: [],
                archivedMemberIDs: [],
                groups: [],
                presets: [],
                knownUnitIDs: orderedUnitIDs,
                activeUnitIDs: orderedUnitIDs
            )
        )
    }

    public init(id: PotID, currency: Currency, topology: StructuralProjection) throws {
        guard (1...EventEnvelope.maximumSupportedSchemaVersion).contains(topology.minimumSchemaVersion) else { throw PotConfigurationError.unsupportedTopologySchemaVersion(topology.minimumSchemaVersion) }
        guard !topology.knownUnitIDs.isEmpty else { throw PotConfigurationError.emptyUnitList }
        var seen = Set<UnitID>()
        for unitID in topology.knownUnitIDs where !seen.insert(unitID).inserted {
            throw PotConfigurationError.duplicateUnit(unitID)
        }
        var activeUnitIDs = Set<UnitID>()
        for unitID in topology.activeUnitIDs {
            guard seen.contains(unitID), activeUnitIDs.insert(unitID).inserted else { throw PotConfigurationError.invalidActiveUnit(unitID) }
        }
        for memberID in topology.members.keys.sorted() {
            guard let member = topology.members[memberID] else { continue }
            for unitID in [member.personalUnitID, member.unitID] where !seen.contains(unitID) {
                throw PotConfigurationError.unknownMemberUnit(
                    memberID: memberID,
                    unitID: unitID
                )
            }
        }
        var personalUnitIDs = Set<UnitID>()
        for memberID in topology.members.keys.sorted() {
            guard let personalUnitID = topology.members[memberID]?.personalUnitID else {
                continue
            }
            guard personalUnitIDs.insert(personalUnitID).inserted else { throw PotConfigurationError.duplicatePersonalUnit(personalUnitID) }
        }
        var claimed = Set<MemberID>()
        for memberID in topology.claimedMemberIDs {
            guard topology.members[memberID] != nil else { throw PotConfigurationError.unknownStructuralMember(memberID) }
            guard claimed.insert(memberID).inserted else { throw PotConfigurationError.duplicateStructuralMember(memberID) }
        }
        var archived = Set<MemberID>()
        for memberID in topology.archivedMemberIDs {
            guard topology.members[memberID] != nil else { throw PotConfigurationError.unknownStructuralMember(memberID) }
            guard archived.insert(memberID).inserted else { throw PotConfigurationError.duplicateStructuralMember(memberID) }
        }
        let ownerIDs = topology.members.compactMap { memberID, member in
            member.role == .owner ? memberID : nil
        }
        guard ownerIDs.count <= 1 else { throw PotConfigurationError.multipleOwners }
        if !topology.members.isEmpty {
            guard let ownerID = ownerIDs.first, !archived.contains(ownerID) else { throw PotConfigurationError.activeOwnerRequired }
        }
        var groupIDs = Set<GroupID>()
        var groupUnitIDs = Set<UnitID>()
        var groupedMemberIDs = Set<MemberID>()
        var registeredGroupUnitIDs = Set<UnitID>()
        for groupID in topology.groupUnitIDsByGroupID.keys.sorted() {
            guard let unitID = topology.groupUnitIDsByGroupID[groupID],
                  seen.contains(unitID),
                  !personalUnitIDs.contains(unitID),
                  registeredGroupUnitIDs.insert(unitID).inserted
            else {
                throw PotConfigurationError.invalidInitialGroup(groupID)
            }
        }
        for group in topology.groups {
            guard group.defaultShareWeight > 0,
                  seen.contains(group.unitID),
                  !personalUnitIDs.contains(group.unitID),
                  topology.groupUnitIDsByGroupID[group.groupID] == group.unitID,
                  groupIDs.insert(group.groupID).inserted,
                  groupUnitIDs.insert(group.unitID).inserted
            else {
                throw PotConfigurationError.invalidInitialGroup(group.groupID)
            }
            for memberID in group.orderedMemberIDs {
                guard let member = topology.members[memberID],
                      (topology.minimumSchemaVersion >= 2 || !archived.contains(memberID)),
                      groupedMemberIDs.insert(memberID).inserted,
                      member.unitID == group.unitID
                else {
                    throw PotConfigurationError.invalidInitialGroup(group.groupID)
                }
            }
        }
        for memberID in topology.members.keys.sorted()
        where !groupedMemberIDs.contains(memberID) {
            guard let member = topology.members[memberID],
                  member.unitID == member.personalUnitID
            else {
                throw PotConfigurationError.inconsistentMemberUnit(memberID)
            }
        }
        let memberManagedUnitIDs = personalUnitIDs
            .union(registeredGroupUnitIDs)
        let currentMemberUnitIDs = Set(topology.members.compactMap { memberID, member in
            archived.contains(memberID) ? nil : member.unitID
        })
        for unitID in currentMemberUnitIDs where !activeUnitIDs.contains(unitID) {
            throw PotConfigurationError.invalidActiveUnit(unitID)
        }
        for unitID in activeUnitIDs
        where memberManagedUnitIDs.contains(unitID) && !currentMemberUnitIDs.contains(unitID) {
            throw PotConfigurationError.invalidActiveUnit(unitID)
        }
        var presetNames = Set<String>()
        for preset in topology.presets {
            guard presetNames.insert(preset.name).inserted else { throw PotConfigurationError.duplicateInitialPreset(preset.name) }
            var presetUnitIDs = Set<UnitID>()
            for unitID in preset.orderedUnitIDs {
                guard seen.contains(unitID), presetUnitIDs.insert(unitID).inserted else { throw PotConfigurationError.unknownPresetUnit(unitID) }
            }
        }
        self.id = id
        self.currency = currency
        orderedUnitIDs = topology.knownUnitIDs
        self.topology = topology
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case currency
        case orderedUnitIDs
        case topology
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(PotID.self, forKey: .id)
        let currency = try container.decode(Currency.self, forKey: .currency)
        if let topology = try container.decodeIfPresent(
            StructuralProjection.self,
            forKey: .topology
        ) {
            try self.init(id: id, currency: currency, topology: topology)
        } else {
            try self.init(
                id: id,
                currency: currency,
                orderedUnitIDs: container.decode([UnitID].self, forKey: .orderedUnitIDs)
            )
        }
    }
}
