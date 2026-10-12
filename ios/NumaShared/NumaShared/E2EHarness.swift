#if DEBUG
import Foundation
import NumaSharedCore
import NumaSharedSync
import OSLog

nonisolated enum NumaSharedE2ECommand: String, Sendable {
    case observe
    case createOne = "create-one"
    case createAfter = "create-after"
    case queueTwenty = "queue-twenty"
    case p3OwnerBootstrap = "p3-owner-bootstrap"
    case p3ClaimLeaked = "p3-claim-leaked"
    case p3RejectLeaked = "p3-reject-leaked"
    case p3ClaimApproved = "p3-claim-approved"
    case p3ApproveClaim = "p3-approve-claim"
    case p3CrossExpense = "p3-cross-expense"
    case p3Settlement = "p3-settlement"
    case p3RevisionA = "p3-revision-a"
    case p3RevisionB = "p3-revision-b"
    case p3ResolveContest = "p3-resolve-contest"

    var usesInviteOnlyLogin: Bool {
        self == .p3ClaimLeaked || self == .p3ClaimApproved
    }
}

nonisolated struct NumaSharedE2ELaunchEnvelope: Sendable {
    let runID: String
    let role: String
    let command: NumaSharedE2ECommand

    var artifactName: String { "\(runID)-\(role).json" }

    static func process(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> NumaSharedE2ELaunchEnvelope? {
        guard arguments.contains(NumaSharedE2EConfiguration.launchArgument),
              let runID = environment["NUMA_SHARED_E2E_RUN_ID"],
              let role = environment["NUMA_SHARED_E2E_ROLE"],
              let commandValue = environment["NUMA_SHARED_E2E_COMMAND"],
              runID.count <= 48,
              runID.allSatisfy({
                  $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-")
              }),
              role == "A" || role == "B",
              let command = NumaSharedE2ECommand(rawValue: commandValue)
        else { return nil }
        return NumaSharedE2ELaunchEnvelope(
            runID: runID,
            role: role,
            command: command
        )
    }
}

nonisolated enum NumaSharedE2EFailureStage: String, Sendable {
    case configuration
    case repositoryBootstrap = "repository-bootstrap"
    case runtimeInitialization = "runtime-initialization"
    case commandPreparation = "command-preparation"
    case authentication
    case journeyAction = "journey-action"
    case artifactReporting = "artifact-reporting"
}

nonisolated enum NumaSharedE2EFailureCode: String, Sendable {
    case configurationUnavailable = "E2E_CONFIGURATION_UNAVAILABLE"
    case repositoryBootstrapFailed = "E2E_REPOSITORY_BOOTSTRAP_FAILED"
    case runtimeInitializationFailed = "E2E_RUNTIME_INITIALIZATION_FAILED"
    case commandPreparationFailed = "E2E_COMMAND_PREPARATION_FAILED"
    case authenticationFailed = "E2E_AUTHENTICATION_FAILED"
    case journeyAssertionFailed = "E2E_JOURNEY_ASSERTION_FAILED"
    case transportUnavailable = "E2E_TRANSPORT_UNAVAILABLE"
    case artifactInspectionFailed = "E2E_ARTIFACT_INSPECTION_FAILED"
    case artifactWriteFailed = "E2E_ARTIFACT_WRITE_FAILED"
}

nonisolated enum NumaSharedE2EDiagnosticArtifact {
    static let kind = "NUMA_SHARED_E2E_DIAGNOSTIC_V1"
    private static let logger = Logger(
        subsystem: "tech.arsik.numashared.debug",
        category: "E2E"
    )

    static func writeProgress(
        envelope: NumaSharedE2ELaunchEnvelope,
        stage: NumaSharedE2EFailureStage,
        to destination: URL,
        now: Date = Date()
    ) throws {
        try write(
            envelope: envelope,
            stage: stage,
            failureCode: nil,
            to: destination,
            now: now
        )
    }

    static func writeFailure(
        envelope: NumaSharedE2ELaunchEnvelope,
        stage: NumaSharedE2EFailureStage,
        code: NumaSharedE2EFailureCode,
        to destination: URL,
        now: Date = Date()
    ) throws {
        try write(
            envelope: envelope,
            stage: stage,
            failureCode: code,
            to: destination,
            now: now
        )
    }

    @discardableResult
    static func recordProgress(
        envelope: NumaSharedE2ELaunchEnvelope,
        stage: NumaSharedE2EFailureStage
    ) -> Bool {
        guard let destination = applicationSupportURL(for: envelope) else {
            logWriteFailure(stage: stage)
            return false
        }
        do {
            try writeProgress(envelope: envelope, stage: stage, to: destination)
            logger.debug(
                "\(kind, privacy: .public) stage=\(stage.rawValue, privacy: .public)"
            )
            return true
        } catch {
            logWriteFailure(stage: stage)
            return false
        }
    }

    @discardableResult
    static func recordFailure(
        envelope: NumaSharedE2ELaunchEnvelope,
        stage: NumaSharedE2EFailureStage,
        code: NumaSharedE2EFailureCode
    ) -> Bool {
        guard let destination = applicationSupportURL(for: envelope) else {
            logWriteFailure(stage: stage)
            return false
        }
        do {
            try writeFailure(
                envelope: envelope,
                stage: stage,
                code: code,
                to: destination
            )
            logger.error(
                "\(kind, privacy: .public) stage=\(stage.rawValue, privacy: .public) code=\(code.rawValue, privacy: .public)"
            )
            return true
        } catch {
            logWriteFailure(stage: stage)
            return false
        }
    }

    static func applicationSupportURL(
        for envelope: NumaSharedE2ELaunchEnvelope
    ) -> URL? {
        FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first?
            .appendingPathComponent("NumaShared", isDirectory: true)
            .appendingPathComponent("E2E", isDirectory: true)
            .appendingPathComponent(envelope.artifactName)
    }

    private static func write(
        envelope: NumaSharedE2ELaunchEnvelope,
        stage: NumaSharedE2EFailureStage,
        failureCode: NumaSharedE2EFailureCode?,
        to destination: URL,
        now: Date
    ) throws {
        let artifact = Artifact(
            kind: kind,
            ready: false,
            terminal: failureCode != nil,
            runID: envelope.runID,
            role: envelope.role,
            command: envelope.command.rawValue,
            stage: stage.rawValue,
            failureCode: failureCode?.rawValue,
            timestamp: ISO8601DateFormatter().string(from: now)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(artifact)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: destination, options: .atomic)
    }

    private static func logWriteFailure(stage: NumaSharedE2EFailureStage) {
        logger.error(
            "\(kind, privacy: .public) stage=\(stage.rawValue, privacy: .public) code=\(NumaSharedE2EFailureCode.artifactWriteFailed.rawValue, privacy: .public)"
        )
    }

    private struct Artifact: Encodable {
        let kind: String
        let ready: Bool
        let terminal: Bool
        let runID: String
        let role: String
        let command: String
        let stage: String
        let failureCode: String?
        let timestamp: String
    }
}

nonisolated struct NumaSharedE2EConfiguration: Sendable {
    static let launchArgument = "--numa-shared-e2e"

    let runID: String
    let role: String
    let runSeed: String
    let bootstrapSecret: String
    let command: NumaSharedE2ECommand
    let sync: NumaSyncConfiguration
    let identities: AppLedgerIdentitySet
    let firstInviteCredentials: InviteCredentialPair?
    let secondInviteCredentials: InviteCredentialPair?
    let inviteClaimTicket: String?
    let targetPotID: PotID?

    var accountKey: String {
        runID.hasPrefix("p3-")
            ? "p3-two-account-\(runID)-\(role)"
            : "p2-single-account-\(runID)"
    }
    var databaseName: String { "ledger-e2e-\(runID)-\(role).sqlite" }
    var artifactName: String { "\(runID)-\(role).json" }
    var refreshTokenAccount: String { "e2e-\(runID)-\(role)-v1" }
    var launchEnvelope: NumaSharedE2ELaunchEnvelope {
        NumaSharedE2ELaunchEnvelope(runID: runID, role: role, command: command)
    }

    static func process(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> NumaSharedE2EConfiguration? {
        guard arguments.contains(launchArgument) else { return nil }
        guard let envelope = NumaSharedE2ELaunchEnvelope.process(
            arguments: arguments,
            environment: environment
        ) else { throw NumaSessionError.configurationUnavailable }
        let runSeed = try required("NUMA_SHARED_E2E_RUN_SEED", in: environment)
        let bootstrapSecret = try required(
            "NUMA_SHARED_E2E_BOOTSTRAP_SECRET",
            in: environment
        )
        guard bootstrapSecret.count >= 32,
              let deploymentURL = localURL(
                try required("NUMA_SHARED_E2E_CONVEX_URL", in: environment)
              ),
              let siteURL = localURL(
                try required("NUMA_SHARED_E2E_SITE_URL", in: environment)
              )
        else { throw NumaSessionError.configurationUnavailable }
        let firstInviteCredentials = try inviteCredentials(
            tokenName: "NUMA_SHARED_E2E_INVITE_TOKEN_1",
            codeName: "NUMA_SHARED_E2E_INVITE_CODE_1",
            environment: environment
        )
        let secondInviteCredentials = try inviteCredentials(
            tokenName: "NUMA_SHARED_E2E_INVITE_TOKEN_2",
            codeName: "NUMA_SHARED_E2E_INVITE_CODE_2",
            environment: environment
        )
        let inviteClaimTicket = try optionalTicket(
            "NUMA_SHARED_E2E_INVITE_TICKET",
            environment: environment
        )
        let targetPotID = try optionalPotID(
            "NUMA_SHARED_E2E_TARGET_POT_ID",
            environment: environment
        )
        if envelope.command == .p3OwnerBootstrap,
           firstInviteCredentials == nil || secondInviteCredentials == nil {
            throw NumaSessionError.configurationUnavailable
        }
        if envelope.command.usesInviteOnlyLogin,
           inviteClaimTicket == nil || targetPotID == nil {
            throw NumaSessionError.configurationUnavailable
        }
        return NumaSharedE2EConfiguration(
            runID: envelope.runID,
            role: envelope.role,
            runSeed: runSeed,
            bootstrapSecret: bootstrapSecret,
            command: envelope.command,
            sync: NumaSyncConfiguration(
                deploymentURL: deploymentURL,
                siteURL: siteURL
            ),
            identities: try AppLedgerIdentitySet.deterministicE2E(seed: runSeed),
            firstInviteCredentials: firstInviteCredentials,
            secondInviteCredentials: secondInviteCredentials,
            inviteClaimTicket: inviteClaimTicket,
            targetPotID: targetPotID
        )
    }

    private static func required(
        _ name: String,
        in environment: [String: String]
    ) throws -> String {
        guard let value = environment[name], !value.isEmpty else {
            throw NumaSessionError.configurationUnavailable
        }
        return value
    }

    private static func inviteCredentials(
        tokenName: String,
        codeName: String,
        environment: [String: String]
    ) throws -> InviteCredentialPair? {
        let token = environment[tokenName].flatMap { $0.isEmpty ? nil : $0 }
        let code = environment[codeName].flatMap { $0.isEmpty ? nil : $0 }
        guard token != nil || code != nil else { return nil }
        guard let token, let code,
              let credentials = InviteCredentialPair(token: token, code: code)
        else { throw NumaSessionError.configurationUnavailable }
        return credentials
    }

    private static func optionalTicket(
        _ name: String,
        environment: [String: String]
    ) throws -> String? {
        guard let value = environment[name], !value.isEmpty else { return nil }
        guard (32 ... 4_096).contains(value.utf8.count),
              value.utf8.allSatisfy({ (33 ... 126).contains($0) })
        else { throw NumaSessionError.configurationUnavailable }
        return value
    }

    private static func optionalPotID(
        _ name: String,
        environment: [String: String]
    ) throws -> PotID? {
        guard let value = environment[name], !value.isEmpty else { return nil }
        guard let uuid = UUID(uuidString: value),
              let potID = try? PotID(validating: uuid)
        else { throw NumaSessionError.configurationUnavailable }
        return potID
    }

    private static func localURL(_ value: String) -> URL? {
        guard let url = URL(string: value),
              url.scheme == "http" || url.scheme == "https",
              let host = url.host,
              host == "127.0.0.1" || host == "localhost" || host == "::1",
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil
        else { return nil }
        return url
    }
}

nonisolated struct NumaSharedE2ELedgerState: Sendable {
    let activePotID: String
    let pendingCount: Int
    let eventIDs: [String]
    let localOrdinalEventIDs: [String]
    let acknowledgedServerSequences: [Int64]
    let acknowledgedEvents: [NumaSharedE2EAcknowledgement]
    let currentMemberRole: String?
    let activeMemberCount: Int
    let expenseRecordCount: Int
    let settlementRecordCount: Int
    let contestedRecordCount: Int
    let maximumRevisionCount: Int
}

nonisolated struct NumaSharedE2EAcknowledgement: Encodable, Sendable {
    let serverSequence: Int64
    let eventID: String
}

@MainActor
final class NumaSharedE2EReporter {
    private let configuration: NumaSharedE2EConfiguration
    private let repository: AppLedgerRepository
    private let runtime: AppSyncRuntime
    private var task: Task<Void, Never>?

    init(
        configuration: NumaSharedE2EConfiguration,
        repository: AppLedgerRepository,
        runtime: AppSyncRuntime
    ) {
        self.configuration = configuration
        self.repository = repository
        self.runtime = runtime
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard await self?.writeArtifact() == true else { return }
                do {
                    try await Task.sleep(for: .milliseconds(200))
                } catch {
                    return
                }
            }
        }
    }

    private func writeArtifact() async -> Bool {
        let ledger: NumaSharedE2ELedgerState
        do {
            ledger = try await repository.e2eLedgerState()
        } catch {
            NumaSharedE2EDiagnosticArtifact.recordFailure(
                envelope: configuration.launchEnvelope,
                stage: .artifactReporting,
                code: .artifactInspectionFailed
            )
            return false
        }
        let diagnostic = runtime.diagnosticState()
        guard let accountID = diagnostic.accountID, !accountID.isEmpty else {
            NumaSharedE2EDiagnosticArtifact.recordFailure(
                envelope: configuration.launchEnvelope,
                stage: .authentication,
                code: .authenticationFailed
            )
            return false
        }
        let artifact = Artifact(
            ready: true,
            runID: configuration.runID,
            role: configuration.role,
            command: configuration.command.rawValue,
            choiceSeed: configuration.runSeed,
            accountID: accountID,
            activePotID: ledger.activePotID,
            connectionState: connectionState(diagnostic.presentation),
            pendingCount: ledger.pendingCount,
            totalEventCount: ledger.eventIDs.count,
            acknowledgedServerSequences: ledger.acknowledgedServerSequences,
            acknowledgedEvents: ledger.acknowledgedEvents,
            localOrdinalEventIDs: ledger.localOrdinalEventIDs,
            uniqueEventIDs: Array(Set(ledger.eventIDs)).sorted(),
            currentMemberRole: ledger.currentMemberRole,
            activeMemberCount: ledger.activeMemberCount,
            expenseRecordCount: ledger.expenseRecordCount,
            settlementRecordCount: ledger.settlementRecordCount,
            contestedRecordCount: ledger.contestedRecordCount,
            maximumRevisionCount: ledger.maximumRevisionCount,
            lastSyncOutcome: diagnostic.report.map { outcome($0.outcome) },
            lastError: diagnostic.errorCode,
            timestamp: ISO8601DateFormatter().string(from: Date())
        )
        guard let destination = NumaSharedE2EDiagnosticArtifact.applicationSupportURL(
            for: configuration.launchEnvelope
        ) else {
            NumaSharedE2EDiagnosticArtifact.recordFailure(
                envelope: configuration.launchEnvelope,
                stage: .artifactReporting,
                code: .artifactWriteFailed
            )
            return false
        }
        do {
            let data = try JSONEncoder().encode(artifact)
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(
                to: destination,
                options: [.atomic, .completeFileProtection]
            )
        } catch {
            NumaSharedE2EDiagnosticArtifact.recordFailure(
                envelope: configuration.launchEnvelope,
                stage: .artifactReporting,
                code: .artifactWriteFailed
            )
            return false
        }
        return true
    }

    private func connectionState(_ presentation: SyncPresentation) -> String {
        switch presentation {
        case .local: "local"
        case .signingIn: "connecting"
        case .offline: "offline"
        case .syncing: "syncing"
        case .paused: "paused"
        case .synced: "connected"
        }
    }

    private func outcome(_ value: SyncRunOutcome) -> String {
        switch value {
        case .completed: "completed"
        case .alreadyRunning: "already-running"
        case .retryScheduled: "retry-scheduled"
        case .paused: "paused"
        }
    }

    private struct Artifact: Encodable {
        let ready: Bool
        let runID: String
        let role: String
        let command: String
        let choiceSeed: String
        let accountID: String
        let activePotID: String
        let connectionState: String
        let pendingCount: Int
        let totalEventCount: Int
        let acknowledgedServerSequences: [Int64]
        let acknowledgedEvents: [NumaSharedE2EAcknowledgement]
        let localOrdinalEventIDs: [String]
        let uniqueEventIDs: [String]
        let currentMemberRole: String?
        let activeMemberCount: Int
        let expenseRecordCount: Int
        let settlementRecordCount: Int
        let contestedRecordCount: Int
        let maximumRevisionCount: Int
        let lastSyncOutcome: String?
        let lastError: String?
        let timestamp: String
    }
}
#endif
