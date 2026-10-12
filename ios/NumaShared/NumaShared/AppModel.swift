import AuthenticationServices
import NumaSharedCore
import NumaSharedSync
import SwiftUI

enum Screen: Equatable, Sendable {
    case welcome, create, people, openingBalance, home
}
enum SheetKind {
    case none, activity, detail, editExpense, voidRecord
    case settlePlan, settleAmount
}
nonisolated enum OpeningBalanceRelation: Sendable {
    case owesHousehold
    case householdOwesMember
}
nonisolated enum ExpenseSplitMode: String, CaseIterable, Identifiable, Sendable {
    case shares
    case exact

    var id: Self { self }
}
private enum InviteCreationTarget: Equatable, Sendable {
    case localUnit(UnitID)
    case member(NumaSharedCore.MemberID)
    case potLink
}

nonisolated struct AccountDeletionRecoveryState: Codable, Equatable, Sendable {
    let requestID: UUID
    let originatingTimeZone: String
    let serverComplete: Bool
}

nonisolated struct AccountDeletionRecoveryStore: Sendable {
    private static let filename = "account-deletion-v1.json"
    private let explicitDirectory: URL?

    init(directory: URL? = nil) {
        explicitDirectory = directory
    }

    func load() throws -> AccountDeletionRecoveryState? {
        let fileURL = try fileURL(createDirectory: false)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }
        return try JSONDecoder().decode(
            AccountDeletionRecoveryState.self,
            from: Data(contentsOf: fileURL)
        )
    }

    func save(_ state: AccountDeletionRecoveryState) throws {
        let data = try JSONEncoder().encode(state)
        try data.write(
            to: fileURL(createDirectory: true),
            options: .atomic
        )
    }

    func clear() throws {
        let fileURL = try fileURL(createDirectory: false)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return
        }
        try FileManager.default.removeItem(at: fileURL)
    }

    private func fileURL(createDirectory: Bool) throws -> URL {
        let directory: URL
        if let explicitDirectory {
            directory = explicitDirectory
        } else {
            directory = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: createDirectory
            ).appendingPathComponent("NumaShared", isDirectory: true)
        }
        if createDirectory {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
        }
        return directory.appendingPathComponent(Self.filename)
    }
}

@MainActor
final class AppModel: ObservableObject {
    // MARK: Navigation
    @Published var screen: Screen = .welcome
    @Published var sheet: SheetKind = .none
    @Published var potName = ""
    @Published var potCurrency = CurrencyCatalog.suggested()
    @Published private(set) var isPotCurrencyConfirmed = false
    @Published var ownerDisplayName = ""
    @Published var samDisplayName = ""
    @Published var leoDisplayName = ""
    @Published private(set) var setupPersonUnits: [UnitID] = []
    @Published private(set) var setupPairs: [[UnitID]] = []
    @Published var additionalSetupNames: [UnitID: String] = [:]
    var setupGroupedUnits: Set<UnitID> { Set(setupPairs.flatMap { $0 }) }
    @Published private(set) var isCompletingSetup = false
    var hasPendingSetupRegistration: Bool { pendingCompletedSetup != nil }
    var isSetupDraftLocked: Bool { isCompletingSetup || hasPendingSetupRegistration }
    @Published private(set) var setupErrorMessage: String?
    @Published private(set) var isSavingOpeningBalance = false
    @Published private(set) var openingBalanceErrorMessage: String?
    @Published private(set) var isBootstrapping = true
    @Published private(set) var localDataErrorMessage: String?
    @Published private(set) var isRecoveringLocalData = false
    private var localDataFailureBlocksApp = false

    // MARK: Ledger projection
    @Published private(set) var records: [ExpenseRecord] = []
    @Published private(set) var balances: [UnitID: Int64] = AppLedgerSnapshot.empty.balances
    @Published private(set) var spend: Int64 = 0
    @Published private(set) var plan: [SettlementStep] = []
    @Published private(set) var pendingDeliveryEventCount = 0
    @Published private(set) var unsyncedEventCount = 0
    @Published private(set) var isArchived = false
    @Published private(set) var isCurrentMemberArchived = false
    @Published private(set) var reductionAccess: ReductionAccess = .readWrite
    private var readerSchemaVersion = EventEnvelope.currentSchemaVersion
    @Published private(set) var budgetGroupStructure: StructuralProjection?
    @Published private(set) var activeBudgetUnitIDs: [UnitID] = []
    var usesBudgetGroups: Bool { budgetGroupStructure?.minimumSchemaVersion == 2 }
    var canEditBudgetGroups: Bool {
        usesBudgetGroups && budgetGroupStructure?.hasFinancialHistory == false
            && isCurrentMemberOwner && canWrite && !isPersisting
    }
    var payerPeople: [AppMemberProfile] {
        memberProfiles.filter { $0.state != .archived && $0.budgetUnitID.map(activeBudgetUnitIDs.contains) == true }
    }
    func personName(_ profile: AppMemberProfile) -> String {
        profile.displayName ?? (profile.state == .archived ? "Former member" : "Unknown member")
    }
    func selectExpensePayer(_ profile: AppMemberProfile) {
        guard let unit = profile.budgetUnitID, payerPeople.contains(where: { $0.memberID == profile.memberID }) else { return }
        expensePayerMemberID = profile.memberID
        expensePayer = unit
    }
    func setBudgetPartner(_ member: NumaSharedCore.MemberID, partner: NumaSharedCore.MemberID?) {
        guard canEditBudgetGroups, let structure = budgetGroupStructure else { return }
        var pairs = structure.groups.map(\.orderedMemberIDs).filter { !$0.contains(member) }
        if let partner {
            guard partner != member, !pairs.contains(where: { $0.contains(partner) }) else { return }
            pairs.append([member, partner])
        }
        isPersisting = true
        let repository = repository
        Task { [weak self] in
            do {
                let snapshot = try await repository.changeBudgetGroups(pairs: pairs)
                self?.apply(snapshot)
                self?.isPersisting = false
            } catch { self?.persistenceFailed(error) }
        }
    }
    @Published private(set) var minimumReaderSchemaVersion: UInt16?
    @Published private(set) var minimumSupportedBuild: Int?
    @Published private(set) var memberProfiles: [AppMemberProfile] = []
    @Published private(set) var currentMemberID: NumaSharedCore.MemberID?
    private var appliedRevision: Int64 = -1
    private var repository: AppLedgerRepository

    // Local pot registry (v1.1 multi-pot: local-first; sync stays bound to
    // the pot it was enabled on, so switching/creating requires sync off).
    @Published private(set) var localPots: [LocalPotDescriptor] = []
    @Published private(set) var activePotID: UUID?
    @Published var potSwitcherPresented = false
    @Published private(set) var isCreatingAdditionalPot = false
    private var registryPersists = false
    private var ephemeralPotStores: [UUID: AppLedgerRepository] = [:]
    private var pendingNewPot: (id: UUID, databaseName: String)?
    private var newPotReturn: (repository: AppLedgerRepository, potID: UUID?)?
    private var pendingCompletedSetup: (snapshot: AppLedgerSnapshot, destination: Screen)?
#if DEBUG
    private var failsNextSetupRegistrationForTesting = false
    func failNextSetupRegistrationForTesting() { failsNextSetupRegistrationForTesting = true }
#endif
    private var syncRuntime: AppSyncRuntime?
    private var syncConfigurationFlight: (
        id: UUID,
        repository: AppLedgerRepository,
        task: Task<Void, Never>
    )?
#if DEBUG
    @Published private(set) var qaLaunchReadyMilliseconds: Int?
    let qaHidesStatusBar: Bool
    let qaHidesDebugControls: Bool
    let qaEightUnitField: Bool
    let qaTenUnitField: Bool
    let qaOpensAddSheetOnLaunch: Bool
    /// Freezes decorative motion (breath, shimmer, entrance stagger) so
    /// pixel-sampling checks audit settled UI — the Reduce Motion look.
    let qaStillMotion: Bool
    private let qaLaunchStartedUptime = ProcessInfo.processInfo.systemUptime
    private let usesEphemeralQAStore: Bool
    private let isIsolatedReferenceQA: Bool
    private let e2eConfiguration: NumaSharedE2EConfiguration?
    private let e2eEnvelope: NumaSharedE2ELaunchEnvelope?
    private var e2eReporter: NumaSharedE2EReporter?
    private var qaBootstrapFailuresRemaining = 0
    private var qaShowsLocalDataError = false
#endif
    private var isPersisting = false

    // MARK: Sync and identity
    @Published private var runtimeSyncPresentation: SyncPresentation = .local
    @Published var syncSetupPresented = false
    @Published private(set) var syncErrorMessage: String?
    private var pendingAppleNonce: String?
    private let pushNotificationSystem: any PushNotificationSystem
    private var receivedPushToken: APNsDeviceToken?
    private var didRequestRemoteNotificationRegistration = false
    private var isReconcilingPushNotifications = false
    private var pendingNotificationPotID: NumaSharedCore.PotID?
    private var isOpeningNotificationPot = false

    // MARK: People
    @Published var peoplePresented = false
    @Published private(set) var pendingInviteClaims: [PendingInviteClaim] = []
    @Published private(set) var isRefreshingPeople = false
    @Published private(set) var isUpdatingPeople = false
    @Published private(set) var isIssuingInvite = false
    @Published private(set) var peopleErrorMessage: String?
    @Published private(set) var managedInvites: [ManagedInvite] = []
    @Published private(set) var issuedInvite: ShareableInvite?
    @Published private(set) var pushNotificationPermission:
        PushNotificationPermissionState = .notDetermined
    @Published private(set) var isPotMuted = false
    @Published private(set) var isUpdatingNotifications = false
    @Published private(set) var notificationErrorMessage: String?
    private var pendingInviteCreation: InviteCreationTarget?

    func openPeopleManagement() {
        peopleErrorMessage = nil
        peoplePresented = true
        guard isSyncEnabled else {
            pendingInviteClaims = []
            managedInvites = []
            return
        }
        refreshPeople()
    }

    func dismissPeopleManagement() {
        peoplePresented = false
    }

    // MARK: Settings
    @Published var settingsPresented = false
    @Published private(set) var isPreparingCSVExport = false
    @Published private(set) var csvExportURL: URL?
    @Published private(set) var csvExportRowCount: Int?
    @Published private(set) var csvExportErrorMessage: String?
    @Published private(set) var csvExportPrivacyWarning: String?
    private var csvExportRequestID: UUID?
    private var csvExportTask: Task<Void, Never>?
    private var csvExportDirectory: URL?
    @Published var signOutConfirmationPresented = false
    @Published private(set) var isSigningOut = false
    @Published private(set) var signOutCleanupPending = false
    @Published private(set) var signOutErrorMessage: String?
    @Published var accountDeletionConfirmationPresented = false
    @Published private(set) var isLoadingAccountDeletion = false
    @Published private(set) var isDeletingAccount = false
    @Published private(set) var accountDeletionPreviewMessage = ""
    @Published private(set) var accountDeletionErrorMessage: String?
    private var accountDeletionRequestID: UUID?
    private var accountDeletionServerComplete = false
    private var accountDeletionOriginatingTimeZone: IANATimeZone?
    private let accountDeletionRecoveryStore: AccountDeletionRecoveryStore
#if DEBUG
    private var qaAccountDeletionPreview: NumaAccountDeletionPreview?
#endif

    // MARK: Invite join
    @Published var joinPresented = false
    @Published var joinCode = ""
    @Published private(set) var joinPhase: JoinPhase = .entry
    @Published private(set) var joinErrorMessage: String?
    private var inviteSiteURL: URL?
    private var invitePreviewService: (any InvitePreviewServing)?
    private var pendingInviteTicket: String?
    private var pendingInviteKind: InviteKind?
    private var pendingInviteSchemaVersion: UInt16?
    private var pendingInvitePotName: String?
    private var joinRequestID: UUID?

    // MARK: Add-expense entry
    @Published var amountInt = ""
    @Published var amountFrac: String? = nil
    @Published var merchant = ""
    @Published var category = ""
    @Published var expenseDate = Date()
    @Published var expensePayer: UnitID = .am
    @Published var expensePayerMemberID: NumaSharedCore.MemberID?
    @Published var attached: Set<UnitID> = []
    @Published var shares: [UnitID: Int64] = [.am: 2, .sam: 1, .leo: 1]
    @Published var expenseSplitMode: ExpenseSplitMode = .shares
    @Published private(set) var exactParts: [UnitID: Int64] = [:]
    @Published private(set) var exactSplitDrafts: [UnitID: String] = [:]
    @Published private(set) var lockedExactUnits = Set<UnitID>()
    @Published private(set) var exactSplitErrorMessage: String?
    @Published var showSplitPreview = false

    // MARK: Gesture-driven transient state (add-expense vessel drag)
    @Published var addDragPoint: CGPoint? = nil
    @Published var addHalo: UnitID? = nil

    // MARK: Gesture-driven transient state (home dock grab)
    @Published var homeDragPoint: CGPoint? = nil
    @Published var homeHalo: UnitID? = nil
    @Published var homeLockedAll = false

    // MARK: Gesture-driven transient state (firm-hold settlement)
    @Published var liftUnit: UnitID? = nil
    @Published var liftPoint: CGPoint? = nil
    @Published var liftLocked = false

    // MARK: Sheets
    @Published var activityFilter: UnitID? = nil
    @Published var activitySearchQuery = ""
    @Published var activityKindFilter: ActivityKindFilter = .all
    @Published var activityPeriodFilter: ActivityPeriodFilter = .all
    @Published var detailID: String? = nil
    @Published private(set) var detailReturnsToActivity = false
    private var settlementReturnsHome = false
    @Published var editTitle = ""
    @Published var editAmountInt = ""
    @Published var editAmountFrac: String? = nil
    @Published var editCategory = ""
    @Published var voidReasonDraft = ""

    // MARK: Settle amount entry
    @Published var settleFrom: UnitID? = nil
    @Published var settleTo: UnitID = .am
    @Published var settleDebt: Int64 = 0
    @Published var sInt = ""
    @Published var sFrac: String? = nil
    @Published private(set) var isManualSettlement = false
    @Published private(set) var settlementReversalTargetID: String?

    // MARK: Undo
    @Published var undoText: String? = nil
    private var undoEventID: NumaSharedCore.EventID?

    // MARK: Privacy / accessibility toggles
    @Published private(set) var hideAmounts: Bool
    @Published var reduceMotion = false
    private let privacyPreferences: DevicePrivacyPreferences

    @Published var addPresented = false

    init(
        launchArguments: [String] = ProcessInfo.processInfo.arguments,
        pushNotificationSystem: any PushNotificationSystem =
            SystemPushNotificationSystem(),
        privacyPreferences: DevicePrivacyPreferences = DevicePrivacyPreferences(),
        accountDeletionRecoveryStore: AccountDeletionRecoveryStore =
            AccountDeletionRecoveryStore()
    ) {
        self.pushNotificationSystem = pushNotificationSystem
        self.privacyPreferences = privacyPreferences
        self.accountDeletionRecoveryStore = accountDeletionRecoveryStore
#if DEBUG
        if launchArguments.contains("--qa-reset-privacy") {
            privacyPreferences.setHideAmounts(false)
        }
#endif
        hideAmounts = privacyPreferences.hideAmounts
#if DEBUG
        var seedCasaMar = false
        let sharedTableReferenceQA = launchArguments.contains("--qa-shared-table-reference")
        isIsolatedReferenceQA = sharedTableReferenceQA
        var ephemeralQA = false
        var contestedCasaMarQA = false
        let arguments = launchArguments
        qaHidesStatusBar = arguments.contains("--qa-hide-status-bar")
        qaHidesDebugControls = arguments.contains("--qa-app-store-capture")
        qaEightUnitField = arguments.contains("--qa-eight-unit-field")
        qaTenUnitField = arguments.contains("--qa-ten-unit-field")
        qaOpensAddSheetOnLaunch = arguments.contains("--qa-add-sheet")
        qaStillMotion = arguments.contains("--qa-still-motion")
        qaBootstrapFailuresRemaining = arguments.contains("--qa-bootstrap-failure") ? 1 : 0
        qaShowsLocalDataError = arguments.contains("--qa-local-data-error")
        let keepLoadingSkeleton = arguments.contains("--qa-loading-skeleton")
        let environment = ProcessInfo.processInfo.environment
        let launchEnvelope = sharedTableReferenceQA ? nil : NumaSharedE2ELaunchEnvelope.process(
            arguments: arguments,
            environment: environment
        )
        let e2e: NumaSharedE2EConfiguration?
        do {
            if sharedTableReferenceQA {
                e2e = nil
            } else {
                e2e = try NumaSharedE2EConfiguration.process(
                    arguments: arguments,
                    environment: environment
                )
            }
        } catch {
            e2e = nil
            if let launchEnvelope {
                NumaSharedE2EDiagnosticArtifact.recordFailure(
                    envelope: launchEnvelope,
                    stage: .configuration,
                    code: .configurationUnavailable
                )
            }
        }
        if arguments.contains("--qa-home") {
            screen = .home
            ephemeralQA = true
        }
        if arguments.contains("--qa-onboarding") {
            screen = .welcome
            ephemeralQA = true
        }
        if sharedTableReferenceQA {
            screen = .home
            ephemeralQA = true
        }
        if arguments.contains("--qa-seeded-home") {
            screen = .home
            seedCasaMar = true
            ephemeralQA = true
        }
        if arguments.contains("--qa-add-sheet") {
            screen = .home
            seedCasaMar = true
            ephemeralQA = true
        }
        if arguments.contains("--qa-contested-record") {
            screen = .home
            seedCasaMar = true
            ephemeralQA = true
            contestedCasaMarQA = true
        }
        if arguments.contains("--qa-account-deletion") {
            qaAccountDeletionPreview = NumaAccountDeletionPreview(pots: [
                .init(
                    potID: "01890f5e-7b00-7000-8000-000000000001",
                    name: "Casa Mar",
                    outcome: .anonymized,
                    successorName: "Maya"
                ),
            ])
        }
        if arguments.contains("--qa-forced-update") {
            minimumSupportedBuild = Int.max
        }
        if ephemeralQA && e2e == nil {
            // Named reference fixtures belong only to explicit in-memory QA.
            potName = "Casa Mar"
            ownerDisplayName = "Arseny"
        }
        if let e2e {
            screen = .home
            ephemeralQA = false
            repository = AppLedgerRepository(
                storageMode: .persistent,
                identities: e2e.identities,
                databaseName: e2e.databaseName
            , readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
        } else {
            repository = AppLedgerRepository(
                storageMode: ephemeralQA ? .inMemory : .persistent
            , readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
        }
        if arguments.contains("--qa-issued-invite"),
           let inviteID = UUID(
            uuidString: "018bcfe5-6800-7000-8000-000000000099"
           ),
           let url = URL(string:
            "https://steady-otter-123.convex.site/join/qa_invite_token_0123456789abcdef0123456789abcdef?code=SAM234"
           ) {
            issuedInvite = ShareableInvite(
                id: inviteID,
                kind: .potLink,
                pendingMemberID: nil,
                url: url,
                code: "SAM234",
                expiresAtMillis: 1_900_000_000_000
            )
        }
        usesEphemeralQAStore = ephemeralQA
        e2eConfiguration = e2e
        e2eEnvelope = launchEnvelope
        if e2e != nil, let launchEnvelope {
            NumaSharedE2EDiagnosticArtifact.recordProgress(
                envelope: launchEnvelope,
                stage: .repositoryBootstrap
            )
        }
#else
        let seedCasaMar = false
        let keepLoadingSkeleton = false
        repository = AppLedgerRepository(storageMode: .persistent, readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
#endif

#if DEBUG
        let potRegistryEligible = e2e == nil
#else
        let potRegistryEligible = true
#endif
        if potRegistryEligible {
#if DEBUG
            configureLocalPotRegistry(persistent: !usesEphemeralQAStore)
#else
            configureLocalPotRegistry(persistent: true)
#endif
        }

        restoreAccountDeletionRecovery()

        installInviteServiceIfAvailable()

        let repository = repository
        Task { [weak self] in
            do {
#if DEBUG
                if self?.qaBootstrapFailuresRemaining ?? 0 > 0 {
                    self?.qaBootstrapFailuresRemaining -= 1
                    throw CocoaError(.fileReadUnknown)
                }
#endif
                guard self?.hasBlockingLocalDataFailure != true else {
                    self?.isBootstrapping = false
#if DEBUG
                    self?.markQALaunchReady()
#endif
                    return
                }
                var snapshot = try await repository.bootstrap(seedCasaMar: seedCasaMar)
#if DEBUG
                if sharedTableReferenceQA {
                    snapshot = try await repository.loadSharedTableReferenceFixture(longNames: arguments.contains("--qa-long-household-names"))
                }
                if contestedCasaMarQA {
                    snapshot = try await repository.loadContestedCasaMarSeed()
                }
#endif
                self?.apply(snapshot, animated: false)
                if !keepLoadingSkeleton,
                   self?.accountDeletionRequestID == nil {
                    self?.isBootstrapping = false
#if DEBUG
                    self?.markQALaunchReady()
                    if self?.qaOpensAddSheetOnLaunch == true {
                        self?.beginAdd()
                    }
                    if self?.qaShowsLocalDataError == true {
                        self?.presentLocalDataFailure(blocking: false)
                    }
#endif
                }
                await self?.configureSync()
            } catch {
#if DEBUG
                self?.recordE2EFailure(
                    stage: .repositoryBootstrap,
                    code: .repositoryBootstrapFailed
                )
#endif
                self?.isBootstrapping = false
#if DEBUG
                self?.markQALaunchReady()
#endif
                self?.presentLocalDataFailure(blocking: true)
            }
        }
    }

    init(
        repository: AppLedgerRepository,
        snapshot: AppLedgerSnapshot,
        pushNotificationSystem: any PushNotificationSystem =
            SystemPushNotificationSystem(),
        privacyPreferences: DevicePrivacyPreferences = DevicePrivacyPreferences(),
        accountDeletionRecoveryStore: AccountDeletionRecoveryStore =
            AccountDeletionRecoveryStore()
    ) {
#if DEBUG
        qaHidesStatusBar = false
        qaHidesDebugControls = false
        qaEightUnitField = false
        qaTenUnitField = false
        qaOpensAddSheetOnLaunch = false
        qaStillMotion = false
        usesEphemeralQAStore = false
        isIsolatedReferenceQA = false
        e2eConfiguration = nil
        e2eEnvelope = nil
#endif
        self.repository = repository
        self.pushNotificationSystem = pushNotificationSystem
        self.privacyPreferences = privacyPreferences
        self.accountDeletionRecoveryStore = accountDeletionRecoveryStore
        hideAmounts = privacyPreferences.hideAmounts
        isBootstrapping = false
        restoreAccountDeletionRecovery()
        if accountDeletionRequestID != nil { isBootstrapping = true }
        apply(snapshot, animated: false)
    }

#if DEBUG
    private func markQALaunchReady() {
        guard qaLaunchReadyMilliseconds == nil else { return }
        qaLaunchReadyMilliseconds = max(
            0,
            Int((ProcessInfo.processInfo.systemUptime - qaLaunchStartedUptime) * 1_000)
        )
    }
#endif

    // MARK: - Derived ledger state

    var liveRecords: [ExpenseRecord] { records.filter { !$0.voided } }
    var accountedRecords: [ExpenseRecord] {
        liveRecords.filter { $0.deliveryState != .failed }
    }
    var isEmpty: Bool { accountedRecords.isEmpty }
    var isAllEven: Bool {
        !isEmpty && ledgerUnitIDs.allSatisfy { balances[$0] == 0 }
    }
    var requiresUpdate: Bool {
        if requiresAppUpdate { return true }
        if let minimumReaderSchemaVersion,
           minimumReaderSchemaVersion > readerSchemaVersion {
            return true
        }
        if case .readOnly = reductionAccess { return true }
        return false
    }

    var requiresAppUpdate: Bool {
        Self.shouldForceUpdate(
            minimumSupportedBuild: minimumSupportedBuild,
            currentBuild: Self.currentBuildNumber()
        )
    }

    nonisolated static func shouldForceUpdate(
        minimumSupportedBuild: Int?,
        currentBuild: Int
    ) -> Bool {
        guard let minimumSupportedBuild,
              minimumSupportedBuild > 0,
              currentBuild > 0
        else { return false }
        return currentBuild < minimumSupportedBuild
    }

    nonisolated static func currentBuildNumber(_ bundle: Bundle = .main) -> Int {
        guard let value = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              let build = Int(value),
              build > 0
        else { return 0 }
        return build
    }

    var currentMemberProfile: AppMemberProfile? {
        guard let currentMemberID else { return nil }
        return memberProfiles.first { $0.memberID == currentMemberID }
    }

    var currentUnitID: UnitID {
        currentMemberProfile?.budgetUnitID ?? currentMemberProfile?.unitID ?? .am
    }

    var isCurrentMemberOwner: Bool {
        currentMemberProfile?.role == .owner
    }

    var canLeaveCurrentPot: Bool {
        guard isSyncEnabled, currentMemberProfile?.state == .active else { return false }
        return !isCurrentMemberOwner || hasMultipleActiveMembers
    }

    var leavePotWarning: String {
        let balance = balances[currentUnitID] ?? 0
        if balance == 0 {
            return isCurrentMemberOwner
                ? String(localized: "Ownership passes automatically to the longest-standing active member. Your history stays frozen on this iPhone.")
                : String(localized: "Your history stays frozen and exportable on this iPhone after you leave.")
        }
        return localizedFormat(
            "Your current balance is %@. Leaving does not settle it. Your history stays frozen and exportable on this iPhone.",
            fmt(balance, forceCents: true)
        )
    }

    var currentPayerDescription: String {
        unitInfo(for: currentUnitID).isWoven
            ? String(localized: "your household")
            : String(localized: "you")
    }

    var isRecordMutationInFlight: Bool { isPersisting }

    func unitInfo(for id: UnitID) -> UnitInfo {
        if id == .more {
            let count = fieldOverflowUnitIDs.count
            return UnitInfo(
                id: id,
                name: String(localized: "More"),
                initials: "+\(count)",
                isWoven: false,
                weight: Int64(max(1, count)),
                isYou: false,
                color: Pal.purple,
                inkColor: Pal.purpleInk
            )
        }
        let base = AllUnits[id]
        let matchingProfiles = memberProfiles.filter { ($0.budgetUnitID ?? $0.unitID) == id }
        if usesBudgetGroups {
            let name = matchingProfiles.map(personName).joined(separator: " + ")
            // Registry order, not debt direction or a random UUID hash, owns
            // group color. Retired group identities keep their original slot.
            let registeredGroups = Set(budgetGroupStructure?.groupUnitIDsByGroupID.values.map { $0 } ?? [])
            let orderedGroups = budgetGroupStructure?.knownUnitIDs.filter(registeredGroups.contains) ?? []
            let index = id.remoteCoreUnitID.flatMap(orderedGroups.firstIndex(of:))
                ?? UnitID.allCases.firstIndex(of: id)
                ?? id.rawValue.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % 3 }
            let colors: [(Color, Color)] = [(Pal.teal, Pal.tealInk), (Pal.purple, Pal.purpleInk), (Pal.amber, Pal.amberInk)]
            return UnitInfo(id: id, name: name.isEmpty ? "Former group" : name,

                initials: initials(for: name), isWoven: matchingProfiles.count > 1, weight: 1,
                isYou: id == currentUnitID, color: colors[index % colors.count].0, inkColor: colors[index % colors.count].1)
        }
        let projectedNames = matchingProfiles.compactMap(\.displayName)
        let projectedName = projectedNames.isEmpty
            ? nil
            : projectedNames.joined(separator: " + ")
        let localName: String
        if id == .am { localName = ownerDisplayName }
        else if id == .sam {
            localName = samDisplayName.isEmpty ? base?.name ?? "" : samDisplayName
        } else if id == .leo {
            localName = leoDisplayName.isEmpty ? base?.name ?? "" : leoDisplayName
        }
        else { localName = base?.name ?? "" }
        // A member profile can label its one-person unit, but it must never
        // replace the distinct identity of a settlement group.
        let name = base?.isWoven == true
            ? base?.name ?? String(localized: "Shared group")
            : projectedName
                ?? (localName.isEmpty ? String(localized: "Unknown member") : localName)
        let paletteIndex = id.rawValue.unicodeScalars.reduce(0) {
            ($0 + Int($1.value)) % 3
        }
        let identityColors: [(Color, Color)] = [
            (Pal.teal, Pal.tealInk),
            (Pal.amber, Pal.amberInk),
            (Pal.purple, Pal.purpleInk),
        ]
        let colors = identityColors[paletteIndex]
        return UnitInfo(
            id: id,
            name: name,
            initials: initials(for: name),
            isWoven: base?.isWoven == true || matchingProfiles.count > 1,
            weight: base?.weight ?? Int64(max(1, matchingProfiles.count)),
            isYou: id == currentUnitID,
            color: base?.color ?? colors.0,
            inkColor: base?.inkColor ?? colors.1
        )
    }

    var unitInfos: [UnitID: UnitInfo] {
        var seen = Set<UnitID>()
        let units = (ledgerUnitIDs + fieldUnitIDs).filter {
            seen.insert($0).inserted
        }
        return Dictionary(uniqueKeysWithValues: units.map {
            ($0, unitInfo(for: $0))
        })
    }

    var fieldUnitIDs: [UnitID] {
#if DEBUG
        if qaEightUnitField { return UnitID.eightUnitPerformanceCases }
#endif
        return fieldPresentation.visibleUnitIDs
    }

    var fieldOverflowUnitIDs: [UnitID] {
        fieldPresentation.overflowUnitIDs
    }

    var fieldBalances: [UnitID: Int64] {
        guard !fieldOverflowUnitIDs.isEmpty else { return balances }
        var presented = balances
        // Overflow is a navigation cluster, never a financial counterparty.
        presented[.more] = 0
        return presented
    }

    var ledgerUnitIDs: [UnitID] {
#if DEBUG
        if qaEightUnitField { return UnitID.eightUnitPerformanceCases }
        if qaTenUnitField { return UnitID.tenUnitPerformanceCases }
#endif
        var seen = Set<UnitID>()
        var result = (usesBudgetGroups ? activeBudgetUnitIDs : memberProfiles.compactMap { $0.budgetUnitID ?? $0.unitID }).filter {
            seen.insert($0).inserted
        }
        for unit in balances.keys.sorted(by: { $0.rawValue < $1.rawValue })
            where unit != .more
                && (balances[unit] != 0 || memberProfiles.isEmpty)
                && seen.insert(unit).inserted {
            result.append(unit)
        }
        return result.isEmpty ? UnitID.allCases : result
    }

    private var fieldPresentation: FieldUnitPresentation {
        FieldUnitPresentation.make(
            units: ledgerUnitIDs,
            balances: balances,
            pinnedUnitID: currentUnitID
        )
    }

    func recordSubtitle(_ record: ExpenseRecord) -> String {
        record.subtitle { unitInfo(for: $0).name }
    }

    func initials(for name: String) -> String {
        let words = name.components(
            separatedBy: CharacterSet.alphanumerics.inverted
        ).filter { !$0.isEmpty }
        let value = words.prefix(2).compactMap { word in
            word.first.map { String($0).uppercased() }
        }.joined(separator: "·")
        return value.isEmpty ? "?" : value
    }
    var canWrite: Bool {
        !requiresUpdate
            && !isArchived
            && !isCurrentMemberArchived
            && syncPresentation.pauseDisposition == nil
            && localDataErrorMessage == nil
    }
    var hasBlockingLocalDataFailure: Bool {
        localDataFailureBlocksApp && localDataErrorMessage != nil
    }
    var syncPresentation: SyncPresentation {
        if case .synced = runtimeSyncPresentation,
           pendingDeliveryEventCount > 0 {
            return .syncing(pendingCount: pendingDeliveryEventCount)
        }
        return runtimeSyncPresentation
    }
    var isSyncEnabled: Bool { syncPresentation.isSyncEnabled }
    var homePresentationDate: Date {
#if DEBUG
        if isIsolatedReferenceQA { return Date(timeIntervalSince1970: 1_789_200_000) }
#endif
        return Date()
    }
    var canSignOut: Bool {
        signOutCleanupPending || syncRuntime?.diagnosticState().accountID != nil
    }
    var canDeleteAccount: Bool {
        if accountDeletionServerComplete { return true }
#if DEBUG
        if qaAccountDeletionPreview != nil { return true }
#endif
        return syncRuntime?.diagnosticState().accountID != nil
    }
    var activityHistoryCopy: String {
        Self.activityHistoryCopy(
            for: syncPresentation,
            hasPendingDeliveryEvents: pendingDeliveryEventCount > 0,
            hasUnsyncedEvents: unsyncedEventCount > 0
        )
    }

    nonisolated static func activityHistoryCopy(
        for presentation: SyncPresentation,
        hasPendingDeliveryEvents: Bool = false,
        hasUnsyncedEvents: Bool = false
    ) -> String {
        switch presentation {
        case .local:
            String(localized: "On this iPhone until you enable sync.")
        case .signingIn, .offline, .syncing:
            String(localized: "Waiting records stay on this iPhone.")
        case .synced where hasPendingDeliveryEvents:
            String(localized: "Waiting records stay on this iPhone.")
        case .synced where hasUnsyncedEvents:
            String(localized: "Some records are only on this iPhone.")
        case .synced:
            String(localized: "Synced with everyone in this pot.")
        case .paused:
            String(localized: "Available on this iPhone.")
        }
    }

    func fmt(_ cents: Int64, forceCents: Bool = false) -> String {
        money(
            decimalMinorUnits: Decimal(cents),
            currency: potCurrency,
            fractionDigits: forceCents ? potCurrency.exponent : nil,
            hidden: hideAmounts
        )
    }

    func fmtMagnitude(_ minorUnits: Int64, forceCents: Bool = false) -> String {
        let magnitude = Decimal(minorUnits.magnitude)
        return money(
            decimalMinorUnits: magnitude,
            currency: potCurrency,
            fractionDigits: forceCents ? potCurrency.exponent : nil,
            hidden: hideAmounts
        )
    }

    var hiddenAmountPlaceholder: String {
        MoneyFormatter.hiddenString(currency: potCurrency)
    }

    var amountEntryHint: String {
        if potCurrency.exponent == 0 {
            return localizedFormat("%@ — whole units only.", potCurrency.code)
        }
        return localizedFormat(
            "%1$@ — up to %2$lld decimal places.",
            potCurrency.code,
            Int64(potCurrency.exponent)
        )
    }

    func setHideAmounts(_ hidden: Bool) {
        guard hideAmounts != hidden else { return }
        privacyPreferences.setHideAmounts(hidden)
        hideAmounts = hidden
    }

    private func apply(_ snapshot: AppLedgerSnapshot, animated: Bool = true) {
        guard snapshot.revision >= appliedRevision else { return }
        let invalidatesPreparedExport = snapshot.revision > appliedRevision
        appliedRevision = snapshot.revision
        if invalidatesPreparedExport, csvExportURL != nil {
            discardPreparedCSVExport()
        }
        let update = {
            self.records = snapshot.records
            self.balances = snapshot.balances
            self.spend = snapshot.spend
            self.plan = snapshot.plan
            self.pendingDeliveryEventCount = snapshot.pendingDeliveryEventCount
            self.unsyncedEventCount = snapshot.unsyncedEventCount
            self.isArchived = snapshot.isArchived
            self.isCurrentMemberArchived = snapshot.isCurrentMemberArchived
            self.reductionAccess = snapshot.reductionAccess
            self.minimumReaderSchemaVersion = snapshot.minimumReaderSchemaVersion
            self.readerSchemaVersion = snapshot.readerSchemaVersion
            self.budgetGroupStructure = snapshot.structure
            self.activeBudgetUnitIDs = snapshot.activeBudgetUnitIDs
            self.memberProfiles = snapshot.memberProfiles
            self.currentMemberID = snapshot.currentMemberID
            if !self.addPresented {
                self.expensePayer = snapshot.memberProfiles.first(where: {
                    $0.memberID == snapshot.currentMemberID
                })?.unitID ?? .am
            }
            if snapshot.potSetup.isComplete || !snapshot.records.isEmpty {
                self.potCurrency = snapshot.currency
                self.isPotCurrencyConfirmed = true
            }
            if snapshot.potSetup.isComplete {
                self.potName = snapshot.potSetup.potName
                self.ownerDisplayName = snapshot.memberProfiles.first(where: {
                    $0.role == .owner
                })?.displayName ?? snapshot.potSetup.displayNames[.am] ?? ""
                self.samDisplayName = snapshot.potSetup.displayNames[.sam] ?? ""
                self.leoDisplayName = snapshot.potSetup.displayNames[.leo] ?? ""
                self.screen = .home
            }
        }
        if animated {
            withAnimation(reduceMotion ? .easeInOut(duration: 0.22)
                                       : .spring(response: 0.4, dampingFraction: 1.0)) {
                update()
            }
        } else {
            update()
        }
        refreshActivePotDescriptor()
    }

    func retryLocalData() {
        guard localDataErrorMessage != nil, !isRecoveringLocalData else { return }
        isRecoveringLocalData = true
        let wasBlocking = localDataFailureBlocksApp
        Task { [weak self] in
            guard let self else { return }
            do {
                if registryPersists && localPots.isEmpty {
                    try loadPersistentPotRegistry()
                } else if registryPersists, let activePotID {
                    try PotRegistry.save(.init(
                        pots: localPots,
                        activeID: activePotID
                    ))
                }
                let target = repository
                let snapshot = try await target.bootstrap(seedCasaMar: false)
                guard repository === target else {
                    isRecoveringLocalData = false
                    return
                }
                if wasBlocking { appliedRevision = -1 }
                apply(snapshot, animated: false)
                localDataErrorMessage = nil
                localDataFailureBlocksApp = false
                isRecoveringLocalData = false
                isBootstrapping = false
                await configureSync()
            } catch {
                localDataErrorMessage = wasBlocking
                    ? String(localized: "Your records haven’t been changed. Retry to load the verified copy on this iPhone.")
                    : String(localized: "That change couldn’t be verified. Reload this pot.")
                localDataFailureBlocksApp = wasBlocking
                isRecoveringLocalData = false
                Haptics.warned()
            }
        }
    }

    private func presentLocalDataFailure(
        blocking: Bool,
        error _: Error? = nil
    ) {
        localDataErrorMessage = blocking
            ? String(localized: "Your records haven’t been changed. Retry to load the verified copy on this iPhone.")
            : String(localized: "That change couldn’t be verified. Reload this pot.")
        localDataFailureBlocksApp = blocking
        addPresented = false
        sheet = .none
        isPersisting = false
        Haptics.warned()
    }

    private func persistenceFailed(_ error: Error? = nil) {
        var needsRecovery = true
        if let repositoryError = error as? AppLedgerRepositoryError {
            switch repositoryError {
            case let .readOnlyReduction(issue):
                reductionAccess = .readOnly(issue)
                needsRecovery = false
            case .archivedPot:
                isArchived = true
                needsRecovery = false
            default:
                break
            }
        }
        if needsRecovery {
            presentLocalDataFailure(blocking: false, error: error)
        } else {
            isPersisting = false
            Haptics.warned()
        }
    }

    // MARK: - Sync and Sign in with Apple

    func beginSyncSetup() {
        syncErrorMessage = nil
        syncSetupPresented = true
    }

    func dismissSyncSetup() {
        syncSetupPresented = false
        cancelPendingInviteCheckpoint()
    }

    func syncSetupDidDismiss() {
        guard !syncSetupPresented else { return }
        cancelPendingInviteCheckpoint()
    }

    // MARK: - Push notifications

    func enableNotifications() {
        guard !isUpdatingNotifications else { return }
        Task { [weak self] in
            await self?.requestPushAuthorization(afterAcceptedMembership: false)
        }
    }

    func setPotMuted(_ muted: Bool) {
        guard let syncRuntime,
              syncRuntime.diagnosticState().accountID != nil,
              !isUpdatingNotifications
        else { return }
        isUpdatingNotifications = true
        notificationErrorMessage = nil
        Task { [weak self] in
            do {
                let confirmed = try await syncRuntime.setPotMute(muted)
                guard let self else { return }
                isPotMuted = confirmed
                isUpdatingNotifications = false
                Haptics.saved()
            } catch {
                guard let self else { return }
                isUpdatingNotifications = false
                notificationErrorMessage = String(
                    localized: "Notification settings couldn’t be saved. Try again."
                )
                Haptics.warned()
            }
        }
    }

    func receivePushDeviceToken(_ token: APNsDeviceToken) {
        receivedPushToken = token
        Task { [weak self] in
            await self?.registerReceivedPushTokenIfPossible()
        }
    }

    func receivePushNotificationRoute(_ route: PushNotificationRoute) {
        pendingNotificationPotID = route.potID
        Task { [weak self] in
            await self?.openPendingNotificationPotIfPossible()
        }
    }

    func receivePushRegistrationFailure() {
        didRequestRemoteNotificationRegistration = false
        notificationErrorMessage = String(
            localized: "This iPhone couldn’t register for notifications. It will retry after sync."
        )
    }

    private func schedulePushNotificationReconciliation() {
        Task { [weak self] in
            await self?.reconcilePushNotifications()
            await self?.openPendingNotificationPotIfPossible()
        }
    }

    private func reconcilePushNotifications() async {
        guard !isReconcilingPushNotifications,
              let syncRuntime,
              syncRuntime.diagnosticState().accountID != nil
        else { return }
        isReconcilingPushNotifications = true
        defer { isReconcilingPushNotifications = false }
        let status = await pushNotificationSystem.authorizationStatus()
        pushNotificationPermission = status
        guard status == .authorized else { return }
        requestRemoteNotificationRegistrationIfNeeded()
        await registerReceivedPushTokenIfPossible()
    }

    private func requestPushAuthorization(
        afterAcceptedMembership: Bool
    ) async {
        guard let syncRuntime,
              syncRuntime.diagnosticState().accountID != nil,
              !isUpdatingNotifications,
              !afterAcceptedMembership || hasMultipleActiveMembers
        else { return }
        isUpdatingNotifications = true
        notificationErrorMessage = nil
        defer { isUpdatingNotifications = false }
        let current = await pushNotificationSystem.authorizationStatus()
        pushNotificationPermission = current
        switch current {
        case .authorized:
            requestRemoteNotificationRegistrationIfNeeded()
            await registerReceivedPushTokenIfPossible()
        case .denied:
            return
        case .notDetermined:
            do {
                let granted = try await pushNotificationSystem.requestAuthorization()
                pushNotificationPermission = granted ? .authorized : .denied
                guard granted else { return }
                requestRemoteNotificationRegistrationIfNeeded()
                await registerReceivedPushTokenIfPossible()
            } catch {
                notificationErrorMessage = String(
                    localized: "Notifications couldn’t be enabled. Try again."
                )
                Haptics.warned()
            }
        }
    }

    private var hasMultipleActiveMembers: Bool {
        memberProfiles.lazy.filter { $0.state == .active }.count > 1
    }

    private func requestRemoteNotificationRegistrationIfNeeded() {
        guard !didRequestRemoteNotificationRegistration else { return }
        didRequestRemoteNotificationRegistration = true
        pushNotificationSystem.registerForRemoteNotifications()
    }

    private func registerReceivedPushTokenIfPossible() async {
        guard pushNotificationPermission == .authorized,
              let syncRuntime,
              syncRuntime.diagnosticState().accountID != nil,
              let receivedPushToken,
              let timeZone = (try? IANATimeZone(TimeZone.current.identifier))
                ?? (try? IANATimeZone("UTC"))
        else { return }
#if DEBUG
        let environment = PushNotificationEnvironment.sandbox
#else
        let environment = PushNotificationEnvironment.production
#endif
        do {
            try await syncRuntime.registerPushToken(PushTokenRegistration(
                token: receivedPushToken,
                environment: environment,
                timeZone: timeZone
            ))
            notificationErrorMessage = nil
        } catch {
            notificationErrorMessage = String(
                localized: "This iPhone couldn’t register for notifications. It will retry after sync."
            )
        }
    }

    private func openPendingNotificationPotIfPossible() async {
        guard !isOpeningNotificationPot,
              let syncRuntime,
              syncRuntime.diagnosticState().accountID != nil,
              let potID = pendingNotificationPotID
        else { return }
        pendingNotificationPotID = nil
        isOpeningNotificationPot = true
        defer { isOpeningNotificationPot = false }
        do {
            let snapshot = try await syncRuntime.openNotificationPot(potID)
            apply(snapshot, animated: false)
            peoplePresented = false
            joinPresented = false
            screen = .home
            isPotMuted = (try? await syncRuntime.getPotMute()) ?? false
        } catch let error as SyncTransportError {
            if case .retryable = error {
                pendingNotificationPotID = potID
            }
        } catch {
            return
        }
    }

    // MARK: - Settings

    func openSettings() {
        settingsPresented = true
        refreshSettingsNotificationState()
    }

    func dismissSettings() {
        settingsPresented = false
    }

    func openPeopleFromSettings() {
        settingsPresented = false
        Task { [weak self] in
            await Task.yield()
            self?.openPeopleManagement()
        }
    }

    func refreshSettingsNotificationState() {
        guard let syncRuntime,
              isSyncEnabled,
              !isUpdatingNotifications
        else { return }
        isUpdatingNotifications = true
        notificationErrorMessage = nil
        Task { [weak self] in
            do {
                let muted = try await syncRuntime.getPotMute()
                guard let self else { return }
                isPotMuted = muted
                isUpdatingNotifications = false
            } catch {
                self?.isUpdatingNotifications = false
                self?.notificationErrorMessage = String(
                    localized: "Notification settings couldn’t be loaded. Try again."
                )
            }
        }
    }

    func prepareCSVExport(onPrepared: (@MainActor (URL, Bool) -> Void)? = nil) {
        let repository = repository
        let runtime = syncRuntime
        let archived = isCurrentMemberArchived
        let potName = potName
        prepareCSVExport(
            privacyRefresh: { try await runtime?.refreshPrivacyBeforeExport() ?? !archived },
            writer: { directory in
                try await repository.writeCSVExport(potName: potName, temporaryDirectory: directory)
            },
            onPrepared: onPrepared
        )
    }

    @discardableResult
    private func prepareCSVExport(
        privacyRefresh: @escaping @MainActor () async throws -> Bool,
        writer: @escaping @MainActor (URL) async throws -> LedgerCSVFile,
        onPrepared: (@MainActor (URL, Bool) -> Void)? = nil
    ) -> Task<Void, Never>? {
        guard !isPreparingCSVExport, !isSigningOut, !isDeletingAccount,
              !signOutCleanupPending, !accountDeletionServerComplete else { return nil }
        let requestID = UUID()
        let repository = repository
        let runtime = syncRuntime
        let accountID = runtime?.diagnosticState().accountID
        let potID = activePotID
        // Each in-flight export owns its output. A stale completion can remove
        // only its files, even if another pot uses the same export filename.
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedExports", isDirectory: true)
            .appendingPathComponent(requestID.uuidString, isDirectory: true)
        csvExportRequestID = requestID
        isPreparingCSVExport = true
        // A refresh can apply deletions before a later page or file write fails.
        // Retire the previous shareable file before starting that work.
        discardPreparedCSVExport()
        let task = Task { [weak self] in
            var published = false
            var exportRevision: Int64?
            defer {
                if !published { try? FileManager.default.removeItem(at: directory) }
                if self?.csvExportRequestID == requestID {
                    self?.csvExportRequestID = nil
                    self?.csvExportTask = nil
                    self?.isPreparingCSVExport = false
                }
            }
            do {
                let privacyIsCurrent = try await privacyRefresh()
                guard let self, self.isCurrentCSVExport(requestID, repository: repository,
                    runtime: runtime, accountID: accountID, potID: potID) else { return }
                // Privacy preflight may itself publish a newer redacted snapshot.
                // Fence the file against changes arriving after that refresh.
                exportRevision = appliedRevision
                let file = try await writer(directory)
                guard isCurrentCSVExport(requestID, repository: repository,
                    runtime: runtime, accountID: accountID, potID: potID) else { return }
                guard appliedRevision == exportRevision else {
                    csvExportErrorMessage = String(localized: "History changed while preparing this file. Prepare the export again.")
                    return
                }
                discardPreparedCSVExport()
                csvExportURL = file.url
                csvExportDirectory = directory
                csvExportRowCount = file.rowCount
                csvExportPrivacyWarning = privacyIsCurrent ? nil : String(localized:
                    "Latest deletions couldn’t be checked. This export uses this iPhone’s saved history. Refresh when you’re online.")
                published = true
                Haptics.saved()
                onPrepared?(file.url, privacyIsCurrent)
            } catch {
                guard let self, self.isCurrentCSVExport(requestID, repository: repository,
                    runtime: runtime, accountID: accountID, potID: potID) else { return }
                csvExportErrorMessage = exportRevision != nil && appliedRevision != exportRevision
                    ? String(localized: "History changed while preparing this file. Prepare the export again.")
                    : String(localized: "The CSV export couldn’t be prepared. Try again.")
                Haptics.warned()
            }
        }
        csvExportTask = task
        return task
    }

    private func isCurrentCSVExport(
        _ requestID: UUID,
        repository: AppLedgerRepository,
        runtime: AppSyncRuntime?,
        accountID: String?,
        potID: UUID?
    ) -> Bool {
        csvExportRequestID == requestID && self.repository === repository
            && syncRuntime === runtime && runtime?.diagnosticState().accountID == accountID
            && activePotID == potID && !isSigningOut && !isDeletingAccount
            && !signOutCleanupPending && !accountDeletionServerComplete && !Task.isCancelled
    }

    private func discardPreparedCSVExport() {
        if let csvExportDirectory { try? FileManager.default.removeItem(at: csvExportDirectory) }
        else if let csvExportURL { try? FileManager.default.removeItem(at: csvExportURL) }
        csvExportDirectory = nil
        csvExportURL = nil
        csvExportRowCount = nil
        csvExportErrorMessage = nil
        csvExportPrivacyWarning = nil
    }

    private func invalidateCSVExport() {
        csvExportRequestID = nil
        csvExportTask?.cancel()
        csvExportTask = nil
        isPreparingCSVExport = false
        discardPreparedCSVExport()
    }

    func requestSignOut() {
        guard canSignOut, !isSigningOut else { return }
        signOutErrorMessage = nil
        signOutConfirmationPresented = true
    }

    var signOutConfirmationMessage: String {
        Self.signOutConfirmationMessage(unsyncedCount: unsyncedEventCount)
    }

    nonisolated static func signOutConfirmationMessage(
        unsyncedCount: Int
    ) -> String {
        if unsyncedCount == 1 {
            return String(
                localized: "1 record hasn’t synced and will be lost from this iPhone."
            )
        }
        if unsyncedCount > 1 {
            return String(
                format: String(
                    localized: "%lld records haven’t synced and will be lost from this iPhone."
                ),
                locale: .current,
                Int64(unsyncedCount)
            )
        }
        return String(
            localized: "Synced records stay in the shared pot. This iPhone’s local cache will be cleared."
        )
    }

    func syncBeforeSignOut() {
        signOutConfirmationPresented = false
        retrySync()
    }

    func confirmSignOut() {
        guard !isSigningOut else { return }
        let cleanupWasPending = signOutCleanupPending
        guard cleanupWasPending || syncRuntime != nil else { return }
        signOutConfirmationPresented = false
        isSigningOut = true
        invalidateCSVExport()
        signOutErrorMessage = nil
        let runtime = syncRuntime
        let token = receivedPushToken
        let temporaryDirectory = FileManager.default.temporaryDirectory
        Task { [weak self] in
            guard let self else { return }
            if !cleanupWasPending {
                guard let runtime else {
                    isSigningOut = false
                    return
                }
                do {
                    try await runtime.signOut(unregistering: token)
                    signOutCleanupPending = true
                    retireSyncRuntime()
                } catch {
                    isSigningOut = false
                    signOutErrorMessage = String(
                        localized: "Sign out couldn’t finish. Try again."
                    )
                    Haptics.warned()
                    return
                }
            }
            do {
                let snapshot = try await eraseAllLocalAccountState(
                    temporaryDirectory: temporaryDirectory
                )
                isSigningOut = false
                signOutCleanupPending = false
                await finishLocalAccountRemoval(snapshot)
            } catch {
                isSigningOut = false
                signOutErrorMessage = String(
                    localized: "This iPhone’s local data couldn’t be cleared. Try signing out again."
                )
                Haptics.warned()
            }
        }
    }

    private func restoreAccountDeletionRecovery() {
#if DEBUG
        // Ephemeral QA never reads real recovery, credentials or network configuration.
        // Explicit isolated E2E uses its own persistent store and configuration.
        guard !usesEphemeralQAStore else { return }
#endif
        do {
            guard let recovery = try accountDeletionRecoveryStore.load() else {
                return
            }
            accountDeletionRequestID = recovery.requestID
            accountDeletionOriginatingTimeZone = try IANATimeZone(
                recovery.originatingTimeZone
            )
            accountDeletionServerComplete = recovery.serverComplete
        } catch {
            presentLocalDataFailure(blocking: true, error: error)
        }
    }

    func requestAccountDeletion() {
        guard canDeleteAccount, !isLoadingAccountDeletion, !isDeletingAccount else {
            return
        }
        accountDeletionErrorMessage = nil
        if accountDeletionServerComplete {
            accountDeletionPreviewMessage = String(
                localized: "Your account was deleted. Clear this iPhone’s remaining local data to finish."
            )
            accountDeletionConfirmationPresented = true
            return
        }
#if DEBUG
        if let preview = qaAccountDeletionPreview {
            accountDeletionRequestID = accountDeletionRequestID ?? UUIDv7.generate()
            accountDeletionPreviewMessage = Self.accountDeletionMessage(
                preview: preview,
                unsyncedCount: unsyncedEventCount
            )
            accountDeletionConfirmationPresented = true
            return
        }
#endif
        guard let runtime = syncRuntime else { return }
        isLoadingAccountDeletion = true
        Task { [weak self] in
            do {
                let preview = try await runtime.accountDeletionPreview()
                guard let self else { return }
                accountDeletionRequestID = accountDeletionRequestID
                    ?? UUIDv7.generate()
                accountDeletionPreviewMessage = Self.accountDeletionMessage(
                    preview: preview,
                    unsyncedCount: unsyncedEventCount
                )
                isLoadingAccountDeletion = false
                accountDeletionConfirmationPresented = true
            } catch {
                self?.isLoadingAccountDeletion = false
                self?.accountDeletionErrorMessage = String(
                    localized: "Deletion details couldn’t be loaded. Try again."
                )
                Haptics.warned()
            }
        }
    }

    nonisolated static func accountDeletionMessage(
        preview: NumaAccountDeletionPreview,
        unsyncedCount: Int
    ) -> String {
        var paragraphs = [String(
            localized: "Your sign-in identifiers, relay email, push tokens, and authored text will be deleted. Shared arithmetic stays visible to other members under “Former member.”"
        )]
        for pot in preview.pots {
            let name = pot.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            let shownName = name.flatMap { $0.isEmpty ? nil : $0 }
                ?? String(localized: "Shared pot")
            switch pot.outcome {
            case .deleted:
                paragraphs.append(String(
                    format: String(
                        localized: "“%@” will be deleted because no other active member remains."
                    ),
                    locale: .current,
                    shownName
                ))
            case .anonymized:
                if let successor = pot.successorName, !successor.isEmpty {
                    paragraphs.append(String(
                        format: String(localized: "Ownership of “%@” will transfer to %@."),
                        locale: .current,
                        shownName,
                        successor
                    ))
                } else {
                    paragraphs.append(String(
                        format: String(localized: "“%@” will stay available to its other members."),
                        locale: .current,
                        shownName
                    ))
                }
            }
        }
        if unsyncedCount == 1 {
            paragraphs.append(String(
                localized: "1 unsynced record on this iPhone will be deleted."
            ))
        } else if unsyncedCount > 1 {
            paragraphs.append(String(
                format: String(
                    localized: "%lld unsynced records on this iPhone will be deleted."
                ),
                locale: .current,
                Int64(unsyncedCount)
            ))
        }
        return paragraphs.joined(separator: "\n\n")
    }

    func confirmAccountDeletion() {
        guard !isDeletingAccount else { return }
        accountDeletionConfirmationPresented = false
        isDeletingAccount = true
        invalidateCSVExport()
        accountDeletionErrorMessage = nil
#if DEBUG
        let isQADeletion = qaAccountDeletionPreview != nil
#else
        let isQADeletion = false
#endif
        if !isQADeletion {
            do {
                guard let requestID = accountDeletionRequestID else {
                    throw NumaSessionError.noCachedSession
                }
                let safeTimeZone: IANATimeZone
                if let accountDeletionOriginatingTimeZone {
                    safeTimeZone = accountDeletionOriginatingTimeZone
                } else if let current = try? IANATimeZone(
                    TimeZone.current.identifier
                ) {
                    safeTimeZone = current
                } else {
                    safeTimeZone = try IANATimeZone("UTC")
                }
                let recovery = AccountDeletionRecoveryState(
                    requestID: requestID,
                    originatingTimeZone: safeTimeZone.identifier,
                    serverComplete: accountDeletionServerComplete
                )
                try accountDeletionRecoveryStore.save(recovery)
                accountDeletionOriginatingTimeZone = safeTimeZone
            } catch {
                isDeletingAccount = false
                accountDeletionErrorMessage = String(
                    localized: "The account couldn’t be deleted. Try again."
                )
                Haptics.warned()
                return
            }
        }
        let runtime = syncRuntime
        Task { [weak self] in
            await self?.performAccountDeletion(
                using: runtime,
                isQADeletion: isQADeletion
            )
        }
    }

    private func performAccountDeletion(
        using runtime: AppSyncRuntime?,
        isQADeletion: Bool = false
    ) async {
        do {
            if isQADeletion {
                accountDeletionServerComplete = true
            }
            if !accountDeletionServerComplete {
                guard let runtime,
                      let requestID = accountDeletionRequestID,
                      let originatingTimeZone = accountDeletionOriginatingTimeZone
                else { throw NumaSessionError.noCachedSession }
                try await runtime.deleteAccount(
                    requestID: requestID,
                    originatingTimeZone: originatingTimeZone
                )
                try accountDeletionRecoveryStore.save(
                    AccountDeletionRecoveryState(
                        requestID: requestID,
                        originatingTimeZone: originatingTimeZone.identifier,
                        serverComplete: true
                    )
                )
                accountDeletionServerComplete = true
            }
            retireSyncRuntime()
            let snapshot = try await eraseAllLocalAccountState(
                temporaryDirectory: FileManager.default.temporaryDirectory
            )
            await finishLocalAccountRemoval(snapshot, reconfigureSync: false)
            if !isQADeletion {
                guard let runtime else { throw NumaSessionError.noCachedSession }
                try await runtime.clearAccountDeletionCredential()
                try accountDeletionRecoveryStore.clear()
            }
            isDeletingAccount = false
            accountDeletionServerComplete = false
            accountDeletionRequestID = nil
            accountDeletionOriginatingTimeZone = nil
        } catch {
            isDeletingAccount = false
            accountDeletionErrorMessage = accountDeletionServerComplete
                ? String(
                    localized: "Your account was deleted, but this iPhone’s local data couldn’t be cleared. Try again."
                )
                : String(localized: "The account couldn’t be deleted. Try again.")
            Haptics.warned()
        }
    }

    private func eraseAllLocalAccountState(
        temporaryDirectory: URL
    ) async throws -> AppLedgerSnapshot {
        var repositories = Array(ephemeralPotStores.values)
        repositories.append(repository)
        if let newPotReturn { repositories.append(newPotReturn.repository) }
        var seenRepositories = Set<ObjectIdentifier>()
        for candidate in repositories
        where seenRepositories.insert(ObjectIdentifier(candidate)).inserted {
            _ = try await candidate.eraseLocalAccountState(
                temporaryDirectory: temporaryDirectory
            )
        }

        if registryPersists {
            try PotRegistry.removeAccountStores(
                named: localPots.map(\.databaseName)
            )
        }

        let freshID = UUID()
        let freshDatabaseName = registryPersists
            ? PotRegistry.newDatabaseName()
            : "ephemeral-\(freshID.uuidString)"
        let descriptor = LocalPotDescriptor(
            id: freshID,
            name: "",
            currencyCode: CurrencyCatalog.suggested().code,
            databaseName: freshDatabaseName,
            createdAt: Date()
        )
        let freshRepository = AppLedgerRepository(
            storageMode: registryPersists ? .persistent : .inMemory,
            databaseName: freshDatabaseName
        , readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
        let snapshot = try await freshRepository.bootstrap(seedCasaMar: false)
        if registryPersists {
            try PotRegistry.persist(.init(
                pots: [descriptor],
                activeID: descriptor.id
            ))
        }

        repository = freshRepository
        localPots = [descriptor]
        activePotID = descriptor.id
        ephemeralPotStores = registryPersists ? [:] : [descriptor.id: freshRepository]
        pendingNewPot = nil
        newPotReturn = nil
        pendingCompletedSetup = nil
        isCreatingAdditionalPot = false
        appliedRevision = -1
        return snapshot
    }

    private func finishLocalAccountRemoval(
        _ snapshot: AppLedgerSnapshot,
        reconfigureSync: Bool = true
    ) async {
        retireSyncRuntime()
        isPotMuted = false
        pendingInviteClaims = []
        managedInvites = []
        issuedInvite = nil
        csvExportURL = nil
        csvExportRowCount = nil
        csvExportErrorMessage = nil
        csvExportPrivacyWarning = nil
        peoplePresented = false
        joinPresented = false
        settingsPresented = false
        sheet = .none
        clearUndo()
        resetSetupFields()
        ownerDisplayName = ""
        apply(snapshot, animated: false)
        screen = .welcome
        isBootstrapping = false
        if reconfigureSync { await configureSync() }
    }

    func beginInvite(for unitID: UnitID) {
        beginInvite(.localUnit(unitID))
    }

    func beginInvite(for memberID: NumaSharedCore.MemberID) {
        beginInvite(.member(memberID))
    }

    func beginPotInvite() {
        beginInvite(.potLink)
    }

    func refreshPeople() {
        guard isSyncEnabled,
              let syncRuntime,
              !isRefreshingPeople,
              !isUpdatingPeople
        else { return }
        isRefreshingPeople = true
        peopleErrorMessage = nil
        Task { [weak self] in
            do {
                let claims = try await syncRuntime.refreshMemberAdministration()
                guard let self else { return }
                let invites = isCurrentMemberOwner
                    ? try await syncRuntime.listManagedInvites()
                    : []
                let muted = try await syncRuntime.getPotMute()
                pendingInviteClaims = claims
                managedInvites = invites
                isPotMuted = muted
                isRefreshingPeople = false
                schedulePushNotificationReconciliation()
            } catch {
                guard let self else { return }
                isRefreshingPeople = false
                peopleErrorMessage = Self.userFacingPeopleError(error)
                Haptics.warned()
            }
        }
    }

    func approvePendingInviteClaim(
        _ claimID: PendingInviteClaimID,
        as memberID: NumaSharedCore.MemberID
    ) {
        performPeopleUpdate(requestPushAuthorizationAfterSuccess: true) { runtime in
            try await runtime.approvePendingInviteClaim(
                claimID,
                memberID: memberID
            )
        }
    }

    func rejectPendingInviteClaim(_ claimID: PendingInviteClaimID) {
        performPeopleUpdate { runtime in
            try await runtime.rejectPendingInviteClaim(claimID)
        }
    }

    func detachMemberClaim(_ memberID: NumaSharedCore.MemberID) {
        performPeopleUpdate { runtime in
            try await runtime.reassignMemberClaim(memberID)
        }
    }

    func archiveMember(_ memberID: NumaSharedCore.MemberID) {
        performPeopleUpdate { runtime in
            try await runtime.archiveMember(memberID)
        }
    }

    func leaveCurrentPot() {
        guard canLeaveCurrentPot,
              let syncRuntime,
              !isRefreshingPeople,
              !isUpdatingPeople
        else { return }
        isUpdatingPeople = true
        peopleErrorMessage = nil
        Task { [weak self] in
            do {
                try await syncRuntime.leaveCurrentPot()
                guard let self else { return }
                pendingInviteClaims = []
                managedInvites = []
                isUpdatingPeople = false
                peoplePresented = false
                Haptics.saved()
            } catch {
                guard let self else { return }
                isUpdatingPeople = false
                peopleErrorMessage = Self.userFacingPeopleError(error)
                Haptics.warned()
            }
        }
    }

    func transferOwnership(to memberID: NumaSharedCore.MemberID) {
        performPeopleUpdate { runtime in
            try await runtime.transferOwnership(to: memberID)
        }
    }

    func anonymizePendingMember(_ memberID: NumaSharedCore.MemberID) {
        performPeopleUpdate { runtime in
            try await runtime.anonymizePendingMember(memberID)
        }
    }

    func revokeInvite(_ inviteID: UUID) {
        guard isSyncEnabled,
              let syncRuntime,
              !isRefreshingPeople,
              !isUpdatingPeople,
              !isIssuingInvite
        else { return }
        isUpdatingPeople = true
        peopleErrorMessage = nil
        Task { [weak self] in
            do {
                let invites = try await syncRuntime.revokeInvite(inviteID)
                guard let self else { return }
                managedInvites = invites
                if issuedInvite?.id == inviteID { issuedInvite = nil }
                isUpdatingPeople = false
                Haptics.saved()
            } catch {
                guard let self else { return }
                isUpdatingPeople = false
                peopleErrorMessage = Self.userFacingPeopleError(error)
                Haptics.warned()
            }
        }
    }

    private func beginInvite(_ target: InviteCreationTarget) {
        guard !isIssuingInvite, !isUpdatingPeople else { return }
        peopleErrorMessage = nil
        if !isSyncEnabled {
            pendingInviteCreation = target
            peoplePresented = false
            beginSyncSetup()
            return
        }
        issueInvite(target)
    }

    private func issueInvite(_ target: InviteCreationTarget) {
        guard let syncRuntime,
              let inviteSiteURL,
              let resolved = resolvedInviteTarget(target)
        else {
            peopleErrorMessage = String(localized:
                "This invite couldn’t be created. Refresh People and try again."
            )
            Haptics.warned()
            return
        }
        let credentials: InviteCredentialPair
        do {
            credentials = try NumaInviteCredentialGenerator.generate()
        } catch {
            peopleErrorMessage = String(localized:
                "This invite couldn’t be created. Try again."
            )
            Haptics.warned()
            return
        }
        let routeParser = InviteRouteParser(siteURL: inviteSiteURL)
        guard (try? routeParser.url(for: .token(
            credentials.token,
            pairedCode: credentials.code
        ))) != nil else {
            peopleErrorMessage = String(localized:
                "This invite couldn’t be created. Try again."
            )
            Haptics.warned()
            return
        }
        isIssuingInvite = true
        peopleErrorMessage = nil
        Task { [weak self] in
            do {
                let request = try await syncRuntime.issueInvite(
                    kind: resolved.kind,
                    pendingMemberID: resolved.memberID,
                    credentials: credentials
                )
                let url = try routeParser.url(
                    for: .token(
                        request.credentials.token,
                        pairedCode: request.credentials.code
                    )
                )
                let invites = try? await syncRuntime.listManagedInvites()
                guard let self else { return }
                issuedInvite = ShareableInvite(
                    id: request.inviteID,
                    kind: request.kind,
                    pendingMemberID: request.pendingMemberID,
                    url: url,
                    code: request.credentials.code,
                    expiresAtMillis: request.expiresAtMillis
                )
                if let invites { managedInvites = invites }
                isIssuingInvite = false
                Haptics.saved()
            } catch {
                if let transport = error as? SyncTransportError,
                   case let .terminal(code) = transport,
                   ["INVITE_CODE_UNAVAILABLE", "INVITE_SECRET_ALREADY_USED"]
                    .contains(code) {
                    syncRuntime.discardPendingInviteIssue(
                        kind: resolved.kind,
                        pendingMemberID: resolved.memberID
                    )
                }
                guard let self else { return }
                isIssuingInvite = false
                peopleErrorMessage = Self.userFacingPeopleError(error)
                Haptics.warned()
            }
        }
    }

    private func resolvedInviteTarget(
        _ target: InviteCreationTarget
    ) -> (kind: InviteAdministrationKind, memberID: NumaSharedCore.MemberID?)? {
        switch target {
        case let .localUnit(unitID):
            guard let profile = memberProfiles.first(where: {
                $0.unitID == unitID && $0.state == .pending
            }) else { return nil }
            return (.perMember, profile.memberID)
        case let .member(memberID):
            guard memberProfiles.contains(where: {
                $0.memberID == memberID && $0.state == .pending
            }) else { return nil }
            return (.perMember, memberID)
        case .potLink:
            return (.potLink, nil)
        }
    }

    private func cancelPendingInviteCheckpoint() {
        guard pendingInviteCreation != nil else { return }
        pendingInviteCreation = nil
        if screen == .home { peoplePresented = true }
    }

    private func performPeopleUpdate(
        requestPushAuthorizationAfterSuccess: Bool = false,
        _ operation: @escaping @MainActor (
            AppSyncRuntime
        ) async throws -> [PendingInviteClaim]
    ) {
        guard isSyncEnabled,
              let syncRuntime,
              !isRefreshingPeople,
              !isUpdatingPeople
        else { return }
        isUpdatingPeople = true
        peopleErrorMessage = nil
        Task { [weak self] in
            do {
                let claims = try await operation(syncRuntime)
                guard let self else { return }
                pendingInviteClaims = claims
                if isCurrentMemberOwner {
                    managedInvites = (try? await syncRuntime.listManagedInvites())
                        ?? managedInvites
                } else {
                    managedInvites = []
                }
                if requestPushAuthorizationAfterSuccess {
                    await requestPushAuthorization(afterAcceptedMembership: true)
                }
                isUpdatingPeople = false
                Haptics.saved()
            } catch {
                guard let self else { return }
                isUpdatingPeople = false
                peopleErrorMessage = Self.userFacingPeopleError(error)
                Haptics.warned()
            }
        }
    }

    nonisolated private static func userFacingPeopleError(_ error: Error) -> String {
        guard let transportError = error as? SyncTransportError else {
            return String(localized: "People couldn’t be updated. Try again.")
        }
        switch transportError {
        case .retryable:
            return String(localized: "That change wasn’t confirmed. Retry when you’re online.")
        case let .terminal(code):
            switch code {
            case "NOT_OWNER":
                return String(localized: "Only the owner can make that change.")
            case "CANNOT_ARCHIVE_OWNER":
                return String(localized: "Transfer ownership before archiving the owner.")
            case "SOLE_ACTIVE_MEMBER":
                return String(localized: "Add or approve another member before leaving this pot.")
            case "CLAIM_INVALID", "CLAIM_NOT_PENDING", "MEMBER_ALREADY_CLAIMED":
                return String(localized: "That join request changed. Refresh People and try again.")
            case "INVITE_PENDING_MEMBER_ALREADY_ACTIVE":
                return String(localized: "That person already has an active invite. Revoke it before creating another.")
            case "INVITE_CODE_UNAVAILABLE", "INVITE_SECRET_ALREADY_USED":
                return String(localized: "That invite couldn’t be created. Try again.")
            case "INVITE_INVALID", "INVITE_ALREADY_USED":
                return String(localized: "That invite changed. Refresh People and try again.")
            case "MEMBERSHIP_ARCHIVED", "NOT_MEMBER", "POT_MEMBERSHIP_REQUIRED":
                return String(localized: "You’re no longer a member of this pot.")
            default:
                return String(localized: "People couldn’t be updated. Try again.")
            }
        }
    }

    // MARK: - Invite join

    func beginJoin() {
        resetJoin()
        joinPresented = true
    }

    func dismissJoin() {
        guard !joinIsBusy else { return }
        joinPresented = false
        resetJoin()
    }

    func joinDidDismiss() {
        guard !joinPresented else { return }
        resetJoin()
    }

    func useAnotherJoinCode() {
        guard !joinIsBusy else { return }
        resetJoin()
    }

    func submitJoinCode() {
        guard let credential = InviteCredential.typedCode(joinCode) else {
            joinErrorMessage = String(localized: "Enter the six-letter or number code.")
            Haptics.warned()
            return
        }
        resolveInvite(credential)
    }

    @discardableResult
    func handleOpenURL(_ url: URL) -> Bool {
        installInviteServiceIfAvailable()
        guard !joinIsBusy,
              let inviteSiteURL,
              let credential = try? InviteRouteParser(siteURL: inviteSiteURL).parse(url)
        else { return false }
        joinPresented = true
        joinCode = ""
        resolveInvite(credential)
        return true
    }

    var joinNeedsAuthentication: Bool {
        syncRuntime?.diagnosticState().accountID == nil
    }

    var joinIsBusy: Bool {
        switch joinPhase {
        case .resolving, .claiming: true
        case .entry, .preview, .pendingApproval, .joined, .inactive: false
        }
    }

    func claimResolvedInvite() {
        guard !joinNeedsAuthentication else {
            joinErrorMessage = String(localized: "Sign in with Apple to join this pot.")
            return
        }
        Task { [weak self] in
            await self?.performResolvedInviteClaim()
        }
    }

    func openJoinedPot() {
        guard case .joined = joinPhase else { return }
        screen = .home
        joinPresented = false
        resetJoin()
    }

    private func resetJoin() {
        joinRequestID = nil
        joinCode = ""
        joinPhase = .entry
        joinErrorMessage = nil
        pendingInviteTicket = nil
        pendingInviteKind = nil
        pendingInviteSchemaVersion = nil
        pendingInvitePotName = nil
    }

    private func resolveInvite(_ credential: InviteCredential) {
        installInviteServiceIfAvailable()
        guard let invitePreviewService else {
            joinErrorMessage = String(localized: "Invites aren’t available right now. Ask for the code and try again later.")
            return
        }
        let requestID = UUID()
        joinRequestID = requestID
        joinPhase = .resolving
        joinErrorMessage = nil
        pendingInviteTicket = nil
        pendingInviteKind = nil
        pendingInviteSchemaVersion = nil
        pendingInvitePotName = nil
        Task { [weak self] in
            await self?.fetchInvitePreview(
                credential,
                using: invitePreviewService,
                requestID: requestID
            )
        }
    }

    private func fetchInvitePreview(
        _ credential: InviteCredential,
        using service: any InvitePreviewServing,
        requestID: UUID
    ) async {
        do {
            let preview = try await service.resolve(credential)
            applyInvitePreview(preview, requestID: requestID)
        } catch {
            applyInvitePreviewError(error, requestID: requestID)
        }
    }

    private func installInviteServiceIfAvailable() {
#if DEBUG
        // Ephemeral QA never reads real recovery, credentials or network configuration.
        // Explicit isolated E2E uses its own persistent store and configuration.
        guard !usesEphemeralQAStore else { return }
#endif
        guard invitePreviewService == nil else { return }
#if DEBUG
        let configuration = e2eConfiguration?.sync ?? NumaSyncConfiguration.bundled()
#else
        let configuration = NumaSyncConfiguration.bundled()
#endif
        guard let configuration else { return }
        inviteSiteURL = configuration.siteURL
        invitePreviewService = NumaInviteHTTPClient(siteURL: configuration.siteURL)
    }

    private func applyInvitePreview(_ preview: InvitePreview, requestID: UUID) {
        guard joinRequestID == requestID else { return }
        joinRequestID = nil
        guard preview.status == .active else {
            joinPhase = .inactive(preview.status)
            return
        }
        guard let kind = preview.kind,
              let ticket = preview.claimTicket,
              let minimum = preview.minimumReaderSchemaVersion,
              (1...EventEnvelope.maximumSupportedSchemaVersion).contains(minimum)
        else {
            joinPhase = .entry
            joinErrorMessage = String(localized: "This invite couldn’t be checked. Try again.")
            return
        }
        pendingInviteTicket = ticket
        pendingInviteKind = kind
        pendingInviteSchemaVersion = minimum
        pendingInvitePotName = preview.potName
        joinPhase = .preview(potName: preview.potName, kind: kind)
    }

    private func applyInvitePreviewError(_ error: Error, requestID: UUID) {
        guard joinRequestID == requestID else { return }
        joinRequestID = nil
        joinPhase = .entry
        switch error as? NumaInviteHTTPError {
        case .transportUnavailable:
            joinErrorMessage = String(localized: "You appear to be offline. The code is unchanged.")
        case .serviceUnavailable:
            joinErrorMessage = String(localized: "Invites aren’t available right now. Try again later.")
        case .invalidResponse, .none:
            joinErrorMessage = String(localized: "This invite couldn’t be checked. Try again.")
        }
    }

    func prepareAppleAuthorization(_ request: ASAuthorizationAppleIDRequest) {
        do {
            let nonce = try NumaAppleNonce.make()
            pendingAppleNonce = nonce
            request.nonce = NumaAppleNonce.digest(nonce)
            request.requestedScopes = [.email]
        } catch {
            pendingAppleNonce = nil
            if hasPendingInviteClaim {
                joinErrorMessage = String(localized: "Sign in couldn’t start. Try again.")
            } else {
                syncErrorMessage = String(localized: "Sign in couldn’t start. Try again.")
            }
        }
    }

    func completeAppleAuthorization(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case let .success(authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identityData = credential.identityToken,
                  let codeData = credential.authorizationCode,
                  let identityToken = String(data: identityData, encoding: .utf8),
                  let authorizationCode = String(data: codeData, encoding: .utf8),
                  let nonce = pendingAppleNonce
            else {
                pendingAppleNonce = nil
                if hasPendingInviteClaim {
                    joinErrorMessage = self.syncRuntime == nil
                        ? String(localized: "Invites aren’t available right now. Try again later.")
                        : String(localized: "Apple sign in didn’t finish. Try again.")
                } else {
                    syncErrorMessage = self.syncRuntime == nil
                        ? String(localized: "Sync isn’t available right now. Your records are still on this iPhone.")
                        : String(localized: "Apple sign in didn’t finish. Try again.")
                }
                return
            }
            pendingAppleNonce = nil
            submitAppleCredential(NumaAppleCredential(
                identityToken: identityToken,
                authorizationCode: authorizationCode,
                rawNonce: nonce
            ))
        case let .failure(error):
            pendingAppleNonce = nil
            if let appleError = error as? ASAuthorizationError,
               appleError.code == .canceled {
                if !hasPendingInviteClaim { dismissSyncSetup() }
                return
            }
            if hasPendingInviteClaim {
                joinErrorMessage = String(localized: "Apple sign in didn’t finish. Try again.")
            } else {
                syncErrorMessage = String(localized: "Apple sign in didn’t finish. Try again.")
            }
        }
    }

    private func submitAppleCredential(_ credential: NumaAppleCredential) {
        if hasPendingInviteClaim {
            joinErrorMessage = nil
            Task { [weak self] in
                await self?.performInviteLoginAndClaim(credential)
            }
            return
        }
        syncSetupPresented = true
        syncErrorMessage = nil
        Task { [weak self] in
            await self?.performAppleLogin(credential)
        }
    }

    private func performAppleLogin(_ credential: NumaAppleCredential) async {
        guard let syncRuntime else {
            syncSetupPresented = true
            syncErrorMessage = String(localized: "Sync isn’t available right now. Your records are still on this iPhone.")
            return
        }
        await syncRuntime.login(with: credential)
        let result = syncRuntime.diagnosticState()
        if result.accountID != nil {
            let inviteCreation = pendingInviteCreation
            pendingInviteCreation = nil
            syncSetupPresented = false
            if let inviteCreation {
                await Task.yield()
                peoplePresented = true
                issueInvite(inviteCreation)
            }
        } else {
            // Apple authorization completed, but Numa's backend did not
            // accept an authenticated session. Keep that error in view.
            syncSetupPresented = true
            if syncErrorMessage == nil {
                syncErrorMessage = Self.userFacingSyncError(
                    result.errorCode ?? "AUTHENTICATION_FAILED",
                    presentation: result.presentation
                )
            }
        }
    }

    private var hasPendingInviteClaim: Bool {
        joinPresented
            && pendingInviteTicket != nil
            && pendingInviteKind != nil
    }

    private func performInviteLoginAndClaim(_ credential: NumaAppleCredential) async {
        guard let syncRuntime else {
            joinErrorMessage = String(localized: "Invites aren’t available right now. Try again later.")
            return
        }
        let priorPhase = joinPhase
        joinPhase = .claiming(potName: pendingInvitePotName)
        let authenticated = await syncRuntime.loginForInvite(with: credential)
        guard authenticated else {
            joinPhase = priorPhase
            let diagnostic = syncRuntime.diagnosticState()
            joinErrorMessage = Self.userFacingSyncError(
                diagnostic.errorCode ?? "AUTHENTICATION_FAILED",
                presentation: diagnostic.presentation
            )
            return
        }
        await performResolvedInviteClaim()
    }

    private func performResolvedInviteClaim() async {
        guard let syncRuntime,
              let ticket = pendingInviteTicket,
              let kind = pendingInviteKind
        else {
            joinErrorMessage = String(localized: "This invite couldn’t be checked. Try again.")
            return
        }
        joinPhase = .claiming(potName: pendingInvitePotName)
        let timeZone = (try? IANATimeZone(TimeZone.current.identifier))
            ?? (try? IANATimeZone("UTC"))
        guard let timeZone else {
            joinPhase = .preview(potName: pendingInvitePotName, kind: kind)
            joinErrorMessage = String(localized: "This invite couldn’t be joined. Try again.")
            return
        }
        do {
            let outcome = try await syncRuntime.claimInvite(
                ticket: ticket,
                kind: kind,
                timeZone: timeZone,
                targetSchemaVersion: pendingInviteSchemaVersion
            )
            pendingInviteTicket = nil
            switch outcome {
            case .joined:
                joinPhase = .joined(potName: pendingInvitePotName)
                await requestPushAuthorization(afterAcceptedMembership: true)
            case .pendingApproval:
                joinPhase = .pendingApproval(potName: pendingInvitePotName)
            }
        } catch {
            joinPhase = .preview(potName: pendingInvitePotName, kind: kind)
            let diagnostic = syncRuntime.diagnosticState()
            joinErrorMessage = Self.userFacingSyncError(
                diagnostic.errorCode ?? "INVITE_CLAIM_FAILED",
                presentation: diagnostic.presentation
            )
        }
    }

    func retrySync() {
        guard let syncRuntime else { return }
        Task { await syncRuntime.synchronizeNow(userInitiated: true) }
    }

    func refreshAppConfiguration() {
        guard let syncRuntime else { return }
        Task { [weak self] in
            guard let configuration = try? await syncRuntime.appConfiguration(),
                  configuration.minimumSupportedBuild.map({ $0 > 0 }) != false
            else { return }
            self?.applyAppConfiguration(configuration)
        }
    }

    private func applyAppConfiguration(_ configuration: NumaAppConfiguration) {
        minimumSupportedBuild = configuration.minimumSupportedBuild
        guard requiresAppUpdate else { return }
        addPresented = false
        sheet = .none
        syncSetupPresented = false
        joinPresented = false
        peoplePresented = false
        settingsPresented = false
        signOutConfirmationPresented = false
        accountDeletionConfirmationPresented = false
    }

    private func configureSync() async {
#if DEBUG
        // Ephemeral QA never reads real recovery, credentials or network configuration.
        // Explicit isolated E2E uses its own persistent store and configuration.
        guard !usesEphemeralQAStore else { return }
#endif
        let configuredRepository = repository
        if let syncRuntime, syncRuntime.isBound(to: configuredRepository) {
            return
        }
        await coordinateSyncConfiguration(for: configuredRepository) { [weak self] in
            await self?.performSyncConfiguration(
                for: configuredRepository
            )
        }
    }

    private func coordinateSyncConfiguration(
        for configuredRepository: AppLedgerRepository,
        operation: @escaping @MainActor () async -> Void
    ) async {
        if let flight = syncConfigurationFlight,
           flight.repository === configuredRepository
        {
            await flight.task.value
            return
        }

        syncConfigurationFlight?.task.cancel()
        let flightID = UUID()
        let task = Task { @MainActor in
            await operation()
        }
        syncConfigurationFlight = (
            id: flightID,
            repository: configuredRepository,
            task: task
        )
        await task.value
        if syncConfigurationFlight?.id == flightID {
            syncConfigurationFlight = nil
        }
    }

    private func performSyncConfiguration(
        for configuredRepository: AppLedgerRepository
    ) async {
#if DEBUG
        var e2eStage = NumaSharedE2EFailureStage.runtimeInitialization
        if e2eConfiguration != nil {
            recordE2EProgress(stage: e2eStage)
        }
#endif
#if DEBUG
        let configuration = e2eConfiguration?.sync ?? NumaSyncConfiguration.bundled()
#else
        let configuration = NumaSyncConfiguration.bundled()
#endif
        guard let configuration else { return }
        inviteSiteURL = configuration.siteURL
        invitePreviewService = NumaInviteHTTPClient(siteURL: configuration.siteURL)
        if let syncRuntime {
            if syncRuntime.isBound(to: configuredRepository) { return }
            retireSyncRuntime()
        }
        do {
#if DEBUG
            let refreshTokens: any RefreshTokenStoring = e2eConfiguration.map {
                KeychainRefreshTokenStore(account: $0.refreshTokenAccount)
            } ?? KeychainRefreshTokenStore()
#else
            let refreshTokens: any RefreshTokenStoring = KeychainRefreshTokenStore()
#endif
            let runtime = try await AppSyncRuntime(
                configuration: configuration,
                repository: configuredRepository,
                refreshTokens: refreshTokens
            )
            guard installSyncRuntime(runtime, boundTo: configuredRepository) else {
                return
            }
            if let appConfiguration = try? await runtime.appConfiguration() {
                applyAppConfiguration(appConfiguration)
            }
#if DEBUG
            if let e2eConfiguration {
                e2eStage = .commandPreparation
                recordE2EProgress(stage: e2eStage)
                let snapshot = try await configuredRepository.prepareE2ECommand(
                    e2eConfiguration.command,
                    runSeed: e2eConfiguration.runSeed
                )
                apply(snapshot, animated: false)
                e2eStage = .authentication
                recordE2EProgress(stage: e2eStage)
                let authenticated: Bool
                if e2eConfiguration.command.usesInviteOnlyLogin {
                    authenticated = await runtime.loginE2EForInvite(
                        accountKey: e2eConfiguration.accountKey,
                        bootstrapSecret: e2eConfiguration.bootstrapSecret
                    )
                } else {
                    await runtime.loginE2E(
                        accountKey: e2eConfiguration.accountKey,
                        bootstrapSecret: e2eConfiguration.bootstrapSecret
                    )
                    authenticated = runtime.diagnosticState().accountID != nil
                }
                let diagnostic = runtime.diagnosticState()
                guard authenticated, diagnostic.accountID != nil else {
                    recordE2EFailure(
                        stage: .authentication,
                        code: Self.e2eAuthenticationFailureCode(
                            diagnostic.errorCode
                        )
                    )
                    return
                }
                e2eStage = .journeyAction
                recordE2EProgress(stage: e2eStage)
                let journeySnapshot = try await performE2EJourneyAction(
                    e2eConfiguration,
                    runtime: runtime
                )
                apply(journeySnapshot, animated: false)
                e2eStage = .artifactReporting
                recordE2EProgress(stage: e2eStage)
                let reporter = NumaSharedE2EReporter(
                    configuration: e2eConfiguration,
                    repository: configuredRepository,
                    runtime: runtime
                )
                e2eReporter = reporter
                reporter.start()
                return
            }
#endif
            if accountDeletionRequestID != nil {
                isDeletingAccount = true
                await performAccountDeletion(using: runtime)
                return
            }
            await runtime.restoreCachedSession()
        } catch {
#if DEBUG
            if e2eConfiguration != nil {
                recordE2EFailure(
                    stage: e2eStage,
                    code: Self.e2eFailureCode(for: e2eStage)
                )
            }
#endif
            guard repository === configuredRepository else { return }
            runtimeSyncPresentation = .local
            syncErrorMessage = String(localized: "Sync isn’t available right now. Your records are still on this iPhone.")
        }
    }

#if DEBUG
    private func performE2EJourneyAction(
        _ configuration: NumaSharedE2EConfiguration,
        runtime: AppSyncRuntime
    ) async throws -> AppLedgerSnapshot {
        switch configuration.command {
        case .p3OwnerBootstrap:
            guard let first = configuration.firstInviteCredentials,
                  let second = configuration.secondInviteCredentials
            else { throw Self.e2eJourneyFailure() }
            _ = try await runtime.issueInvite(
                kind: .potLink,
                pendingMemberID: nil,
                credentials: first
            )
            _ = try await runtime.issueInvite(
                kind: .potLink,
                pendingMemberID: nil,
                credentials: second
            )
        case .p3ClaimLeaked, .p3ClaimApproved:
            guard let ticket = configuration.inviteClaimTicket,
                  let targetPotID = configuration.targetPotID
            else { throw Self.e2eJourneyFailure() }
            let outcome = try await runtime.claimInvite(
                ticket: ticket,
                kind: .potLink,
                timeZone: try IANATimeZone("UTC"),
                targetSchemaVersion: nil // Pot-link claims author no event; approval uses the owner's verified target pot.
            )
            guard outcome == .pendingApproval else {
                throw Self.e2eJourneyFailure()
            }
            try await runtime.assertE2EPendingAccessDenied(to: targetPotID)
        case .p3RejectLeaked:
            let claims = try await runtime.refreshMemberAdministration()
            guard claims.count == 1, let claim = claims.first else {
                throw Self.e2eJourneyFailure()
            }
            let remaining = try await runtime.rejectPendingInviteClaim(claim.id)
            guard remaining.isEmpty else { throw Self.e2eJourneyFailure() }
        case .p3ApproveClaim:
            let claims = try await runtime.refreshMemberAdministration()
            let snapshot = try await repository.refreshSnapshot()
            guard claims.count == 1,
                  let claim = claims.first,
                  let member = snapshot.memberProfiles.first(where: {
                      $0.unitID == .sam && $0.state == .pending
                  })
            else { throw Self.e2eJourneyFailure() }
            let remaining = try await runtime.approvePendingInviteClaim(
                claim.id,
                memberID: member.memberID
            )
            guard remaining.isEmpty else { throw Self.e2eJourneyFailure() }
        case .p3CrossExpense:
            let snapshot = try await repository.refreshSnapshot()
            guard snapshot.currentMemberProfile?.role == .member,
                  snapshot.currentMemberProfile?.unitID == .sam
            else { throw Self.e2eJourneyFailure() }
            let mutation = try await repository.appendExpense(
                title: "P3 cross-account expense",
                amountMinorUnits: 10_000,
                payer: .sam,
                orderedUnits: [.am],
                weights: [.am: 1],
                category: "Shared"
            )
            try await finishE2EMutation(mutation, runtime: runtime)
        case .p3Settlement:
            let snapshot = try await repository.refreshSnapshot()
            guard snapshot.currentMemberProfile?.role == .owner else {
                throw Self.e2eJourneyFailure()
            }
            let mutation = try await repository.appendSettlement(
                title: "P3 owner settlement",
                amountMinorUnits: 2_500,
                from: .am,
                to: .sam
            )
            try await finishE2EMutation(mutation, runtime: runtime)
        case .p3RevisionA:
            if let mutation = try await repository.appendE2EConcurrentExpenseRevision(
                recordTitle: "P3 cross-account expense",
                revisionTitle: "P3 edit A",
                amountMinorUnits: 12_000,
                runSeed: configuration.runSeed
            ) {
                try await finishE2EMutation(mutation, runtime: runtime)
            }
        case .p3RevisionB:
            if let mutation = try await repository.appendE2EConcurrentExpenseRevision(
                recordTitle: "P3 cross-account expense",
                revisionTitle: "P3 edit B",
                amountMinorUnits: 8_000,
                runSeed: configuration.runSeed
            ) {
                try await finishE2EMutation(mutation, runtime: runtime)
            }
        case .p3ResolveContest:
            await runtime.synchronizeNow(userInitiated: true)
            let snapshot = try await repository.refreshSnapshot()
            guard let record = snapshot.records.first(where: {
                $0.contest != nil && $0.revisionHistory.contains(where: {
                    $0.title == "P3 edit A"
                })
            }),
            let contest = record.contest,
            let chosen = record.revisionHistory.first(where: {
                $0.title == "P3 edit A" && contest.headRevisionIDs.contains($0.id)
            }),
            let otherID = contest.headRevisionIDs.first(where: {
                $0 != chosen.id
            })
            else { throw Self.e2eJourneyFailure() }
            let mutation = try await repository.resolveExpenseContest(
                recordID: record.id,
                choosing: chosen.id,
                comparedWith: otherID
            )
            try await finishE2EMutation(mutation, runtime: runtime)
        case .observe, .createOne, .createAfter, .queueTwenty:
            break
        }
        return try await repository.refreshSnapshot()
    }

    private func finishE2EMutation(
        _ mutation: AppLedgerMutation,
        runtime: AppSyncRuntime
    ) async throws {
        let expiry = try await repository.expireHeldEvent(
            eventID: mutation.eventID,
            now: mutation.undoDeadline.addingTimeInterval(0.001)
        )
        guard case let .transitioned(eventIDs) = expiry,
              eventIDs.contains(mutation.eventID)
        else { throw Self.e2eJourneyFailure() }
        await runtime.synchronizeNow(userInitiated: true)
        let diagnostic = runtime.diagnosticState()
        guard diagnostic.errorCode == nil else {
            throw Self.e2eJourneyFailure()
        }
    }

    nonisolated private static func e2eJourneyFailure() -> SyncTransportError {
        .terminal(code: NumaSharedE2EFailureCode.journeyAssertionFailed.rawValue)
    }

    private func recordE2EProgress(stage: NumaSharedE2EFailureStage) {
        guard let e2eEnvelope else { return }
        NumaSharedE2EDiagnosticArtifact.recordProgress(
            envelope: e2eEnvelope,
            stage: stage
        )
    }

    private func recordE2EFailure(
        stage: NumaSharedE2EFailureStage,
        code: NumaSharedE2EFailureCode
    ) {
        guard let e2eEnvelope else { return }
        NumaSharedE2EDiagnosticArtifact.recordFailure(
            envelope: e2eEnvelope,
            stage: stage,
            code: code
        )
    }

    nonisolated private static func e2eFailureCode(
        for stage: NumaSharedE2EFailureStage
    ) -> NumaSharedE2EFailureCode {
        switch stage {
        case .configuration:
            .configurationUnavailable
        case .repositoryBootstrap:
            .repositoryBootstrapFailed
        case .runtimeInitialization:
            .runtimeInitializationFailed
        case .commandPreparation:
            .commandPreparationFailed
        case .authentication:
            .authenticationFailed
        case .journeyAction:
            .journeyAssertionFailed
        case .artifactReporting:
            .artifactWriteFailed
        }
    }

    nonisolated private static func e2eAuthenticationFailureCode(
        _ runtimeCode: String?
    ) -> NumaSharedE2EFailureCode {
        switch runtimeCode {
        case "transportUnavailable", "TRANSPORT_UNAVAILABLE", "TRANSPORT_TIMEOUT":
            .transportUnavailable
        default:
            .authenticationFailed
        }
    }
#endif

    @discardableResult
    private func installSyncRuntime(
        _ runtime: AppSyncRuntime,
        boundTo configuredRepository: AppLedgerRepository
    ) -> Bool {
        guard repository === configuredRepository,
              runtime.isBound(to: configuredRepository)
        else {
            runtime.retire()
            return false
        }
        runtime.onUpdate = { [weak self] presentation, _, snapshot, errorCode in
            guard let self, self.repository === configuredRepository else { return }
            runtimeSyncPresentation = presentation
            if let snapshot { apply(snapshot) }
            syncErrorMessage = errorCode.map {
                Self.userFacingSyncError($0, presentation: presentation)
            }
            schedulePushNotificationReconciliation()
        }
        if let installedRuntime = syncRuntime, installedRuntime !== runtime {
            invalidateCSVExport()
            installedRuntime.retire()
        }
        syncRuntime = runtime
        schedulePushNotificationReconciliation()
        return true
    }

    private func retireSyncRuntime() {
        invalidateCSVExport()
        syncRuntime?.retire()
        syncRuntime = nil
        runtimeSyncPresentation = .local
        syncErrorMessage = nil
    }

    nonisolated static func userFacingSyncError(
        _ code: String,
        presentation: SyncPresentation? = nil
    ) -> String {
        switch code {
        case "AUTH_SESSION_REVOKED", "SESSION_REVOKED",
             "REFRESH_TOKEN_EXPIRED", "REFRESH_TOKEN_INVALID",
             "REFRESH_TOKEN_REUSED", "AUTH_SESSION_REQUIRED":
            String(localized: "Sync session ended. Sign in again to resume.")
        case "NOT_MEMBER", "MEMBERSHIP_ARCHIVED", "POT_MEMBERSHIP_REQUIRED":
            String(localized: "You’re no longer a member of this pot.")
        case "READER_UPDATE_REQUIRED":
            String(localized: "Update Numa Shared to continue syncing this pot.")
        case "ACCOUNT_IDENTITY_MISMATCH":
            String(localized: "This pot belongs to a different account. Sign back in with the original account.")
        case "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
             "NEGATIVE_CONTRIBUTION_BUDGET_EXCEEDED":
            String(localized: "This pot reached its safe record capacity. Copy the failed record details and contact support.")
        default:
            if presentation?.pauseDisposition != nil {
                String(localized: "This record couldn’t be added. It remains on this iPhone; copy its details and contact support.")
            } else {
                String(localized: "Your records are safe here. Retry when you’re online.")
            }
        }
    }

#if DEBUG
    func prepareCSVExportForTesting(
        privacyRefresh: @escaping @MainActor () async throws -> Bool,
        writer: @escaping @MainActor (URL) async throws -> LedgerCSVFile,
        onPrepared: (@MainActor (URL, Bool) -> Void)? = nil
    ) -> Task<Void, Never>? {
        prepareCSVExport(privacyRefresh: privacyRefresh, writer: writer, onPrepared: onPrepared)
    }

    var hasExternalServicesForTesting: Bool { syncRuntime != nil || invitePreviewService != nil }

    func setSyncPresentationForTesting(_ presentation: SyncPresentation) {
        runtimeSyncPresentation = presentation
    }

    func applySnapshotForTesting(_ snapshot: AppLedgerSnapshot) {
        apply(snapshot, animated: false)
    }

    func setSyncRuntimeForTesting(_ runtime: AppSyncRuntime) {
        installSyncRuntime(runtime, boundTo: repository)
    }

    func coordinateSyncConfigurationForTesting(
        operation: @escaping @MainActor () async -> Void
    ) async {
        await coordinateSyncConfiguration(
            for: repository,
            operation: operation
        )
    }

    func repositoryForTesting() -> AppLedgerRepository {
        repository
    }

    func eraseAllLocalAccountStateForTesting(
        temporaryDirectory: URL
    ) async throws -> AppLedgerSnapshot {
        retireSyncRuntime()
        return try await eraseAllLocalAccountState(
            temporaryDirectory: temporaryDirectory
        )
    }

    func presentLocalDataFailureForTesting(blocking: Bool) {
        presentLocalDataFailure(blocking: blocking)
    }

    func setInvitePreviewServiceForTesting(
        siteURL: URL,
        service: any InvitePreviewServing
    ) {
        inviteSiteURL = siteURL
        invitePreviewService = service
    }

    func resolveJoinCodeForTesting(_ value: String) async {
        joinPresented = true
        joinCode = value
        guard let credential = InviteCredential.typedCode(value),
              let invitePreviewService
        else {
            joinErrorMessage = String(localized: "Enter the six-letter or number code.")
            return
        }
        let requestID = UUID()
        joinRequestID = requestID
        joinPhase = .resolving
        joinErrorMessage = nil
        await fetchInvitePreview(
            credential,
            using: invitePreviewService,
            requestID: requestID
        )
    }

    func setResolvedInviteForTesting(
        ticket: String,
        kind: InviteKind,
        potName: String?
    ) {
        joinPresented = true
        pendingInviteTicket = ticket
        pendingInviteKind = kind
        pendingInviteSchemaVersion = 1
        pendingInvitePotName = potName
        joinPhase = .preview(potName: potName, kind: kind)
        joinErrorMessage = nil
    }

    func submitAppleCredentialForTesting(_ credential: NumaAppleCredential) async {
        if hasPendingInviteClaim {
            await performInviteLoginAndClaim(credential)
            return
        }
        syncSetupPresented = true
        syncErrorMessage = nil
        await performAppleLogin(credential)
    }
#endif

    // MARK: - Onboarding

    var canCompleteSetup: Bool {
        Self.isValidSetupValue(potName)
            && Self.isValidSetupValue(ownerDisplayName)
            && !setupPersonUnits.isEmpty
            && setupPersonUnits.allSatisfy {
                Self.isValidSetupValue(setupName(for: $0))
            }
            && setupSettlementUnitCount >= 2
            && setupPersonUnits.count + 1 + setupPairs.count <= 64
            && isPotCurrencyConfirmed
    }

    var canAddSetupPerson: Bool {
        setupPersonUnits.count < 63
    }

    var setupSettlementUnitCount: Int {
        let participantCount = setupPersonUnits.count + 1
        return participantCount - setupPairs.count
    }

    func setupInputDidChange() {
        setupErrorMessage = nil
    }

    @discardableResult
    func addSetupPerson() -> UnitID? {
        guard !isSetupDraftLocked, canAddSetupPerson else { return nil }
        let unit = [UnitID.sam, .leo].first(where: { !setupPersonUnits.contains($0) })
            ?? .remote(NumaSharedCore.UnitID.generate())
        setupPersonUnits.append(unit)
        setupErrorMessage = nil
        return unit
    }

    func removeSetupPerson(_ unit: UnitID) {
        guard !isSetupDraftLocked, let index = setupPersonUnits.firstIndex(of: unit) else { return }
        setupPersonUnits.remove(at: index)
        if unit == .sam { samDisplayName = "" }
        if unit == .leo { leoDisplayName = "" }
        additionalSetupNames[unit] = nil
        setupPairs.removeAll { $0.contains(unit) }
        setupErrorMessage = nil
    }

    func groupSetupUnits(_ source: UnitID, with target: UnitID) -> Bool {
        guard !isSetupDraftLocked, source != target,
              (source == .am || setupPersonUnits.contains(source)),
              (target == .am || setupPersonUnits.contains(target)),
              setupName(for: source).isEmpty == false,
              setupName(for: target).isEmpty == false
        else { return false }
        guard !setupPairs.contains(where: { $0.contains(source) || $0.contains(target) }) else { return false }
        guard setupPersonUnits.count + 1 + setupPairs.count + 1 <= 64 else {
            setupErrorMessage = "This household has reached its group identity limit."
            return false
        }
        setupPairs.append([source, target])
        setupErrorMessage = nil
        Haptics.locked()
        return true
    }

    func toggleSetupGrouping(_ unit: UnitID) {
        guard !isSetupDraftLocked else { return }
        if setupGroupedUnits.contains(unit) { setupPairs.removeAll { $0.contains(unit) } }
        else { _ = groupSetupUnits(unit, with: .am) }
    }

    func clearSetupGrouping() {
        guard !isSetupDraftLocked else { return }
        setupPairs.removeAll()
    }

    func setupName(for unit: UnitID) -> String {
        if unit == .am { return Self.trimmedSetupValue(ownerDisplayName) }
        if unit == .sam { return Self.trimmedSetupValue(samDisplayName) }
        if unit == .leo { return Self.trimmedSetupValue(leoDisplayName) }
        return Self.trimmedSetupValue(additionalSetupNames[unit] ?? "")
    }

    func goWelcome() {
        if isCreatingAdditionalPot {
            cancelNewPot()
            return
        }
        setupErrorMessage = nil
        screen = .welcome
    }

    // MARK: - Local pots (v1.1 multi-pot)

    func openPotSwitcher() {
        potSwitcherPresented = true
    }

    /// Switching and creating are local-first: while sync is enabled it
    /// stays bound to its pot, so both actions require sync off.
    var canManagePots: Bool {
        !isSyncEnabled
            && !isCreatingAdditionalPot
            && !isBootstrapping
            && localDataErrorMessage == nil
    }

    func switchPot(to id: UUID) {
        guard canManagePots,
              id != activePotID,
              let descriptor = localPots.first(where: { $0.id == id })
        else { return }
        potSwitcherPresented = false
        isBootstrapping = true
        let source = repository
        let target = potRepository(for: descriptor)
        Task { [weak self] in
            do {
                let snapshot = try await target.bootstrap(seedCasaMar: false)
                guard let self, self.repository === source else { return }
                if registryPersists {
                    try PotRegistry.save(.init(pots: localPots, activeID: id))
                }
                retireSyncRuntime()
                repository = target
                activePotID = id
                appliedRevision = -1
                apply(snapshot, animated: false)
                isBootstrapping = false
                await configureSync()
            } catch {
                guard let self, self.repository === source else { return }
                isBootstrapping = false
                presentLocalDataFailure(blocking: false, error: error)
            }
        }
    }

    func beginNewPot() {
        guard canManagePots else { return }
        potSwitcherPresented = false
        newPotReturn = (repository, activePotID)
        let pendingID = UUID()
        let databaseName = registryPersists
            ? PotRegistry.newDatabaseName()
            : "ephemeral-\(pendingID.uuidString)"
        pendingNewPot = (pendingID, databaseName)
        pendingCompletedSetup = nil
        let fresh: AppLedgerRepository
        if registryPersists {
            fresh = AppLedgerRepository(storageMode: .persistent, databaseName: databaseName, readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
        } else {
            fresh = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
            ephemeralPotStores[pendingID] = fresh
        }
        retireSyncRuntime()
        repository = fresh
        isCreatingAdditionalPot = true
        resetSetupFields()
        screen = .create
    }

    func cancelNewPot() {
        guard isCreatingAdditionalPot, let back = newPotReturn else { return }
        if let pending = pendingNewPot {
            if registryPersists {
                do {
                    try PotRegistry.deleteStore(named: pending.databaseName)
                } catch {
                    setupErrorMessage = String(
                        localized: "This pot couldn’t be removed. Try again."
                    )
                    Haptics.warned()
                    return
                }
            } else {
                ephemeralPotStores[pending.id] = nil
            }
        }
        retireSyncRuntime()
        repository = back.repository
        activePotID = back.potID
        pendingNewPot = nil
        newPotReturn = nil
        pendingCompletedSetup = nil
        isCreatingAdditionalPot = false
        setupErrorMessage = nil
        screen = .home
        reloadActivePot(from: back.repository)
    }

    private func configureLocalPotRegistry(persistent: Bool) {
        registryPersists = persistent
        if persistent {
            do {
                try loadPersistentPotRegistry()
            } catch {
                presentLocalDataFailure(blocking: true, error: error)
            }
        } else {
            let descriptor = LocalPotDescriptor(
                id: UUID(),
                name: "",
                currencyCode: potCurrency.code,
                databaseName: "ephemeral",
                createdAt: Date()
            )
            localPots = [descriptor]
            activePotID = descriptor.id
            // The in-memory store lives only as this instance — cache it so
            // switching away and back never opens a fresh empty store.
            ephemeralPotStores[descriptor.id] = repository
        }
    }

    private func loadPersistentPotRegistry() throws {
        let state: PotRegistry.State
        if let stored = try PotRegistry.load() {
            state = stored
        } else {
            let id = UUID()
            state = .init(
                pots: [LocalPotDescriptor(
                    id: id,
                    name: "",
                    currencyCode: potCurrency.code,
                    databaseName: PotRegistry.legacyDatabaseName,
                    createdAt: Date()
                )],
                activeID: id
            )
            try PotRegistry.save(state)
        }
        guard let active = state.pots.first(where: { $0.id == state.activeID }) else {
            throw PotRegistry.RegistryError.missingActivePot
        }
        repository = AppLedgerRepository(
            storageMode: .persistent,
            databaseName: active.databaseName
        , readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
        localPots = state.pots
        activePotID = state.activeID
    }

    private func potRepository(for descriptor: LocalPotDescriptor) -> AppLedgerRepository {
        if registryPersists {
            return AppLedgerRepository(
                storageMode: .persistent,
                databaseName: descriptor.databaseName
            , readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
        }
        if let cached = ephemeralPotStores[descriptor.id] { return cached }
        let fresh = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: EventEnvelope.budgetGroupSchemaVersion)
        ephemeralPotStores[descriptor.id] = fresh
        return fresh
    }

    private func reloadActivePot(from repository: AppLedgerRepository) {
        isBootstrapping = true
        Task { [weak self] in
            do {
                let snapshot = try await repository.bootstrap(seedCasaMar: false)
                guard let self, self.repository === repository else { return }
                self.appliedRevision = -1
                self.apply(snapshot, animated: false)
                self.isBootstrapping = false
                await self.configureSync()
            } catch {
                guard let self, self.repository === repository else { return }
                self.isBootstrapping = false
                self.presentLocalDataFailure(blocking: true, error: error)
            }
        }
    }

    private func resetSetupFields() {
        potName = ""
        samDisplayName = ""
        leoDisplayName = ""
        setupPersonUnits = []
        setupPairs = []
        additionalSetupNames = [:]
        potCurrency = CurrencyCatalog.suggested()
        isPotCurrencyConfirmed = false
        setupErrorMessage = nil
    }

    private func registerPendingPotIfNeeded() throws {
        guard isCreatingAdditionalPot, let pending = pendingNewPot else { return }
#if DEBUG
        if failsNextSetupRegistrationForTesting {
            failsNextSetupRegistrationForTesting = false
            throw CocoaError(.fileWriteNoPermission)
        }
#endif
        let descriptor = LocalPotDescriptor(
            id: pending.id,
            name: potName,
            currencyCode: potCurrency.code,
            databaseName: pending.databaseName,
            createdAt: Date()
        )
        let updatedPots = localPots + [descriptor]
        if registryPersists {
            try PotRegistry.save(.init(
                pots: updatedPots,
                activeID: pending.id
            ))
        }
        localPots = updatedPots
        activePotID = pending.id
        pendingNewPot = nil
        newPotReturn = nil
        isCreatingAdditionalPot = false
    }

    private func refreshActivePotDescriptor() {
        guard !isCreatingAdditionalPot,
              let activePotID,
              let index = localPots.firstIndex(where: { $0.id == activePotID }),
              localPots[index].name != potName
                || localPots[index].currencyCode != potCurrency.code
        else { return }
        var updatedPots = localPots
        updatedPots[index].name = potName
        updatedPots[index].currencyCode = potCurrency.code
        if registryPersists {
            do {
                try PotRegistry.save(.init(
                    pots: updatedPots,
                    activeID: activePotID
                ))
            } catch {
                localPots = updatedPots
                persistenceFailed(error)
                return
            }
        }
        localPots = updatedPots
    }

    func goCreate() {
        guard !isSetupDraftLocked else { return }
        setupErrorMessage = nil
        screen = .create
    }

    func goPeople() {
        guard !isSetupDraftLocked else { return }
        guard Self.isValidSetupValue(potName),
              isPotCurrencyConfirmed
        else {
            setupErrorMessage = isPotCurrencyConfirmed
                ? String(localized: "Enter a household name.")
                : String(localized: "Confirm the pot currency.")
            Haptics.warned()
            return
        }
        setupErrorMessage = nil
        screen = .people
    }

    func selectPotCurrency(_ currency: Currency) {
        guard !isSetupDraftLocked else { return }
        potCurrency = currency
        isPotCurrencyConfirmed = true
        setupErrorMessage = nil
    }

    func finishSetup() {
        persistSetup(then: .home)
    }

    func continueToOpeningBalance() {
        persistSetup(then: .openingBalance)
    }

    private func persistSetup(then destination: Screen) {
        guard !isCompletingSetup else { return }
        guard canCompleteSetup else {
            setupErrorMessage = setupSettlementUnitCount < 2
                ? String(localized: "Keep at least two balance groups separate.")
                : String(localized: "Add at least one person and enter every name.")
            Haptics.warned()
            return
        }
        let potName = Self.trimmedSetupValue(potName)
        let ownerDisplayName = Self.trimmedSetupValue(ownerDisplayName)
        let samDisplayName = setupPersonUnits.contains(.sam)
            ? Self.trimmedSetupValue(samDisplayName)
            : nil
        let leoDisplayName = setupPersonUnits.contains(.leo)
            ? Self.trimmedSetupValue(leoDisplayName)
            : nil
        let groupedMemberUnits = destination == .home ? setupGroupedUnits : []
        let people = ([UnitID.am] + setupPersonUnits).map { ($0, setupName(for: $0)) }
        let pairs = setupPairs
        let useNewSetup = readerSchemaVersion >= 2
        let currency = potCurrency
        isCompletingSetup = true
        setupErrorMessage = nil
        if let pending = pendingCompletedSetup {
            do {
                try registerPendingPotIfNeeded()
                pendingCompletedSetup = nil
                apply(pending.snapshot)
                isCompletingSetup = false
                screen = pending.destination
                Haptics.saved()
                Task { [weak self] in
                    await self?.configureSync()
                    await self?.syncRuntime?.synchronizeNow()
                }
            } catch {
                isCompletingSetup = false
                setupErrorMessage = String(
                    localized: "Setup couldn’t be saved. Try again."
                )
                Haptics.warned()
            }
            return
        }
        let repository = repository
        Task { [weak self] in
            do {
                let snapshot: AppLedgerSnapshot
                if useNewSetup {
                    snapshot = try await repository.completeBudgetGroupSetup(potName: potName, currency: currency,
                        people: people, pairs: pairs)
                } else {
                    snapshot = try await repository.completeLocalSetup(
                    potName: potName,
                    currency: currency,
                    ownerDisplayName: ownerDisplayName,
                    samDisplayName: samDisplayName,
                    leoDisplayName: leoDisplayName,
                    groupedMemberUnits: groupedMemberUnits
                    )
                }
                // Register BEFORE apply: apply's descriptor refresh must
                // see the new pot as active, not rename the previous one.
                if self?.isCreatingAdditionalPot == true {
                    self?.pendingCompletedSetup = (snapshot, destination)
                }
                try self?.registerPendingPotIfNeeded()
                self?.pendingCompletedSetup = nil
                self?.apply(snapshot)
                self?.isCompletingSetup = false
                self?.screen = destination
                Haptics.saved()
                await self?.configureSync()
                await self?.syncRuntime?.synchronizeNow()
            } catch {
                self?.isCompletingSetup = false
                self?.setupErrorMessage = String(
                    localized: "Setup couldn’t be saved. Try again."
                )
                Haptics.warned()
            }
        }
    }

    func skipOpeningBalance() {
        if usesBudgetGroups { screen = .home }
        else { finalizeSetupGroup(then: nil) }
    }

    func saveBudgetGroupOpeningBalance(entries: [UnitID: Int64]) {
        guard usesBudgetGroups, !isSavingOpeningBalance, !isPersisting,
              entries.values.contains(where: { $0 != 0 }) else { return }
        isSavingOpeningBalance = true
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.appendOpeningBalance(title: "Opening balances before Numa Shared", entries: entries)
                self?.apply(mutation.snapshot)
                self?.isSavingOpeningBalance = false
                self?.screen = .home
                self?.setUndo(text: "Opening balances saved", eventID: mutation.eventID, deadline: mutation.undoDeadline)
            } catch {
                self?.isSavingOpeningBalance = false
                self?.openingBalanceErrorMessage = "Opening balances couldn’t be saved. Check the amounts and try again."
            }
        }
    }

    func saveOpeningBalance(
        samText: String,
        samRelation: OpeningBalanceRelation,
        leoText: String,
        leoRelation: OpeningBalanceRelation,
        locale: Locale = .current
    ) {
        guard !isSavingOpeningBalance,
              let entries = Self.openingBalanceEntries(
                  samText: samText,
                  samRelation: samRelation,
                  leoText: leoText,
                  leoRelation: leoRelation,
                  locale: locale,
                  currency: potCurrency
              ),
              entries.values.contains(where: { $0 != 0 })
        else {
            openingBalanceErrorMessage = localizedFormat(
                "Enter at least one amount with up to %lld decimal places.",
                Int64(potCurrency.exponent)
            )
            Haptics.warned()
            return
        }
        isSavingOpeningBalance = true
        openingBalanceErrorMessage = nil
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.appendOpeningBalance(
                    title: String(localized: "Opening balances before Numa Shared"),
                    entries: entries
                )
                guard let self else { return }
                let grouped = try await repository.appendSetupGroup(
                    setupGroupedUnits
                )
                apply(grouped?.snapshot ?? mutation.snapshot)
                isSavingOpeningBalance = false
                screen = .home
                Haptics.saved()
                setUndo(
                    text: String(localized: "Opening balances saved"),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.isSavingOpeningBalance = false
                self?.openingBalanceErrorMessage = String(
                    localized: "Opening balances couldn’t be saved. Try again."
                )
                Haptics.warned()
            }
        }
    }

    private func finalizeSetupGroup(then completion: (() -> Void)?) {
        guard !isSavingOpeningBalance else { return }
        isSavingOpeningBalance = true
        openingBalanceErrorMessage = nil
        let repository = repository
        let groupedUnits = setupGroupedUnits
        Task { [weak self] in
            do {
                if let mutation = try await repository.appendSetupGroup(groupedUnits) {
                    self?.apply(mutation.snapshot)
                }
                self?.isSavingOpeningBalance = false
                self?.screen = .home
                completion?()
            } catch {
                self?.isSavingOpeningBalance = false
                self?.openingBalanceErrorMessage = String(
                    localized: "Setup couldn’t be saved. Try again."
                )
                Haptics.warned()
            }
        }
    }

    nonisolated static func groupOpeningBalanceEntries(texts: [UnitID: String], relations: [UnitID: OpeningBalanceRelation],
        units: [UnitID], owner: UnitID, locale: Locale, currency: Currency) -> [UnitID: Int64]? {
        var entries: [UnitID: Int64] = [:]
        var total: Int64 = 0
        for unit in units where unit != owner {
            guard let amount = openingBalanceMagnitude(texts[unit] ?? "", locale: locale, currency: currency) else { return nil }
            let value = signedOpeningBalance(amount, relation: relations[unit] ?? .owesHousehold)
            let next = total.addingReportingOverflow(value)
            guard !next.overflow else { return nil }
            total = next.partialValue
            entries[unit] = value
        }
        guard total != .min else { return nil }
        entries[owner] = -total
        return entries
    }

    nonisolated static func openingBalanceEntries(
        samText: String,
        samRelation: OpeningBalanceRelation,
        leoText: String,
        leoRelation: OpeningBalanceRelation,
        locale: Locale,
        currency: Currency = .eur
    ) -> [UnitID: Int64]? {
        guard let samMagnitude = openingBalanceMagnitude(
            samText,
            locale: locale,
            currency: currency
        ),
        let leoMagnitude = openingBalanceMagnitude(
            leoText,
            locale: locale,
            currency: currency
        ) else { return nil }
        let sam = signedOpeningBalance(
            samMagnitude,
            relation: samRelation
        )
        let leo = signedOpeningBalance(
            leoMagnitude,
            relation: leoRelation
        )
        let (memberTotal, overflow) = sam.addingReportingOverflow(leo)
        guard !overflow, memberTotal != Int64.min else { return nil }
        return [.am: -memberTotal, .sam: sam, .leo: leo]
    }

    nonisolated private static func openingBalanceMagnitude(
        _ rawValue: String,
        locale: Locale,
        currency: Currency
    ) -> Int64? {
        let value = rawValue.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        if value.isEmpty { return 0 }
        let separator = locale.decimalSeparator ?? "."
        let separators = separator == "." ? ["."] : [separator, "."]
        var normalized = value
        for candidate in separators where candidate != "." {
            normalized = normalized.replacingOccurrences(
                of: candidate,
                with: "."
            )
        }
        let components = normalized.split(
            separator: ".",
            maxSplits: 2,
            omittingEmptySubsequences: false
        )
        guard components.count <= 2 else { return nil }
        let whole = String(components[0])
        let fraction = components.count == 2 ? String(components[1]) : nil
        guard !whole.isEmpty,
              whole.allSatisfy(\.isNumber),
              fraction?.allSatisfy(\.isNumber) ?? true,
              let input = try? MoneyInput(
                  wholeDigits: whole,
                  fractionalDigits: fraction
              ),
              let money = try? input.money(currency: currency),
              money.minorUnits >= 0
        else { return nil }
        return money.minorUnits
    }

    nonisolated private static func signedOpeningBalance(
        _ magnitude: Int64,
        relation: OpeningBalanceRelation
    ) -> Int64 {
        switch relation {
        case .owesHousehold: -magnitude
        case .householdOwesMember: magnitude
        }
    }

    nonisolated static func isValidSetupValue(_ value: String) -> Bool {
        let trimmed = trimmedSetupValue(value)
        return !trimmed.isEmpty
            && trimmed.utf16.count <= 128
            && trimmed != WireEventV1.redactedTextPlaceholder
    }

    private nonisolated static func trimmedSetupValue(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

#if DEBUG
    func loadJulySeed() {
        guard !isPersisting, canWrite else { Haptics.warned(); return }
        isPersisting = true
        let repository = repository
        Task { [weak self] in
            do {
                let snapshot = try await repository.loadCasaMarSeed()
                self?.apply(snapshot)
                self?.isPersisting = false
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }
#endif

    func restart() {
        screen = .welcome
        sheet = .none
        activityFilter = nil
        clearUndo()
#if DEBUG
        guard usesEphemeralQAStore else { return }
        let repository = repository
        Task { [weak self] in
            do {
                if let snapshot = try await repository.resetEphemeral() {
                    self?.appliedRevision = -1
                    self?.apply(snapshot, animated: false)
                }
            } catch {
                self?.persistenceFailed(error)
            }
        }
#endif
    }

    // MARK: - Add-expense

    func beginAdd(prefilling units: Set<UnitID> = []) {
        guard canWrite else { Haptics.warned(); return }
        amountInt = ""
        amountFrac = nil
        merchant = ""
        category = ""
        expenseDate = homePresentationDate
        expensePayer = currentUnitID
        expensePayerMemberID = usesBudgetGroups ? currentMemberID : nil
        attached = units.intersection(expenseBeneficiaryUnitIDs)
        homeLockedAll = false
        shares = Dictionary(uniqueKeysWithValues: ledgerUnitIDs.map { ($0, 1) })
        if !usesBudgetGroups { shares[currentUnitID] = 2 }
        expenseSplitMode = .shares
        exactParts = [:]
        exactSplitDrafts = [:]
        lockedExactUnits = []
        exactSplitErrorMessage = nil
        showSplitPreview = false
        addPresented = true
    }

    func closeAdd() {
        addPresented = false
        showSplitPreview = false
    }

    func key(_ key: String) {
        (amountInt, amountFrac) = Self.editKey(
            amountInt,
            amountFrac,
            key,
            currency: potCurrency
        )
    }

    nonisolated static func editKey(
        _ intPart: String,
        _ fracPart: String?,
        _ key: String,
        locale: Locale = .current,
        currency: Currency = .eur
    ) -> (String, String?) {
        guard let input = try? MoneyInput(
            wholeDigits: intPart,
            fractionalDigits: fracPart
        ) else { return (intPart, fracPart) }

        let inputKey: MoneyInputKey
        if key == "⌫" {
            inputKey = .backspace
        } else if key == "." || key == (locale.decimalSeparator ?? ".") {
            inputKey = .decimalSeparator
        } else if let digit = Int(key) {
            inputKey = .digit(digit)
        } else {
            return (intPart, fracPart)
        }
        let edited = input.applying(inputKey, currency: currency)
        return (edited.wholeDigits, edited.fractionalDigits)
    }

    func centsOf(_ intPart: String, _ fracPart: String?) -> Int64 {
        guard let input = try? MoneyInput(
            wholeDigits: intPart,
            fractionalDigits: fracPart
        ), let amount = try? input.money(currency: potCurrency) else {
            return 0
        }
        return amount.minorUnits
    }

    func displayAmount(_ intPart: String, _ fracPart: String?) -> String {
        Self.displayAmount(intPart, fracPart, currency: potCurrency)
    }

    nonisolated static func displayAmount(
        _ intPart: String,
        _ fracPart: String?,
        locale: Locale = .current,
        currency: Currency = .eur
    ) -> String {
        guard let input = try? MoneyInput(
            wholeDigits: intPart,
            fractionalDigits: fracPart
        ), let amount = try? input.money(currency: currency) else {
            return money(
                decimalMinorUnits: 0,
                currency: currency,
                fractionDigits: 0,
                locale: locale
            )
        }

        let typedDigits = fracPart?.count ?? 0
        let keepsSeparator = fracPart?.isEmpty == true
        var formatted = money(
            decimalMinorUnits: Decimal(amount.minorUnits),
            currency: currency,
            fractionDigits: keepsSeparator ? 1 : typedDigits,
            locale: locale
        )
        if keepsSeparator,
           let placeholder = formatted.lastIndex(where: { $0.wholeNumberValue != nil }) {
            formatted.remove(at: placeholder)
        }
        return formatted
    }

    var addedAmountCents: Int64 { centsOf(amountInt, amountFrac) }
    var canReviewSplit: Bool { addedAmountCents > 0 && !attached.isEmpty }
    var expenseBeneficiaryUnitIDs: [UnitID] { usesBudgetGroups ? activeBudgetUnitIDs : ledgerUnitIDs }
    var attachedKeys: [UnitID] { expenseBeneficiaryUnitIDs.filter(attached.contains) }
    var expensePayerDescription: String {
        if usesBudgetGroups {
            return payerPeople.first { $0.memberID == expensePayerMemberID }.map(personName) ?? "Choose person"
        }
        return expensePayer == currentUnitID
            ? currentPayerDescription
            : unitInfo(for: expensePayer).name
    }
    var canSaveExpense: Bool {
        guard canReviewSplit, !usesBudgetGroups || payerPeople.contains(where: { $0.memberID == expensePayerMemberID && $0.budgetUnitID == expensePayer }) else { return false }
        if expenseSplitMode == .shares { return true }
        guard exactSplitErrorMessage == nil,
              Set(exactParts.keys) == Set(attachedKeys) else { return false }
        var total: Int64 = 0
        for unitID in attachedKeys {
            // The saved allocation must match the text still visible in every field.
            guard let amount = exactSplitDraftAmount(for: unitID),
                  amount == exactParts[unitID] else { return false }
            let addition = total.addingReportingOverflow(amount)
            guard !addition.overflow else { return false }
            total = addition.partialValue
        }
        return total == addedAmountCents
    }

    func toggleUnit(_ unit: UnitID) {
        if attached.contains(unit) {
            attached.remove(unit)
        } else {
            attached.insert(unit)
            shares[unit] = shares[unit] ?? 1
        }
        homeLockedAll = false
        if expenseSplitMode == .exact { prepareExactSplit() }
    }

    func dropAll() {
        attached = Set(expenseBeneficiaryUnitIDs)
        homeLockedAll = true
        if expenseSplitMode == .exact { prepareExactSplit() }
    }

    func bumpShare(_ unit: UnitID, by delta: Int64) {
        guard !usesBudgetGroups else { return }
        shares[unit] = max(1, min(9, (shares[unit] ?? 1) + delta))
    }

    func allocatedParts() -> [UnitID: Int64] {
        if expenseSplitMode == .exact { return exactParts }
        return Self.allocateMinorUnits(
            total: addedAmountCents,
            weights: shares,
            orderedUnitIDs: attachedKeys
        ) ?? [:]
    }

    /// Preview only; accepted balances still come exclusively from replay.
    /// Apply the record's net contribution, avoiding overflow-prone intermediate totals.
    func expenseBalanceAfter(for unit: UnitID) -> Int64? {
        guard canSaveExpense else { return nil }
        let part = allocatedParts()[unit] ?? 0
        let before = balances[unit] ?? 0
        let change = unit == expensePayer ? addedAmountCents - part : -part
        let result = before.addingReportingOverflow(change)
        return result.overflow ? nil : result.partialValue
    }

    var expenseImpactDescription: String? {
        let units = ledgerUnitIDs
        let after = units.compactMap { unit -> (UnitID, Int64)? in
            expenseBalanceAfter(for: unit).map { (unit, $0) }
        }
        guard after.count == units.count else { return nil }
        return expenseImpactDescription(after: Dictionary(uniqueKeysWithValues: after))
    }

    func expenseImpactDescription(after balances: [UnitID: Int64]) -> String {
        let after = balances.sorted { $0.key.rawValue < $1.key.rawValue }.map { ($0.key, $0.value) }
        if after.allSatisfy({ $0.1 == 0 }) { return "After saving, no one owes anyone." }
        if after.count == 2, let debtor = after.first(where: { $0.1 < 0 }),
           let creditor = after.first(where: { $0.1 > 0 }) {
            return "After saving, \(unitInfo(for: debtor.0).name) owe \(unitInfo(for: creditor.0).name) \(fmtMagnitude(debtor.1))."
        }
        return "After saving, " + after.filter { $0.1 != 0 }.map { unit, value in
            "\(unitInfo(for: unit).name) \(value < 0 ? "owe" : "get back") \(fmtMagnitude(value)) overall"
        }.joined(separator: "; ") + "."
    }

    nonisolated static func allocateMinorUnits(
        total: Int64,
        weights: [UnitID: Int64],
        orderedUnitIDs: [UnitID]
    ) -> [UnitID: Int64]? {
        try? MinorUnitAllocator.allocate(
            total: total,
            weights: weights,
            orderedUnitIDs: orderedUnitIDs
        )
    }

    func openSplitPreview() {
        guard canReviewSplit else { return }
        expenseSplitMode = .shares
        prepareExactSplit()
        showSplitPreview = true
    }

    func closeSplitPreview() { showSplitPreview = false }

    func selectExpenseSplitMode(_ mode: ExpenseSplitMode) {
        expenseSplitMode = mode
        if mode == .exact { prepareExactSplit() }
    }

    func exactSplitDraft(for unitID: UnitID) -> String {
        exactSplitDrafts[unitID] ?? formatExactSplitDraft(exactParts[unitID] ?? 0)
    }

    func updateExactSplitDraft(_ rawValue: String, for unitID: UnitID) {
        guard attached.contains(unitID) else { return }
        exactSplitDrafts[unitID] = rawValue
        lockedExactUnits.insert(unitID)
        rebalanceExactSplit()
    }

    private func exactSplitDraftAmount(for unitID: UnitID) -> Int64? {
        Self.parseMinorUnits(
            exactSplitDraft(for: unitID),
            locale: .current,
            currency: potCurrency
        )
    }

    func toggleExactSplitLock(_ unitID: UnitID) {
        guard attached.contains(unitID) else { return }
        if lockedExactUnits.contains(unitID) {
            lockedExactUnits.remove(unitID)
        } else {
            lockedExactUnits.insert(unitID)
        }
        rebalanceExactSplit()
    }

    private func prepareExactSplit() {
        let keys = attachedKeys
        guard !keys.isEmpty else { return }
        var existingTotal: Int64 = 0
        var existingTotalIsValid = true
        for unitID in keys {
            let next = existingTotal.addingReportingOverflow(exactParts[unitID] ?? 0)
            if next.overflow {
                existingTotalIsValid = false
                break
            }
            existingTotal = next.partialValue
        }
        if Set(exactParts.keys) != Set(keys)
            || !existingTotalIsValid
            || existingTotal != addedAmountCents {
            exactParts = Self.allocateMinorUnits(
                total: addedAmountCents,
                weights: shares,
                orderedUnitIDs: keys
            ) ?? [:]
            lockedExactUnits = []
        }
        exactSplitDrafts = Dictionary(uniqueKeysWithValues: keys.map {
            ($0, formatExactSplitDraft(exactParts[$0] ?? 0))
        })
        exactSplitErrorMessage = nil
    }

    private func rebalanceExactSplit() {
        let keys = attachedKeys
        lockedExactUnits.formIntersection(keys)
        var lockedTotal: Int64 = 0
        for unitID in keys where lockedExactUnits.contains(unitID) {
            // Revalidate all edited fields, not only the one most recently changed.
            guard let amount = exactSplitDraftAmount(for: unitID) else {
                exactSplitErrorMessage = localizedFormat(
                    "Enter an amount with up to %lld decimal places.",
                    Int64(potCurrency.exponent)
                )
                return
            }
            exactParts[unitID] = amount
            let result = lockedTotal.addingReportingOverflow(amount)
            guard !result.overflow else {
                exactSplitErrorMessage = String(localized: "The locked amounts are too large.")
                return
            }
            lockedTotal = result.partialValue
        }
        guard lockedTotal <= addedAmountCents else {
            exactSplitErrorMessage = String(localized: "Locked amounts exceed the expense total.")
            return
        }
        let unlocked = keys.filter { !lockedExactUnits.contains($0) }
        guard !unlocked.isEmpty else {
            exactSplitErrorMessage = lockedTotal == addedAmountCents
                ? nil
                : String(localized: "Locked amounts must add up to the expense total.")
            return
        }
        guard let distributed = Self.allocateMinorUnits(
            total: addedAmountCents - lockedTotal,
            weights: shares,
            orderedUnitIDs: unlocked
        ) else {
            exactSplitErrorMessage = String(localized: "This split couldn’t be calculated.")
            return
        }
        for unitID in unlocked {
            exactParts[unitID] = distributed[unitID] ?? 0
            exactSplitDrafts[unitID] = formatExactSplitDraft(exactParts[unitID] ?? 0)
        }
        exactSplitErrorMessage = nil
    }

    private func formatExactSplitDraft(_ amount: Int64) -> String {
        let scale = potCurrency.minorUnitScale
        let whole = amount / scale
        guard potCurrency.exponent > 0 else { return String(whole) }
        let fraction = amount % scale
        let separator = Locale.current.decimalSeparator ?? "."
        return String(whole)
            + separator
            + String(format: "%0*lld", potCurrency.exponent, fraction)
    }

    nonisolated static func parseMinorUnits(
        _ rawValue: String,
        locale: Locale,
        currency: Currency
    ) -> Int64? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        let separator = locale.decimalSeparator ?? "."
        var normalized = value
        if separator != "." {
            normalized = normalized.replacingOccurrences(of: separator, with: ".")
        }
        let components = normalized.split(
            separator: ".",
            maxSplits: 2,
            omittingEmptySubsequences: false
        )
        guard components.count <= 2 else { return nil }
        let whole = String(components[0])
        let fraction = components.count == 2 ? String(components[1]) : nil
        guard !whole.isEmpty,
              whole.allSatisfy(\.isNumber),
              fraction?.allSatisfy(\.isNumber) ?? true,
              let input = try? MoneyInput(
                  wholeDigits: whole,
                  fractionalDigits: fraction
              ),
              let money = try? input.money(currency: currency),
              money.minorUnits >= 0
        else { return nil }
        return money.minorUnits
    }

    @discardableResult
    func saveExpense(onSaved: (@MainActor (String) -> Void)? = nil) -> Bool {
        let keys = attachedKeys
        let amount = addedAmountCents
        guard !isPersisting, canWrite, canSaveExpense,
              !keys.isEmpty, amount > 0
        else { return false }
        isPersisting = true
        let title = merchant.isEmpty ? String(localized: "Expense") : merchant
        let savedCategory = category.isEmpty
            ? String(localized: "Uncategorized")
            : category
        let weights = shares
        let explicitAllocations = expenseSplitMode == .exact ? exactParts : nil
        let payer = expensePayer
        let payerMemberID = usesBudgetGroups ? expensePayerMemberID : nil
        let occurredAt = expenseDate
        let recordID = NumaSharedCore.RecordID.generate(at: occurredAt)
        let repository = repository

        Task { [weak self] in
            do {
                let mutation = try await repository.appendExpense(
                    title: title,
                    amountMinorUnits: amount,
                    payer: payer,
                    orderedUnits: keys,
                    weights: weights,
                    explicitAllocations: explicitAllocations,
                    category: savedCategory,
                    occurredAt: occurredAt,
                    payerMemberID: payerMemberID,
                    recordID: recordID
                )
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                if onSaved == nil { addPresented = false }
                showSplitPreview = false
                Haptics.saved()
                setUndo(
                    text: localizedFormat(
                        "%1$@ %2$@ saved",
                        title,
                        fmt(amount)
                    ),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
                onSaved?(recordID.description)
            } catch {
                self?.persistenceFailed(error)
            }
        }
        return true
    }

    // MARK: - Sheets

    func openActivity() { activityFilter = nil; sheet = .activity }
    func closeSheet() {
        sheet = .none
        activityFilter = nil
        detailID = nil
        detailReturnsToActivity = false
        settlementReturnsHome = false
        settlementReversalTargetID = nil
    }
    func tapOrb(_ unit: UnitID) {
        activityFilter = unit == .more ? nil : unit
        sheet = .activity
    }
    func openDetail(_ id: String) {
        detailReturnsToActivity = sheet == .activity
        detailID = id
        sheet = .detail
    }

    func leaveDetail() {
        if detailReturnsToActivity { sheet = .activity }
        else { closeSheet() }
    }

    func contestedHeadRevisions(
        for record: ExpenseRecord
    ) -> [ExpenseRevisionVersion] {
        guard let contest = record.contest else { return [] }
        let revisionsByID = Dictionary(
            uniqueKeysWithValues: record.revisionHistory.map { ($0.id, $0) }
        )
        return contest.headRevisionIDs.prefix(2).compactMap {
            revisionsByID[$0]
        }
    }

    func contestBalanceImpacts(
        for record: ExpenseRecord,
        choosing revision: ExpenseRevisionVersion
    ) -> [ExpenseBalanceImpact] {
        guard let provisionalID = record.contest?.provisionalRevisionID,
              let provisional = record.revisionHistory.first(where: {
                  $0.id == provisionalID
              })
        else { return [] }
        let beforeContribution = Self.expenseContribution(provisional)
        let afterContribution = Self.expenseContribution(revision)
        return Set(ledgerUnitIDs + Array(beforeContribution.keys) + Array(afterContribution.keys)).sorted { $0.rawValue < $1.rawValue }.compactMap { unitID in
            let delta = (afterContribution[unitID] ?? .zero)
                - (beforeContribution[unitID] ?? .zero)
            guard delta != .zero else { return nil }
            let before = Decimal(balances[unitID] ?? 0)
            return ExpenseBalanceImpact(
                id: unitID,
                beforeMinorUnits: before,
                afterMinorUnits: before + delta
            )
        }
    }

    func contestBalanceState(
        _ minorUnits: Decimal,
        for unitID: UnitID
    ) -> String {
        let name = unitInfo(for: unitID).name
        if minorUnits > .zero {
            return localizedFormat(
                "%1$@ gets back %2$@",
                name,
                money(
                    decimalMinorUnits: minorUnits,
                    currency: potCurrency,
                    hidden: hideAmounts
                )
            )
        }
        if minorUnits < .zero {
            return localizedFormat(
                "%1$@ owes %2$@",
                name,
                money(
                    decimalMinorUnits: -minorUnits,
                    currency: potCurrency,
                    hidden: hideAmounts
                )
            )
        }
        return localizedFormat("%@ is even", name)
    }

    func resolveContestedRecord(
        choosing revision: ExpenseRevisionVersion,
        comparedWith otherRevision: ExpenseRevisionVersion
    ) {
        guard !isPersisting, canWrite,
              let recordID = detailID,
              revision.id != otherRevision.id
        else { return }
        isPersisting = true
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.resolveExpenseContest(
                    recordID: recordID,
                    choosing: revision.id,
                    comparedWith: otherRevision.id
                )
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                Haptics.saved()
                setUndo(
                    text: localizedFormat(
                        "Choice recorded for %@",
                        revision.title
                    ),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }

    nonisolated private static func expenseContribution(
        _ revision: ExpenseRevisionVersion
    ) -> [UnitID: Decimal] {
        var result = Dictionary(
            uniqueKeysWithValues: Set(revision.parts.keys)
                .union([revision.payer])
                .map { ($0, Decimal.zero) }
        )
        result[revision.payer, default: .zero] += Decimal(revision.amountCents)
        for (unitID, minorUnits) in revision.parts {
            result[unitID, default: .zero] -= Decimal(minorUnits)
        }
        return result
    }

    private func expenseContribution(
        payer: UnitID,
        amountMinorUnits: Int64,
        parts: [UnitID: Int64]
    ) -> [UnitID: Decimal] {
        var result = Dictionary(
            uniqueKeysWithValues: Set(parts.keys)
                .union([payer])
                .map { ($0, Decimal.zero) }
        )
        result[payer, default: .zero] += Decimal(amountMinorUnits)
        for (unitID, minorUnits) in parts {
            result[unitID, default: .zero] -= Decimal(minorUnits)
        }
        return result
    }

    var editAmountMinorUnits: Int64 {
        centsOf(editAmountInt, editAmountFrac)
    }

    var canSaveExpenseEdit: Bool {
        guard let record = editingRecord else { return false }
        let title = editTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let category = editCategory.trimmingCharacters(in: .whitespacesAndNewlines)
        let changed = title != record.title || category != (record.category ?? "")
            || editAmountMinorUnits != record.amountCents
        return canWrite && !isPersisting && changed && record.contest == nil
            && !record.voided
            && !title.isEmpty
            && editAmountMinorUnits > 0
    }

    var editBalanceImpacts: [ExpenseBalanceImpact] {
        guard let record = editingRecord,
              let revisedParts = editAllocatedParts(for: record)
        else { return [] }
        let beforeContribution = expenseContribution(
            payer: record.payer,
            amountMinorUnits: record.amountCents,
            parts: record.parts
        )
        let afterContribution = expenseContribution(
            payer: record.payer,
            amountMinorUnits: editAmountMinorUnits,
            parts: revisedParts
        )
        return Set(ledgerUnitIDs + Array(record.parts.keys) + [record.payer]).sorted { $0.rawValue < $1.rawValue }.compactMap { unitID in
            let delta = (afterContribution[unitID] ?? .zero)
                - (beforeContribution[unitID] ?? .zero)
            guard delta != .zero else { return nil }
            let before = Decimal(balances[unitID] ?? 0)
            return ExpenseBalanceImpact(
                id: unitID,
                beforeMinorUnits: before,
                afterMinorUnits: before + delta
            )
        }
    }

    var voidBalanceImpacts: [ExpenseBalanceImpact] {
        guard let record = editingRecord else { return [] }
        let contribution = expenseContribution(
            payer: record.payer,
            amountMinorUnits: record.amountCents,
            parts: record.parts
        )
        return Set(ledgerUnitIDs + Array(record.parts.keys) + [record.payer]).sorted { $0.rawValue < $1.rawValue }.compactMap { unitID in
            let delta = -(contribution[unitID] ?? .zero)
            guard delta != .zero else { return nil }
            let before = Decimal(balances[unitID] ?? 0)
            return ExpenseBalanceImpact(
                id: unitID,
                beforeMinorUnits: before,
                afterMinorUnits: before + delta
            )
        }
    }

    private var editingRecord: ExpenseRecord? {
        guard let detailID else { return nil }
        return records.first { $0.id == detailID }
    }

    var canRepeatRecord: Bool {
        guard let record = editingRecord else { return false }
        return canWrite
            && !isPersisting
            && (record.kind == .expense || record.kind == .personal)
            && record.deliveryState != .failed
            && !record.voided
            && record.contest == nil
    }

    func repeatRecord() {
        guard canRepeatRecord, let record = editingRecord else { return }
        isPersisting = true
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.repeatExpense(recordID: record.id)
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                detailID = nil
                sheet = .activity
                Haptics.saved()
                setUndo(
                    text: localizedFormat("%@ repeated", record.title),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }

    private func editAllocatedParts(
        for record: ExpenseRecord
    ) -> [UnitID: Int64]? {
        if editAmountMinorUnits == record.amountCents {
            return record.parts
        }
        let ordered = record.allocationUnitIDs.isEmpty
            ? record.parts.keys.sorted { $0.rawValue < $1.rawValue } : record.allocationUnitIDs
        let weights = Dictionary(uniqueKeysWithValues: ordered.map {
            ($0, max(1, record.parts[$0] ?? 0))
        })
        return Self.allocateMinorUnits(
            total: editAmountMinorUnits,
            weights: weights,
            orderedUnitIDs: ordered
        )
    }

    func beginEditRecord() {
        guard let record = editingRecord,
              record.kind == .expense || record.kind == .personal,
              record.deliveryState != .failed,
              !record.voided,
              record.contest == nil
        else { return }
        editTitle = record.title
        editCategory = record.category ?? ""
        let scale = potCurrency.minorUnitScale
        editAmountInt = String(record.amountCents / scale)
        if potCurrency.exponent > 0 {
            let fraction = String(record.amountCents % scale)
            editAmountFrac = String(
                repeating: "0",
                count: max(0, potCurrency.exponent - fraction.count)
            ) + fraction
        } else {
            editAmountFrac = nil
        }
        sheet = .editExpense
    }

    func editExpenseKey(_ key: String) {
        (editAmountInt, editAmountFrac) = Self.editKey(
            editAmountInt,
            editAmountFrac,
            key,
            currency: potCurrency
        )
    }

    func clearExpenseEditAmount() {
        guard !isPersisting else { return }
        editAmountInt = ""
        editAmountFrac = nil
    }

    func cancelRecordAction() {
        sheet = .detail
        voidReasonDraft = ""
    }

    func saveExpenseEdit() {
        guard !isPersisting, canWrite, canSaveExpenseEdit,
              let record = editingRecord
        else { return }
        isPersisting = true
        let id = record.id
        let title = editTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let amount = editAmountMinorUnits
        let category = editCategory.trimmingCharacters(in: .whitespacesAndNewlines)
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.appendExpenseRevision(
                    recordID: id,
                    title: title,
                    amountMinorUnits: amount,
                    category: category.isEmpty ? nil : category
                )
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                sheet = .detail
                Haptics.saved()
                setUndo(
                    text: localizedFormat("%@ updated", title),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }

    func beginVoidRecord() {
        guard let record = editingRecord,
              record.kind != .settlement,
              record.deliveryState != .failed,
              !record.voided
        else { return }
        voidReasonDraft = ""
        sheet = .voidRecord
    }

    func confirmVoidRecord() {
        guard !isPersisting, canWrite,
              let id = detailID,
              let record = records.first(where: { $0.id == id }),
              record.kind != .settlement,
              !record.voided,
              !voidReasonDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        isPersisting = true
        let reason = voidReasonDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.appendVoid(
                    recordID: id,
                    reason: reason
                )
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                voidReasonDraft = ""
                sheet = .activity
                setUndo(
                    text: localizedFormat("%@ voided", record.title),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }

    func restoreRecord() {
        guard !isPersisting, canWrite,
              let id = detailID,
              let record = records.first(where: { $0.id == id }),
              record.kind != .settlement,
              record.voided
        else { return }
        isPersisting = true
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.appendRestore(recordID: id)
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                setUndo(
                    text: localizedFormat("%@ restored", record.title),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }

    func flagRecord() {
        guard !isPersisting, canWrite,
              let id = detailID,
              let record = records.first(where: { $0.id == id }),
              record.kind == .settlement,
              !record.flagged
        else { return }
        isPersisting = true
        let repository = repository
        Task { [weak self] in
            do {
                let mutation = try await repository.appendFlag(recordID: id)
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                setUndo(
                    text: localizedFormat("%@ flagged", record.title),
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }

    func openSettlePlan() {
        guard canWrite else { Haptics.warned(); return }
        if plan.count == 1, let step = plan.first {
            chooseBridge(from: step.from, to: step.to, amountCents: step.amountCents)
            settlementReturnsHome = true
            return
        }
        settlementReturnsHome = false
        settlementReversalTargetID = nil
        isManualSettlement = false
        settleFrom = nil
        sheet = .settlePlan
    }

    func chooseBridge(from: UnitID, to: UnitID, amountCents: Int64) {
        guard canWrite else { Haptics.warned(); return }
        settlementReturnsHome = false
        settlementReversalTargetID = nil
        isManualSettlement = false
        settleFrom = from
        settleTo = to
        settleDebt = amountCents
        setSettlementInput(amountCents)
        liftUnit = nil
        liftLocked = false
        sheet = .settleAmount
    }

    func beginManualSettlement() {
        guard canWrite, ledgerUnitIDs.count >= 2 else {
            Haptics.warned()
            return
        }
        settlementReversalTargetID = nil
        isManualSettlement = true
        let from = ledgerUnitIDs.first(where: { (balances[$0] ?? 0) < 0 })
            ?? ledgerUnitIDs[0]
        let to = ledgerUnitIDs.first(where: { $0 != from }) ?? ledgerUnitIDs[1]
        settleFrom = from
        settleTo = to
        let fromBalance = balances[from] ?? 0
        settleDebt = fromBalance < 0 && fromBalance != .min ? -fromBalance : 0
        sInt = ""
        sFrac = nil
        sheet = .settleAmount
    }

    func selectManualSettlementFrom(_ unitID: UnitID) {
        guard isManualSettlement, ledgerUnitIDs.contains(unitID) else { return }
        settleFrom = unitID
        if settleTo == unitID,
           let replacement = ledgerUnitIDs.first(where: { $0 != unitID }) {
            settleTo = replacement
        }
    }

    func selectManualSettlementTo(_ unitID: UnitID) {
        guard isManualSettlement, ledgerUnitIDs.contains(unitID),
              unitID != settleFrom
        else { return }
        settleTo = unitID
    }

    func backToPlan() {
        if settlementReversalTargetID != nil {
            settlementReversalTargetID = nil
            sheet = .detail
        } else if settlementReturnsHome {
            closeSheet()
        } else {
            isManualSettlement = false
            sheet = .settlePlan
        }
    }

    func clearSettlementAmount() {
        guard !isPersisting else { return }
        sInt = ""
        sFrac = nil
    }

    var isRecordingSettlementReversal: Bool {
        settlementReversalTargetID != nil
    }

    func linkedSettlementReversalAmount(for record: ExpenseRecord) -> Int64 {
        records.lazy
            .filter {
                $0.kind == .settlement
                    && $0.deliveryState != .failed
                    && $0.reversalOfRecordID == record.id
            }
            .reduce(0) { partial, reversal in
                partial.addingReportingOverflow(reversal.amountCents).partialValue
            }
    }

    func remainingSettlementReversal(for record: ExpenseRecord) -> Int64 {
        guard record.kind == .settlement, record.flagged else { return 0 }
        return max(record.amountCents - linkedSettlementReversalAmount(for: record), 0)
    }

    func beginSettlementReversal() {
        guard !isPersisting, canWrite,
              let recordID = detailID,
              let record = records.first(where: { $0.id == recordID }),
              record.kind == .settlement,
              record.flagged,
              let receiver = record.to
        else { return }
        let remaining = remainingSettlementReversal(for: record)
        guard remaining > 0 else { return }
        settlementReversalTargetID = recordID
        isManualSettlement = false
        settleFrom = receiver
        settleTo = record.payer
        settleDebt = remaining
        setSettlementInput(remaining)
        sheet = .settleAmount
    }

    func sKey(_ key: String) {
        (sInt, sFrac) = Self.editKey(sInt, sFrac, key, currency: potCurrency)
    }

    func useExactDebt() { setSettlementInput(settleDebt) }

    func useOverpay() {
        guard let overpaySuggestion else { Haptics.warned(); return }
        setSettlementInput(overpaySuggestion)
    }

    var overpaySuggestion: Int64? {
        guard !usesBudgetGroups, !isRecordingSettlementReversal, !isManualSettlement else { return nil }
        let debt = settlementDebtMagnitude
        guard debt <= UInt64(Int64.max) else { return nil }
        return Self.overpaySuggestion(
            for: Int64(debt),
            increment: 25 * potCurrency.minorUnitScale
        )
    }

    nonisolated static func overpaySuggestion(
        for debt: Int64,
        increment: Int64 = 2_500
    ) -> Int64? {
        let (amount, overflow) = debt.addingReportingOverflow(increment)
        return overflow ? nil : amount
    }

    private func setSettlementInput(_ amount: Int64) {
        let scale = potCurrency.minorUnitScale
        sInt = String(amount / scale)
        let remainder = amount % scale
        sFrac = remainder != 0
            ? String(format: "%0*lld", potCurrency.exponent, remainder)
            : nil
    }

    private var settlementDebtMagnitude: UInt64 {
        guard let from = settleFrom,
              let balance = balances[from],
              balance < 0
        else { return 0 }
        return balance.magnitude
    }

    private func formattedSettlementMagnitude(_ magnitude: UInt64) -> String {
        money(
            decimalMinorUnits: Decimal(magnitude),
            currency: potCurrency,
            hidden: hideAmounts
        )
    }

    var settlePreviewText: String {
        guard let from = settleFrom else { return "" }
        let name = unitInfo(for: from).name
        let amount = centsOf(sInt, sFrac)
        if amount <= 0 {
            return isRecordingSettlementReversal
                ? String(localized: "Enter the reversal amount.")
                : String(localized: "Enter what actually changed hands.")
        }
        if isRecordingSettlementReversal {
            guard amount <= settleDebt else {
                return String(localized: "A linked reversal can’t exceed the remaining original amount.")
            }
            if amount == settleDebt {
                return String(localized: "This fully reverses the remaining flagged settlement amount.")
            }
            return localizedFormat(
                "%@ will remain linked for correction.",
                fmt(settleDebt - amount, forceCents: true)
            )
        }
        if usesBudgetGroups, let after = settlementBalanceAfter(for: from),
           let receiverAfter = settlementBalanceAfter(for: settleTo) {
            let flips = ((balances[from] ?? 0) < 0 && after > 0)
                || ((balances[settleTo] ?? 0) > 0 && receiverAfter < 0)
            let summary: String
            if ledgerUnitIDs.count == 2 {
                if after < 0 { summary = "After this, \(name) still owe \(unitInfo(for: settleTo).name) \(fmtMagnitude(after))." }
                else if after > 0 { summary = "After this, \(unitInfo(for: settleTo).name) owe \(name) \(fmtMagnitude(after))." }
                else { summary = "After this, both groups are even." }
            } else {
                summary = after < 0 ? "After this, \(name) still owe \(fmtMagnitude(after)) overall."
                    : after > 0 ? "After this, \(name) are owed \(fmtMagnitude(after)) overall." : "After this, \(name) are even."
            }
            return (flips ? "Overpayment reverses who owes whom. " : "") + summary
                + " Only record money already sent elsewhere."
        }
        if isManualSettlement {
            return localizedFormat(
                "%1$@ paid %2$@ %3$@.",
                name,
                unitInfo(for: settleTo).name,
                fmt(amount, forceCents: true)
            )
        }
        let debt = settlementDebtMagnitude
        let transferred = UInt64(amount)
        if transferred < debt {
            return localizedFormat(
                "%1$@ will still owe %2$@ after this.",
                name,
                formattedSettlementMagnitude(debt - transferred)
            )
        }
        if transferred == debt {
            return localizedFormat("%@ will be even.", name)
        }
        return localizedFormat(
            "%1$@ will switch from owing %2$@ to getting back %3$@.",
            name,
            formattedSettlementMagnitude(debt),
            formattedSettlementMagnitude(transferred - debt)
        )
    }

    func settlementBalanceAfter(for unitID: UnitID) -> Int64? {
        guard let from = settleFrom,
              let before = balances[unitID]
        else { return nil }
        let amount = centsOf(sInt, sFrac)
        guard amount > 0 else { return before }
        if unitID == from {
            let result = before.addingReportingOverflow(amount)
            return result.overflow ? nil : result.partialValue
        }
        if unitID == settleTo {
            let result = before.subtractingReportingOverflow(amount)
            return result.overflow ? nil : result.partialValue
        }
        return before
    }

    var canRecordSettlement: Bool {
        let amount = centsOf(sInt, sFrac)
        return !isPersisting && canWrite && settleFrom != nil && settleFrom != settleTo
            && amount > 0 && (settlementReversalTargetID == nil || amount <= settleDebt)
    }

    func markPaid() {
        guard canRecordSettlement, let from = settleFrom else { return }
        let amount = centsOf(sInt, sFrac)
        let receiver = settleTo
        let receiverName = receiver == currentUnitID
            ? String(localized: "your household")
            : unitInfo(for: receiver).name
        let reversalTargetID = settlementReversalTargetID
        let reversalTarget = reversalTargetID.flatMap { targetID in
            records.first { $0.id == targetID }
        }
        if reversalTargetID != nil, amount > settleDebt { return }
        isPersisting = true
        let title = reversalTarget.map {
            localizedFormat("Reversal of %@", $0.title)
        } ?? localizedFormat(
            "%1$@ paid %2$@",
            unitInfo(for: from).name,
            receiverName
        )
        let repository = repository

        Task { [weak self] in
            do {
                let mutation = try await repository.appendSettlement(
                    title: title,
                    amountMinorUnits: amount,
                    from: from,
                    to: receiver,
                    reversalOfRecordID: reversalTargetID
                )
                guard let self else { return }
                apply(mutation.snapshot)
                isPersisting = false
                sheet = .none
                settleFrom = nil
                isManualSettlement = false
                settlementReversalTargetID = nil
                Haptics.saved()
                let confirmation = reversalTargetID == nil
                    ? localizedFormat("Settlement %@ recorded", fmt(amount))
                    : localizedFormat("Reversal %@ recorded", fmt(amount))
                setUndo(
                    text: confirmation,
                    eventID: mutation.eventID,
                    deadline: mutation.undoDeadline
                )
            } catch {
                self?.persistenceFailed(error)
            }
        }
    }

    // MARK: - Undo

    private func setUndo(
        text: String,
        eventID: NumaSharedCore.EventID,
        deadline: Date
    ) {
        undoText = text
        undoEventID = eventID
        scheduleHeldExpiry(eventID: eventID, deadline: deadline)
    }

    private func scheduleHeldExpiry(
        eventID: NumaSharedCore.EventID,
        deadline: Date
    ) {
        let repository = repository
        Task { [weak self] in
            var expiryFloor = deadline
            var delay = max(0, deadline.timeIntervalSinceNow)
            while true {
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return
                }
                do {
                    let effectiveNow = Self.effectiveExpiryNow(
                        wallClockNow: Date(),
                        scheduledDeadline: expiryFloor
                    )
                    switch try await repository.expireHeldEvent(
                        eventID: eventID,
                        now: effectiveNow
                    ) {
                    case let .transitioned(eventIDs):
                        await self?.syncRuntime?.synchronizeNow()
                        if let current = self?.undoEventID, eventIDs.contains(current) {
                            self?.clearUndo()
                        }
                        return
                    case let .stillHeld(until: nextDeadline):
                        delay = max(0, nextDeadline.timeIntervalSince(effectiveNow))
                        expiryFloor = nextDeadline
                    case .noLongerHeld:
                        if self?.undoEventID == eventID {
                            self?.clearUndo()
                        }
                        return
                    }
                } catch {
                    delay = 1
                }
            }
        }
    }

    nonisolated static func effectiveExpiryNow(
        wallClockNow: Date,
        scheduledDeadline: Date
    ) -> Date {
        max(wallClockNow, scheduledDeadline)
    }

    func undoNow() {
        guard !isPersisting, let eventID = undoEventID else { return }
        isPersisting = true
        let repository = repository
        Task { [weak self] in
            do {
                guard let snapshot = try await repository.undoHeldEvent(eventID: eventID) else {
                    self?.clearUndo()
                    self?.persistenceFailed()
                    return
                }
                self?.apply(snapshot)
                self?.isPersisting = false
                self?.clearUndo()
            } catch {
                self?.clearUndo()
                self?.persistenceFailed(error)
            }
        }
    }

    private func clearUndo() {
        undoEventID = nil
        undoText = nil
    }

    // MARK: - Activity rows

    func rows(for records: [ExpenseRecord]) -> [ExpenseRecord] {
        records.sorted { lhs, rhs in
            lhs.sortOrdinal == rhs.sortOrdinal
                ? lhs.id > rhs.id
                : lhs.sortOrdinal > rhs.sortOrdinal
        }
    }

    func filteredActivityRows(now: Date = Date()) -> [ExpenseRecord] {
        let calendar = Calendar.current
        let periodStart: Date? = switch activityPeriodFilter {
        case .all: nil
        case .week: calendar.dateInterval(of: .weekOfYear, for: now)?.start
        case .month: calendar.dateInterval(of: .month, for: now)?.start
        case .year: calendar.dateInterval(of: .year, for: now)?.start
        }
        let query = activitySearchQuery.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        let matching = records.filter { record in
            if let activityFilter {
                let includesUnit = if record.kind == .settlement {
                    record.payer == activityFilter || record.to == activityFilter
                } else {
                    record.payer == activityFilter || record.parts[activityFilter] != nil
                }
                guard includesUnit else { return false }
            }
            guard activityKindFilter.includes(record.kind) else { return false }
            if let periodStart {
                guard record.occurredAt >= periodStart,
                      record.occurredAt <= now
                else { return false }
            }
            guard !query.isEmpty else { return true }
            let involvedUnitNames = Set(record.parts.keys)
                .union([record.payer])
                .union(record.to.map { [$0] } ?? [])
                .map { unitInfo(for: $0).name }
            let searchable = [
                record.title,
                record.category,
                record.note,
                record.recordedBy,
            ].compactMap { $0 }
                + involvedUnitNames
                + record.revisionHistory.flatMap {
                    [$0.title, $0.category, $0.note].compactMap { $0 }
                }
            return searchable.contains {
                $0.localizedCaseInsensitiveContains(query)
            }
        }
        return rows(for: matching)
    }

    struct FilterExplain {
        let title: String
        let lines: [(String, String)]
    }

    var filterExplain: FilterExplain? {
        guard let filter = activityFilter else { return nil }
        let unit = unitInfo(for: filter)
        let balance = balances[filter] ?? 0
        var share = Decimal.zero
        var paid = Decimal.zero
        var opening = Decimal.zero
        var settledMinorUnits = Decimal.zero
        for record in accountedRecords {
            if record.kind == .settlement {
                if record.payer == filter {
                    settledMinorUnits += Decimal(record.amountCents)
                }
                if record.to == filter {
                    settledMinorUnits -= Decimal(record.amountCents)
                }
            } else if record.kind == .openingBalance {
                opening += Decimal(record.parts[filter] ?? 0)
            } else if record.kind == .expense || record.kind == .personal {
                if record.payer == filter { paid += Decimal(record.amountCents) }
                if let part = record.parts[filter] { share += Decimal(part) }
            }
        }
        let title: String
        if balance > 0 {
            title = localizedFormat(
                "%1$@ gets back %2$@",
                unit.name,
                fmt(balance)
            )
        } else if balance < 0 {
            title = localizedFormat(
                "%1$@ owes %2$@",
                unit.name,
                fmtMagnitude(balance)
            )
        } else {
            title = localizedFormat("%@ is even", unit.name)
        }
        let startingLine: [(String, String)] = opening == 0 ? [] : [
            ("Starting balance", (opening >= 0 ? "+" : "−") + money(decimalMinorUnits: abs(opening), currency: potCurrency, hidden: hideAmounts)),
        ]
        return FilterExplain(title: title, lines: startingLine + [
            (String(localized: "Share of expenses"), "−" + money(decimalMinorUnits: share, currency: potCurrency, hidden: hideAmounts)),
            (String(localized: "Paid for the pot"), "+" + money(decimalMinorUnits: paid, currency: potCurrency, hidden: hideAmounts)),
            (
                String(localized: "Settled so far"),
                (settledMinorUnits >= 0 ? "+" : "−") + money(
                    decimalMinorUnits: abs(settledMinorUnits),
                    currency: potCurrency,
                    hidden: hideAmounts
                )
            ),
        ])
    }
}
