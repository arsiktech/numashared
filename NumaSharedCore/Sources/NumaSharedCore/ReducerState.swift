import Foundation

// MARK: - Reducer working state

internal enum MutableRevisableKind: Equatable {
    case expense
    case openingBalance
}

internal struct MutableRevision {
    let projection: RevisionProjection
    let order: Int

    init(event: EventEnvelope, order: Int, content: RevisableRecordContent) {
        projection = RevisionProjection(
            eventID: event.id,
            actorMemberID: event.actorMemberID,
            occurredAt: event.occurredAt,
            serverSequence: event.serverSequence,
            content: content
        )
        self.order = order
    }
}

internal struct MutableRevisableRecord {
    let recordID: RecordID
    let originalKind: MutableRevisableKind
    var revisions: [EventID: MutableRevision]
    var heads: Set<EventID>
    var resolvedContests: [RevisionPair: EventID]
    var isVoided: Bool
    var voidReason: String?
    let createdOrder: Int

    init(
        recordID: RecordID,
        originalKind: MutableRevisableKind,
        firstRevision: MutableRevision,
        createdOrder: Int
    ) {
        self.recordID = recordID
        self.originalKind = originalKind
        revisions = [firstRevision.projection.eventID: firstRevision]
        heads = [firstRevision.projection.eventID]
        resolvedContests = [:]
        isVoided = false
        voidReason = nil
        self.createdOrder = createdOrder
    }

    var appliedRevision: MutableRevision? {
        heads.compactMap { revisions[$0] }.max { $0.order < $1.order }
    }
}

internal struct MutableSettlementRecord {
    let recordID: RecordID
    let eventID: EventID
    let content: SettlementContent
    var isFlagged: Bool
    let createdOrder: Int
}

internal enum MutableRecord {
    case revisable(MutableRevisableRecord)
    case settlement(MutableSettlementRecord)

    var recordID: RecordID {
        switch self {
        case let .revisable(record): record.recordID
        case let .settlement(record): record.recordID
        }
    }

    var createdOrder: Int {
        switch self {
        case let .revisable(record): record.createdOrder
        case let .settlement(record): record.createdOrder
        }
    }
}

internal struct MutableTopology {
    var members: [MemberID: MemberTopology]
    var claimedMemberIDs: Set<MemberID>
    var archivedMemberIDs: Set<MemberID>
    var groups: [SettlementGroupSnapshot]
    var groupUnitIDsByGroupID: [GroupID: UnitID]
    var presetsByName: [String: ParticipantPresetSnapshot]
    var knownUnitIDs: [UnitID]
    var knownUnitIDSet: Set<UnitID>
    var activeUnitIDs: [UnitID]
    var activeUnitIDSet: Set<UnitID>
    var minimumSchemaVersion: UInt16
    var hasFinancialHistory: Bool

    init(_ projection: StructuralProjection) {
        members = projection.members
        minimumSchemaVersion = projection.minimumSchemaVersion
        hasFinancialHistory = projection.hasFinancialHistory
        claimedMemberIDs = Set(projection.claimedMemberIDs)
        archivedMemberIDs = Set(projection.archivedMemberIDs)
        groups = projection.groups
        groupUnitIDsByGroupID = projection.groupUnitIDsByGroupID
        presetsByName = Dictionary(
            projection.presets.map { ($0.name, $0) },
            uniquingKeysWith: { _, latest in latest }
        )
        knownUnitIDs = projection.knownUnitIDs
        knownUnitIDSet = Set(projection.knownUnitIDs)
        activeUnitIDs = projection.activeUnitIDs
        activeUnitIDSet = Set(projection.activeUnitIDs)
    }

    mutating func addKnownUnit(_ unitID: UnitID) -> Bool {
        guard knownUnitIDSet.insert(unitID).inserted else { return false }
        knownUnitIDs.append(unitID)
        return true
    }

    mutating func addActiveUnit(_ unitID: UnitID) {
        guard activeUnitIDSet.insert(unitID).inserted else { return }
        activeUnitIDs.append(unitID)
    }

    mutating func rebuildMemberManagedActiveUnits(
        previousManagedUnitIDs: Set<UnitID>
    ) {
        let unmanagedUnitIDs = activeUnitIDSet.subtracting(previousManagedUnitIDs)
        let currentMemberUnitIDs = Set(members.compactMap { memberID, member in
            archivedMemberIDs.contains(memberID) ? nil : member.unitID
        })
        activeUnitIDSet = unmanagedUnitIDs.union(currentMemberUnitIDs)
        activeUnitIDs = knownUnitIDs.filter(activeUnitIDSet.contains)
    }

    func settlementEligibleUnitIDs(
        balances: [UnitID: Int64]
    ) -> Set<UnitID> {
        var eligible = activeUnitIDSet
        for (unitID, balance) in balances where balance != 0 {
            eligible.insert(unitID)
        }
        return eligible
    }

    func projectedBalances(
        from rawBalances: [UnitID: Int64]
    ) -> [UnitID: Int64]? {
        var destinationByPersonalUnit = [UnitID: UnitID]()
        for memberID in members.keys.sorted()
        where minimumSchemaVersion >= 2 || !archivedMemberIDs.contains(memberID) {
            guard let member = members[memberID] else { continue }
            if let existing = destinationByPersonalUnit[member.personalUnitID],
               existing != member.unitID {
                return nil
            }
            destinationByPersonalUnit[member.personalUnitID] = member.unitID
        }

        var projected = Dictionary(
            uniqueKeysWithValues: rawBalances.keys.map { ($0, Int128(0)) }
        )
        for unitID in rawBalances.keys.sorted() {
            let destination = destinationByPersonalUnit[unitID] ?? unitID
            projected[destination, default: 0] += Int128(rawBalances[unitID] ?? 0)
        }

        var exact = [UnitID: Int64]()
        for unitID in projected.keys.sorted() {
            guard let minorUnits = Int64(exactly: projected[unitID] ?? 0) else { return nil }
            exact[unitID] = minorUnits
        }
        return exact
    }

    var projection: StructuralProjection {
        StructuralProjection(
            members: members,
            claimedMemberIDs: claimedMemberIDs.sorted(),
            archivedMemberIDs: archivedMemberIDs.sorted(),
            groups: groups,
            groupUnitIDsByGroupID: groupUnitIDsByGroupID,
            presets: presetsByName.values.sorted {
                $0.name == $1.name
                    ? $0.orderedUnitIDs.lexicographicallyPrecedes($1.orderedUnitIDs)
                    : $0.name < $1.name
            },
            knownUnitIDs: knownUnitIDs,
            activeUnitIDs: activeUnitIDs,
            minimumSchemaVersion: minimumSchemaVersion,
            hasFinancialHistory: hasFinancialHistory
        )
    }
}

internal struct MutableLedgerState {
    var records = [RecordID: MutableRecord]()
    var appliedEventIDs = [EventID]()
    var auditOnlyEventIDs = [EventID]()
    var lastAppliedServerSequence: Int64?
    var latestPotName: String?
    var isArchived = false
    var financialBalances: [UnitID: Int64]
    var financialSpend: Int64
    var topology: MutableTopology

    init(pot: PotConfiguration) {
        financialBalances = Dictionary(
            uniqueKeysWithValues: pot.orderedUnitIDs.map { ($0, Int64(0)) }
        )
        financialSpend = 0
        topology = MutableTopology(pot.topology)
    }
}

internal struct IndexedEvent {
    let inputOffset: Int
    let event: EventEnvelope
}

internal struct FinancialContribution {
    let balances: [UnitID: Int128]
    let spend: Int128

    static let zero = FinancialContribution(balances: [:], spend: 0)
}
