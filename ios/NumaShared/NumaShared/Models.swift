import Foundation
import NumaSharedCore
import NumaSharedSync
import SwiftUI

nonisolated struct UnitID: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {
    let rawValue: String

    init?(rawValue: String) {
        guard !rawValue.isEmpty else { return nil }
        self.rawValue = rawValue
    }

    private init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    static let am = UnitID("am")
    static let sam = UnitID("sam")
    static let leo = UnitID("leo")
    static let more = UnitID("more")
    static let allCases: [UnitID] = [.am, .sam, .leo]
#if DEBUG
    static let noor = UnitID("noor")
    static let ivy = UnitID("ivy")
    static let max = UnitID("max")
    static let zoe = UnitID("zoe")
    static let eli = UnitID("eli")
    static let mia = UnitID("mia")
    static let kai = UnitID("kai")
    static let eightUnitPerformanceCases: [UnitID] = [
        .am, .sam, .leo, .noor, .ivy, .max, .zoe, .eli,
    ]
    static let tenUnitPerformanceCases: [UnitID] = [
        .am, .sam, .leo, .noor, .ivy, .max, .zoe, .eli, .mia, .kai,
    ]
#endif

    static func remote(_ coreUnitID: NumaSharedCore.UnitID) -> UnitID {
        UnitID("remote:\(coreUnitID.description)")
    }

    var remoteCoreUnitID: NumaSharedCore.UnitID? {
        let prefix = "remote:"
        guard rawValue.hasPrefix(prefix),
              let uuid = UUID(uuidString: String(rawValue.dropFirst(prefix.count)))
        else { return nil }
        return try? NumaSharedCore.UnitID(validating: uuid)
    }
}

nonisolated struct FieldUnitPresentation: Equatable, Sendable {
    let visibleUnitIDs: [UnitID]
    let overflowUnitIDs: [UnitID]

    static func make(
        units: [UnitID],
        balances: [UnitID: Int64],
        pinnedUnitID: UnitID? = nil
    ) -> FieldUnitPresentation {
        guard units.count > 8 else {
            return FieldUnitPresentation(
                visibleUnitIDs: units,
                overflowUnitIDs: []
            )
        }
        let positions = Dictionary(uniqueKeysWithValues: units.enumerated().map {
            ($0.element, $0.offset)
        })
        let ranked = units.sorted { lhs, rhs in
            let left = (balances[lhs] ?? 0).magnitude
            let right = (balances[rhs] ?? 0).magnitude
            if left != right { return left > right }
            return (positions[lhs] ?? 0) < (positions[rhs] ?? 0)
        }
        var selected = Array(ranked.prefix(7))
        if let pinnedUnitID,
           units.contains(pinnedUnitID),
           !selected.contains(pinnedUnitID) {
            selected.removeLast()
            selected.insert(pinnedUnitID, at: 0)
        }
        let selectedSet = Set(selected)
        return FieldUnitPresentation(
            visibleUnitIDs: selected + [.more],
            overflowUnitIDs: units.filter { !selectedSet.contains($0) }
        )
    }
}

struct UnitInfo {
    let id: UnitID
    let name: String
    let initials: String
    let isWoven: Bool
    let weight: Int64
    let isYou: Bool
    let color: Color
    let inkColor: Color
}

let AllUnits: [UnitID: UnitInfo] = {
    var units: [UnitID: UnitInfo] = [
        .am: UnitInfo(id: .am, name: "Arseny + Maya", initials: "A·M", isWoven: true, weight: 2, isYou: true, color: .clear, inkColor: .clear),
        .sam: UnitInfo(id: .sam, name: "Sam", initials: "S", isWoven: false, weight: 1, isYou: false, color: Pal.teal, inkColor: Pal.tealInk),
        .leo: UnitInfo(id: .leo, name: "Leo", initials: "L", isWoven: false, weight: 1, isYou: false, color: Pal.amber, inkColor: Pal.amberInk),
    ]
#if DEBUG
    units.merge([
        .noor: UnitInfo(id: .noor, name: "Noor", initials: "N", isWoven: false, weight: 1, isYou: false, color: Pal.purple, inkColor: Pal.purpleInk),
        .ivy: UnitInfo(id: .ivy, name: "Ivy", initials: "I", isWoven: false, weight: 1, isYou: false, color: Pal.teal, inkColor: Pal.tealInk),
        .max: UnitInfo(id: .max, name: "Max", initials: "M", isWoven: false, weight: 1, isYou: false, color: Pal.amber, inkColor: Pal.amberInk),
        .zoe: UnitInfo(id: .zoe, name: "Zoe", initials: "Z", isWoven: false, weight: 1, isYou: false, color: Pal.purple, inkColor: Pal.purpleInk),
        .eli: UnitInfo(id: .eli, name: "Eli", initials: "E", isWoven: false, weight: 1, isYou: false, color: Pal.teal, inkColor: Pal.tealInk),
        .mia: UnitInfo(id: .mia, name: "Mia", initials: "M", isWoven: false, weight: 1, isYou: false, color: Pal.amber, inkColor: Pal.amberInk),
        .kai: UnitInfo(id: .kai, name: "Kai", initials: "K", isWoven: false, weight: 1, isYou: false, color: Pal.purple, inkColor: Pal.purpleInk),
    ]) { current, _ in current }
#endif
    return units
}()

@MainActor
func unitInfo(for id: UnitID) -> UnitInfo {
    AllUnits[id] ?? UnitInfo(
        id: id,
        name: String(localized: "Unknown member"),
        initials: "?",
        isWoven: false,
        weight: 1,
        isYou: false,
        color: .clear,
        inkColor: .clear
    )
}

nonisolated func localizedFormat(
    _ resource: LocalizedStringResource,
    _ arguments: CVarArg...
) -> String {
    String(
        format: String(localized: resource),
        locale: Locale.current,
        arguments: arguments
    )
}

nonisolated enum RecordKind: String, CaseIterable, Sendable {
    case expense, personal, settlement, openingBalance
    case expenseRevision, openingBalanceRevision
    case voidAttempt, restoreAttempt, settlementFlagAttempt, failedAttempt

    var displayName: String {
        switch self {
        case .expense: String(localized: "Expense")
        case .personal: String(localized: "Personal expense")
        case .settlement: String(localized: "Settlement")
        case .openingBalance: String(localized: "Opening balance")
        case .expenseRevision: String(localized: "Expense edit")
        case .openingBalanceRevision: String(localized: "Opening balance edit")
        case .voidAttempt: String(localized: "Void attempt")
        case .restoreAttempt: String(localized: "Restore attempt")
        case .settlementFlagAttempt: String(localized: "Settlement flag")
        case .failedAttempt: String(localized: "Failed record")
        }
    }
}

nonisolated enum ActivityKindFilter: String, CaseIterable, Identifiable, Sendable {
    case all, expenses, settlements, openingBalances, corrections

    var id: Self { self }
    var displayName: String {
        switch self {
        case .all: String(localized: "All records")
        case .expenses: String(localized: "Expenses")
        case .settlements: String(localized: "Settlements")
        case .openingBalances: String(localized: "Opening balances")
        case .corrections: String(localized: "Corrections")
        }
    }

    func includes(_ kind: RecordKind) -> Bool {
        switch self {
        case .all: true
        case .expenses: kind == .expense || kind == .personal
        case .settlements: kind == .settlement
        case .openingBalances:
            kind == .openingBalance || kind == .openingBalanceRevision
        case .corrections:
            kind == .expenseRevision || kind == .voidAttempt
                || kind == .restoreAttempt || kind == .settlementFlagAttempt
                || kind == .failedAttempt
        }
    }
}

nonisolated enum ActivityPeriodFilter: String, CaseIterable, Identifiable, Sendable {
    case all, week, month, year

    var id: Self { self }
    var displayName: String {
        switch self {
        case .all: String(localized: "All time")
        case .week: String(localized: "This week")
        case .month: String(localized: "This month")
        case .year: String(localized: "This year")
        }
    }
}

nonisolated struct ExpenseRevisionVersion: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let amountCents: Int64
    let payer: UnitID
    let parts: [UnitID: Int64]
    let category: String?
    let note: String?
    let occurredAt: Date
    let originatingTimeZoneIdentifier: String
    let recordedBy: String
    var payerMemberID: NumaSharedCore.MemberID? = nil
    var payerDisplayName: String? = nil

    func formattedWhen(locale: Locale = .current) -> String {
        var style = Date.FormatStyle()
            .day(.defaultDigits)
            .month(.abbreviated)
            .hour(.defaultDigits(amPM: .abbreviated))
            .minute(.twoDigits)
            .locale(locale)
        style.timeZone = TimeZone(identifier: originatingTimeZoneIdentifier) ?? .current
        return occurredAt.formatted(style)
    }
}

nonisolated struct ExpenseRecordContest: Equatable, Sendable {
    let headRevisionIDs: [String]
    let provisionalRevisionID: String
}

nonisolated struct ExpenseBalanceImpact: Identifiable, Equatable, Sendable {
    let id: UnitID
    let beforeMinorUnits: Decimal
    let afterMinorUnits: Decimal
}

nonisolated struct ExpenseRecord: Identifiable, Sendable {
    let id: String
    let sortOrdinal: Int64
    let kind: RecordKind
    let title: String
    let amountCents: Int64
    let payer: UnitID
    let parts: [UnitID: Int64]
    let to: UnitID?
    let occurredAt: Date
    let originatingTimeZoneIdentifier: String
    let category: String?
    let note: String?
    let recordedBy: String
    let voided: Bool
    let voidReason: String?
    let flagged: Bool
    let deliveryState: RecordDeliveryState
    let terminalReason: String?
    let targetRecordID: String?
    let reversalOfRecordID: String?
    let revisionHistory: [ExpenseRevisionVersion]
    let appliedRevisionID: String?
    let contest: ExpenseRecordContest?
    let payerMemberID: NumaSharedCore.MemberID?
    let payerDisplayName: String?
    let allocationUnitIDs: [UnitID]

    init(
        id: String,
        sortOrdinal: Int64,
        kind: RecordKind,
        title: String,
        amountCents: Int64,
        payer: UnitID,
        parts: [UnitID: Int64],
        to: UnitID?,
        occurredAt: Date,
        originatingTimeZoneIdentifier: String,
        category: String?,
        note: String? = nil,
        recordedBy: String,
        voided: Bool,
        voidReason: String? = nil,
        flagged: Bool,
        deliveryState: RecordDeliveryState = .synced,
        terminalReason: String? = nil,
        targetRecordID: String? = nil,
        reversalOfRecordID: String? = nil,
        revisionHistory: [ExpenseRevisionVersion] = [],
        appliedRevisionID: String? = nil,
        contest: ExpenseRecordContest? = nil,
        payerMemberID: NumaSharedCore.MemberID? = nil,
        payerDisplayName: String? = nil,
        allocationUnitIDs: [UnitID] = []
    ) {
        self.id = id
        self.sortOrdinal = sortOrdinal
        self.kind = kind
        self.title = title
        self.amountCents = amountCents
        self.payer = payer
        self.parts = parts
        self.to = to
        self.occurredAt = occurredAt
        self.originatingTimeZoneIdentifier = originatingTimeZoneIdentifier
        self.category = category
        self.note = note
        self.recordedBy = recordedBy
        self.voided = voided
        self.voidReason = voidReason
        self.flagged = flagged
        self.deliveryState = deliveryState
        self.terminalReason = terminalReason
        self.targetRecordID = targetRecordID
        self.reversalOfRecordID = reversalOfRecordID
        self.revisionHistory = revisionHistory
        self.appliedRevisionID = appliedRevisionID
        self.contest = contest
        self.payerMemberID = payerMemberID
        self.payerDisplayName = payerDisplayName
        self.allocationUnitIDs = allocationUnitIDs
    }

    var when: String {
        formattedWhen()
    }

    func formattedWhen(locale: Locale = .current, now: Date = Date()) -> String {
        let timeZone = TimeZone(identifier: originatingTimeZoneIdentifier) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if calendar.isDate(occurredAt, inSameDayAs: now) {
            return String(localized: "Today", locale: locale)
        }
        var style = Date.FormatStyle()
            .weekday(.abbreviated)
            .day(.defaultDigits)
            .month(.abbreviated)
            .locale(locale)
        style.timeZone = timeZone
        return occurredAt.formatted(style)
    }

    /// Second line for an activity row, matching the source prototype's `rowFor`.
    @MainActor var subtitle: String {
        subtitle { unitInfo(for: $0).name }
    }

    @MainActor
    func subtitle(unitName: (UnitID) -> String) -> String {
        switch kind {
        case .settlement:
            if reversalOfRecordID != nil {
                return localizedFormat(
                    "Reversal · %1$@ · by %2$@",
                    when,
                    recordedBy
                )
            }
            return localizedFormat(
                "Settlement · %1$@ · by %2$@",
                when,
                recordedBy
            )
        case .personal:
            return localizedFormat(
                "Personal · %1$@ paid · %2$@",
                unitName(payer),
                when
            )
        case .expense:
            let count = parts.count
            if count == 1 {
                return localizedFormat(
                    "%1$@ paid · %2$@ · split %3$lld unit",
                    unitName(payer),
                    when,
                    Int64(count)
                )
            }
            return localizedFormat(
                "%1$@ paid · %2$@ · split %3$lld units",
                unitName(payer),
                when,
                Int64(count)
            )
        case .openingBalance:
            return localizedFormat(
                "Opening balance · %@",
                when
            )
        case .expenseRevision, .openingBalanceRevision:
            return localizedFormat("Edit attempt · %1$@ · by %2$@", when, recordedBy)
        case .voidAttempt:
            return localizedFormat("Void attempt · %1$@ · by %2$@", when, recordedBy)
        case .restoreAttempt:
            return localizedFormat("Restore attempt · %1$@ · by %2$@", when, recordedBy)
        case .settlementFlagAttempt:
            return localizedFormat("Flag attempt · %1$@ · by %2$@", when, recordedBy)
        case .failedAttempt:
            return localizedFormat("Failed attempt · %1$@ · by %2$@", when, recordedBy)
        }
    }

    @MainActor var badge: String? {
        if contest != nil { return String(localized: "Needs choice") }
        if voided { return String(localized: "Void") }
        if flagged { return String(localized: "Flagged") }
        if reversalOfRecordID != nil { return String(localized: "Reversal") }
        switch kind {
        case .personal: return String(localized: "Personal")
        case .settlement: return String(localized: "Settled")
        case .openingBalance: return String(localized: "Opening")
        case .expenseRevision, .openingBalanceRevision: return String(localized: "Edit")
        case .voidAttempt: return String(localized: "Void")
        case .restoreAttempt: return String(localized: "Restore")
        case .settlementFlagAttempt: return String(localized: "Flag")
        case .failedAttempt: return String(localized: "Failed")
        case .expense: return nil
        }
    }

    var displaysAmount: Bool {
        switch kind {
        case .expense, .personal, .settlement, .expenseRevision:
            true
        case .openingBalance, .openingBalanceRevision, .voidAttempt,
             .restoreAttempt, .settlementFlagAttempt, .failedAttempt:
            false
        }
    }

    @MainActor var deliveryCopy: String? {
        switch deliveryState {
        case .waiting:
            String(localized: "Waiting to sync")
        case .failed:
            if Self.accessFailureCodes.contains(terminalReason ?? "") {
                String(localized: "Couldn’t be added — you’re no longer a member")
            } else if Self.capacityFailureCodes.contains(terminalReason ?? "") {
                String(localized: "Couldn’t be added — this pot reached its safe record capacity. Copy the details and contact support.")
            } else {
                String(localized: "Couldn’t be added — copy the details and contact support.")
            }
        case .synced:
            nil
        }
    }

    /// A user-initiated, redaction-safe support artifact for terminal attempts.
    /// Arithmetic stays in exact minor units so copied/shared evidence cannot
    /// introduce a locale-dependent rounding claim.
    var failureSupportText: String? {
        guard deliveryState == .failed else { return nil }
        var lines = [
            String(localized: "Numa Shared failed record"),
            localizedFormat("Title: %@", title),
            localizedFormat("Kind: %@", kind.displayName),
            localizedFormat("Amount (minor units): %lld", amountCents),
            localizedFormat("Occurred: %@", occurredAt.formatted(.iso8601)),
            localizedFormat("Failure: %@", terminalReason ?? "UNKNOWN"),
            localizedFormat(
                "Local event: %@",
                id.replacingOccurrences(of: "failed:", with: "")
            ),
        ]
        if let targetRecordID {
            lines.append(localizedFormat("Target record: %@", targetRecordID))
        }
        return lines.joined(separator: "\n")
    }

    private static let accessFailureCodes: Set<String> = [
        "NOT_MEMBER",
        "MEMBERSHIP_ARCHIVED",
        "POT_MEMBERSHIP_REQUIRED",
    ]

    private static let capacityFailureCodes: Set<String> = [
        "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
        "NEGATIVE_CONTRIBUTION_BUDGET_EXCEEDED",
    ]
}

nonisolated enum RecordDeliveryState: Equatable, Sendable {
    case waiting
    case failed
    case synced
}

/// A suggested transfer that clears debt with the fewest possible transfers.
nonisolated struct SettlementStep: Sendable {
    let from: UnitID
    let to: UnitID
    let amountCents: Int64
}

nonisolated struct AppPotSetupSnapshot: Equatable, Sendable {
    let potName: String
    let displayNames: [UnitID: String]
    let isComplete: Bool

    var ownerDisplayName: String? { displayNames[.am] }

    static let incomplete = AppPotSetupSnapshot(
        potName: "",
        displayNames: [:],
        isComplete: false
    )
}

nonisolated struct AppMemberProfile: Equatable, Sendable {
    let memberID: NumaSharedCore.MemberID
    let unitID: UnitID?
    let displayName: String?
    let role: MemberRole
    let state: PotMemberState
    var budgetUnitID: UnitID? = nil
}

nonisolated struct AppLedgerSnapshot: Sendable {
    let revision: Int64
    let currency: Currency
    let balances: [UnitID: Int64]
    let spend: Int64
    let plan: [SettlementStep]
    let records: [ExpenseRecord]
    let pendingDeliveryEventCount: Int
    let unsyncedEventCount: Int
    let isArchived: Bool
    let isCurrentMemberArchived: Bool
    let reductionAccess: ReductionAccess
    let minimumReaderSchemaVersion: UInt16?
    let readerSchemaVersion: UInt16
    let potSetup: AppPotSetupSnapshot
    let memberProfiles: [AppMemberProfile]
    let currentMemberID: NumaSharedCore.MemberID?
    let structure: StructuralProjection?
    let activeBudgetUnitIDs: [UnitID]

    init(
        revision: Int64,
        currency: Currency = .eur,
        balances: [UnitID: Int64],
        spend: Int64,
        plan: [SettlementStep],
        records: [ExpenseRecord],
        pendingDeliveryEventCount: Int,
        unsyncedEventCount: Int,
        isArchived: Bool,
        isCurrentMemberArchived: Bool = false,
        reductionAccess: ReductionAccess,
        minimumReaderSchemaVersion: UInt16?,
        readerSchemaVersion: UInt16 = EventEnvelope.currentSchemaVersion,
        potSetup: AppPotSetupSnapshot = .incomplete,
        memberProfiles: [AppMemberProfile] = [],
        currentMemberID: NumaSharedCore.MemberID? = nil,
        structure: StructuralProjection? = nil,
        activeBudgetUnitIDs: [UnitID] = []
    ) {
        self.revision = revision
        self.currency = currency
        self.balances = balances
        self.spend = spend
        self.plan = plan
        self.records = records
        self.pendingDeliveryEventCount = pendingDeliveryEventCount
        self.unsyncedEventCount = unsyncedEventCount
        self.isArchived = isArchived
        self.isCurrentMemberArchived = isCurrentMemberArchived
        self.reductionAccess = reductionAccess
        self.minimumReaderSchemaVersion = minimumReaderSchemaVersion
        self.readerSchemaVersion = readerSchemaVersion
        self.potSetup = potSetup
        self.memberProfiles = memberProfiles
        self.currentMemberID = currentMemberID
        self.structure = structure
        self.activeBudgetUnitIDs = activeBudgetUnitIDs
    }

    var currentMemberProfile: AppMemberProfile? {
        guard let currentMemberID else { return nil }
        return memberProfiles.first { $0.memberID == currentMemberID }
    }

    var requiresReaderUpdate: Bool {
        guard let minimumReaderSchemaVersion else { return false }
        return minimumReaderSchemaVersion > readerSchemaVersion
    }

    var hasPendingDeliveryEvents: Bool {
        pendingDeliveryEventCount > 0
    }

    static let empty = AppLedgerSnapshot(
        revision: 0,
        balances: [.am: 0, .sam: 0, .leo: 0],
        spend: 0,
        plan: [],
        records: [],
        pendingDeliveryEventCount: 0,
        unsyncedEventCount: 0,
        isArchived: false,
        reductionAccess: .readWrite,
        minimumReaderSchemaVersion: nil
    )
}

nonisolated enum HeldEventExpiry: Sendable {
    case transitioned(eventIDs: [NumaSharedCore.EventID])
    case stillHeld(until: Date)
    case noLongerHeld
}

nonisolated struct AppLedgerMutation: Sendable {
    let snapshot: AppLedgerSnapshot
    let eventID: NumaSharedCore.EventID
    let undoDeadline: Date
}

nonisolated struct AppLedgerIdentitySet: Codable, Equatable, Sendable {
    let potID: NumaSharedCore.PotID
    let ownerMemberID: NumaSharedCore.MemberID
    let samMemberID: NumaSharedCore.MemberID
    let leoMemberID: NumaSharedCore.MemberID
    let householdUnitID: NumaSharedCore.UnitID
    let samUnitID: NumaSharedCore.UnitID
    let leoUnitID: NumaSharedCore.UnitID
    let adoptedUnitIDs: [NumaSharedCore.UnitID]?

    init(
        potID: NumaSharedCore.PotID,
        ownerMemberID: NumaSharedCore.MemberID,
        samMemberID: NumaSharedCore.MemberID,
        leoMemberID: NumaSharedCore.MemberID,
        householdUnitID: NumaSharedCore.UnitID,
        samUnitID: NumaSharedCore.UnitID,
        leoUnitID: NumaSharedCore.UnitID,
        adoptedUnitIDs: [NumaSharedCore.UnitID]? = nil
    ) {
        self.potID = potID
        self.ownerMemberID = ownerMemberID
        self.samMemberID = samMemberID
        self.leoMemberID = leoMemberID
        self.householdUnitID = householdUnitID
        self.samUnitID = samUnitID
        self.leoUnitID = leoUnitID
        self.adoptedUnitIDs = adoptedUnitIDs
    }

    static func fresh(at date: Date = Date()) -> AppLedgerIdentitySet {
        AppLedgerIdentitySet(
            potID: .generate(at: date),
            ownerMemberID: .generate(at: date),
            samMemberID: .generate(at: date),
            leoMemberID: .generate(at: date),
            householdUnitID: .generate(at: date),
            samUnitID: .generate(at: date),
            leoUnitID: .generate(at: date)
        )
    }

    static func adoptingRemotePot(
        configuration: PotConfiguration,
        memberID: NumaSharedCore.MemberID,
        preserving local: AppLedgerIdentitySet
    ) throws -> AppLedgerIdentitySet {
        guard let first = configuration.orderedUnitIDs.first else {
            throw AppLedgerRepositoryError.unsupportedRemoteUnitCount(0)
        }
        return AppLedgerIdentitySet(
            potID: configuration.id,
            ownerMemberID: memberID,
            samMemberID: local.samMemberID,
            leoMemberID: local.leoMemberID,
            householdUnitID: first,
            samUnitID: configuration.orderedUnitIDs.dropFirst().first ?? first,
            leoUnitID: configuration.orderedUnitIDs.dropFirst(2).first ?? first,
            adoptedUnitIDs: configuration.orderedUnitIDs
        )
    }

    static var legacy: AppLedgerIdentitySet {
        get throws {
            try AppLedgerIdentitySet(
                potID: AppLedgerIDs.potID(),
                ownerMemberID: AppLedgerIDs.actorMemberID(for: .am),
                samMemberID: AppLedgerIDs.actorMemberID(for: .sam),
                leoMemberID: AppLedgerIDs.actorMemberID(for: .leo),
                householdUnitID: AppLedgerIDs.coreUnit(for: .am),
                samUnitID: AppLedgerIDs.coreUnit(for: .sam),
                leoUnitID: AppLedgerIDs.coreUnit(for: .leo)
            )
        }
    }

    var orderedUnitIDs: [NumaSharedCore.UnitID] {
        adoptedUnitIDs ?? [householdUnitID, samUnitID, leoUnitID]
    }

    func memberID(for unit: UnitID) -> NumaSharedCore.MemberID {
        if unit == .am { return ownerMemberID }
        if unit == .sam { return samMemberID }
        if unit == .leo { return leoMemberID }
        return ownerMemberID
    }

    func coreUnit(for unit: UnitID) -> NumaSharedCore.UnitID {
        if unit == .am { return orderedUnitIDs[0] }
        if unit == .sam, orderedUnitIDs.count > 1 { return orderedUnitIDs[1] }
        if unit == .leo, orderedUnitIDs.count > 2 { return orderedUnitIDs[2] }
        guard let remote = unit.remoteCoreUnitID
        else { preconditionFailure("Unit has no ledger identity") }
        return remote
    }

    func appUnit(for coreUnit: NumaSharedCore.UnitID) -> UnitID? {
        guard let index = orderedUnitIDs.firstIndex(of: coreUnit) else {
            return .remote(coreUnit)
        }
        if index == 0 { return .am }
        if index == 1 { return .sam }
        if index == 2 { return .leo }
        return .remote(coreUnit)
    }

#if DEBUG
    static func deterministicE2E(seed: String) throws -> AppLedgerIdentitySet {
        let factory = try E2EUUIDFactory(seed: seed)
        return try AppLedgerIdentitySet(
            potID: NumaSharedCore.PotID(validating: try factory.uuid(discriminator: 1)),
            ownerMemberID: NumaSharedCore.MemberID(validating: try factory.uuid(discriminator: 2)),
            samMemberID: NumaSharedCore.MemberID(validating: try factory.uuid(discriminator: 3)),
            leoMemberID: NumaSharedCore.MemberID(validating: try factory.uuid(discriminator: 4)),
            householdUnitID: NumaSharedCore.UnitID(validating: try factory.uuid(discriminator: 0x11)),
            samUnitID: NumaSharedCore.UnitID(validating: try factory.uuid(discriminator: 0x12)),
            leoUnitID: NumaSharedCore.UnitID(validating: try factory.uuid(discriminator: 0x13))
        )
    }
#endif
}

nonisolated struct AppLedgerIdentityMetadata: Codable, Equatable, Sendable {
    let identities: AppLedgerIdentitySet
    let accountID: String?
    let minimumReaderSchemaVersion: UInt16?
}

/// Fixed UUIDv7 identities keep the app's stable visual unit enum aligned
/// with Core identifiers across launches and SQLite rebuilds.
nonisolated enum AppLedgerIDs {
    static func potID() throws -> NumaSharedCore.PotID {
        try NumaSharedCore.PotID(validating: fixedUUID(0x01))
    }

    static func actorMemberID(for unit: UnitID) throws -> NumaSharedCore.MemberID {
        let suffix: UInt8
        if unit == .am { suffix = 0x02 }
        else if unit == .sam { suffix = 0x03 }
        else if unit == .leo { suffix = 0x04 }
        else { preconditionFailure("Dynamic units have no fixed member identity") }
        return try NumaSharedCore.MemberID(validating: fixedUUID(suffix))
    }

    static func coreUnit(for unit: UnitID) throws -> NumaSharedCore.UnitID {
        let suffix: UInt8
        if unit == .am { suffix = 0x11 }
        else if unit == .sam { suffix = 0x12 }
        else if unit == .leo { suffix = 0x13 }
        else { preconditionFailure("Dynamic units have no fixed ledger identity") }
        return try NumaSharedCore.UnitID(validating: fixedUUID(suffix))
    }

    static func appUnit(for unitID: NumaSharedCore.UnitID) -> UnitID? {
        for unit in UnitID.allCases {
            if let candidate = try? coreUnit(for: unit), candidate == unitID {
                return unit
            }
        }
        return nil
    }

#if DEBUG
    static func seedRecordID(_ index: UInt8) throws -> NumaSharedCore.RecordID {
        try NumaSharedCore.RecordID(validating: fixedUUID(0x40 &+ index))
    }

    static func seedEventID(_ index: UInt8) throws -> NumaSharedCore.EventID {
        try NumaSharedCore.EventID(validating: fixedUUID(0x50 &+ index))
    }
#endif

    private static func fixedUUID(_ suffix: UInt8) -> UUID {
        UUID(uuid: (
            0x01, 0x9B, 0x01, 0x00,
            0x00, suffix, 0x70 | (suffix & 0x0F), suffix,
            0x80 | (suffix & 0x3F), suffix, 0x4E, 0x55,
            0x4D, 0x41, 0x00, suffix
        ))
    }
}

#if DEBUG
nonisolated struct E2EUUIDFactory: Sendable {
    private let seed: UInt64

    init(seed: String) throws {
        guard (1...16).contains(seed.count),
              seed.allSatisfy({ $0.isHexDigit }),
              let parsed = UInt64(seed, radix: 16)
        else { throw NumaSessionError.configurationUnavailable }
        self.seed = parsed
    }

    func uuid(discriminator: UInt64) throws -> UUID {
        var generator = SplitMix64(state: seed ^ (discriminator &* 0x9E37_79B9_7F4A_7C15))
        let timestamp = 1_700_000_000_000 + (seed & 0x0000_000F_FFFF_FFFF)
        return try UUIDv7.generate(
            timestampMilliseconds: timestamp,
            using: &generator
        )
    }

    func randomIndex(discriminator: UInt64, count: Int) throws -> Int {
        guard count > 0 else { throw NumaSessionError.configurationUnavailable }
        var generator = SplitMix64(
            state: seed ^ (discriminator &* 0xD1B5_4A32_D192_ED03)
        )
        return Int(generator.next() % UInt64(count))
    }

    private struct SplitMix64: RandomNumberGenerator {
        var state: UInt64

        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var value = state
            value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
            value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
            return value ^ (value >> 31)
        }
    }
}
#endif
