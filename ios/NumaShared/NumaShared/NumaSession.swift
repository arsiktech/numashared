import ConvexMobile
import CryptoKit
import Foundation
import Security

nonisolated struct NumaAppleCredential: Equatable, Sendable {
    let identityToken: String
    let authorizationCode: String
    let rawNonce: String
}

nonisolated struct NumaSession: Decodable, Equatable, Sendable {
    let accessToken: String
    let accessTokenExpiresInSeconds: Int
    let refreshToken: String
    let refreshExpiresAt: Int64
    let accountID: String?

    enum CodingKeys: String, CodingKey {
        case accessToken
        case accessTokenExpiresInSeconds
        case refreshToken
        case refreshExpiresAt
        case accountID = "accountId"
    }

    init(
        accessToken: String,
        accessTokenExpiresInSeconds: Int,
        refreshToken: String,
        refreshExpiresAt: Int64,
        accountID: String?
    ) {
        self.accessToken = accessToken
        self.accessTokenExpiresInSeconds = accessTokenExpiresInSeconds
        self.refreshToken = refreshToken
        self.refreshExpiresAt = refreshExpiresAt
        self.accountID = accountID
    }
}

nonisolated struct NumaAccountDeletionPreview: Decodable, Equatable, Sendable {
    nonisolated struct Pot: Decodable, Equatable, Sendable {
        nonisolated enum Outcome: String, Decodable, Equatable, Sendable {
            case deleted, anonymized
        }

        let potID: String
        let name: String?
        let outcome: Outcome
        let successorName: String?

        enum CodingKeys: String, CodingKey {
            case potID = "potId"
            case name, outcome, successorName
        }
    }

    let pots: [Pot]
}

nonisolated struct NumaAppConfiguration: Decodable, Equatable, Sendable {
    let minimumSupportedBuild: Int?
}

nonisolated enum NumaSessionError: Error, Equatable, Sendable {
    case configurationUnavailable
    case appleCredentialInvalid
    case noCachedSession
    case invalidResponse
    case transportUnavailable
    case server(code: String, retryable: Bool)
}

nonisolated protocol RefreshTokenStoring: Sendable {
    func read() async throws -> String?
    func write(_ token: String) async throws
    func clear() async throws
}

nonisolated protocol NumaSessionServing: Sendable {
    func appConfiguration() async throws -> NumaAppConfiguration
    func exchangeApple(_ credential: NumaAppleCredential) async throws -> NumaSession
    func refresh(refreshToken: String) async throws -> NumaSession
    func logout(refreshToken: String) async throws
    func accountDeletionPreview(refreshToken: String) async throws
        -> NumaAccountDeletionPreview
    func deleteAccount(
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    ) async throws
#if DEBUG
    func bootstrapE2E(accountKey: String, bootstrapSecret: String) async throws -> NumaSession
#endif
}

extension NumaSessionServing {
    func appConfiguration() async throws -> NumaAppConfiguration {
        NumaAppConfiguration(minimumSupportedBuild: nil)
    }

    func accountDeletionPreview(refreshToken: String) async throws
        -> NumaAccountDeletionPreview {
        throw NumaSessionError.configurationUnavailable
    }

    func deleteAccount(
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    ) async throws {
        throw NumaSessionError.configurationUnavailable
    }
}

nonisolated protocol HTTPDataLoading: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPDataLoading {
    nonisolated func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await data(for: request, delegate: nil)
    }
}

actor NumaSessionHTTPClient: NumaSessionServing {
    private let siteURL: URL
    private let loader: any HTTPDataLoading
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(siteURL: URL, loader: any HTTPDataLoading = URLSession.shared) {
        self.siteURL = siteURL
        self.loader = loader
    }

    func exchangeApple(_ credential: NumaAppleCredential) async throws -> NumaSession {
        try await post(
            path: "auth/apple/exchange",
            body: AppleExchangeRequest(
                identityToken: credential.identityToken,
                authorizationCode: credential.authorizationCode,
                nonce: credential.rawNonce
            ),
            response: NumaSession.self
        )
    }

    func appConfiguration() async throws -> NumaAppConfiguration {
        try await get(path: "app-config", response: NumaAppConfiguration.self)
    }

    func refresh(refreshToken: String) async throws -> NumaSession {
        try await post(
            path: "auth/refresh",
            body: RefreshRequest(refreshToken: refreshToken),
            response: NumaSession.self
        )
    }

    func logout(refreshToken: String) async throws {
        _ = try await post(
            path: "auth/logout",
            body: RefreshRequest(refreshToken: refreshToken),
            response: LogoutResponse.self
        )
    }

    func accountDeletionPreview(refreshToken: String) async throws
        -> NumaAccountDeletionPreview {
        try await post(
            path: "auth/account/deletion-preview",
            body: RefreshRequest(refreshToken: refreshToken),
            response: NumaAccountDeletionPreview.self
        )
    }

    func deleteAccount(
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    ) async throws {
        _ = try await post(
            path: "auth/account/delete",
            body: AccountDeletionRequest(
                refreshToken: refreshToken,
                requestID: requestID,
                originatingTimeZone: originatingTimeZone
            ),
            response: AccountDeletionResponse.self
        )
    }

#if DEBUG
    func bootstrapE2E(accountKey: String, bootstrapSecret: String) async throws -> NumaSession {
        try await post(
            path: "auth/e2e/bootstrap",
            body: E2EBootstrapRequest(
                accountKey: accountKey,
                bootstrapSecret: bootstrapSecret
            ),
            response: NumaSession.self
        )
    }
#endif

    private func post<Body: Encodable, Response: Decodable>(
        path: String,
        body: Body,
        response: Response.Type
    ) async throws -> Response {
        var request = URLRequest(
            url: siteURL.appendingPathComponent(path),
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 15
        )
        request.httpMethod = "POST"
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        return try await load(request, response: response)
    }

    private func get<Response: Decodable>(
        path: String,
        response: Response.Type
    ) async throws -> Response {
        var request = URLRequest(
            url: siteURL.appendingPathComponent(path),
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 15
        )
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        return try await load(request, response: response)
    }

    private func load<Response: Decodable>(
        _ request: URLRequest,
        response: Response.Type
    ) async throws -> Response {
        let data: Data
        let urlResponse: URLResponse
        do {
            (data, urlResponse) = try await loader.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            try Task.checkCancellation()
            throw NumaSessionError.transportUnavailable
        }
        guard let http = urlResponse as? HTTPURLResponse else {
            throw NumaSessionError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if let failure = try? decoder.decode(ErrorResponse.self, from: data) {
                throw NumaSessionError.server(
                    code: failure.error.code,
                    retryable: failure.error.retryable
                )
            }
            throw NumaSessionError.server(
                code: "IDENTITY_REQUEST_FAILED",
                retryable: http.statusCode >= 500
            )
        }
        do {
            return try decoder.decode(response, from: data)
        } catch {
            throw NumaSessionError.invalidResponse
        }
    }
}

actor KeychainRefreshTokenStore: RefreshTokenStoring {
    private let service: String
    private let account: String

    init(
        service: String = "tech.arsik.numashared.session",
        account: String = "refresh-token-v1"
    ) {
        self.service = service
        self.account = account
    }

    func read() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else {
            throw KeychainError(status: status)
        }
        return token
    }

    func write(_ token: String) throws {
        guard let data = token.data(using: .utf8), !data.isEmpty else {
            throw KeychainError(status: errSecParam)
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var inserted = baseQuery
            for (key, value) in attributes { inserted[key] = value }
            let insertStatus = SecItemAdd(inserted as CFDictionary, nil)
            guard insertStatus == errSecSuccess else {
                throw KeychainError(status: insertStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private struct KeychainError: Error, Sendable {
        let status: OSStatus
    }
}

@MainActor
final class NumaAuthProvider: AuthProvider {
    typealias T = NumaSession

    private enum PendingLogin {
        case apple(NumaAppleCredential)
#if DEBUG
        case e2e(accountKey: String, bootstrapSecret: String)
#endif
    }

    private let server: any NumaSessionServing
    private let refreshTokens: any RefreshTokenStoring
    private var pendingLogin: PendingLogin?
    private var onIDToken: (@Sendable (String?) -> Void)?
    private var refreshFlight: (id: UUID, task: Task<NumaSession, Error>)?
    private var sessionValidator: ((NumaSession) async throws -> Void)?
    private var sessionGeneration = UUID()
    private var endingSessionGeneration: UUID?
    private var credentialMutationInProgress = false
    private var credentialMutationWaiters: [CheckedContinuation<Void, Never>] = []

    init(server: any NumaSessionServing, refreshTokens: any RefreshTokenStoring) {
        self.server = server
        self.refreshTokens = refreshTokens
    }

    func prepareAppleLogin(_ credential: NumaAppleCredential) {
        pendingLogin = .apple(credential)
    }

#if DEBUG
    func prepareE2ELogin(accountKey: String, bootstrapSecret: String) {
        pendingLogin = .e2e(accountKey: accountKey, bootstrapSecret: bootstrapSecret)
    }
#endif

    func hasCachedSession() async -> Bool {
        (try? await refreshTokens.read()) != nil
    }

    /// Validates account binding before a newly exchanged credential can
    /// replace the previously accepted refresh token or reach Convex.
    func setSessionValidator(
        _ validator: @escaping (NumaSession) async throws -> Void
    ) {
        sessionValidator = validator
    }

    func login(
        onIdToken: @Sendable @escaping (String?) -> Void
    ) async throws -> NumaSession {
        guard endingSessionGeneration == nil else { throw CancellationError() }
        guard let pendingLogin else { throw NumaSessionError.appleCredentialInvalid }
        self.pendingLogin = nil
        let generation = beginSessionGeneration()
        onIDToken = onIdToken
        let session: NumaSession
        switch pendingLogin {
        case let .apple(credential):
            session = try await server.exchangeApple(credential)
#if DEBUG
        case let .e2e(accountKey, bootstrapSecret):
            session = try await server.bootstrapE2E(
                accountKey: accountKey,
                bootstrapSecret: bootstrapSecret
            )
#endif
        }
        do {
            try await accept(session, generation: generation, preservePreviousCredential: true)
            try requireCurrentSession(generation)
        } catch {
            await revokeIssuedSession(session)
            try requireCurrentSession(generation)
            throw error
        }
        return session
    }

    func loginFromCache(
        onIdToken: @Sendable @escaping (String?) -> Void
    ) async throws -> NumaSession {
        guard endingSessionGeneration == nil else { throw CancellationError() }
        self.onIDToken = onIdToken
        let flight: (id: UUID, task: Task<NumaSession, Error>)
        if let refreshFlight {
            flight = refreshFlight
        } else {
            let generation = beginSessionGeneration()
            let task = Task<NumaSession, Error> { @MainActor [weak self] in
                guard let self else { throw CancellationError() }
                return try await self.refreshSession(generation: generation)
            }
            flight = (generation, task)
            refreshFlight = flight
        }
        do {
            let session = try await flight.task.value
            try requireCurrentSession(flight.id)
            if refreshFlight?.id == flight.id { refreshFlight = nil }
            return session
        } catch {
            if refreshFlight?.id == flight.id { refreshFlight = nil }
            throw error
        }
    }

    func logout() async throws {
        let generation = beginSessionEnd()
        defer { finishSessionEnd(generation) }
        await acquireCredentialMutation()
        defer { releaseCredentialMutation() }
        try requireCurrentSession(generation)
        let token = try await refreshTokens.read()
        try requireCurrentSession(generation)
        if let token {
            try await server.logout(refreshToken: token)
        }
        try requireCurrentSession(generation)
        try await refreshTokens.clear()
        try requireCurrentSession(generation)
        onIDToken?(nil)
        onIDToken = nil
    }

    func accountDeletionPreview() async throws -> NumaAccountDeletionPreview {
        guard let token = try await refreshTokens.read() else {
            throw NumaSessionError.noCachedSession
        }
        return try await server.accountDeletionPreview(refreshToken: token)
    }

    func appConfiguration() async throws -> NumaAppConfiguration {
        try await server.appConfiguration()
    }

    func deleteAccount(requestID: String, originatingTimeZone: String) async throws {
        guard let token = try await refreshTokens.read() else {
            throw NumaSessionError.noCachedSession
        }
        try await server.deleteAccount(
            refreshToken: token,
            requestID: requestID,
            originatingTimeZone: originatingTimeZone
        )
    }

    func clearAccountDeletionCredential() async throws {
        let generation = beginSessionEnd()
        defer { finishSessionEnd(generation) }
        try await clearCredential(generation: generation)
    }

    nonisolated func extractIdToken(from authResult: NumaSession) -> String {
        authResult.accessToken
    }

    private func accept(
        _ session: NumaSession,
        generation: UUID,
        preservePreviousCredential: Bool
    ) async throws {
        try requireCurrentSession(generation)
        guard session.accessTokenExpiresInSeconds > 0,
              session.refreshExpiresAt > 0,
              !session.accessToken.isEmpty,
              !session.refreshToken.isEmpty
        else { throw NumaSessionError.invalidResponse }
        try await sessionValidator?(session)
        try requireCurrentSession(generation)
        await acquireCredentialMutation()
        defer { releaseCredentialMutation() }
        try requireCurrentSession(generation)
        let previousRefreshToken = try await refreshTokens.read()
        try requireCurrentSession(generation)
        do {
            try await refreshTokens.write(session.refreshToken)
            try requireCurrentSession(generation)
        } catch {
            // A store can suspend while writing. Roll back under the same gate
            // before a newer login or explicit session end can mutate it.
            if preservePreviousCredential, let previousRefreshToken {
                try? await refreshTokens.write(previousRefreshToken)
            } else {
                try? await refreshTokens.clear()
            }
            throw error
        }
        onIDToken?(session.accessToken)
    }

    private func refreshSession(generation: UUID) async throws -> NumaSession {
        let token = try await cachedCredential(generation: generation)
        let session: NumaSession
        do {
            session = try await server.refresh(refreshToken: token)
        } catch {
            try requireCurrentSession(generation)
            if case let NumaSessionError.server(_, retryable) = error, !retryable {
                try? await clearCredential(generation: generation)
            }
            throw error
        }
        do {
            try await accept(session, generation: generation, preservePreviousCredential: false)
            try requireCurrentSession(generation)
        } catch {
            await revokeIssuedSession(session)
            try requireCurrentSession(generation)
            // A successful refresh invalidates its predecessor. Only this
            // generation may clear it; a later accepted login owns its token.
            try? await clearCredential(generation: generation)
            throw error
        }
        return session
    }

    private func cachedCredential(generation: UUID) async throws -> String {
        await acquireCredentialMutation()
        defer { releaseCredentialMutation() }
        try requireCurrentSession(generation)
        let token = try await refreshTokens.read()
        try requireCurrentSession(generation)
        guard let token else { throw NumaSessionError.noCachedSession }
        return token
    }

    private func clearCredential(generation: UUID) async throws {
        await acquireCredentialMutation()
        defer { releaseCredentialMutation() }
        try requireCurrentSession(generation)
        try await refreshTokens.clear()
        try requireCurrentSession(generation)
        onIDToken?(nil)
        onIDToken = nil
    }

    private func beginSessionGeneration() -> UUID {
        sessionGeneration = UUID()
        refreshFlight?.task.cancel()
        refreshFlight = nil
        return sessionGeneration
    }

    private func beginSessionEnd() -> UUID {
        let generation = beginSessionGeneration()
        endingSessionGeneration = generation
        pendingLogin = nil
        return generation
    }

    private func finishSessionEnd(_ generation: UUID) {
        if endingSessionGeneration == generation { endingSessionGeneration = nil }
    }

    private func requireCurrentSession(_ generation: UUID) throws {
        guard generation == sessionGeneration else { throw CancellationError() }
    }

    private func acquireCredentialMutation() async {
        if credentialMutationInProgress {
            await withCheckedContinuation { credentialMutationWaiters.append($0) }
        } else {
            credentialMutationInProgress = true
        }
    }

    private func releaseCredentialMutation() {
        if credentialMutationWaiters.isEmpty {
            credentialMutationInProgress = false
        } else {
            credentialMutationWaiters.removeFirst().resume()
        }
    }

    private func revokeIssuedSession(_ session: NumaSession) async {
        guard !session.refreshToken.isEmpty else { return }
        try? await server.logout(refreshToken: session.refreshToken)
    }
}

nonisolated enum NumaAppleNonce {
    static func make() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw NumaSessionError.transportUnavailable
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func digest(_ rawNonce: String) -> String {
        SHA256.hash(data: Data(rawNonce.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

private nonisolated struct AppleExchangeRequest: Encodable {
    let identityToken: String
    let authorizationCode: String
    let nonce: String
}

private nonisolated struct RefreshRequest: Encodable {
    let refreshToken: String
}

private nonisolated struct LogoutResponse: Decodable {
    let revoked: Bool
}

private nonisolated struct AccountDeletionRequest: Encodable {
    let refreshToken: String
    let requestID: String
    let originatingTimeZone: String

    enum CodingKeys: String, CodingKey {
        case refreshToken
        case requestID = "requestId"
        case originatingTimeZone
    }
}

private nonisolated struct AccountDeletionResponse: Decodable {
    let deleted: Bool
}

private nonisolated struct ErrorResponse: Decodable {
    nonisolated struct Failure: Decodable {
        let code: String
        let retryable: Bool
    }

    let error: Failure
}

#if DEBUG
private nonisolated struct E2EBootstrapRequest: Encodable {
    let accountKey: String
    let bootstrapSecret: String
}
#endif
