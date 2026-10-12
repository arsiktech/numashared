import Foundation
import NumaSharedCore
import NumaSharedSync

nonisolated enum AppLedgerRepositoryError: Error, Sendable {
    case applicationSupportDirectoryUnavailable
    case identityMetadataInvalid
    case invalidAccountIdentifier
    case accountIdentityMismatch
    case localSetupIncomplete
    case unsupportedRemoteUnitCount(Int)
#if DEBUG
    case invalidSeedDate
#endif
    case missingStoredRecord(String)
    case unknownRecord(String)
    case recordNotContested(String)
    case recordContested(String)
    case recordNotEditable(String)
    case unknownRevision(String)
    case invalidContestSelection
    case unsupportedRevisionContent
    case invalidExpenseAllocations
    case unknownUnit(NumaSharedCore.UnitID)
    case invalidLocalMutation(ReductionIssue)
    case readOnlyReduction(ReductionIssue)
    case archivedPot
}

nonisolated struct AppLedgerSyncContext: Sendable {
    let store: LedgerStore
    let configuration: PotConfiguration
    let ownerMemberID: NumaSharedCore.MemberID
    let ownerDisplayName: String?
    let accountID: String?
    let minimumReaderSchemaVersion: UInt16?
}

/// Serializes the synchronous SQLite API away from the main actor and exposes
/// only rebuilt Core projections to the UI layer.
actor AppLedgerRepository {
    enum StorageMode: Sendable {
        case inMemory
        case persistent
    }

    private let readerSchemaVersion: UInt16
    private let storageMode: StorageMode
    private let suppliedIdentities: AppLedgerIdentitySet?
    private let databaseName: String
    private let explicitIdentityMetadataURL: URL?
    private let identityMetadataFilename: String?
    private var store: LedgerStore?
    private var identities: AppLedgerIdentitySet?
    private var boundAccountID: String?
    private var minimumReaderSchemaVersion: UInt16?
    private var revision: Int64 = 0

    init(
        storageMode: StorageMode,
        identities: AppLedgerIdentitySet? = nil,
        databaseName: String = "ledger.sqlite",
        identityMetadataURL: URL? = nil,
        readerSchemaVersion: UInt16 = EventEnvelope.currentSchemaVersion
    ) {
        self.readerSchemaVersion = min(readerSchemaVersion, EventEnvelope.maximumSupportedSchemaVersion)
        self.storageMode = storageMode
        suppliedIdentities = identities
        self.databaseName = databaseName
        explicitIdentityMetadataURL = identityMetadataURL
        switch storageMode {
        case .inMemory:
            identityMetadataFilename = nil
        case .persistent:
            identityMetadataFilename = databaseName == "ledger.sqlite"
                ? "identity-v1.json"
                : "\(databaseName).identity-v1.json"
        }
    }

    init(
        store: LedgerStore,
        identities: AppLedgerIdentitySet? = nil,
        identityMetadataURL: URL? = nil
    ) {
        readerSchemaVersion = store.readerSchemaVersion
        storageMode = .persistent
        suppliedIdentities = identities
        databaseName = "ledger.sqlite"
        explicitIdentityMetadataURL = identityMetadataURL
        identityMetadataFilename = nil
        self.store = store
    }

    /// Opt-in data seam for the budget-group UI successor. Never converts an existing ledger.
    func configureLocalBudgetGroups(potName: String, members: [LocalPotSetupMember],
                                   groups: [SettlementGroupSnapshot], at date: Date = Date()) throws -> LedgerStoreSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identity = try resolvedIdentities(in: store)
        guard store.readerSchemaVersion >= 2,
              let configuration = try store.potConfiguration(for: identity.potID),
              Set(configuration.orderedUnitIDs + groups.map(\.unitID)).count <= 64 else {
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        _ = try store.saveLocalPotSetup(potID: identity.potID, potName: potName,
            ownerMemberID: identity.ownerMemberID, members: members,
            originatingTimeZone: try IANATimeZone(TimeZone.current.identifier), at: date, budgetGroups: groups)
        return try store.snapshot(for: identity.potID)
    }

    /// Completes a new household only. Personal units are fixed before any prerequisite or money.
    func completeBudgetGroupSetup(potName: String, currency: Currency,
                                  people: [(UnitID, String)], pairs: [[UnitID]],
                                  at date: Date = Date()) throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identity = try resolvedIdentities(in: store)
        guard readerSchemaVersion >= 2, people.first?.0 == .am, (2...64).contains(people.count),
              Set(people.map(\.0)).count == people.count else {
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        let previous = try store.localPotSetup(for: identity.potID)
        let members = people.map { unit, name in
            LocalPotSetupMember(memberID: previous?.bindings.first { $0.profile.unitID == identity.coreUnit(for: unit) }?.profile.memberID
                ?? (UnitID.allCases.contains(unit) ? identity.memberID(for: unit) : .generate(at: date)),
                unitID: identity.coreUnit(for: unit), displayName: name, role: unit == .am ? .owner : .member)
        }
        let memberByUnit = Dictionary(uniqueKeysWithValues: zip(people.map(\.0), members.map(\.memberID)))
        let before = try store.snapshot(for: identity.potID)
        let groups = try makeBudgetGroups(pairs.map { pair in try pair.map { unit in
            guard let member = memberByUnit[unit] else { throw AppLedgerRepositoryError.identityMetadataInvalid }
            return member
        } }, retaining: before.reduction.projection.structure.groups, at: date)
        guard Set(members.map(\.unitID) + groups.map(\.unitID)).count <= 64 else {
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        // Include only real people. The alias mapping remains independent of this durable baseline.
        try store.confirmPotCurrency(currency, for: identity.potID, orderedUnitIDs: members.map(\.unitID))
        _ = try configureLocalBudgetGroups(potName: potName, members: members, groups: groups, at: date)
        advanceRevision()
        return try snapshot(from: store)
    }

    private func makeBudgetGroups(_ pairs: [[NumaSharedCore.MemberID]], retaining existing: [SettlementGroupSnapshot],
                                  at date: Date) throws -> [SettlementGroupSnapshot] {
        guard pairs.allSatisfy({ $0.count == 2 }), Set(pairs.flatMap { $0 }).count == pairs.count * 2 else {
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        return pairs.map { pair in
            existing.first { Set($0.orderedMemberIDs) == Set(pair) }
                ?? SettlementGroupSnapshot(groupID: .generate(at: date), unitID: .generate(at: date),
                    orderedMemberIDs: pair, defaultShareWeight: 1)
        }
    }

    func changeBudgetGroups(pairs: [[NumaSharedCore.MemberID]], at date: Date = Date()) throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        let identity = try resolvedIdentities(in: store)
        let before = try store.snapshot(for: identity.potID)
        guard before.reduction.projection.structure.minimumSchemaVersion == 2,
              !before.reduction.projection.structure.hasFinancialHistory,
              before.reduction.projection.structure.members[identity.ownerMemberID]?.role == .owner else {
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        let groups = try makeBudgetGroups(pairs, retaining: before.reduction.projection.structure.groups, at: date)
        guard Set(before.reduction.projection.structure.knownUnitIDs + groups.map(\.unitID)).count <= 64 else {
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        let event = EventEnvelope(potID: identity.potID, actorMemberID: identity.ownerMemberID,
            occurredAt: date, originatingTimeZone: try currentTimeZone(), schemaVersion: 2,
            payload: .groupChanged(GroupChangedPayload(groups: groups)))
        // Structural revision is the accepted log position, including the unacknowledged local prefix.
        let structuralRevision = before.reductionOrderedEvents.lastIndex { stored in
            switch stored.event.payload {
            case .memberAdded, .memberClaimed, .memberClaimReassigned, .memberArchived, .ownershipTransferred,
                 .groupChanged, .presetChanged, .potRenamed, .potArchived: true
            default: false
            }
        }.map { Int64($0 + 1) } ?? 0
        _ = try store.appendBudgetGroupChange(event, expectedTopologyRevision: structuralRevision, savedAt: date)
        advanceRevision()
        return try snapshot(from: store)
    }

    func budgetGroupSnapshot() throws -> LedgerStoreSnapshot {
        let store = try preparedStore()
        let identity = try resolvedIdentities(in: store)
        return try store.snapshot(for: identity.potID)
    }

    /// The caller chooses the actual payer independently of the recording member.
    func appendBudgetGroupExpense(content: ExpenseContent, at date: Date = Date()) throws -> StoredLedgerEvent {
        let store = try preparedStore()
        let identity = try resolvedIdentities(in: store)
        let before = try store.snapshot(for: identity.potID)
        guard store.readerSchemaVersion >= 2, before.reduction.projection.structure.minimumSchemaVersion == 2,
              let configuration = try store.potConfiguration(for: identity.potID) else {
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        let event = EventEnvelope(potID: identity.potID, actorMemberID: identity.ownerMemberID,
            occurredAt: date, originatingTimeZone: try IANATimeZone(TimeZone.current.identifier), schemaVersion: 2,
            payload: .expenseAdded(ExpenseAddedPayload(recordID: .generate(at: date), content: content)))
        let result = LedgerReducer(supportedSchemaVersion: 2).reduce(pot: configuration,
            events: before.reductionOrderedEvents.map(\.event) + [event])
        if case let .readOnly(issue) = result.access { throw AppLedgerRepositoryError.readOnlyReduction(issue) }
        return try store.appendHeldLocalEvent(event, savedAt: date)
    }

#if DEBUG
    /// The approved design's synthetic ledger, written through the same local
    /// setup and expense seams as onboarding. Never enters a persistent store.
    func loadSharedTableReferenceFixture(longNames: Bool = false) throws -> AppLedgerSnapshot {
        guard case .inMemory = storageMode else { throw AppLedgerRepositoryError.identityMetadataInvalid }
        let baseDate = Date(timeIntervalSince1970: 1_789_027_200) // 10 September 2026 08:00 UTC
        let jo = UnitID.remote(try NumaSharedCore.UnitID(validating:
            UUID(uuidString: "01993000-0000-7000-8000-000000000004")!))
        let setup = try completeBudgetGroupSetup(
            potName: longNames ? "Our very welcoming shared household by the sea" : "Our place", currency: .eur,
            people: [(.am, "You"), (.sam, longNames ? "Samantha Alexandra" : "Sam"),
                     (.leo, longNames ? "Alexandria Elizabeth" : "Alex"), (jo, longNames ? "Josephine Gabriella" : "Jo")],
            pairs: [[.am, .sam], [.leo, jo]], at: baseDate.addingTimeInterval(-3600))
        guard let alex = setup.memberProfiles.first(where: { $0.unitID == .leo }),
              let joProfile = setup.memberProfiles.first(where: { $0.unitID == jo }),
              let payerUnit = alex.budgetUnitID else { throw AppLedgerRepositoryError.identityMetadataInvalid }
        let units = setup.activeBudgetUnitIDs
        let weights = Dictionary(uniqueKeysWithValues: units.map { ($0, Int64(1)) })
        _ = try appendExpense(title: "Internet", amountMinorUnits: 7_200, payer: payerUnit,
            orderedUnits: units, weights: weights, category: "Internet",
            occurredAt: baseDate, savedAt: baseDate, payerMemberID: joProfile.memberID)
        return try appendExpense(title: "Dinner together", amountMinorUnits: 9_600, payer: payerUnit,
            orderedUnits: units, weights: weights, category: "Dining",
            occurredAt: baseDate.addingTimeInterval(86400), savedAt: baseDate.addingTimeInterval(86400),
            payerMemberID: alex.memberID).snapshot
    }
#endif

    func bootstrap(seedCasaMar: Bool) throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
#if DEBUG
        if seedCasaMar, try store.loadEvents(for: identities.potID).isEmpty {
            try ingestCasaMarSeed(into: store)
        }
#else
        _ = seedCasaMar
#endif
        return try snapshot(from: store)
    }

    func refreshSnapshot() throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        advanceRevision()
        return try snapshot(from: store)
    }

    func writeCSVExport(
        potName: String,
        temporaryDirectory: URL
    ) throws -> LedgerCSVFile {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        guard let configuration = try store.potConfiguration(for: identities.potID) else {
            throw LedgerStoreError.potNotRegistered(identities.potID)
        }
        let export = try LedgerCSVExporter.make(
            potName: potName,
            configuration: configuration,
            snapshot: try store.snapshot(for: identities.potID)
        )
        let manager = FileManager.default
        let exportDirectory = temporaryDirectory
            .appendingPathComponent("NumaSharedExports", isDirectory: true)
        if manager.fileExists(atPath: exportDirectory.path) {
            try manager.removeItem(at: exportDirectory)
        }
        try manager.createDirectory(
            at: exportDirectory,
            withIntermediateDirectories: true
        )
        let fileURL = exportDirectory.appendingPathComponent(export.filename)
        try export.data.write(
            to: fileURL,
            options: [.atomic, .completeFileProtection]
        )
        return LedgerCSVFile(url: fileURL, rowCount: export.rowCount)
    }

    func eraseLocalAccountState(
        temporaryDirectory: URL
    ) throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        let freshIdentities = AppLedgerIdentitySet.fresh()

        // Replace account-bound metadata first. If the later SQLite erase is
        // interrupted, the previous account cannot be reopened on relaunch.
        try persistIdentity(freshIdentities)
        identities = freshIdentities
        boundAccountID = nil
        minimumReaderSchemaVersion = nil
        try store.eraseAllLocalData()

        let exportDirectory = temporaryDirectory
            .appendingPathComponent("NumaSharedExports", isDirectory: true)
        if FileManager.default.fileExists(atPath: exportDirectory.path) {
            try FileManager.default.removeItem(at: exportDirectory)
        }

        try registerPotIfNeeded(in: store)
        advanceRevision()
        return try snapshot(from: store)
    }

    func replaceAuthoritativeMemberRoster(
        _ profiles: [PotMemberProfile],
        at date: Date = Date()
    ) throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        _ = try store.replaceCachedMemberRoster(
            profiles,
            for: identities.potID,
            at: date
        )
        advanceRevision()
        return try snapshot(from: store)
    }

    func completeLocalSetup(
        potName: String,
        currency: Currency = .eur,
        ownerDisplayName: String,
        samDisplayName: String?,
        leoDisplayName: String?,
        groupedMemberUnits: Set<UnitID> = [],
        at date: Date = Date()
    ) throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        try store.confirmPotCurrency(currency, for: identities.potID)
        _ = try saveLocalSetup(
            in: store,
            identities: identities,
            potName: potName,
            ownerDisplayName: ownerDisplayName,
            samDisplayName: samDisplayName,
            leoDisplayName: leoDisplayName,
            originatingTimeZone: try currentTimeZone(),
            at: date
        )
        guard let grouped = try appendSetupGroup(
            groupedMemberUnits,
            at: date
        ) else {
            advanceRevision()
            return try snapshot(from: store)
        }
        return grouped.snapshot
    }

    func appendSetupGroup(
        _ groupedMemberUnits: Set<UnitID>,
        at date: Date = Date()
    ) throws -> AppLedgerMutation? {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        let orderedGroupedMembers = UnitID.allCases.filter(groupedMemberUnits.contains)
            .map { identities.memberID(for: $0) }
        guard orderedGroupedMembers.count >= 2 else { return nil }
        return try appendHeld(
            payload: .groupChanged(GroupChangedPayload(groups: [
                SettlementGroupSnapshot(
                    groupID: .generate(at: date),
                    unitID: .generate(at: date),
                    orderedMemberIDs: orderedGroupedMembers,
                    defaultShareWeight: Int64(orderedGroupedMembers.count)
                ),
            ])),
            occurredAt: date,
            savedAt: date
        )
    }

    func syncContext() throws -> AppLedgerSyncContext {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        guard let configuration = try store.potConfiguration(for: identities.potID) else {
            throw LedgerStoreError.potNotRegistered(identities.potID)
        }
        return try makeSyncContext(
            store: store,
            configuration: configuration,
            identities: identities,
            accountID: boundAccountID,
            minimumReaderSchemaVersion: minimumReaderSchemaVersion
        )
    }

    func validateAccountBinding(_ accountID: String) throws {
        let normalized = try normalizedAccountID(accountID)
        let store = try preparedStore()
        _ = try resolvedIdentities(in: store)
        if let boundAccountID, boundAccountID != normalized {
            throw AppLedgerRepositoryError.accountIdentityMismatch
        }
    }

    func bindActiveIdentity(
        to accountID: String,
        minimumReaderSchemaVersion: UInt16
    ) throws -> AppLedgerSyncContext {
        let normalized = try normalizedAccountID(accountID)
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        if let boundAccountID, boundAccountID != normalized {
            throw AppLedgerRepositoryError.accountIdentityMismatch
        }
        try persistIdentity(
            identities,
            accountID: normalized,
            minimumReaderSchemaVersion: minimumReaderSchemaVersion
        )
        boundAccountID = normalized
        self.minimumReaderSchemaVersion = minimumReaderSchemaVersion
        advanceRevision()
        guard let configuration = try store.potConfiguration(for: identities.potID) else {
            throw LedgerStoreError.potNotRegistered(identities.potID)
        }
        return try makeSyncContext(
            store: store,
            configuration: configuration,
            identities: identities,
            accountID: normalized,
            minimumReaderSchemaVersion: minimumReaderSchemaVersion
        )
    }

    /// Switches the app projection to a server-discovered pot and persists the
    /// current account's member identity before any remote event is rendered.
    func activateRemotePot(
        _ descriptor: RemotePotDescriptor,
        accountID: String
    ) throws -> AppLedgerSyncContext {
        let normalized = try normalizedAccountID(accountID)
        let store = try preparedStore()
        let previous = try resolvedIdentities(in: store)
        if let boundAccountID, boundAccountID != normalized {
            throw AppLedgerRepositoryError.accountIdentityMismatch
        }
        let configuration: PotConfiguration
        if let existing = try store.potConfiguration(for: descriptor.configuration.id) {
            guard existing.currency == descriptor.configuration.currency,
                  descriptor.currentKnownUnitIDs.starts(with: existing.orderedUnitIDs),
                  !descriptor.hasInitialUnitBaseline || descriptor.minimumReaderSchemaVersion < 2
                    || existing.orderedUnitIDs == descriptor.configuration.orderedUnitIDs else {
                throw LedgerStoreError.potConfigurationConflict(descriptor.configuration.id)
            }
            configuration = existing
        } else {
            guard descriptor.hasInitialUnitBaseline else {
                throw SyncTransportError.terminal(code: "BOOTSTRAP_BASELINE_UNAVAILABLE")
            }
            try store.registerPot(descriptor.configuration)
            configuration = descriptor.configuration
        }
        let adopted = try AppLedgerIdentitySet.adoptingRemotePot(
            configuration: descriptor.configuration,
            memberID: descriptor.memberID,
            preserving: previous
        )
        try persistIdentity(
            adopted,
            accountID: normalized,
            minimumReaderSchemaVersion: descriptor.minimumReaderSchemaVersion
        )
        identities = adopted
        boundAccountID = normalized
        minimumReaderSchemaVersion = descriptor.minimumReaderSchemaVersion
        advanceRevision()
        return try makeSyncContext(
            store: store,
            configuration: configuration,
            identities: adopted,
            accountID: normalized,
            minimumReaderSchemaVersion: descriptor.minimumReaderSchemaVersion
        )
    }

#if DEBUG
    func loadCasaMarSeed() throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        if try store.loadEvents(for: identities.potID).isEmpty {
            try ingestCasaMarSeed(into: store)
            advanceRevision()
        }
        return try snapshot(from: store)
    }

    func loadContestedCasaMarSeed() throws -> AppLedgerSnapshot {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        if try store.loadEvents(for: identities.potID).isEmpty {
            try ingestCasaMarSeed(into: store)
        }
        let existingIDs = Set(
            try store.loadStoredEvents(for: identities.potID).map(\.event.id)
        )
        let zone = try IANATimeZone("Europe/Madrid")
        let am = identities.coreUnit(for: .am)
        let sam = identities.coreUnit(for: .sam)
        let leo = identities.coreUnit(for: .leo)
        let rootEventID = try AppLedgerIDs.seedEventID(1)
        let recordID = try AppLedgerIDs.seedRecordID(1)

        func revision(
            id: UInt8,
            sequence: Int64,
            actor: UnitID,
            title: String,
            amount: Int64,
            day: Int
        ) throws -> EventEnvelope {
            EventEnvelope(
                id: try AppLedgerIDs.seedEventID(id),
                potID: identities.potID,
                actorMemberID: identities.memberID(for: actor),
                occurredAt: try seedDate(day: day),
                originatingTimeZone: zone,
                serverSequence: sequence,
                payload: .expenseRevised(ExpenseRevisedPayload(
                    recordID: recordID,
                    basis: .parent(rootEventID),
                    content: .expense(ExpenseContent(
                        kind: .shared,
                        title: title,
                        amount: Money(minorUnits: amount, currency: .eur),
                        payerUnitID: sam,
                        allocations: [
                            ExpenseAllocation(
                                unitID: am,
                                amount: Money(
                                    minorUnits: amount / 2,
                                    currency: .eur
                                )
                            ),
                            ExpenseAllocation(
                                unitID: sam,
                                amount: Money(
                                    minorUnits: amount / 4,
                                    currency: .eur
                                )
                            ),
                            ExpenseAllocation(
                                unitID: leo,
                                amount: Money(
                                    minorUnits: amount - amount / 2 - amount / 4,
                                    currency: .eur
                                )
                            ),
                        ],
                        category: "Groceries"
                    ))
                ))
            )
        }

        let revisions = try [
            revision(
                id: 6,
                sequence: 7,
                actor: .sam,
                title: "Groceries — Sam edit",
                amount: 13_000,
                day: 9
            ),
            revision(
                id: 7,
                sequence: 8,
                actor: .leo,
                title: "Groceries — Leo edit",
                amount: 11_000,
                day: 10
            ),
        ]
        for event in revisions where !existingIDs.contains(event.id) {
            _ = try store.ingestRemoteEvent(event, receivedAt: event.occurredAt)
        }
        advanceRevision()
        return try snapshot(from: store)
    }
#endif

    func appendExpense(
        title: String,
        amountMinorUnits: Int64,
        payer: UnitID = .am,
        orderedUnits: [UnitID],
        weights: [UnitID: Int64],
        explicitAllocations: [UnitID: Int64]? = nil,
        category: String?,
        occurredAt: Date = Date(),
        savedAt: Date = Date(),
        payerMemberID: NumaSharedCore.MemberID? = nil,
        recordID: NumaSharedCore.RecordID? = nil
    ) throws -> AppLedgerMutation {
        let identities = try currentIdentities()
        let orderedCoreUnits = orderedUnits.map(identities.coreUnit(for:))
        let total = Money(minorUnits: amountMinorUnits, currency: try currentCurrency())
        let allocations: [ExpenseAllocation]
        if let explicitAllocations {
            guard Set(explicitAllocations.keys) == Set(orderedUnits) else {
                throw AppLedgerRepositoryError.invalidExpenseAllocations
            }
            var sum: Int64 = 0
            for unitID in orderedUnits {
                guard let amount = explicitAllocations[unitID], amount >= 0 else {
                    throw AppLedgerRepositoryError.invalidExpenseAllocations
                }
                let next = sum.addingReportingOverflow(amount)
                guard !next.overflow else {
                    throw AppLedgerRepositoryError.invalidExpenseAllocations
                }
                sum = next.partialValue
            }
            guard sum == amountMinorUnits else {
                throw AppLedgerRepositoryError.invalidExpenseAllocations
            }
            allocations = orderedUnits.map { unitID in
                ExpenseAllocation(
                    unitID: identities.coreUnit(for: unitID),
                    amount: Money(
                        minorUnits: explicitAllocations[unitID] ?? 0,
                        currency: total.currency
                    )
                )
            }
        } else {
            let coreWeights = Dictionary(uniqueKeysWithValues: weights.map {
                (identities.coreUnit(for: $0.key), $0.value)
            })
            let allocated = try WeightedAllocator.allocate(
                total: total,
                weights: coreWeights,
                orderedUnitIDs: orderedCoreUnits
            )
            allocations = orderedCoreUnits.compactMap { unitID in
                allocated[unitID].map { ExpenseAllocation(unitID: unitID, amount: $0) }
            }
        }
        let kind: NumaSharedCore.ExpenseKind =
            orderedUnits.count == 1 && orderedUnits.first != payer ? .personal : .shared
        let recordID = recordID ?? NumaSharedCore.RecordID.generate(at: occurredAt)
        let payload = EventPayload.expenseAdded(ExpenseAddedPayload(
            recordID: recordID,
            content: ExpenseContent(
                kind: kind,
                title: title,
                amount: total,
                payerUnitID: identities.coreUnit(for: payer),
                allocations: allocations,
                category: category,
                payerMemberID: payerMemberID
            )
        ))
        return try appendHeld(
            payload: payload,
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func repeatExpense(
        recordID description: String,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        let recordID = try recordID(from: description)
        let reduction = try store.reduction(for: identities.potID)
        guard case let .revisable(record)? = reduction.projection.records[recordID],
              case let .expense(current) = record.currentContent,
              !record.isVoided,
              record.contested == nil
        else {
            throw AppLedgerRepositoryError.recordNotEditable(description)
        }
        return try appendHeld(
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: .generate(at: occurredAt),
                content: current
            )),
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func appendExpenseRevision(
        recordID description: String,
        title: String,
        amountMinorUnits: Int64,
        category: String?,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        let recordID = try recordID(from: description)
        let reduction = try store.reduction(for: identities.potID)
        guard case let .revisable(record)? = reduction.projection.records[recordID],
              case let .expense(current) = record.currentContent,
              !record.isVoided
        else {
            throw AppLedgerRepositoryError.recordNotEditable(description)
        }
        guard record.contested == nil else {
            throw AppLedgerRepositoryError.recordContested(description)
        }
        let total = Money(
            minorUnits: amountMinorUnits,
            currency: try currentCurrency()
        )
        let allocations: [ExpenseAllocation]
        if amountMinorUnits == current.amount.minorUnits {
            allocations = current.allocations
        } else {
            let orderedUnitIDs = current.allocations.map(\.unitID)
            let weights = Dictionary(uniqueKeysWithValues: current.allocations.map {
                ($0.unitID, max(1, $0.amount.minorUnits))
            })
            let allocated = try WeightedAllocator.allocate(
                total: total,
                weights: weights,
                orderedUnitIDs: orderedUnitIDs
            )
            allocations = orderedUnitIDs.compactMap { unitID in
                allocated[unitID].map {
                    ExpenseAllocation(unitID: unitID, amount: $0)
                }
            }
        }
        return try appendHeld(
            payload: .expenseRevised(ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(record.appliedRevisionID),
                content: .expense(ExpenseContent(
                    kind: current.kind,
                    title: title,
                    amount: total,
                    payerUnitID: current.payerUnitID,
                    allocations: allocations,
                    category: category,
                    payerMemberID: current.payerMemberID
                ))
            )),
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func appendSettlement(
        title: String,
        amountMinorUnits: Int64,
        from: UnitID,
        to: UnitID,
        reversalOfRecordID: String? = nil,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let identities = try currentIdentities()
        let currency = try currentCurrency()
        let reversalTarget = try reversalOfRecordID.map { try self.recordID(from: $0) }
        let newRecordID = NumaSharedCore.RecordID.generate(at: occurredAt)
        let payload = EventPayload.settlementRecorded(SettlementRecordedPayload(
            recordID: newRecordID,
            content: SettlementContent(
                title: title,
                amount: Money(minorUnits: amountMinorUnits, currency: currency),
                fromUnitID: identities.coreUnit(for: from),
                toUnitID: identities.coreUnit(for: to),
                reversalOfRecordID: reversalTarget
            )
        ))
        return try appendHeld(
            payload: payload,
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func appendOpeningBalance(
        title: String,
        entries: [UnitID: Int64],
        note: String? = nil,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let identities = try currentIdentities()
        let currency = try currentCurrency()
        let content = OpeningBalanceContent(
            title: title,
            entries: entries.keys.sorted(by: { $0.rawValue < $1.rawValue }).compactMap { unitID in
                entries[unitID].map {
                    OpeningBalanceEntry(
                        unitID: identities.coreUnit(for: unitID),
                        amount: Money(minorUnits: $0, currency: currency)
                    )
                }
            },
            note: note
        )
        return try appendHeld(
            payload: .openingBalanceSet(OpeningBalanceSetPayload(
                recordID: .generate(at: occurredAt),
                content: content
            )),
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func appendVoid(
        recordID description: String,
        reason: String,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let payload = EventPayload.recordVoided(RecordVoidedPayload(
            recordID: try recordID(from: description),
            reason: reason
        ))
        return try appendHeld(
            payload: payload,
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func appendRestore(
        recordID description: String,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let payload = EventPayload.recordRestored(RecordRestoredPayload(
            recordID: try recordID(from: description)
        ))
        return try appendHeld(
            payload: payload,
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func appendFlag(
        recordID description: String,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let payload = EventPayload.settlementFlagged(SettlementFlaggedPayload(
            recordID: try recordID(from: description)
        ))
        return try appendHeld(
            payload: payload,
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func resolveExpenseContest(
        recordID description: String,
        choosing chosenRevisionDescription: String,
        comparedWith otherRevisionDescription: String,
        occurredAt: Date = Date(),
        savedAt: Date = Date()
    ) throws -> AppLedgerMutation {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        let recordID = try recordID(from: description)
        let chosenRevisionID = try eventID(from: chosenRevisionDescription)
        let otherRevisionID = try eventID(from: otherRevisionDescription)
        let reduction = try store.reduction(for: identities.potID)
        guard case let .revisable(record)? = reduction.projection.records[recordID],
              let contest = record.contested
        else {
            throw AppLedgerRepositoryError.recordNotContested(description)
        }
        let activeHeads = Set(contest.headRevisionIDs)
        guard chosenRevisionID != otherRevisionID,
              activeHeads.contains(chosenRevisionID),
              activeHeads.contains(otherRevisionID)
        else {
            throw AppLedgerRepositoryError.invalidContestSelection
        }
        guard let chosenRevision = record.revisions.first(where: {
            $0.eventID == chosenRevisionID
        }) else {
            throw AppLedgerRepositoryError.unknownRevision(
                chosenRevisionDescription
            )
        }
        guard case .expense = chosenRevision.content else {
            throw AppLedgerRepositoryError.unsupportedRevisionContent
        }
        return try appendHeld(
            payload: .expenseRevised(ExpenseRevisedPayload(
                recordID: recordID,
                basis: .resolution(try RevisionPair(
                    chosenRevisionID,
                    otherRevisionID
                )),
                content: chosenRevision.content
            )),
            occurredAt: occurredAt,
            savedAt: savedAt
        )
    }

    func undoHeldEvent(
        eventID: NumaSharedCore.EventID,
        now: Date = Date()
    ) throws -> AppLedgerSnapshot? {
        let store = try preparedStore()
        let deleted = try store.undoHeldLocalEvent(
            eventID: eventID,
            now: now,
            undoSessionIsActive: true
        )
        guard deleted else { return nil }
        advanceRevision()
        return try snapshot(from: store)
    }

    func expireHeldEvent(
        eventID: NumaSharedCore.EventID,
        now: Date = Date()
    ) throws -> HeldEventExpiry {
        let store = try preparedStore()
        let potID = try resolvedIdentities(in: store).potID
        let beforeEvents = try store.loadStoredEvents(for: potID)
        guard let before = beforeEvents.first(where: { $0.event.id == eventID }),
              before.delivery.state == .held
        else { return .noLongerHeld }
        if let deadline = before.delivery.undoDeadline, now < deadline {
            return .stillHeld(until: deadline)
        }

        let heldEventIDs = Set(beforeEvents.compactMap {
            $0.delivery.state == .held ? $0.event.id : nil
        })
        _ = try store.expireHeldEvents(now: now)
        let afterEvents = try store.loadStoredEvents(for: potID)
        guard let after = afterEvents.first(where: { $0.event.id == eventID })
        else { return .noLongerHeld }
        if after.delivery.state == .ready {
            let transitioned = afterEvents.compactMap { stored in
                heldEventIDs.contains(stored.event.id) && stored.delivery.state == .ready
                    ? stored.event.id
                    : nil
            }.sorted()
            return .transitioned(eventIDs: transitioned)
        }
        if after.delivery.state == .held, let deadline = after.delivery.undoDeadline {
            return .stillHeld(until: deadline)
        }
        return .noLongerHeld
    }

#if DEBUG
    func resetEphemeral(seedCasaMar: Bool = false) throws -> AppLedgerSnapshot? {
        guard case .inMemory = storageMode else { return nil }
        store = nil
        advanceRevision()
        return try bootstrap(seedCasaMar: seedCasaMar)
    }
#endif

    // MARK: - Store lifecycle

    private func currentIdentities() throws -> AppLedgerIdentitySet {
        let store = try preparedStore()
        return try resolvedIdentities(in: store)
    }

    private func resolvedIdentities(in store: LedgerStore) throws -> AppLedgerIdentitySet {
        if let identities { return identities }
        let metadataURL = try identityMetadataURL()
        if let metadataURL,
           FileManager.default.fileExists(atPath: metadataURL.path) {
            let data = try Data(contentsOf: metadataURL)
            if let metadata = try? JSONDecoder().decode(
                AppLedgerIdentityMetadata.self,
                from: data
            ) {
                let accountID = try metadata.accountID.map(normalizedAccountID)
                identities = metadata.identities
                boundAccountID = accountID
                minimumReaderSchemaVersion = metadata.minimumReaderSchemaVersion
                return metadata.identities
            }
            if let legacy = try? JSONDecoder().decode(
                AppLedgerIdentitySet.self,
                from: data
            ) {
                identities = legacy
                return legacy
            }
            throw AppLedgerRepositoryError.identityMetadataInvalid
        }
        if let suppliedIdentities {
            try persistIdentity(suppliedIdentities)
            identities = suppliedIdentities
            return suppliedIdentities
        }
        if metadataURL == nil {
            let legacy = try AppLedgerIdentitySet.legacy
            identities = legacy
            return legacy
        }
        if case .inMemory = storageMode {
            let legacy = try AppLedgerIdentitySet.legacy
            identities = legacy
            return legacy
        }

        let legacy = try AppLedgerIdentitySet.legacy
        let selected = try store.potConfiguration(for: legacy.potID) == nil
            ? AppLedgerIdentitySet.fresh()
            : legacy
        try persistIdentity(selected)
        identities = selected
        return selected
    }

    private func identityMetadataURL() throws -> URL? {
        if let explicitIdentityMetadataURL { return explicitIdentityMetadataURL }
        guard let identityMetadataFilename else { return nil }
        return try applicationSupportDirectory()
            .appendingPathComponent(identityMetadataFilename)
    }

    private func persistIdentity(
        _ value: AppLedgerIdentitySet,
        accountID: String? = nil,
        minimumReaderSchemaVersion: UInt16? = nil
    ) throws {
        guard let metadataURL = try identityMetadataURL() else { return }
        try FileManager.default.createDirectory(
            at: metadataURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(AppLedgerIdentityMetadata(
            identities: value,
            accountID: accountID,
            minimumReaderSchemaVersion: minimumReaderSchemaVersion
        ))
        try data.write(
            to: metadataURL,
            options: [.atomic, .completeFileProtection]
        )
    }

    private func normalizedAccountID(_ value: String) throws -> String {
        guard let uuid = UUID(uuidString: value) else {
            throw AppLedgerRepositoryError.invalidAccountIdentifier
        }
        return uuid.uuidString.lowercased()
    }

    private func applicationSupportDirectory() throws -> URL {
        let fileManager = FileManager.default
        guard let baseURL = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw AppLedgerRepositoryError.applicationSupportDirectoryUnavailable
        }
        let directory = baseURL.appendingPathComponent("NumaShared", isDirectory: true)
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private func preparedStore() throws -> LedgerStore {
        if let store { return store }

        let opened: LedgerStore
        switch storageMode {
        case .inMemory:
            opened = try LedgerStore.inMemory(readerSchemaVersion: readerSchemaVersion)
        case .persistent:
            let databaseURL = try applicationSupportDirectory()
                .appendingPathComponent(databaseName)
            opened = try LedgerStore(
                path: databaseURL.path,
                fileProtection: .completeUntilFirstUserAuthentication,
                readerSchemaVersion: readerSchemaVersion
            )
        }
        store = opened
        return opened
    }

    private func registerPotIfNeeded(in store: LedgerStore) throws {
        let identities = try resolvedIdentities(in: store)
        let potID = identities.potID
        if try store.potConfiguration(for: potID) != nil { return }
        let configuration = try PotConfiguration(
            id: potID,
            currency: .eur,
            orderedUnitIDs: identities.orderedUnitIDs
        )
        try store.registerPot(configuration)
    }

    private func currentCurrency() throws -> Currency {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let potID = try resolvedIdentities(in: store).potID
        guard let configuration = try store.potConfiguration(for: potID) else {
            throw LedgerStoreError.potNotRegistered(potID)
        }
        return configuration.currency
    }

    private func makeSyncContext(
        store: LedgerStore,
        configuration: PotConfiguration,
        identities: AppLedgerIdentitySet,
        accountID: String?,
        minimumReaderSchemaVersion: UInt16?
    ) throws -> AppLedgerSyncContext {
        AppLedgerSyncContext(
            store: store,
            configuration: configuration,
            ownerMemberID: identities.ownerMemberID,
            ownerDisplayName: try store.localPotSetup(
                for: configuration.id
            )?.ownerDisplayName,
            accountID: accountID,
            minimumReaderSchemaVersion: minimumReaderSchemaVersion
        )
    }

    @discardableResult
    private func saveLocalSetup(
        in store: LedgerStore,
        identities: AppLedgerIdentitySet,
        potName: String,
        ownerDisplayName: String,
        samDisplayName: String?,
        leoDisplayName: String?,
        originatingTimeZone: IANATimeZone,
        at date: Date
    ) throws -> LocalPotSetup {
        var members = [
            LocalPotSetupMember(
                memberID: identities.ownerMemberID,
                unitID: identities.householdUnitID,
                displayName: ownerDisplayName,
                role: .owner
            ),
        ]
        if let samDisplayName {
            members.append(LocalPotSetupMember(
                memberID: identities.samMemberID,
                unitID: identities.samUnitID,
                displayName: samDisplayName,
                role: .member
            ))
        }
        if let leoDisplayName {
            members.append(LocalPotSetupMember(
                memberID: identities.leoMemberID,
                unitID: identities.leoUnitID,
                displayName: leoDisplayName,
                role: .member
            ))
        }
        return try store.saveLocalPotSetup(
            potID: identities.potID,
            potName: potName,
            ownerMemberID: identities.ownerMemberID,
            members: members,
            originatingTimeZone: originatingTimeZone,
            at: date
        )
    }

    // MARK: - Immutable writes

    private func appendHeld(
        payload: EventPayload,
        occurredAt: Date,
        savedAt: Date,
        eventID: NumaSharedCore.EventID? = nil
    ) throws -> AppLedgerMutation {
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        let existing = try store.reduction(for: identities.potID)
        if case let .readOnly(issue) = existing.access {
            throw AppLedgerRepositoryError.readOnlyReduction(issue)
        }
        guard !existing.projection.isArchived else {
            throw AppLedgerRepositoryError.archivedPot
        }
        let event = EventEnvelope(
            id: eventID ?? .generate(at: occurredAt),
            potID: identities.potID,
            actorMemberID: identities.ownerMemberID,
            occurredAt: occurredAt,
            originatingTimeZone: try currentTimeZone(),
            schemaVersion: existing.projection.structure.minimumSchemaVersion,
            payload: payload
        )
        // Schema 1 may use the existing local-setup projection overlay; do not reinterpret
        // those histories against the raw pre-log configuration. Its rollback path stays below.
        if existing.projection.structure.minimumSchemaVersion >= 2 {
            guard let configuration = try store.potConfiguration(for: identities.potID) else {
                throw AppLedgerRepositoryError.identityMetadataInvalid
            }
            let ordered = try store.reductionOrderedEvents(for: identities.potID)
            let candidate = LedgerReducer(supportedSchemaVersion: readerSchemaVersion).reduce(
                pot: configuration, events: ordered.map(\.event) + [event])
            if case let .readOnly(issue) = candidate.access { throw AppLedgerRepositoryError.invalidLocalMutation(issue) }
        }
        let stored = try store.appendHeldLocalEvent(event, savedAt: savedAt)

        do {
            advanceRevision()
            let updated = try snapshot(from: store)
            if case let .readOnly(issue) = updated.reductionAccess {
                _ = try store.undoHeldLocalEvent(
                    eventID: event.id,
                    now: savedAt,
                    undoSessionIsActive: true
                )
                throw AppLedgerRepositoryError.invalidLocalMutation(issue)
            }
            return AppLedgerMutation(
                snapshot: updated,
                eventID: event.id,
                undoDeadline: stored.delivery.undoDeadline
                    ?? savedAt.addingTimeInterval(UndoPolicy.window)
            )
        } catch {
            _ = try? store.undoHeldLocalEvent(
                eventID: event.id,
                now: savedAt,
                undoSessionIsActive: true
            )
            throw error
        }
    }

    private func currentTimeZone() throws -> IANATimeZone {
        if let current = try? IANATimeZone(TimeZone.current.identifier) {
            return current
        }
        return try IANATimeZone("UTC")
    }

    private func recordID(from description: String) throws -> NumaSharedCore.RecordID {
        guard let uuid = UUID(uuidString: description) else {
            throw AppLedgerRepositoryError.unknownRecord(description)
        }
        do {
            return try NumaSharedCore.RecordID(validating: uuid)
        } catch {
            throw AppLedgerRepositoryError.unknownRecord(description)
        }
    }

    private func eventID(from description: String) throws -> NumaSharedCore.EventID {
        guard let uuid = UUID(uuidString: description),
              let eventID = try? NumaSharedCore.EventID(validating: uuid)
        else {
            throw AppLedgerRepositoryError.unknownRevision(description)
        }
        return eventID
    }

    private func advanceRevision() {
        revision &+= 1
    }

    // MARK: - Projection adapter

    private func snapshot(from store: LedgerStore) throws -> AppLedgerSnapshot {
        let identities = try resolvedIdentities(in: store)
        let potID = identities.potID
        let storedSnapshot = try store.snapshot(for: potID)
        let reduction = storedSnapshot.reduction
        let storedEvents = storedSnapshot.reductionOrderedEvents
        let lastAuthoritativeSequence = storedSnapshot.syncState?
            .lastServerSequence ?? 0
        let failedEvents = storedSnapshot.storedEvents.filter {
            $0.origin == .local
                && $0.delivery.state == .terminal
        }
        let localSetup = try store.localPotSetup(for: potID)
        let authoritativeRoster = try store.cachedMemberRoster(for: potID)
        let roster = authoritativeRoster.isEmpty
            ? localSetup?.bindings.map(\.profile) ?? []
            : authoritativeRoster
        let memberProfiles = try appMemberProfiles(
            roster,
            structure: reduction.projection.structure,
            identities: identities
        )
        let potSetup = try potSetupSnapshot(
            localSetup,
            authoritativeProfiles: authoritativeRoster.isEmpty ? [] : memberProfiles,
            latestPotName: reduction.projection.latestPotName,
            identities: identities
        )
        let memberDisplayNames: [NumaSharedCore.MemberID: String]
        if authoritativeRoster.isEmpty {
            memberDisplayNames = Dictionary(
                uniqueKeysWithValues: localSetup?.bindings.compactMap { binding in
                    binding.profile.displayName.map {
                        (binding.profile.memberID, $0)
                    }
                } ?? []
            )
        } else {
            memberDisplayNames = Dictionary(
                uniqueKeysWithValues: authoritativeRoster.map { profile in
                    (
                        profile.memberID,
                        profile.displayName
                            ?? (profile.state == .archived
                                ? String(localized: "Former member")
                                : String(localized: "Unknown member"))
                    )
                }
            )
        }

        var balances = Dictionary(uniqueKeysWithValues: identities.orderedUnitIDs.compactMap {
            identities.appUnit(for: $0).map { ($0, Int64.zero) }
        })
        for (coreUnit, amount) in reduction.projection.balances {
            guard let appUnit = identities.appUnit(for: coreUnit) else {
                throw AppLedgerRepositoryError.unknownUnit(coreUnit)
            }
            balances[appUnit] = amount.minorUnits
        }

        let plan: [SettlementStep]
        switch reduction.projection.settlementPlan {
        case let .exact(transfers):
            plan = try transfers.map { transfer in
                guard let from = identities.appUnit(for: transfer.fromUnitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(transfer.fromUnitID)
                }
                guard let to = identities.appUnit(for: transfer.toUnitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(transfer.toUnitID)
                }
                return SettlementStep(
                    from: from,
                    to: to,
                    amountCents: transfer.amount.minorUnits
                )
            }
        case .unavailable:
            plan = []
        }

        return AppLedgerSnapshot(
            revision: revision,
            currency: reduction.projection.spend.currency,
            balances: balances,
            spend: reduction.projection.spend.minorUnits,
            plan: plan,
            records: try makeRecords(
                projection: reduction.projection,
                storedEvents: storedEvents,
                failedEvents: failedEvents,
                lastAuthoritativeSequence: lastAuthoritativeSequence,
                identities: identities,
                memberDisplayNames: memberDisplayNames
            ),
            pendingDeliveryEventCount: storedSnapshot.pendingDeliveryEventCount,
            unsyncedEventCount: storedSnapshot.unsyncedEventCount,
            isArchived: reduction.projection.isArchived,
            isCurrentMemberArchived: reduction.projection.structure
                .archivedMemberIDs.contains(identities.ownerMemberID),
            reductionAccess: reduction.access,
            minimumReaderSchemaVersion: minimumReaderSchemaVersion,
            readerSchemaVersion: readerSchemaVersion,
            potSetup: potSetup,
            memberProfiles: memberProfiles,
            currentMemberID: identities.ownerMemberID,
            structure: reduction.projection.structure,
            activeBudgetUnitIDs: reduction.projection.structure.activeUnitIDs.compactMap(identities.appUnit(for:))
        )
    }

    private func potSetupSnapshot(
        _ setup: LocalPotSetup?,
        authoritativeProfiles: [AppMemberProfile],
        latestPotName: String?,
        identities: AppLedgerIdentitySet
    ) throws -> AppPotSetupSnapshot {
        let expectedUnitIDs = Set(
            (try preparedStore().potConfiguration(for: identities.potID)?.orderedUnitIDs ?? identities.orderedUnitIDs).compactMap(identities.appUnit(for:))
        )
        let boundProfiles = authoritativeProfiles.compactMap { profile in
            profile.unitID.map { ($0, profile.displayName, profile.state) }
        }
        if !boundProfiles.isEmpty,
           authoritativeProfiles.contains(where: { $0.role == .owner }) {
            let groupedProfiles = Dictionary(grouping: boundProfiles, by: \.0)
            let displayNames = groupedProfiles.mapValues { profiles in
                profiles.map { _, displayName, state in
                    displayName
                        ?? (state == .archived
                            ? String(localized: "Former member")
                            : String(localized: "Unknown member"))
                }.joined(separator: " + ")
            }
            return AppPotSetupSnapshot(
                potName: latestPotName
                    ?? setup?.potName
                    ?? String(localized: "Shared pot"),
                displayNames: displayNames,
                isComplete: true
            )
        }
        guard let setup else { return .incomplete }
        var displayNames = [UnitID: String]()
        for binding in setup.bindings {
            guard let coreUnitID = binding.profile.unitID,
                  let displayName = binding.profile.displayName,
                  let unitID = identities.appUnit(for: coreUnitID),
                  displayNames[unitID] == nil
            else {
                throw LocalPotSetupError.corruptStoredSetup(setup.potID)
            }
            displayNames[unitID] = displayName
        }
        guard setup.isComplete,
              displayNames.keys.contains(.am),
              Set(displayNames.keys).isSubset(of: expectedUnitIDs),
              !displayNames.isEmpty
        else {
            throw LocalPotSetupError.corruptStoredSetup(setup.potID)
        }
        return AppPotSetupSnapshot(
            potName: setup.potName,
            displayNames: displayNames,
            isComplete: true
        )
    }

    private func appMemberProfiles(
        _ profiles: [PotMemberProfile],
        structure: StructuralProjection,
        identities: AppLedgerIdentitySet
    ) throws -> [AppMemberProfile] {
        try profiles.map { profile in
            let appUnitID: UnitID?
            let projectedUnitID = structure.members[profile.memberID]?.personalUnitID
                ?? profile.unitID
            if let coreUnitID = projectedUnitID {
                guard let unitID = identities.appUnit(for: coreUnitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(coreUnitID)
                }
                appUnitID = unitID
            } else {
                appUnitID = nil
            }
            return AppMemberProfile(
                memberID: profile.memberID,
                unitID: appUnitID,
                displayName: profile.displayName,
                role: profile.role,
                state: profile.state,
                budgetUnitID: (structure.members[profile.memberID]?.unitID ?? profile.budgetUnitID ?? profile.unitID).flatMap(identities.appUnit(for:))
            )
        }
    }

    private func makeRecords(
        projection: LedgerProjection,
        storedEvents: [StoredLedgerEvent],
        failedEvents: [StoredLedgerEvent],
        lastAuthoritativeSequence: Int64,
        identities: AppLedgerIdentitySet,
        memberDisplayNames: [NumaSharedCore.MemberID: String]
    ) throws -> [ExpenseRecord] {
        let eventByID = Dictionary(
            storedEvents.map { ($0.event.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let authoritativeEvents = storedEvents.filter {
            $0.delivery.serverSequence.map {
                $0 <= lastAuthoritativeSequence
            } ?? false
        }
        let authoritativeEventIDs = Set(authoritativeEvents.map(\.event.id))
        var reductionTail = storedEvents.filter {
            !authoritativeEventIDs.contains($0.event.id)
        }
        let compatibilityBarrier: StoredLedgerEvent?
        if let first = reductionTail.first,
           isCompatibilityBarrier(first) {
            compatibilityBarrier = first
            reductionTail.removeFirst()
        } else {
            compatibilityBarrier = nil
        }
        let optimisticTail = reductionTail + failedEvents
        let displayOrderedEvents = authoritativeEvents
            + [compatibilityBarrier].compactMap { $0 }
            + optimisticTail.sorted {
                if $0.localOrdinal == $1.localOrdinal {
                    return $0.event.id.description < $1.event.id.description
                }
                return $0.localOrdinal < $1.localOrdinal
            }
        let eventOrder = Dictionary(
            uniqueKeysWithValues: displayOrderedEvents.enumerated().map {
                ($0.element.event.id, Int64($0.offset))
            }
        )
        var rootEventByRecord = [NumaSharedCore.RecordID: StoredLedgerEvent]()
        for stored in storedEvents {
            guard let recordID = rootRecordID(in: stored.event.payload) else { continue }
            if rootEventByRecord[recordID] == nil {
                rootEventByRecord[recordID] = stored
            }
        }

        var records = [ExpenseRecord]()
        records.reserveCapacity(projection.records.count + failedEvents.count)
        for projected in projection.records.values {
            switch projected {
            case let .revisable(record):
                guard let source = rootEventByRecord[record.recordID] else {
                    throw AppLedgerRepositoryError.missingStoredRecord(
                        record.recordID.description
                    )
                }
                guard let sortOrdinal = eventOrder[source.event.id] else {
                    throw AppLedgerRepositoryError.missingStoredRecord(
                        record.recordID.description
                    )
                }
                let kind: RecordKind
                let title: String
                let amountMinorUnits: Int64
                let payer: UnitID
                var parts = [UnitID: Int64]()
                let category: String?
                let note: String?
                var actualPayer: NumaSharedCore.MemberID?
                var allocationUnits: [UnitID] = []
                switch record.currentContent {
                case let .expense(content):
                    actualPayer = content.payerMemberID
                    allocationUnits = content.allocations.compactMap { identities.appUnit(for: $0.unitID) }
                    guard let mappedPayer = identities.appUnit(
                        for: content.payerUnitID
                    ) else {
                        throw AppLedgerRepositoryError.unknownUnit(
                            content.payerUnitID
                        )
                    }
                    for allocation in content.allocations {
                        guard let unit = identities.appUnit(
                            for: allocation.unitID
                        ) else {
                            throw AppLedgerRepositoryError.unknownUnit(
                                allocation.unitID
                            )
                        }
                        parts[unit] = allocation.amount.minorUnits
                    }
                    kind = content.kind == .personal ? .personal : .expense
                    title = content.title
                    amountMinorUnits = content.amount.minorUnits
                    payer = mappedPayer
                    category = content.category
                    note = nil
                case let .openingBalance(content):
                    for entry in content.entries {
                        guard let unit = identities.appUnit(for: entry.unitID) else {
                            throw AppLedgerRepositoryError.unknownUnit(entry.unitID)
                        }
                        parts[unit] = entry.amount.minorUnits
                    }
                    kind = .openingBalance
                    title = content.title
                    amountMinorUnits = 0
                    payer = .am
                    category = nil
                    note = content.note
                }
                records.append(ExpenseRecord(
                    id: record.recordID.description,
                    sortOrdinal: sortOrdinal,
                    kind: kind,
                    title: title,
                    amountCents: amountMinorUnits,
                    payer: payer,
                    parts: parts,
                    to: nil,
                    occurredAt: source.event.occurredAt,
                    originatingTimeZoneIdentifier: source.event.originatingTimeZone.identifier,
                    category: category,
                    note: note,
                    recordedBy: actorName(
                        source.event.actorMemberID,
                        identities: identities,
                        memberDisplayNames: memberDisplayNames
                    ),
                    voided: record.isVoided,
                    voidReason: record.voidReason,
                    flagged: false,
                    deliveryState: recordDeliveryState(source.delivery),
                    revisionHistory: try record.revisions.map { revision in
                        try makeRevisionVersion(
                            revision,
                            eventByID: eventByID,
                            identities: identities,
                            memberDisplayNames: memberDisplayNames
                        )
                    },
                    appliedRevisionID: record.appliedRevisionID.description,
                    contest: record.contested.map {
                        ExpenseRecordContest(
                            headRevisionIDs: $0.headRevisionIDs.map(\.description),
                            provisionalRevisionID:
                                $0.provisionalRevisionID.description
                        )
                    },
                    payerMemberID: actualPayer,
                    payerDisplayName: actualPayer.map { memberDisplayNames[$0] ?? String(localized: "Former member") },
                    allocationUnitIDs: allocationUnits
                ))
            case let .settlement(record):
                guard let source = eventByID[record.eventID]
                    ?? rootEventByRecord[record.recordID]
                else {
                    throw AppLedgerRepositoryError.missingStoredRecord(
                        record.recordID.description
                    )
                }
                guard let from = identities.appUnit(for: record.content.fromUnitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(record.content.fromUnitID)
                }
                guard let to = identities.appUnit(for: record.content.toUnitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(record.content.toUnitID)
                }
                guard let sortOrdinal = eventOrder[source.event.id] else {
                    throw AppLedgerRepositoryError.missingStoredRecord(
                        record.recordID.description
                    )
                }
                records.append(ExpenseRecord(
                    id: record.recordID.description,
                    sortOrdinal: sortOrdinal,
                    kind: .settlement,
                    title: record.content.title,
                    amountCents: record.content.amount.minorUnits,
                    payer: from,
                    parts: [:],
                    to: to,
                    occurredAt: source.event.occurredAt,
                    originatingTimeZoneIdentifier: source.event.originatingTimeZone.identifier,
                    category: nil,
                    recordedBy: actorName(
                        source.event.actorMemberID,
                        identities: identities,
                        memberDisplayNames: memberDisplayNames
                    ),
                    voided: false,
                    flagged: record.isFlagged,
                    deliveryState: recordDeliveryState(source.delivery),
                    reversalOfRecordID: record.content.reversalOfRecordID?.description
                ))
            }
        }
        for stored in failedEvents {
            guard let sortOrdinal = eventOrder[stored.event.id] else {
                throw AppLedgerRepositoryError.missingStoredRecord(
                    stored.event.id.description
                )
            }
            records.append(try failedRecord(
                from: stored,
                sortOrdinal: sortOrdinal,
                identities: identities,
                memberDisplayNames: memberDisplayNames
            ))
        }
        return records.sorted { lhs, rhs in
            lhs.sortOrdinal == rhs.sortOrdinal
                ? lhs.id < rhs.id
                : lhs.sortOrdinal < rhs.sortOrdinal
        }
    }

    private func makeRevisionVersion(
        _ revision: RevisionProjection,
        eventByID: [NumaSharedCore.EventID: StoredLedgerEvent],
        identities: AppLedgerIdentitySet,
        memberDisplayNames: [NumaSharedCore.MemberID: String]
    ) throws -> ExpenseRevisionVersion {
        guard let source = eventByID[revision.eventID] else {
            throw AppLedgerRepositoryError.unknownRevision(
                revision.eventID.description
            )
        }
        let title: String
        let amountMinorUnits: Int64
        let payer: UnitID
        var parts = [UnitID: Int64]()
        let category: String?
        let note: String?
        var actualPayer: NumaSharedCore.MemberID?
        switch revision.content {
        case let .expense(content):
            actualPayer = content.payerMemberID
            guard let mappedPayer = identities.appUnit(
                for: content.payerUnitID
            ) else {
                throw AppLedgerRepositoryError.unknownUnit(content.payerUnitID)
            }
            for allocation in content.allocations {
                guard let unit = identities.appUnit(for: allocation.unitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(allocation.unitID)
                }
                parts[unit] = allocation.amount.minorUnits
            }
            title = content.title
            amountMinorUnits = content.amount.minorUnits
            payer = mappedPayer
            category = content.category
            note = nil
        case let .openingBalance(content):
            for entry in content.entries {
                guard let unit = identities.appUnit(for: entry.unitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(entry.unitID)
                }
                parts[unit] = entry.amount.minorUnits
            }
            title = content.title
            amountMinorUnits = 0
            payer = .am
            category = nil
            note = content.note
        }
        return ExpenseRevisionVersion(
            id: revision.eventID.description,
            title: title,
            amountCents: amountMinorUnits,
            payer: payer,
            parts: parts,
            category: category,
            note: note,
            occurredAt: revision.occurredAt,
            originatingTimeZoneIdentifier:
                source.event.originatingTimeZone.identifier,
            recordedBy: actorName(
                revision.actorMemberID,
                identities: identities,
                memberDisplayNames: memberDisplayNames
            ),
            payerMemberID: actualPayer,
            payerDisplayName: actualPayer.map { memberDisplayNames[$0] ?? String(localized: "Former member") }
        )
    }

    private func isCompatibilityBarrier(_ stored: StoredLedgerEvent) -> Bool {
        if stored.event.schemaVersion > readerSchemaVersion {
            return true
        }
        if case .unsupported = stored.event.kind { return true }
        return false
    }

    private func failedRecord(
        from stored: StoredLedgerEvent,
        sortOrdinal: Int64,
        identities: AppLedgerIdentitySet,
        memberDisplayNames: [NumaSharedCore.MemberID: String]
    ) throws -> ExpenseRecord {
        let kind: RecordKind
        let title: String
        let amountMinorUnits: Int64
        let payer: UnitID
        let parts: [UnitID: Int64]
        let to: UnitID?
        let category: String?
        let targetRecordID: String?
        let reversalOfRecordID: String?

        switch stored.event.payload {
        case let .expenseAdded(payload):
            reversalOfRecordID = nil
            targetRecordID = payload.recordID.description
            let content = payload.content
            guard let mappedPayer = identities.appUnit(for: content.payerUnitID) else {
                throw AppLedgerRepositoryError.unknownUnit(content.payerUnitID)
            }
            var mappedParts = [UnitID: Int64]()
            for allocation in content.allocations {
                guard let unit = identities.appUnit(for: allocation.unitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(allocation.unitID)
                }
                mappedParts[unit] = allocation.amount.minorUnits
            }
            kind = content.kind == .personal ? .personal : .expense
            title = content.title
            amountMinorUnits = content.amount.minorUnits
            payer = mappedPayer
            parts = mappedParts
            to = nil
            category = content.category
        case let .settlementRecorded(payload):
            reversalOfRecordID = payload.content.reversalOfRecordID?.description
            targetRecordID = payload.recordID.description
            let content = payload.content
            guard let mappedFrom = identities.appUnit(for: content.fromUnitID) else {
                throw AppLedgerRepositoryError.unknownUnit(content.fromUnitID)
            }
            guard let mappedTo = identities.appUnit(for: content.toUnitID) else {
                throw AppLedgerRepositoryError.unknownUnit(content.toUnitID)
            }
            kind = .settlement
            title = content.title
            amountMinorUnits = content.amount.minorUnits
            payer = mappedFrom
            parts = [:]
            to = mappedTo
            category = nil
        case let .openingBalanceSet(payload):
            reversalOfRecordID = nil
            targetRecordID = payload.recordID.description
            let content = payload.content
            var mappedEntries = [UnitID: Int64]()
            for entry in content.entries {
                guard let unit = identities.appUnit(for: entry.unitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(entry.unitID)
                }
                mappedEntries[unit] = entry.amount.minorUnits
            }
            kind = .openingBalance
            title = content.title
            amountMinorUnits = 0
            payer = .am
            parts = mappedEntries
            to = nil
            category = nil
        case let .expenseRevised(payload):
            reversalOfRecordID = nil
            targetRecordID = payload.recordID.description
            switch payload.content {
            case let .expense(content):
                guard let mappedPayer = identities.appUnit(for: content.payerUnitID) else {
                    throw AppLedgerRepositoryError.unknownUnit(content.payerUnitID)
                }
                var mappedParts = [UnitID: Int64]()
                for allocation in content.allocations {
                    guard let unit = identities.appUnit(for: allocation.unitID) else {
                        throw AppLedgerRepositoryError.unknownUnit(allocation.unitID)
                    }
                    mappedParts[unit] = allocation.amount.minorUnits
                }
                kind = .expenseRevision
                title = content.title
                amountMinorUnits = content.amount.minorUnits
                payer = mappedPayer
                parts = mappedParts
                to = nil
                category = content.category
            case let .openingBalance(content):
                var mappedEntries = [UnitID: Int64]()
                for entry in content.entries {
                    guard let unit = identities.appUnit(for: entry.unitID) else {
                        throw AppLedgerRepositoryError.unknownUnit(entry.unitID)
                    }
                    mappedEntries[unit] = entry.amount.minorUnits
                }
                kind = .openingBalanceRevision
                title = content.title
                amountMinorUnits = 0
                payer = .am
                parts = mappedEntries
                to = nil
                category = nil
            }
        case let .recordVoided(payload):
            reversalOfRecordID = nil
            targetRecordID = payload.recordID.description
            kind = .voidAttempt
            title = localizedFormat("Void attempt: %@", payload.reason)
            amountMinorUnits = 0
            payer = .am
            parts = [:]
            to = nil
            category = nil
        case let .recordRestored(payload):
            reversalOfRecordID = nil
            targetRecordID = payload.recordID.description
            kind = .restoreAttempt
            title = String(localized: "Restore attempt")
            amountMinorUnits = 0
            payer = .am
            parts = [:]
            to = nil
            category = nil
        case let .settlementFlagged(payload):
            reversalOfRecordID = nil
            targetRecordID = payload.recordID.description
            kind = .settlementFlagAttempt
            if let reason = payload.reason {
                title = localizedFormat("Flag attempt: %@", reason)
            } else {
                title = String(localized: "Flag attempt")
            }
            amountMinorUnits = 0
            payer = .am
            parts = [:]
            to = nil
            category = nil
        case .memberAdded, .memberClaimed, .memberClaimReassigned, .memberArchived,
             .ownershipTransferred, .groupChanged, .presetChanged, .potRenamed,
             .potArchived, .unsupported:
            targetRecordID = nil
            reversalOfRecordID = nil
            kind = .failedAttempt
            title = String(localized: "Shared pot change attempt")
            amountMinorUnits = 0
            payer = .am
            parts = [:]
            to = nil
            category = nil
        }

        let actualPayer: NumaSharedCore.MemberID?
        switch stored.event.payload {
        case let .expenseAdded(payload): actualPayer = payload.content.payerMemberID
        case let .expenseRevised(payload):
            if case let .expense(content) = payload.content { actualPayer = content.payerMemberID }
            else { actualPayer = nil }
        default: actualPayer = nil
        }
        return ExpenseRecord(
            id: "failed:\(stored.event.id.description)",
            sortOrdinal: sortOrdinal,
            kind: kind,
            title: title,
            amountCents: amountMinorUnits,
            payer: payer,
            parts: parts,
            to: to,
            occurredAt: stored.event.occurredAt,
            originatingTimeZoneIdentifier: stored.event.originatingTimeZone.identifier,
            category: category,
            recordedBy: actorName(
                stored.event.actorMemberID,
                identities: identities,
                memberDisplayNames: memberDisplayNames
            ),
            voided: false,
            flagged: false,
            deliveryState: .failed,
            terminalReason: stored.delivery.terminalReason,
            targetRecordID: targetRecordID,
            reversalOfRecordID: reversalOfRecordID,
            payerMemberID: actualPayer,
            payerDisplayName: actualPayer.map { memberDisplayNames[$0] ?? String(localized: "Former member") }
        )
    }

    private func rootRecordID(in payload: EventPayload) -> NumaSharedCore.RecordID? {
        switch payload {
        case let .expenseAdded(value): value.recordID
        case let .settlementRecorded(value): value.recordID
        case let .openingBalanceSet(value): value.recordID
        case .expenseRevised, .recordVoided, .recordRestored, .settlementFlagged,
             .memberAdded, .memberClaimed, .memberClaimReassigned, .memberArchived,
             .ownershipTransferred, .groupChanged, .presetChanged, .potRenamed,
             .potArchived, .unsupported:
            nil
        }
    }

    private func actorName(
        _ actorID: NumaSharedCore.MemberID,
        identities: AppLedgerIdentitySet,
        memberDisplayNames: [NumaSharedCore.MemberID: String]
    ) -> String {
        if let displayName = memberDisplayNames[actorID] { return displayName }
        if actorID == identities.ownerMemberID { return "Arseny" }
        if actorID == identities.samMemberID { return "Sam" }
        if actorID == identities.leoMemberID { return "Leo" }
        return String(localized: "Unknown member")
    }

    private func recordDeliveryState(_ delivery: EventDelivery) -> RecordDeliveryState {
        switch delivery.state {
        case .held, .ready, .dispatching: .waiting
        case .terminal: .failed
        case .acknowledged: .synced
        }
    }

#if DEBUG
    // MARK: - Deterministic two-simulator harness

    func prepareE2ECommand(
        _ command: NumaSharedE2ECommand,
        runSeed: String,
        now: Date = Date()
    ) throws -> AppLedgerSnapshot {
        let count: Int
        let base: UInt64
        switch command {
        case .observe, .p3ClaimLeaked, .p3RejectLeaked,
             .p3ClaimApproved, .p3ApproveClaim, .p3CrossExpense,
             .p3Settlement, .p3RevisionA, .p3RevisionB,
             .p3ResolveContest:
            return try refreshSnapshot()
        case .createOne, .p3OwnerBootstrap:
            count = 1
            base = 0x100
        case .createAfter:
            count = 1
            base = 0x400
        case .queueTwenty:
            count = 20
            base = 0x200
        }
        let store = try preparedStore()
        try registerPotIfNeeded(in: store)
        let identities = try resolvedIdentities(in: store)
        if try store.localPotSetup(for: identities.potID) == nil {
            _ = try saveLocalSetup(
                in: store,
                identities: identities,
                potName: "Casa Mar",
                ownerDisplayName: "Arseny",
                samDisplayName: "Sam",
                leoDisplayName: "Leo",
                originatingTimeZone: try IANATimeZone("UTC"),
                at: now
            )
        }
        let factory = try E2EUUIDFactory(seed: runSeed)
        let existingIDs = Set(
            try store.loadStoredEvents(for: identities.potID).map(\.event.id)
        )
        let zone = try IANATimeZone("UTC")
        for index in 0..<count {
            let eventID = try EventID(validating: factory.uuid(
                discriminator: base + UInt64(index)
            ))
            if existingIDs.contains(eventID) { continue }
            let recordID = try RecordID(validating: factory.uuid(
                discriminator: base + 0x80 + UInt64(index)
            ))
            let amount = Int64(try factory.randomIndex(
                discriminator: base + 0x3_000 + UInt64(index),
                count: 10_000
            ) + 1)
            let units = UnitID.allCases
            let payerIndex = try factory.randomIndex(
                discriminator: base + 0x1_000 + UInt64(index),
                count: units.count
            )
            let beneficiaryOffset = try factory.randomIndex(
                discriminator: base + 0x2_000 + UInt64(index),
                count: units.count - 1
            )
            let beneficiaryIndex = beneficiaryOffset >= payerIndex
                ? beneficiaryOffset + 1
                : beneficiaryOffset
            let payerUnitID = identities.coreUnit(for: units[payerIndex])
            let beneficiaryUnitID = identities.coreUnit(for: units[beneficiaryIndex])
            let allocationStyleIndex = try factory.randomIndex(
                discriminator: base + 0x5_000 + UInt64(index),
                count: 2
            )
            let usesBothOtherUnits = amount > 1 && allocationStyleIndex == 1
            let allocations: [ExpenseAllocation]
            if usesBothOtherUnits {
                let otherUnits = units.indices.filter { $0 != payerIndex }
                let firstAmount = Int64(try factory.randomIndex(
                    discriminator: base + 0x6_000 + UInt64(index),
                    count: Int(amount - 1)
                ) + 1)
                allocations = [
                    ExpenseAllocation(
                        unitID: identities.coreUnit(for: units[otherUnits[0]]),
                        amount: Money(minorUnits: firstAmount, currency: .eur)
                    ),
                    ExpenseAllocation(
                        unitID: identities.coreUnit(for: units[otherUnits[1]]),
                        amount: Money(minorUnits: amount - firstAmount, currency: .eur)
                    ),
                ]
            } else {
                allocations = [ExpenseAllocation(
                    unitID: beneficiaryUnitID,
                    amount: Money(minorUnits: amount, currency: .eur)
                )]
            }
            let title = switch command {
            case .observe, .p3ClaimLeaked, .p3RejectLeaked,
                 .p3ClaimApproved, .p3ApproveClaim, .p3CrossExpense,
                 .p3Settlement, .p3RevisionA, .p3RevisionB,
                 .p3ResolveContest:
                preconditionFailure("Observe returns before event creation")
            case .createOne, .p3OwnerBootstrap:
                "NUMA_SHARED_E2E accountless event"
            case .createAfter:
                "NUMA_SHARED_E2E post-auth event"
            case .queueTwenty:
                "NUMA_SHARED_E2E queued event \(index + 1)"
            }
            let event = EventEnvelope(
                id: eventID,
                potID: identities.potID,
                actorMemberID: identities.ownerMemberID,
                occurredAt: now.addingTimeInterval(TimeInterval(index) / 1_000),
                originatingTimeZone: zone,
                payload: .expenseAdded(ExpenseAddedPayload(
                    recordID: recordID,
                    content: ExpenseContent(
                        kind: .shared,
                        title: title,
                        amount: Money(minorUnits: amount, currency: .eur),
                        payerUnitID: payerUnitID,
                        allocations: allocations,
                        category: nil
                    )
                ))
            )
            _ = try store.appendHeldLocalEvent(event, savedAt: now)
        }
        _ = try store.expireHeldEvents(
            now: now.addingTimeInterval(UndoPolicy.window)
        )
        advanceRevision()
        return try snapshot(from: store)
    }

    func appendE2EConcurrentExpenseRevision(
        recordTitle: String,
        revisionTitle: String,
        amountMinorUnits: Int64,
        runSeed: String,
        now: Date = Date()
    ) throws -> AppLedgerMutation? {
        let store = try preparedStore()
        let identities = try resolvedIdentities(in: store)
        let projected = try snapshot(from: store)
        guard let record = projected.records.first(where: {
            $0.title == recordTitle || $0.revisionHistory.contains(where: {
                $0.title == recordTitle
            })
        }),
        let rootRevision = record.revisionHistory.first
        else { throw AppLedgerRepositoryError.unknownRecord(recordTitle) }

        let deterministicID = try EventID(validating: E2EUUIDFactory(
            seed: runSeed
        ).uuid(discriminator: 0x900))
        if try store.loadStoredEvents(for: identities.potID).contains(where: {
            $0.event.id == deterministicID
        }) {
            return nil
        }
        let payload = EventPayload.expenseRevised(ExpenseRevisedPayload(
            recordID: try recordID(from: record.id),
            basis: .parent(try eventID(from: rootRevision.id)),
            content: .expense(ExpenseContent(
                kind: .personal,
                title: revisionTitle,
                amount: Money(minorUnits: amountMinorUnits, currency: .eur),
                payerUnitID: identities.coreUnit(for: .sam),
                allocations: [ExpenseAllocation(
                    unitID: identities.coreUnit(for: .am),
                    amount: Money(
                        minorUnits: amountMinorUnits,
                        currency: .eur
                    )
                )],
                category: "Shared"
            ))
        ))
        return try appendHeld(
            payload: payload,
            occurredAt: now,
            savedAt: now,
            eventID: deterministicID
        )
    }

    func e2eLedgerState() throws -> NumaSharedE2ELedgerState {
        let store = try preparedStore()
        let identities = try resolvedIdentities(in: store)
        let events = try store.loadStoredEvents(for: identities.potID)
        let eventsByLocalOrdinal = events.sorted { lhs, rhs in
            lhs.localOrdinal < rhs.localOrdinal
        }
        var acknowledgements = [NumaSharedE2EAcknowledgement]()
        for stored in events {
            guard let sequence = stored.delivery.serverSequence else { continue }
            acknowledgements.append(NumaSharedE2EAcknowledgement(
                serverSequence: sequence,
                eventID: stored.event.id.description
            ))
        }
        acknowledgements.sort { lhs, rhs in
            lhs.serverSequence == rhs.serverSequence
                ? lhs.eventID < rhs.eventID
                : lhs.serverSequence < rhs.serverSequence
        }
        let projected = try snapshot(from: store)
        let expenseRecordCount = projected.records.filter { record in
            switch record.kind {
            case .expense, .personal, .expenseRevision:
                true
            default:
                false
            }
        }.count
        return NumaSharedE2ELedgerState(
            activePotID: identities.potID.description,
            pendingCount: try store.unsyncedEventCount(for: identities.potID),
            eventIDs: events.map { $0.event.id.description },
            localOrdinalEventIDs: eventsByLocalOrdinal.map {
                $0.event.id.description
            },
            acknowledgedServerSequences: acknowledgements.map {
                $0.serverSequence
            },
            acknowledgedEvents: acknowledgements,
            currentMemberRole: projected.currentMemberProfile?.role.rawValue,
            activeMemberCount: projected.memberProfiles.filter {
                $0.state == .active
            }.count,
            expenseRecordCount: expenseRecordCount,
            settlementRecordCount: projected.records.filter {
                $0.kind == .settlement
            }.count,
            contestedRecordCount: projected.records.filter {
                $0.contest != nil
            }.count,
            maximumRevisionCount: projected.records.map {
                $0.revisionHistory.count
            }.max() ?? 0
        )
    }

    // MARK: - Casa Mar QA seed

    private func ingestCasaMarSeed(into store: LedgerStore) throws {
        for event in try casaMarSeedEvents() {
            _ = try store.ingestRemoteEvent(event, receivedAt: event.occurredAt)
        }
    }

    private func casaMarSeedEvents() throws -> [EventEnvelope] {
        let identities = try currentIdentities()
        let zone = try IANATimeZone("Europe/Madrid")
        let am = identities.coreUnit(for: .am)
        let sam = identities.coreUnit(for: .sam)
        let leo = identities.coreUnit(for: .leo)

        func money(_ minorUnits: Int64) -> Money {
            Money(minorUnits: minorUnits, currency: .eur)
        }
        func allocations(_ values: [(NumaSharedCore.UnitID, Int64)]) -> [ExpenseAllocation] {
            values.map { ExpenseAllocation(unitID: $0.0, amount: money($0.1)) }
        }
        func event(
            _ index: UInt8,
            day: Int,
            actor: UnitID,
            payload: EventPayload
        ) throws -> EventEnvelope {
            EventEnvelope(
                id: try AppLedgerIDs.seedEventID(index),
                potID: identities.potID,
                actorMemberID: identities.memberID(for: actor),
                occurredAt: try seedDate(day: day),
                originatingTimeZone: zone,
                serverSequence: Int64(index) + 1,
                payload: payload
            )
        }

        return try [
            event(0, day: 1, actor: .am, payload: .expenseAdded(ExpenseAddedPayload(
                recordID: AppLedgerIDs.seedRecordID(0),
                content: ExpenseContent(
                    kind: .shared,
                    title: "Rent — July",
                    amount: money(180_000),
                    payerUnitID: am,
                    allocations: allocations([(am, 90_000), (sam, 45_000), (leo, 45_000)]),
                    category: "Home"
                )
            ))),
            event(1, day: 3, actor: .sam, payload: .expenseAdded(ExpenseAddedPayload(
                recordID: AppLedgerIDs.seedRecordID(1),
                content: ExpenseContent(
                    kind: .shared,
                    title: "Groceries at Lidl",
                    amount: money(12_000),
                    payerUnitID: sam,
                    allocations: allocations([(am, 6_000), (sam, 3_000), (leo, 3_000)]),
                    category: "Groceries"
                )
            ))),
            event(2, day: 4, actor: .leo, payload: .expenseAdded(ExpenseAddedPayload(
                recordID: AppLedgerIDs.seedRecordID(2),
                content: ExpenseContent(
                    kind: .shared,
                    title: "Internet",
                    amount: money(6_000),
                    payerUnitID: leo,
                    allocations: allocations([(am, 3_000), (sam, 1_500), (leo, 1_500)]),
                    category: "Utilities"
                )
            ))),
            event(3, day: 6, actor: .am, payload: .expenseAdded(ExpenseAddedPayload(
                recordID: AppLedgerIDs.seedRecordID(3),
                content: ExpenseContent(
                    kind: .personal,
                    title: "Pharmacy — for Leo",
                    amount: money(2_000),
                    payerUnitID: am,
                    allocations: allocations([(leo, 2_000)]),
                    category: "Health"
                )
            ))),
            event(4, day: 7, actor: .sam, payload: .settlementRecorded(SettlementRecordedPayload(
                recordID: AppLedgerIDs.seedRecordID(4),
                content: SettlementContent(
                    title: "Sam paid your household",
                    amount: money(30_000),
                    fromUnitID: sam,
                    toUnitID: am
                )
            ))),
            event(5, day: 8, actor: .leo, payload: .settlementRecorded(SettlementRecordedPayload(
                recordID: AppLedgerIDs.seedRecordID(5),
                content: SettlementContent(
                    title: "Leo paid your household",
                    amount: money(40_000),
                    fromUnitID: leo,
                    toUnitID: am
                )
            ))),
        ]
    }

    private func seedDate(day: Int) throws -> Date {
        guard let timeZone = TimeZone(identifier: "Europe/Madrid") else {
            throw AppLedgerRepositoryError.invalidSeedDate
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let date = calendar.date(from: DateComponents(
            calendar: calendar,
            timeZone: timeZone,
            year: 2026,
            month: 7,
            day: day,
            hour: 12
        )) else {
            throw AppLedgerRepositoryError.invalidSeedDate
        }
        return date
    }
#endif
}
