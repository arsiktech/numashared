import Foundation

// MARK: - Ledger reducer

/// Pure, deterministic fold of an append-only per-pot event stream.
public struct LedgerReducer: Sendable {
    public let supportedSchemaVersion: UInt16
    public let settlementPlanningLimits: SettlementPlanningLimits

    public init(
        supportedSchemaVersion: UInt16 = EventEnvelope.currentSchemaVersion,
        settlementPlanningLimits: SettlementPlanningLimits = .standard
    ) {
        self.supportedSchemaVersion = min(supportedSchemaVersion, EventEnvelope.maximumSupportedSchemaVersion)
        self.settlementPlanningLimits = settlementPlanningLimits
    }

    /// Folds an event sequence into its canonical, last-valid projection.
    ///
    /// Events carrying a server sequence are applied first, in ascending
    /// sequence order with normalized event ID as the deterministic tie-break;
    /// pending events then retain their supplied input order. A duplicate
    /// positive server sequence stops reduction before either colliding event.
    ///
    /// The first unsupported schema/kind, invalid event, or arithmetic failure
    /// stops the fold. The failing event and every later event are excluded,
    /// while all previously committed events remain in `projection`. A fully
    /// safe result is `.readWrite`; `.readOnly(issue)` exposes that last-valid
    /// projection for display but requires callers to reject further writes.
    public func reduce<S: Sequence>(
        pot: PotConfiguration,
        events: S
    ) -> ReductionResult where S.Element == EventEnvelope {
        let orderedEvents = Array(events).enumerated().map {
            IndexedEvent(inputOffset: $0.offset, event: $0.element)
        }.sorted(by: eventPrecedes)
        var eventIDsBySequence = [Int64: [EventID]]()
        for indexedEvent in orderedEvents {
            if let sequence = indexedEvent.event.serverSequence, sequence > 0 {
                eventIDsBySequence[sequence, default: []].append(indexedEvent.event.id)
            }
        }
        let firstDuplicateSequence = eventIDsBySequence.keys
            .filter { (eventIDsBySequence[$0]?.count ?? 0) > 1 }
            .min()
        let duplicateSequenceEventID = firstDuplicateSequence.flatMap {
            eventIDsBySequence[$0]?.min()
        }
        var state = MutableLedgerState(pot: pot)
        var seenEventIDs = Set<EventID>()
        var issue: ReductionIssue?
        if pot.topology.minimumSchemaVersion > supportedSchemaVersion {
            return ReductionResult(
                projection: deriveProjection(pot: pot, state: state).projection,
                access: .readOnly(.unsupportedTopologySchema(
                    encountered: pot.topology.minimumSchemaVersion,
                    supported: supportedSchemaVersion
                ))
            )
        }

        for (order, indexedEvent) in orderedEvents.enumerated() {
            let event = indexedEvent.event
            if event.potID != pot.id {
                issue = .invalidEvent(
                    eventID: event.id,
                    reason: .eventFromDifferentPot(expected: pot.id, actual: event.potID)
                )
                break
            }
            if let duplicateSequence = firstDuplicateSequence,
               event.serverSequence == duplicateSequence,
               let duplicateEventID = duplicateSequenceEventID {
                issue = .invalidEvent(
                    eventID: duplicateEventID,
                    reason: .duplicateServerSequence(duplicateSequence)
                )
                break
            }
            if event.schemaVersion == 0 {
                issue = .invalidEvent(
                    eventID: event.id,
                    reason: .invalidSchemaVersion(event.schemaVersion)
                )
                break
            }
            if event.schemaVersion > supportedSchemaVersion {
                issue = .unsupportedSchema(
                    eventID: event.id,
                    encountered: event.schemaVersion,
                    supported: supportedSchemaVersion
                )
                break
            }
            if case let .unsupported(kind) = event.kind {
                issue = .unsupportedEventKind(eventID: event.id, kind: kind)
                break
            }
            if !seenEventIDs.insert(event.id).inserted {
                issue = .invalidEvent(eventID: event.id, reason: .duplicateEventID(event.id))
                break
            }
            if let sequence = event.serverSequence {
                guard sequence > 0 else {
                    issue = .invalidEvent(
                        eventID: event.id,
                        reason: .invalidServerSequence(sequence)
                    )
                    break
                }
            }

            let targetRecordID = affectedRecordID(for: event.payload)
            let priorRecord = targetRecordID.flatMap { state.records[$0] }
            if let reason = apply(event, order: order, pot: pot, state: &state) {
                issue = .invalidEvent(eventID: event.id, reason: reason)
                break
            }
            if let recordID = targetRecordID,
               !commitFinancialTransition(
                   recordID: recordID,
                   from: priorRecord,
                   to: &state
               ) {
                if let priorRecord {
                    state.records[recordID] = priorRecord
                } else {
                    state.records.removeValue(forKey: recordID)
                }
                issue = .invalidEvent(eventID: event.id, reason: .arithmeticOverflow)
                break
            }
            state.topology.minimumSchemaVersion = max(state.topology.minimumSchemaVersion, event.schemaVersion)
            if targetRecordID != nil { state.topology.hasFinancialHistory = true }
            state.appliedEventIDs.append(event.id)
            if let sequence = event.serverSequence {
                state.lastAppliedServerSequence = sequence
            }
        }

        let derived = deriveProjection(pot: pot, state: state)
        if issue == nil, let derivedIssue = derived.issue {
            issue = derivedIssue
        }
        return ReductionResult(
            projection: derived.projection,
            access: issue.map(ReductionAccess.readOnly) ?? .readWrite
        )
    }

    // MARK: Event ordering and application

    private func eventPrecedes(_ lhs: IndexedEvent, _ rhs: IndexedEvent) -> Bool {
        switch (lhs.event.serverSequence, rhs.event.serverSequence) {
        case let (lhsSequence?, rhsSequence?):
            if lhsSequence != rhsSequence { return lhsSequence < rhsSequence }
            return lhs.event.id < rhs.event.id
        case (_?, nil):
            return true
        case (nil, _?):
            return false
        case (nil, nil):
            return lhs.inputOffset < rhs.inputOffset
        }
    }

    private func apply(
        _ event: EventEnvelope,
        order: Int,
        pot: PotConfiguration,
        state: inout MutableLedgerState
    ) -> InvalidEventReason? {
        guard !state.isArchived else { return .eventAfterPotArchived }
        guard event.schemaVersion >= state.topology.minimumSchemaVersion else { return .schemaDowngrade(required: state.topology.minimumSchemaVersion, actual: event.schemaVersion) }
        if let payerMemberID = event.payload.payerMemberID {
            guard event.schemaVersion >= EventEnvelope.budgetGroupSchemaVersion else { return .payerAttributionRequiresBudgetGroups }
            guard let member = state.topology.members[payerMemberID] else { return .invalidPayerMember(payerMemberID) }
            switch event.payload {
            case let .expenseAdded(payload):
                guard !state.topology.archivedMemberIDs.contains(payerMemberID),
                      member.unitID == payload.content.payerUnitID else {
                    return .invalidPayerMember(payerMemberID)
                }
            case let .expenseRevised(payload):
                if case let .expense(content) = payload.content {
                    // A historical correction may retain the original personal
                    // payer unit even after legacy grouping or archival.
                    let historicalUnits: Set<UnitID>
                    if case let .revisable(record) = state.records[payload.recordID] {
                        historicalUnits = Set(record.revisions.values.compactMap { revision in
                            if case let .expense(old) = revision.projection.content { return old.payerUnitID }
                            return nil
                        })
                    } else {
                        historicalUnits = []
                    }
                    guard member.unitID == content.payerUnitID
                        || (member.personalUnitID == content.payerUnitID && historicalUnits.contains(content.payerUnitID)) else {
                        return .invalidPayerMember(payerMemberID)
                    }
                }
            default: break
            }
        }

        switch event.payload {
        case let .expenseAdded(payload):
            if let reason = createRevisableRecord(
                recordID: payload.recordID,
                content: .expense(payload.content),
                event: event,
                order: order,
                pot: pot,
                state: &state
            ) { return reason }
        case let .openingBalanceSet(payload):
            if let reason = createRevisableRecord(
                recordID: payload.recordID,
                content: .openingBalance(payload.content),
                event: event,
                order: order,
                pot: pot,
                state: &state
            ) { return reason }
        case let .expenseRevised(payload):
            guard let existing = state.records[payload.recordID] else { return .missingRecord(payload.recordID) }
            guard case var .revisable(record) = existing else {
                return .immutableSettlement(
                    recordID: payload.recordID,
                    attemptedKind: event.kind
                )
            }
            let historicalRevisionUnitIDs = record.revisions.values.reduce(
                into: Set<UnitID>()
            ) { historicalUnitIDs, revision in
                historicalUnitIDs.formUnion(unitIDs(in: revision.projection.content))
            }
            let eligibleRevisionUnitIDs = state.topology.activeUnitIDSet.union(
                historicalRevisionUnitIDs
            )
            if let reason = validate(
                payload.content,
                pot: pot,
                knownUnitIDs: state.topology.knownUnitIDSet,
                eligibleUnitIDs: eligibleRevisionUnitIDs
            ) { return reason }
            guard record.originalKind == kind(of: payload.content) else { return .recordKindChanged(payload.recordID) }
            let revision = MutableRevision(
                event: event,
                order: order,
                content: payload.content
            )
            switch payload.basis {
            case let .parent(parentID):
                guard record.revisions[parentID] != nil else { return .unknownRevision(parentID) }
                record.heads.remove(parentID)
                record.heads.insert(event.id)
                let advancedResolutionPairs = record.resolvedContests.compactMap {
                    $0.value == parentID ? $0.key : nil
                }
                for pair in advancedResolutionPairs {
                    record.resolvedContests[pair] = event.id
                }
            case let .resolution(pair):
                guard record.revisions[pair.first] != nil,
                      record.revisions[pair.second] != nil
                else {
                    return .invalidResolution(pair)
                }
                if record.heads.contains(pair.first), record.heads.contains(pair.second) {
                    record.heads.remove(pair.first)
                    record.heads.remove(pair.second)
                    record.heads.insert(event.id)
                } else if let priorResolutionID = record.resolvedContests[pair] {
                    record.heads.remove(priorResolutionID)
                    record.heads.insert(event.id)
                } else {
                    return .invalidResolution(pair)
                }
                record.resolvedContests[pair] = event.id
            }
            record.revisions[event.id] = revision
            state.records[payload.recordID] = .revisable(record)
        case let .recordVoided(payload):
            let reason = payload.reason.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !reason.isEmpty else { return .voidReasonRequired }
            guard let existing = state.records[payload.recordID] else { return .missingRecord(payload.recordID) }
            guard case var .revisable(record) = existing else {
                return .immutableSettlement(
                    recordID: payload.recordID,
                    attemptedKind: event.kind
                )
            }
            record.isVoided = true
            record.voidReason = reason
            state.records[payload.recordID] = .revisable(record)
        case let .recordRestored(payload):
            guard let existing = state.records[payload.recordID] else { return .missingRecord(payload.recordID) }
            guard case var .revisable(record) = existing else {
                return .immutableSettlement(
                    recordID: payload.recordID,
                    attemptedKind: event.kind
                )
            }
            record.isVoided = false
            record.voidReason = nil
            state.records[payload.recordID] = .revisable(record)
        case let .settlementRecorded(payload):
            guard state.records[payload.recordID] == nil else { return .duplicateRecord(payload.recordID) }
            guard let projectedBalances = state.topology.projectedBalances(
                from: state.financialBalances
            ) else {
                return .arithmeticOverflow
            }
            if let reason = validate(
                payload.content,
                pot: pot,
                knownUnitIDs: state.topology.knownUnitIDSet,
                eligibleUnitIDs: payload.content.reversalOfRecordID == nil
                    ? state.topology.settlementEligibleUnitIDs(
                        balances: projectedBalances
                    )
                    : state.topology.knownUnitIDSet
            ) { return reason }
            if let reason = validateSettlementReversal(
                payload.content,
                records: state.records
            ) { return reason }
            state.records[payload.recordID] = .settlement(MutableSettlementRecord(
                recordID: payload.recordID,
                eventID: event.id,
                content: payload.content,
                isFlagged: false,
                createdOrder: order
            ))
        case let .settlementFlagged(payload):
            guard let existing = state.records[payload.recordID] else { return .missingRecord(payload.recordID) }
            guard case var .settlement(record) = existing else { return .nonSettlementFlagTarget(payload.recordID) }
            record.isFlagged = true
            state.records[payload.recordID] = .settlement(record)
        case let .potRenamed(payload):
            state.latestPotName = payload.name
            state.auditOnlyEventIDs.append(event.id)
        case .potArchived:
            state.isArchived = true
            state.auditOnlyEventIDs.append(event.id)
        case let .memberAdded(payload):
            guard state.topology.members[payload.memberID] == nil else { return .duplicateMember(payload.memberID) }
            if let existingMemberID = state.topology.members.keys.sorted().first(where: {
                state.topology.members[$0]?.personalUnitID == payload.unitID
            }) {
                return .memberUnitAlreadyAssigned(
                    unitID: payload.unitID,
                    existingMemberID: existingMemberID
                )
            }
            if let groupID = state.topology.groupUnitIDsByGroupID.keys.sorted().first(where: {
                state.topology.groupUnitIDsByGroupID[$0] == payload.unitID
            }) {
                return .memberUnitConflictsWithGroup(
                    unitID: payload.unitID,
                    groupID: groupID
                )
            }
            if payload.role == .owner,
               let ownerID = state.topology.members.compactMap({ memberID, member in
                   member.role == .owner ? memberID : nil
               })
                   .min() {
                return .ownerAlreadyExists(ownerID)
            }
            if payload.role != .owner, state.topology.members.isEmpty { return .activeOwnerRequired }
            state.topology.members[payload.memberID] = MemberTopology(
                personalUnitID: payload.unitID,
                unitID: payload.unitID,
                role: payload.role
            )
            if state.topology.addKnownUnit(payload.unitID) {
                state.financialBalances[payload.unitID] = 0
            }
            state.topology.addActiveUnit(payload.unitID)
            state.auditOnlyEventIDs.append(event.id)
        case let .memberClaimed(payload):
            guard state.topology.members[payload.memberID] != nil else { return .unknownMember(payload.memberID) }
            guard state.topology.claimedMemberIDs.insert(payload.memberID).inserted else { return .memberAlreadyClaimed(payload.memberID) }
            state.auditOnlyEventIDs.append(event.id)
        case let .memberClaimReassigned(payload):
            guard state.topology.members[payload.memberID] != nil else { return .unknownMember(payload.memberID) }
            guard state.topology.claimedMemberIDs.remove(payload.memberID) != nil else { return .memberNotClaimed(payload.memberID) }
            state.auditOnlyEventIDs.append(event.id)
        case let .memberArchived(payload):
            guard let member = state.topology.members[payload.memberID] else { return .unknownMember(payload.memberID) }
            guard member.role != .owner else { return .ownerMustTransferBeforeArchive(payload.memberID) }
            var topology = state.topology
            let previousManagedUnitIDs = Set(topology.members.values.map(\.unitID))
            guard topology.archivedMemberIDs.insert(payload.memberID).inserted else { return .memberAlreadyArchived(payload.memberID) }
            if event.schemaVersion >= EventEnvelope.budgetGroupSchemaVersion {
                // Departure revokes participation, not the group's ownership.
                // Keep the historical member-to-group binding even when both
                // partners leave or their erasable profiles disappear.
                topology.minimumSchemaVersion = event.schemaVersion
            } else {
                topology.members[payload.memberID] = MemberTopology(
                    personalUnitID: member.personalUnitID,
                    unitID: member.personalUnitID,
                    role: member.role
                )
                topology.groups = topology.groups.compactMap { group in
                    let remainingMemberIDs = group.orderedMemberIDs.filter {
                        $0 != payload.memberID
                    }
                    guard !remainingMemberIDs.isEmpty else { return nil }
                    return SettlementGroupSnapshot(
                        groupID: group.groupID,
                        unitID: group.unitID,
                        orderedMemberIDs: remainingMemberIDs,
                        defaultShareWeight: group.defaultShareWeight
                    )
                }
            }
            topology.rebuildMemberManagedActiveUnits(
                previousManagedUnitIDs: previousManagedUnitIDs
            )
            guard topology.projectedBalances(from: state.financialBalances) != nil else { return .arithmeticOverflow }
            state.topology = topology
            state.auditOnlyEventIDs.append(event.id)
        case let .ownershipTransferred(payload):
            guard let from = state.topology.members[payload.fromMemberID] else { return .unknownMember(payload.fromMemberID) }
            guard let to = state.topology.members[payload.toMemberID] else { return .unknownMember(payload.toMemberID) }
            guard payload.fromMemberID != payload.toMemberID,
                  !state.topology.archivedMemberIDs.contains(payload.toMemberID)
            else {
                return .invalidOwnershipTransfer(
                    from: payload.fromMemberID,
                    to: payload.toMemberID
                )
            }
            guard from.role == .owner else { return .ownershipSourceIsNotOwner(payload.fromMemberID) }
            state.topology.members[payload.fromMemberID] = MemberTopology(
                personalUnitID: from.personalUnitID,
                unitID: from.unitID,
                role: .member
            )
            state.topology.members[payload.toMemberID] = MemberTopology(
                personalUnitID: to.personalUnitID,
                unitID: to.unitID,
                role: .owner
            )
            state.auditOnlyEventIDs.append(event.id)
        case let .groupChanged(payload):
            if event.schemaVersion >= EventEnvelope.budgetGroupSchemaVersion {
                if state.topology.hasFinancialHistory && payload.groups != state.topology.groups { return .budgetGroupsLocked }
                for group in payload.groups where !state.topology.groups.contains(group) {
                    guard (1...2).contains(group.orderedMemberIDs.count), group.defaultShareWeight == 1 else { return .invalidBudgetGroup(group.groupID) }
                }
                // An unchanged grandfathered snapshot neither moves money nor
                // reapplies stricter cardinality/weight rules to valid history.
                if payload.groups == state.topology.groups {
                    state.auditOnlyEventIDs.append(event.id)
                    return nil
                }
            }
            if let reason = validate(
                groups: payload.groups,
                members: state.topology.members,
                archivedMemberIDs: state.topology.archivedMemberIDs,
                groupUnitIDsByGroupID: state.topology.groupUnitIDsByGroupID,
                knownUnitIDs: state.topology.knownUnitIDSet
            ) { return reason }
            var topology = state.topology
            let previousManagedUnitIDs = Set(topology.members.values.map(\.unitID))
            for memberID in Array(topology.members.keys) {
                guard let member = topology.members[memberID] else { continue }
                topology.members[memberID] = MemberTopology(
                    personalUnitID: member.personalUnitID,
                    unitID: member.personalUnitID,
                    role: member.role
                )
            }
            for group in payload.groups {
                _ = topology.addKnownUnit(group.unitID)
                topology.groupUnitIDsByGroupID[group.groupID] = group.unitID
                for memberID in group.orderedMemberIDs {
                    guard let member = topology.members[memberID] else { continue }
                    topology.members[memberID] = MemberTopology(
                        personalUnitID: member.personalUnitID,
                        unitID: group.unitID,
                        role: member.role
                    )
                }
            }
            let addedUnitIDs = topology.knownUnitIDs.filter {
                !state.topology.knownUnitIDSet.contains($0)
            }
            topology.groups = payload.groups
            topology.rebuildMemberManagedActiveUnits(
                previousManagedUnitIDs: previousManagedUnitIDs
            )
            var candidateBalances = state.financialBalances
            for unitID in addedUnitIDs {
                candidateBalances[unitID] = 0
            }
            guard topology.projectedBalances(from: candidateBalances) != nil else { return .arithmeticOverflow }
            state.topology = topology
            state.financialBalances = candidateBalances
            state.auditOnlyEventIDs.append(event.id)
        case let .presetChanged(payload):
            var seen = Set<UnitID>()
            for unitID in payload.orderedUnitIDs {
                if let reason = validateUnitEligibility(unitID,
                knownUnitIDs: state.topology.knownUnitIDSet, eligibleUnitIDs: state.topology.activeUnitIDSet) { return reason }
                guard seen.insert(unitID).inserted else { return .duplicatePresetUnit(unitID) }
            }
            state.topology.presetsByName[payload.name] = ParticipantPresetSnapshot(
                name: payload.name,
                orderedUnitIDs: payload.orderedUnitIDs
            )
            state.auditOnlyEventIDs.append(event.id)
        case .unsupported:
            return nil
        }
        return nil
    }

    // MARK: Record validation

    private func kind(of content: RevisableRecordContent) -> MutableRevisableKind {
        switch content {
        case .expense: .expense
        case .openingBalance: .openingBalance
        }
    }

    private func unitIDs(in content: RevisableRecordContent?) -> Set<UnitID> {
        guard let content else { return [] }
        switch content {
        case let .expense(expense):
            return Set([expense.payerUnitID] + expense.allocations.map(\.unitID))
        case let .openingBalance(openingBalance):
            return Set(openingBalance.entries.map(\.unitID))
        }
    }

    private func validateCurrency(
        _ amount: Money,
        potCurrency: Currency
    ) -> InvalidEventReason? {
        amount.currency == potCurrency
            ? nil : .currencyMismatch(expected: potCurrency, actual: amount.currency)
    }

    private func validateUnitEligibility(
        _ unitID: UnitID,
        knownUnitIDs: Set<UnitID>,
        eligibleUnitIDs: Set<UnitID>
    ) -> InvalidEventReason? {
        guard knownUnitIDs.contains(unitID) else { return .unknownUnit(unitID) }
        guard eligibleUnitIDs.contains(unitID) else { return .inactiveUnit(unitID) }
        return nil
    }

    private func validate(
        groups: [SettlementGroupSnapshot],
        members: [MemberID: MemberTopology],
        archivedMemberIDs: Set<MemberID>,
        groupUnitIDsByGroupID: [GroupID: UnitID],
        knownUnitIDs: Set<UnitID>
    ) -> InvalidEventReason? {
        var groupIDs = Set<GroupID>()
        var groupUnitIDs = Set<UnitID>()
        var groupedMemberIDs = Set<MemberID>()
        let personalUnitIDs = Set(members.values.map(\.personalUnitID))
        var groupIDByUnitID = [UnitID: GroupID]()
        for groupID in groupUnitIDsByGroupID.keys.sorted() {
            guard let unitID = groupUnitIDsByGroupID[groupID] else { continue }
            groupIDByUnitID[unitID] = groupID
        }
        for group in groups {
            guard group.defaultShareWeight > 0 else {
                return .nonPositiveGroupWeight(
                    groupID: group.groupID,
                    weight: group.defaultShareWeight
                )
            }
            guard groupIDs.insert(group.groupID).inserted else { return .duplicateGroup(group.groupID) }
            guard !personalUnitIDs.contains(group.unitID) else { return .groupUnitConflictsWithPersonalUnit(group.unitID) }
            if let expectedUnitID = groupUnitIDsByGroupID[group.groupID],
               expectedUnitID != group.unitID {
                return .groupIdentityRebound(
                    groupID: group.groupID,
                    expectedUnitID: expectedUnitID,
                    actualUnitID: group.unitID
                )
            }
            if let existingGroupID = groupIDByUnitID[group.unitID],
               existingGroupID != group.groupID {
                return .groupUnitReassigned(
                    unitID: group.unitID,
                    existingGroupID: existingGroupID,
                    attemptedGroupID: group.groupID
                )
            }
            if groupUnitIDsByGroupID[group.groupID] == nil,
               knownUnitIDs.contains(group.unitID) {
                return .knownUnitReusedAsGroup(group.unitID)
            }
            guard groupUnitIDs.insert(group.unitID).inserted else { return .duplicateGroupUnit(group.unitID) }
            for memberID in group.orderedMemberIDs {
                guard members[memberID] != nil else { return .unknownGroupMember(memberID) }
                guard !archivedMemberIDs.contains(memberID) else { return .archivedGroupMember(memberID) }
                guard groupedMemberIDs.insert(memberID).inserted else { return .memberInMultipleGroups(memberID) }
            }
        }
        return nil
    }

    private func validate(
        _ content: RevisableRecordContent,
        pot: PotConfiguration,
        knownUnitIDs: Set<UnitID>,
        eligibleUnitIDs: Set<UnitID>
    ) -> InvalidEventReason? {
        switch content {
        case let .expense(expense):
            return validate(
                expense,
                pot: pot,
                knownUnitIDs: knownUnitIDs,
                eligibleUnitIDs: eligibleUnitIDs
            )
        case let .openingBalance(openingBalance):
            return validate(
                openingBalance,
                pot: pot,
                knownUnitIDs: knownUnitIDs,
                eligibleUnitIDs: eligibleUnitIDs
            )
        }
    }

    private func validate(
        _ expense: ExpenseContent,
        pot: PotConfiguration,
        knownUnitIDs: Set<UnitID>,
        eligibleUnitIDs: Set<UnitID>
    ) -> InvalidEventReason? {
        if let reason = validateCurrency(expense.amount, potCurrency: pot.currency) { return reason }
        guard expense.amount.minorUnits > 0 else { return .invalidExpenseAmount }
        if let reason = validateUnitEligibility(expense.payerUnitID,
                knownUnitIDs: knownUnitIDs, eligibleUnitIDs: eligibleUnitIDs) { return reason }
        guard !expense.allocations.isEmpty else { return .invalidExpenseAllocations }
        if expense.kind == .personal {
            guard expense.allocations.count == 1,
                  expense.allocations[0].unitID != expense.payerUnitID
            else {
                return .invalidExpenseAllocations
            }
        }

        var seen = Set<UnitID>()
        var sum: Int64 = 0
        for allocation in expense.allocations {
            if let reason = validateUnitEligibility(allocation.unitID,
                knownUnitIDs: knownUnitIDs, eligibleUnitIDs: eligibleUnitIDs) { return reason }
            guard seen.insert(allocation.unitID).inserted,
                  allocation.amount.minorUnits >= 0
            else { return .invalidExpenseAllocations }
            if let reason = validateCurrency(allocation.amount, potCurrency: pot.currency) { return reason }
            let (next, overflow) = sum.addingReportingOverflow(allocation.amount.minorUnits)
            guard !overflow else { return .arithmeticOverflow }
            sum = next
        }
        return sum == expense.amount.minorUnits ? nil : .invalidExpenseAllocations
    }

    private func validate(
        _ openingBalance: OpeningBalanceContent,
        pot: PotConfiguration,
        knownUnitIDs: Set<UnitID>,
        eligibleUnitIDs: Set<UnitID>
    ) -> InvalidEventReason? {
        guard !openingBalance.entries.isEmpty else { return .invalidOpeningBalance }
        var seen = Set<UnitID>()
        var sum = Decimal.zero
        for entry in openingBalance.entries {
            if let reason = validateUnitEligibility(entry.unitID,
                knownUnitIDs: knownUnitIDs, eligibleUnitIDs: eligibleUnitIDs) { return reason }
            guard seen.insert(entry.unitID).inserted else { return .invalidOpeningBalance }
            if let reason = validateCurrency(entry.amount, potCurrency: pot.currency) { return reason }
            sum += Decimal(entry.amount.minorUnits)
        }
        return sum == .zero ? nil : .invalidOpeningBalance
    }

    private func validate(
        _ settlement: SettlementContent,
        pot: PotConfiguration,
        knownUnitIDs: Set<UnitID>,
        eligibleUnitIDs: Set<UnitID>
    ) -> InvalidEventReason? {
        if let reason = validateCurrency(settlement.amount, potCurrency: pot.currency) { return reason }
        for unitID in [settlement.fromUnitID, settlement.toUnitID] {
            if let reason = validateUnitEligibility(unitID,
                knownUnitIDs: knownUnitIDs, eligibleUnitIDs: eligibleUnitIDs) { return reason }
        }
        guard settlement.amount.minorUnits > 0,
              settlement.fromUnitID != settlement.toUnitID
        else {
            return .invalidSettlement
        }
        return nil
    }

    private func createRevisableRecord(
        recordID: RecordID,
        content: RevisableRecordContent,
        event: EventEnvelope,
        order: Int,
        pot: PotConfiguration,
        state: inout MutableLedgerState
    ) -> InvalidEventReason? {
        guard state.records[recordID] == nil else { return .duplicateRecord(recordID) }
        if let reason = validate(
            content,
            pot: pot,
            knownUnitIDs: state.topology.knownUnitIDSet,
            eligibleUnitIDs: state.topology.activeUnitIDSet
        ) { return reason }
        state.records[recordID] = .revisable(MutableRevisableRecord(
            recordID: recordID,
            originalKind: kind(of: content),
            firstRevision: MutableRevision(event: event, order: order, content: content),
            createdOrder: order
        ))
        return nil
    }

    private func validateSettlementReversal(
        _ settlement: SettlementContent,
        records: [RecordID: MutableRecord]
    ) -> InvalidEventReason? {
        guard let targetRecordID = settlement.reversalOfRecordID else { return nil }
        guard let existing = records[targetRecordID] else { return .missingRecord(targetRecordID) }
        guard case let .settlement(target) = existing else { return .nonSettlementFlagTarget(targetRecordID) }
        guard target.isFlagged else { return .settlementReversalTargetNotFlagged(targetRecordID) }
        guard settlement.fromUnitID == target.content.toUnitID,
              settlement.toUnitID == target.content.fromUnitID
        else {
            return .settlementReversalDirectionMismatch(targetRecordID)
        }
        var remaining = target.content.amount.minorUnits
        for case let .settlement(prior) in records.values
            where prior.content.reversalOfRecordID == targetRecordID {
            let (next, overflow) = remaining.subtractingReportingOverflow(
                prior.content.amount.minorUnits
            )
            guard !overflow else { return .arithmeticOverflow }
            remaining = next
        }
        guard settlement.amount.minorUnits <= remaining else { return .settlementReversalExceedsOriginal(targetRecordID) }
        return nil
    }

    // MARK: Projection and accounting

    private func deriveProjection(
        pot: PotConfiguration,
        state: MutableLedgerState
    ) -> (projection: LedgerProjection, issue: ReductionIssue?) {
        var records = [RecordID: RecordProjection]()
        var issue: ReductionIssue?

        let orderedRecords = state.records.values.sorted {
            $0.createdOrder == $1.createdOrder
                ? $0.recordID < $1.recordID
                : $0.createdOrder < $1.createdOrder
        }
        for record in orderedRecords {
            switch record {
            case let .revisable(revisable):
                guard let applied = revisable.appliedRevision else { continue }
                let revisionProjections = revisable.revisions.values
                    .sorted { $0.order < $1.order }
                    .map(\.projection)
                let headRevisions = revisable.heads.compactMap {
                    revisable.revisions[$0]
                }.sorted { $0.order < $1.order }
                let contested = headRevisions.count > 1
                    ? ContestedRecordProjection(
                        headRevisionIDs: headRevisions.map { $0.projection.eventID },
                        provisionalRevisionID: applied.projection.eventID
                    )
                    : nil
                records[revisable.recordID] = .revisable(RevisableRecordProjection(
                    recordID: revisable.recordID,
                    currentContent: applied.projection.content,
                    appliedRevisionID: applied.projection.eventID,
                    revisions: revisionProjections,
                    isVoided: revisable.isVoided,
                    voidReason: revisable.voidReason,
                    contested: contested
                ))
            case let .settlement(settlement):
                records[settlement.recordID] = .settlement(SettlementRecordProjection(
                    recordID: settlement.recordID,
                    eventID: settlement.eventID,
                    content: settlement.content,
                    isFlagged: settlement.isFlagged
                ))
            }
        }

        let exactProjectedBalances = state.topology.projectedBalances(
            from: state.financialBalances
        )
        let balances = (exactProjectedBalances ?? [:]).mapValues {
            Money(minorUnits: $0, currency: pot.currency)
        }
        let plan: SettlementPlanOutcome
        if exactProjectedBalances == nil {
            plan = .unavailable(.arithmeticOverflow)
            issue = .settlementPlanningFailed(.arithmeticOverflow)
        } else {
            do {
                plan = .exact(try SettlementPlanner.plan(
                    balances: balances,
                    limits: settlementPlanningLimits
                ))
            } catch {
                plan = .unavailable(error)
                switch error {
                case .searchLimitExceeded:
                    break
                case .mixedCurrencies, .nonZeroSum, .arithmeticOverflow:
                    issue = .settlementPlanningFailed(error)
                }
            }
        }

        return (
            LedgerProjection(
                potID: pot.id,
                currency: pot.currency,
                balances: balances,
                spend: Money(minorUnits: state.financialSpend, currency: pot.currency),
                settlementPlan: plan,
                records: records,
                appliedEventIDs: state.appliedEventIDs,
                auditOnlyEventIDs: state.auditOnlyEventIDs,
                lastAppliedServerSequence: state.lastAppliedServerSequence,
                latestPotName: state.latestPotName,
                isArchived: state.isArchived,
                structure: state.topology.projection
            ),
            issue
        )
    }

    private func affectedRecordID(for payload: EventPayload) -> RecordID? {
        switch payload {
        case let .expenseAdded(payload): payload.recordID
        case let .expenseRevised(payload): payload.recordID
        case let .recordVoided(payload): payload.recordID
        case let .recordRestored(payload): payload.recordID
        case let .settlementRecorded(payload): payload.recordID
        case let .settlementFlagged(payload): payload.recordID
        case let .openingBalanceSet(payload): payload.recordID
        case .memberAdded, .memberClaimed, .memberClaimReassigned, .memberArchived,
             .ownershipTransferred, .groupChanged, .presetChanged, .potRenamed,
             .potArchived, .unsupported:
            nil
        }
    }

    private func commitFinancialTransition(
        recordID: RecordID,
        from priorRecord: MutableRecord?,
        to state: inout MutableLedgerState
    ) -> Bool {
        let oldContribution = financialContribution(for: priorRecord)
        let newContribution = financialContribution(for: state.records[recordID])
        let affectedUnits = Set(oldContribution.balances.keys)
            .union(newContribution.balances.keys)
        var candidateBalances = state.financialBalances

        for unitID in affectedUnits {
            let delta = (newContribution.balances[unitID] ?? 0)
                - (oldContribution.balances[unitID] ?? 0)
            let candidate = Int128(candidateBalances[unitID] ?? 0) + delta
            guard let exact = Int64(exactly: candidate) else { return false }
            candidateBalances[unitID] = exact
        }

        let spendDelta = newContribution.spend - oldContribution.spend
        let candidateSpend = Int128(state.financialSpend) + spendDelta
        guard let exactSpend = Int64(exactly: candidateSpend) else { return false }
        guard state.topology.projectedBalances(from: candidateBalances) != nil else { return false }

        state.financialBalances = candidateBalances
        state.financialSpend = exactSpend
        return true
    }

    private func financialContribution(for record: MutableRecord?) -> FinancialContribution {
        guard let record else { return .zero }
        switch record {
        case let .revisable(record):
            guard !record.isVoided, let revision = record.appliedRevision else { return .zero }
            switch revision.projection.content {
            case let .expense(expense):
                var balances = [expense.payerUnitID: Int128(expense.amount.minorUnits)]
                for allocation in expense.allocations {
                    balances[allocation.unitID, default: 0] -= Int128(
                        allocation.amount.minorUnits
                    )
                }
                return FinancialContribution(
                    balances: balances,
                    spend: Int128(expense.amount.minorUnits)
                )
            case let .openingBalance(openingBalance):
                var balances = [UnitID: Int128]()
                for entry in openingBalance.entries {
                    balances[entry.unitID, default: 0] += Int128(entry.amount.minorUnits)
                }
                return FinancialContribution(balances: balances, spend: 0)
            }
        case let .settlement(record):
            return FinancialContribution(
                balances: [
                    record.content.fromUnitID: Int128(record.content.amount.minorUnits),
                    record.content.toUnitID: -Int128(record.content.amount.minorUnits),
                ],
                spend: 0
            )
        }
    }

}
