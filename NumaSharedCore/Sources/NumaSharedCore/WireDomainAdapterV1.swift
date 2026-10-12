import Foundation

// MARK: - Domain adapter

internal extension WireEventPayloadV1 {
    var payerMemberId: MemberID? {
        switch self {
        case let .expenseAdded(_, content): content.payerMemberId
        case let .expenseRevised(_, _, content):
            if case let .expense(expense) = content { expense.payerMemberId } else { nil }
        default: nil
        }
    }

    struct TextContract {
        let required: [WireTextFieldV1]
        let allowed: [WireTextFieldV1]
    }

    var textContract: TextContract {
        switch self {
        case .expenseAdded:
            TextContract(required: [.title], allowed: [.title, .category])
        case let .expenseRevised(_, _, content):
            content.textContract
        case .recordVoided:
            TextContract(required: [.reason], allowed: [.reason])
        case .recordRestored:
            TextContract(required: [], allowed: [])
        case .settlementRecorded:
            TextContract(required: [.title], allowed: [.title])
        case .settlementFlagged:
            TextContract(required: [], allowed: [.reason])
        case .openingBalanceSet:
            TextContract(required: [.title], allowed: [.title, .note])
        case .memberAdded, .memberClaimed, .memberClaimReassigned,
             .ownershipTransferred, .groupChanged, .presetChanged, .potRenamed:
            TextContract(required: [], allowed: [])
        case .memberArchived, .potArchived:
            TextContract(required: [], allowed: [.reason])
        case .unsupported:
            // A newer writer may still use any text sidecar field known to
            // this reader. Preserve that manifest so erasure can be applied
            // even though the arithmetic payload kind is not understood.
            TextContract(required: [], allowed: WireTextFieldV1.canonicalOrder)
        }
    }

    static func separating(
        _ payload: EventPayload
    ) throws -> (payload: WireEventPayloadV1, authoredText: [WireAuthoredTextV1]) {
        switch payload {
        case let .expenseAdded(value):
            return (
                .expenseAdded(recordId: value.recordID, content: WireExpenseContentV1(value.content)),
                expenseText(value.content)
            )
        case let .expenseRevised(value):
            let separated = revisableContent(value.content)
            return (
                .expenseRevised(recordId: value.recordID, basis: WireRevisionBasisV1(value.basis), content: separated.content),
                separated.authoredText
            )
        case let .recordVoided(value):
            return (
                .recordVoided(recordId: value.recordID),
                [WireAuthoredTextV1(field: .reason, value: value.reason)]
            )
        case let .recordRestored(value):
            return (.recordRestored(recordId: value.recordID), [])
        case let .settlementRecorded(value):
            return (
                .settlementRecorded(recordId: value.recordID, content: WireSettlementContentV1(value.content)),
                [WireAuthoredTextV1(field: .title, value: value.content.title)]
            )
        case let .settlementFlagged(value):
            return (
                .settlementFlagged(recordId: value.recordID),
                optionalText(field: .reason, value: value.reason)
            )
        case let .openingBalanceSet(value):
            return (
                .openingBalanceSet(recordId: value.recordID, content: WireOpeningBalanceContentV1(value.content)),
                openingBalanceText(value.content)
            )
        case let .memberAdded(value):
            return (.memberAdded(memberId: value.memberID, unitId: value.unitID, role: value.role), [])
        case let .memberClaimed(value):
            return (.memberClaimed(memberId: value.memberID), [])
        case let .memberClaimReassigned(value):
            return (.memberClaimReassigned(memberId: value.memberID), [])
        case let .memberArchived(value):
            return (
                .memberArchived(memberId: value.memberID),
                optionalText(field: .reason, value: value.reason)
            )
        case let .ownershipTransferred(value):
            return (.ownershipTransferred(fromMemberId: value.fromMemberID, toMemberId: value.toMemberID), [])
        case let .groupChanged(value):
            return (
                .groupChanged(groups: value.groups.map(WireSettlementGroupV1.init)),
                []
            )
        case let .presetChanged(value):
            return (
                .presetChanged(name: value.name, orderedUnitIds: value.orderedUnitIDs),
                []
            )
        case let .potRenamed(value):
            return (.potRenamed(name: value.name), [])
        case let .potArchived(value):
            return (
                .potArchived,
                optionalText(field: .reason, value: value.reason)
            )
        case let .unsupported(kind, _):
            throw WireEventV1Error.unsupportedEventKind(kind)
        }
    }

    func domainPayload(text: [WireTextFieldV1: String]) throws -> EventPayload {
        switch self {
        case let .expenseAdded(recordId, content):
            return .expenseAdded(ExpenseAddedPayload(recordID: recordId, content: try content.domainContent(text: text)))
        case let .expenseRevised(recordId, basis, content):
            return .expenseRevised(ExpenseRevisedPayload(
                recordID: recordId, basis: try basis.domainBasis(), content: try content.domainContent(text: text)
            ))
        case let .recordVoided(recordId):
            return .recordVoided(RecordVoidedPayload(recordID: recordId, reason: try Self.requiredText(.reason, from: text)))
        case let .recordRestored(recordId):
            return .recordRestored(RecordRestoredPayload(recordID: recordId))
        case let .settlementRecorded(recordId, content):
            return .settlementRecorded(SettlementRecordedPayload(
                recordID: recordId,
                content: SettlementContent(
                    title: try Self.requiredText(.title, from: text),
                    amount: content.amount,
                    fromUnitID: content.fromUnitId,
                    toUnitID: content.toUnitId,
                    reversalOfRecordID: content.reversalOfRecordId
                )
            ))
        case let .settlementFlagged(recordId):
            return .settlementFlagged(SettlementFlaggedPayload(recordID: recordId, reason: text[.reason]))
        case let .openingBalanceSet(recordId, content):
            return .openingBalanceSet(OpeningBalanceSetPayload(recordID: recordId, content: try content.domainContent(text: text)))
        case let .memberAdded(memberId, unitId, role):
            return .memberAdded(MemberAddedPayload(
                memberID: memberId,
                unitID: unitId,
                role: role
            ))
        case let .memberClaimed(memberId):
            return .memberClaimed(MemberClaimedPayload(memberID: memberId))
        case let .memberClaimReassigned(memberId):
            return .memberClaimReassigned(MemberClaimReassignedPayload(memberID: memberId))
        case let .memberArchived(memberId):
            return .memberArchived(MemberArchivedPayload(
                memberID: memberId,
                reason: text[.reason]
            ))
        case let .ownershipTransferred(fromMemberId, toMemberId):
            return .ownershipTransferred(OwnershipTransferredPayload(fromMemberID: fromMemberId, toMemberID: toMemberId))
        case let .groupChanged(groups):
            return .groupChanged(GroupChangedPayload(
                groups: groups.map(\.domainSnapshot)
            ))
        case let .presetChanged(name, orderedUnitIds):
            return .presetChanged(PresetChangedPayload(name: name, orderedUnitIDs: orderedUnitIds))
        case let .potRenamed(name):
            return .potRenamed(PotRenamedPayload(name: name))
        case .potArchived:
            return .potArchived(PotArchivedPayload(reason: text[.reason]))
        case let .unsupported(kind, payload):
            return .unsupported(kind: kind, payload: payload)
        }
    }

    static func expenseText(_ content: ExpenseContent) -> [WireAuthoredTextV1] {
        [WireAuthoredTextV1(field: .title, value: content.title)]
            + optionalText(field: .category, value: content.category)
    }

    static func openingBalanceText(
        _ content: OpeningBalanceContent
    ) -> [WireAuthoredTextV1] {
        [WireAuthoredTextV1(field: .title, value: content.title)]
            + optionalText(field: .note, value: content.note)
    }

    static func optionalText(
        field: WireTextFieldV1,
        value: String?
    ) -> [WireAuthoredTextV1] {
        value.map { [WireAuthoredTextV1(field: field, value: $0)] } ?? []
    }

    static func revisableContent(
        _ content: RevisableRecordContent
    ) -> (content: WireRevisableContentV1, authoredText: [WireAuthoredTextV1]) {
        switch content {
        case let .expense(value):
            return (.expense(WireExpenseContentV1(value)), expenseText(value))
        case let .openingBalance(value):
            return (
                .openingBalance(WireOpeningBalanceContentV1(value)),
                openingBalanceText(value)
            )
        }
    }

    static func requiredText(
        _ field: WireTextFieldV1,
        from text: [WireTextFieldV1: String]
    ) throws -> String {
        guard let value = text[field] else { throw WireEventV1Error.missingRequiredText(field) }
        return value
    }
}

internal extension WireExpenseContentV1 {
    init(_ content: ExpenseContent) {
        self.init(
            expenseKind: content.kind,
            amount: content.amount,
            payerUnitId: content.payerUnitID,
            allocations: content.allocations.map {
                WireExpenseAllocationV1(unitId: $0.unitID, amount: $0.amount)
            },
            payerMemberId: content.payerMemberID
        )
    }

    func domainContent(text: [WireTextFieldV1: String]) throws -> ExpenseContent {
        ExpenseContent(
            kind: expenseKind,
            title: try WireEventPayloadV1.requiredText(.title, from: text),
            amount: amount,
            payerUnitID: payerUnitId,
            allocations: allocations.map {
                ExpenseAllocation(unitID: $0.unitId, amount: $0.amount)
            },
            category: text[.category],
            payerMemberID: payerMemberId
        )
    }
}

internal extension WireOpeningBalanceContentV1 {
    init(_ content: OpeningBalanceContent) {
        self.init(entries: content.entries.map {
            WireOpeningBalanceEntryV1(unitId: $0.unitID, amount: $0.amount)
        })
    }

    func domainContent(
        text: [WireTextFieldV1: String]
    ) throws -> OpeningBalanceContent {
        OpeningBalanceContent(
            title: try WireEventPayloadV1.requiredText(.title, from: text),
            entries: entries.map {
                OpeningBalanceEntry(unitID: $0.unitId, amount: $0.amount)
            },
            note: text[.note]
        )
    }
}

internal extension WireSettlementContentV1 {
    init(_ content: SettlementContent) {
        self.init(
            amount: content.amount,
            fromUnitId: content.fromUnitID,
            toUnitId: content.toUnitID,
            reversalOfRecordId: content.reversalOfRecordID
        )
    }
}

internal extension WireRevisionBasisV1 {
    init(_ basis: RevisionBasis) {
        switch basis {
        case let .parent(parentEventId):
            self = .parent(parentEventId: parentEventId)
        case let .resolution(pair):
            self = .resolution(
                firstEventId: pair.first,
                secondEventId: pair.second
            )
        }
    }

    func domainBasis() throws -> RevisionBasis {
        switch self {
        case let .parent(parentEventId):
            .parent(parentEventId)
        case let .resolution(firstEventId, secondEventId):
            .resolution(try RevisionPair(firstEventId, secondEventId))
        }
    }
}

internal extension WireRevisableContentV1 {
    var textContract: WireEventPayloadV1.TextContract {
        switch self {
        case .expense:
            WireEventPayloadV1.TextContract(
                required: [.title],
                allowed: [.title, .category]
            )
        case .openingBalance:
            WireEventPayloadV1.TextContract(
                required: [.title],
                allowed: [.title, .note]
            )
        }
    }

    func domainContent(
        text: [WireTextFieldV1: String]
    ) throws -> RevisableRecordContent {
        switch self {
        case let .expense(content):
            .expense(try content.domainContent(text: text))
        case let .openingBalance(content):
            .openingBalance(try content.domainContent(text: text))
        }
    }
}

internal extension WireSettlementGroupV1 {
    init(_ snapshot: SettlementGroupSnapshot) {
        self.init(
            groupId: snapshot.groupID,
            unitId: snapshot.unitID,
            orderedMemberIds: snapshot.orderedMemberIDs,
            defaultShareWeight: snapshot.defaultShareWeight
        )
    }

    var domainSnapshot: SettlementGroupSnapshot {
        SettlementGroupSnapshot(
            groupID: groupId,
            unitID: unitId,
            orderedMemberIDs: orderedMemberIds,
            defaultShareWeight: defaultShareWeight
        )
    }
}
