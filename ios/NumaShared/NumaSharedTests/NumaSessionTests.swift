import AuthenticationServices
import Foundation
import NumaSharedCore
import NumaSharedSync
import XCTest
@testable import NumaShared

final class NumaSessionTests: XCTestCase {
    func testFieldPresentsSevenMostRelevantUnitsAndMoreAboveEight() throws {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let units = (0..<10).map { offset in
            UnitID.remote(.generate(
                at: date.addingTimeInterval(TimeInterval(offset + 1))
            ))
        }
        let balances = Dictionary(uniqueKeysWithValues: units.enumerated().map {
            index, unit in (unit, Int64(index * 100))
        })

        let presentation = FieldUnitPresentation.make(
            units: units,
            balances: balances
        )

        XCTAssertEqual(presentation.visibleUnitIDs.count, 8)
        XCTAssertEqual(presentation.visibleUnitIDs.last, .more)
        XCTAssertEqual(presentation.overflowUnitIDs, Array(units.prefix(3)))
        XCTAssertEqual(
            Array(presentation.visibleUnitIDs.dropLast()),
            Array(units.suffix(7).reversed())
        )
    }
    @MainActor
    func testAppleLoginExchangesCredentialAndStoresRotatedRefreshToken() async throws {
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "access-one", refreshToken: "refresh-one"),
            refreshResult: .fixture(accessToken: "access-two", refreshToken: "refresh-two")
        )
        let tokens = MemoryRefreshTokenStore()
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        provider.prepareAppleLogin(
            NumaAppleCredential(
                identityToken: "identity-token",
                authorizationCode: "authorization-code",
                rawNonce: "raw-nonce"
            )
        )
        let observed = TokenRecorder()

        let initial = try await provider.login { token in
            observed.record(token)
        }

        XCTAssertEqual(initial.accessToken, "access-one")
        let storedInitialToken = await tokens.read()
        let exchangedCredential = await server.lastAppleCredential()
        XCTAssertEqual(storedInitialToken, "refresh-one")
        XCTAssertEqual(
            exchangedCredential,
            NumaAppleCredential(
                identityToken: "identity-token",
                authorizationCode: "authorization-code",
                rawNonce: "raw-nonce"
            )
        )

        let refreshed = try await provider.loginFromCache { token in
            observed.record(token)
        }
        let storedRotatedToken = await tokens.read()
        let presentedRefreshToken = await server.lastRefreshToken()
        XCTAssertEqual(refreshed.accessToken, "access-two")
        XCTAssertEqual(storedRotatedToken, "refresh-two")
        XCTAssertEqual(presentedRefreshToken, "refresh-one")
        XCTAssertEqual(observed.values(), ["access-one", "access-two"])
    }

    @MainActor
    func testAppleAuthorizationRequestsOnlyTheUsedEmailScope() async throws {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)
        let request = ASAuthorizationAppleIDProvider().createRequest()

        model.prepareAppleAuthorization(request)

        XCTAssertEqual(request.requestedScopes, [.email])
        XCTAssertNotNil(request.nonce)
    }

    @MainActor
    func testRetryableRefreshFailureKeepsCachedTokenAndDoesNotSignOut() async throws {
        let server = RetryableRefreshServerStub()
        let tokens = MemoryRefreshTokenStore(token: "refresh-one")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        let observed = TokenRecorder()

        do {
            _ = try await provider.loginFromCache { token in
                observed.record(token)
            }
            XCTFail("A retryable refresh failure must surface to the caller")
        } catch let error as NumaSessionError {
            XCTAssertEqual(error, .server(code: "RATE_LIMITED", retryable: true))
        }

        let retainedToken = await tokens.read()
        XCTAssertEqual(retainedToken, "refresh-one")
        XCTAssertEqual(observed.values(), [])
    }

    @MainActor
    func testAccountValidatorRejectsNewAccountBeforeReplacingCachedCredential() async throws {
        let accountA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let accountB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory()
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.bindActiveIdentity(
            to: accountA,
            minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
        )
        let server = SessionServerStub(
            exchangeResult: .fixture(
                accessToken: "account-b-access",
                refreshToken: "account-b-refresh",
                accountID: accountB
            ),
            refreshResult: .fixture(
                accessToken: "account-a-access",
                refreshToken: "account-a-rotated-refresh",
                accountID: accountA
            )
        )
        let tokens = MemoryRefreshTokenStore(token: "account-a-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        provider.setSessionValidator { session in
            guard let accountID = session.accountID else {
                throw AppLedgerRepositoryError.invalidAccountIdentifier
            }
            try await repository.validateAccountBinding(accountID)
        }
        provider.prepareAppleLogin(NumaAppleCredential(
            identityToken: "identity-token",
            authorizationCode: "authorization-code",
            rawNonce: "raw-nonce"
        ))
        let observed = TokenRecorder()

        do {
            _ = try await provider.login { observed.record($0) }
            XCTFail("A different account must fail before credential commit")
        } catch let error as AppLedgerRepositoryError {
            guard case .accountIdentityMismatch = error else {
                return XCTFail("Expected accountIdentityMismatch, got \(error)")
            }
        }
        let retainedToken = await tokens.read()
        let revokedTokens = await server.logoutTokens()
        XCTAssertEqual(retainedToken, "account-a-refresh")
        XCTAssertEqual(revokedTokens, ["account-b-refresh"])
        XCTAssertEqual(observed.values(), [])

        let restored = try await provider.loginFromCache { observed.record($0) }
        XCTAssertEqual(restored.accountID, accountA)
        let rotatedToken = await tokens.read()
        XCTAssertEqual(rotatedToken, "account-a-rotated-refresh")
        XCTAssertEqual(observed.values(), ["account-a-access"])
    }

    @MainActor
    func testRejectedRotatedRefreshIsRevokedAndInvalidPredecessorIsCleared() async throws {
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "unused", refreshToken: "unused"),
            refreshResult: .fixture(
                accessToken: "rotated-access",
                refreshToken: "rotated-refresh"
            )
        )
        let tokens = MemoryRefreshTokenStore(token: "predecessor-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        provider.setSessionValidator { _ in throw NumaSessionError.invalidResponse }

        do {
            _ = try await provider.loginFromCache { _ in }
            XCTFail("Rejected rotated credentials must not be accepted")
        } catch let error as NumaSessionError {
            XCTAssertEqual(error, .invalidResponse)
        }

        let storedToken = await tokens.read()
        let presentedToken = await server.lastRefreshToken()
        let revokedTokens = await server.logoutTokens()
        XCTAssertNil(storedToken)
        XCTAssertEqual(presentedToken, "predecessor-refresh")
        XCTAssertEqual(revokedTokens, ["rotated-refresh"])
    }

    @MainActor
    func testConcurrentCachedLoginCoalescesThroughValidationBeforePublishing() async throws {
        let server = CountingSessionServerStub(
            refreshResult: .fixture(
                accessToken: "validated-access",
                refreshToken: "rotated-refresh"
            )
        )
        let tokens = MemoryRefreshTokenStore(token: "cached-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        let validation = ValidationGate()
        provider.setSessionValidator { _ in await validation.enterAndWait() }
        let observed = TokenRecorder()

        let first = Task { @MainActor in
            try await provider.loginFromCache { observed.record($0) }
        }
        await validation.waitUntilEntered()
        let second = Task { @MainActor in
            try await provider.loginFromCache { observed.record($0) }
        }
        await Task.yield()

        let blockedRefreshCount = await server.refreshCount()
        let blockedToken = await tokens.read()
        XCTAssertEqual(blockedRefreshCount, 1)
        XCTAssertEqual(blockedToken, "cached-refresh")
        XCTAssertEqual(observed.values(), [])

        await validation.release()
        let sessions = try await [first.value, second.value]
        let finalRefreshCount = await server.refreshCount()
        let validationCount = await validation.entryCount()
        let finalToken = await tokens.read()

        XCTAssertEqual(sessions.map(\.accessToken), ["validated-access", "validated-access"])
        XCTAssertEqual(finalRefreshCount, 1)
        XCTAssertEqual(validationCount, 1)
        XCTAssertEqual(finalToken, "rotated-refresh")
        XCTAssertEqual(observed.values(), ["validated-access"])
    }

    @MainActor
    func testLateRefreshResponseCannotRestoreCredentialsAfterLogout() async throws {
        let response = ValidationGate()
        let server = SuspendedRefreshServerStub(
            gate: response,
            result: .success(.fixture(accessToken: "late-access", refreshToken: "late-refresh"))
        )
        let tokens = MemoryRefreshTokenStore(token: "cached-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        let observed = TokenRecorder()
        let refresh = Task { @MainActor in
            try await provider.loginFromCache { observed.record($0) }
        }
        await response.waitUntilEntered()

        try await provider.logout()
        await response.release()
        do {
            _ = try await refresh.value
            XCTFail("A refresh from before logout must be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let retainedToken = await tokens.read()
        let revoked = await server.logoutTokens()
        XCTAssertNil(retainedToken)
        XCTAssertEqual(Set(revoked), ["cached-refresh", "late-refresh"])
        XCTAssertEqual(observed.values(), [])
        XCTAssertEqual(observed.signOutCount(), 1)
    }

    @MainActor
    func testLateRefreshValidationCannotRestoreCredentialsAfterDeletionCleanup() async throws {
        let validation = ValidationGate()
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "unused", refreshToken: "unused"),
            refreshResult: .fixture(accessToken: "late-access", refreshToken: "late-refresh")
        )
        let tokens = MemoryRefreshTokenStore(token: "cached-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        provider.setSessionValidator { _ in await validation.enterAndWait() }
        let observed = TokenRecorder()
        let refresh = Task { @MainActor in
            try await provider.loginFromCache { observed.record($0) }
        }
        await validation.waitUntilEntered()

        try await provider.clearAccountDeletionCredential()
        await validation.release()
        do {
            _ = try await refresh.value
            XCTFail("Validation from before deletion cleanup must not publish a token")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let retainedToken = await tokens.read()
        let revoked = await server.logoutTokens()
        XCTAssertNil(retainedToken)
        XCTAssertEqual(revoked, ["late-refresh"])
        XCTAssertEqual(observed.values(), [])
        XCTAssertEqual(observed.signOutCount(), 1)
    }

    @MainActor
    func testLateTerminalRefreshFailureCannotClearNewLogin() async throws {
        let response = ValidationGate()
        let server = SuspendedRefreshServerStub(
            gate: response,
            result: .failure(.server(code: "AUTH_SESSION_REVOKED", retryable: false))
        )
        let tokens = MemoryRefreshTokenStore(token: "cached-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        let observed = TokenRecorder()
        let refresh = Task { @MainActor in
            try await provider.loginFromCache { observed.record($0) }
        }
        await response.waitUntilEntered()
        provider.prepareAppleLogin(.init(
            identityToken: "identity", authorizationCode: "authorization", rawNonce: "nonce"
        ))
        _ = try await provider.login { observed.record($0) }

        await response.release()
        do {
            _ = try await refresh.value
            XCTFail("The superseded refresh must be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let retainedToken = await tokens.read()
        XCTAssertEqual(retainedToken, "new-refresh")
        XCTAssertEqual(observed.values(), ["new-access"])
        XCTAssertEqual(observed.signOutCount(), 0)
    }

    @MainActor
    func testLateRejectedRefreshValidationCannotClearNewLogin() async throws {
        let validation = ValidationGate()
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "new-access", refreshToken: "new-refresh"),
            refreshResult: .fixture(accessToken: "late-access", refreshToken: "late-refresh")
        )
        let tokens = MemoryRefreshTokenStore(token: "cached-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        provider.setSessionValidator { session in
            if session.accessToken == "late-access" {
                await validation.enterAndWait()
                throw NumaSessionError.invalidResponse
            }
        }
        let observed = TokenRecorder()
        let refresh = Task { @MainActor in
            try await provider.loginFromCache { observed.record($0) }
        }
        await validation.waitUntilEntered()
        provider.prepareAppleLogin(.init(
            identityToken: "identity", authorizationCode: "authorization", rawNonce: "nonce"
        ))
        _ = try await provider.login { observed.record($0) }

        await validation.release()
        do {
            _ = try await refresh.value
            XCTFail("Rejected validation from an old attempt must not sign out a new login")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let retainedToken = await tokens.read()
        let revoked = await server.logoutTokens()
        XCTAssertEqual(retainedToken, "new-refresh")
        XCTAssertEqual(revoked, ["late-refresh"])
        XCTAssertEqual(observed.values(), ["new-access"])
        XCTAssertEqual(observed.signOutCount(), 0)
    }

    @MainActor
    func testSuspendedCredentialWriteCannotOutliveDeletionCleanup() async throws {
        let write = ValidationGate()
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "late-access", refreshToken: "late-refresh"),
            refreshResult: .fixture(accessToken: "unused", refreshToken: "unused")
        )
        let tokens = SuspendedWriteTokenStore(token: "cached-refresh", gate: write)
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        let observed = TokenRecorder()
        provider.prepareAppleLogin(.init(
            identityToken: "identity", authorizationCode: "authorization", rawNonce: "nonce"
        ))
        let login = Task { @MainActor in
            try await provider.login { observed.record($0) }
        }
        await write.waitUntilEntered()
        var cleanup: Task<Void, Error>?
        await withCheckedContinuation { started in
            cleanup = Task { @MainActor in
                started.resume()
                try await provider.clearAccountDeletionCredential()
            }
        }

        await write.release()
        try await XCTUnwrap(cleanup).value
        do {
            _ = try await login.value
            XCTFail("An old credential write must not finish after cleanup")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let retainedToken = await tokens.read()
        XCTAssertNil(retainedToken)
        XCTAssertEqual(observed.values(), [])
        XCTAssertEqual(observed.signOutCount(), 1)
    }

    @MainActor
    func testSuspendedRefreshWriteCannotOverwriteNewLogin() async throws {
        let write = ValidationGate()
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "new-access", refreshToken: "new-refresh"),
            refreshResult: .fixture(accessToken: "late-access", refreshToken: "late-refresh")
        )
        let tokens = SuspendedWriteTokenStore(token: "cached-refresh", gate: write)
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        let observed = TokenRecorder()
        let refresh = Task { @MainActor in
            try await provider.loginFromCache { observed.record($0) }
        }
        await write.waitUntilEntered()
        provider.prepareAppleLogin(.init(
            identityToken: "identity", authorizationCode: "authorization", rawNonce: "nonce"
        ))
        var login: Task<NumaSession, Error>?
        await withCheckedContinuation { started in
            login = Task { @MainActor in
                started.resume()
                return try await provider.login { observed.record($0) }
            }
        }

        await write.release()
        _ = try await XCTUnwrap(login).value
        do {
            _ = try await refresh.value
            XCTFail("A suspended old write must yield credential ownership to the new login")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let retainedToken = await tokens.read()
        XCTAssertEqual(retainedToken, "new-refresh")
        XCTAssertEqual(observed.values(), ["new-access"])
        XCTAssertEqual(observed.signOutCount(), 0)
    }

    func testHTTPClientSendsNoStoreJSONContractWithoutLeakingTokensIntoErrors() async throws {
        let loader = HTTPDataLoaderStub { request in
            XCTAssertEqual(request.url?.path, "/auth/refresh")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try XCTUnwrap(request.httpBody)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: body) as? [String: String]
            )
            XCTAssertEqual(object, ["refreshToken": "secret-refresh"])
            let requestURL = try XCTUnwrap(request.url)
            let response = try XCTUnwrap(HTTPURLResponse(
                url: requestURL,
                statusCode: 401,
                httpVersion: "HTTP/1.1",
                headerFields: ["Cache-Control": "no-store"]
            ))
            return (
                Data(#"{"error":{"code":"REFRESH_TOKEN_REUSED","retryable":false}}"#.utf8),
                response
            )
        }
        let client = NumaSessionHTTPClient(
            siteURL: try XCTUnwrap(URL(string: "https://identity.example")),
            loader: loader
        )

        do {
            _ = try await client.refresh(refreshToken: "secret-refresh")
            XCTFail("A rejected refresh must fail")
        } catch let error as NumaSessionError {
            XCTAssertEqual(error, .server(code: "REFRESH_TOKEN_REUSED", retryable: false))
            XCTAssertFalse(String(describing: error).contains("secret-refresh"))
        }
    }

    func testHTTPClientPreservesStructuredCancellation() async throws {
        let siteURL = try XCTUnwrap(URL(string: "https://identity.example"))
        let taskCancellationClient = NumaSessionHTTPClient(
            siteURL: siteURL,
            loader: HTTPDataLoaderStub { _ in throw CancellationError() }
        )
        do {
            _ = try await taskCancellationClient.appConfiguration()
            XCTFail("Expected task cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let urlCancellationClient = NumaSessionHTTPClient(
            siteURL: siteURL,
            loader: HTTPDataLoaderStub { _ in throw URLError(.cancelled) }
        )
        do {
            _ = try await urlCancellationClient.appConfiguration()
            XCTFail("Expected URL loading cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
    }

    @MainActor
    func testAccountDeletionRetainsCachedCredentialUntilDurableLocalCompletion() async throws {
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "unused", refreshToken: "unused"),
            refreshResult: .fixture(accessToken: "unused", refreshToken: "unused")
        )
        let tokens = MemoryRefreshTokenStore(token: "deletion-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)

        let preview = try await provider.accountDeletionPreview()
        XCTAssertEqual(preview.pots.first?.name, "Casa Mar")
        try await provider.deleteAccount(
            requestID: "01890f5e-7b00-7000-8000-000000000123",
            originatingTimeZone: "Europe/Madrid"
        )

        let retainedToken = await tokens.read()
        XCTAssertEqual(retainedToken, "deletion-refresh")
        let request = await server.lastAccountDeletion()
        XCTAssertEqual(request?.refreshToken, "deletion-refresh")
        XCTAssertEqual(request?.requestID, "01890f5e-7b00-7000-8000-000000000123")
        XCTAssertEqual(request?.originatingTimeZone, "Europe/Madrid")
    }

    @MainActor
    func testAccountDeletionCredentialClearsOnlyWhenExplicitlyFinalized() async throws {
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "unused", refreshToken: "unused"),
            refreshResult: .fixture(accessToken: "unused", refreshToken: "unused")
        )
        let tokens = MemoryRefreshTokenStore(token: "deletion-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)

        try await provider.clearAccountDeletionCredential()

        let retainedToken = await tokens.read()
        XCTAssertNil(retainedToken)
    }

    @MainActor
    func testLogoutKeepsCachedCredentialWhenServerRevocationFails() async throws {
        let server = SessionServerStub(
            exchangeResult: .fixture(accessToken: "unused", refreshToken: "unused"),
            refreshResult: .fixture(accessToken: "unused", refreshToken: "unused"),
            logoutError: .server(code: "AUTH_LOGOUT_UNAVAILABLE", retryable: true)
        )
        let tokens = MemoryRefreshTokenStore(token: "logout-refresh")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)

        do {
            try await provider.logout()
            XCTFail("Failed server revocation must keep sign-out incomplete")
        } catch let error as NumaSessionError {
            XCTAssertEqual(
                error,
                .server(code: "AUTH_LOGOUT_UNAVAILABLE", retryable: true)
            )
        }

        let retainedToken = await tokens.read()
        let logoutTokens = await server.logoutTokens()
        XCTAssertEqual(retainedToken, "logout-refresh")
        XCTAssertEqual(logoutTokens, ["logout-refresh"])
    }

    func testAccountDeletionHTTPBodyKeepsCredentialOutOfURL() async throws {
        let loader = HTTPDataLoaderStub { request in
            XCTAssertEqual(request.url?.path, "/auth/account/delete")
            XCTAssertNil(request.url?.query)
            let body = try XCTUnwrap(request.httpBody)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: body) as? [String: String]
            )
            XCTAssertEqual(object, [
                "refreshToken": "secret-refresh",
                "requestId": "01890f5e-7b00-7000-8000-000000000123",
                "originatingTimeZone": "Europe/Madrid",
            ])
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Cache-Control": "no-store"]
            ))
            return (Data(#"{"deleted":true}"#.utf8), response)
        }
        let client = NumaSessionHTTPClient(
            siteURL: try XCTUnwrap(URL(string: "https://identity.example")),
            loader: loader
        )

        try await client.deleteAccount(
            refreshToken: "secret-refresh",
            requestID: "01890f5e-7b00-7000-8000-000000000123",
            originatingTimeZone: "Europe/Madrid"
        )
    }

    func testAppConfigurationLoadsTheNoStoreBuildFloor() async throws {
        let loader = HTTPDataLoaderStub { request in
            XCTAssertEqual(request.url?.path, "/app-config")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Cache-Control": "no-store"]
            ))
            return (Data(#"{"minimumSupportedBuild":42}"#.utf8), response)
        }
        let client = NumaSessionHTTPClient(
            siteURL: try XCTUnwrap(URL(string: "https://identity.example")),
            loader: loader
        )

        let configuration = try await client.appConfiguration()

        XCTAssertEqual(configuration.minimumSupportedBuild, 42)
        XCTAssertTrue(AppModel.shouldForceUpdate(
            minimumSupportedBuild: configuration.minimumSupportedBuild,
            currentBuild: 41
        ))
        XCTAssertFalse(AppModel.shouldForceUpdate(
            minimumSupportedBuild: configuration.minimumSupportedBuild,
            currentBuild: 42
        ))
        XCTAssertFalse(AppModel.shouldForceUpdate(
            minimumSupportedBuild: nil,
            currentBuild: 1
        ))
    }

    func testSupportMailContainsOnlyBoundedDiagnostics() throws {
        let diagnosticID = try XCTUnwrap(
            UUID(uuidString: "01890f5e-7b00-7000-8000-000000000123")
        )

        let url = try XCTUnwrap(AppSupportInfo.mailURL(
            recipient: "support@example.com",
            version: "1.0",
            build: "42",
            systemVersion: "iOS 27.0",
            diagnosticID: diagnosticID
        ))
        let components = try XCTUnwrap(
            URLComponents(url: url, resolvingAgainstBaseURL: false)
        )
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map {
            ($0.name, $0.value ?? "")
        })

        XCTAssertEqual(components.scheme, "mailto")
        XCTAssertEqual(components.path, "support@example.com")
        XCTAssertEqual(query["subject"], "Numa Shared support")
        XCTAssertTrue(query["body", default: ""].contains("App version: 1.0 (42)"))
        XCTAssertTrue(query["body", default: ""].contains("System: iOS 27.0"))
        XCTAssertTrue(query["body", default: ""].contains(diagnosticID.uuidString.lowercased()))
        XCTAssertFalse(query["body", default: ""].localizedCaseInsensitiveContains("token"))
        XCTAssertFalse(query["body", default: ""].localizedCaseInsensitiveContains("account"))
    }

    func testSupportMailRejectsHeaderInjection() {
        XCTAssertNil(AppSupportInfo.mailURL(
            recipient: "support@example.com\nBcc: attacker@example.com",
            version: "1.0",
            build: "42",
            systemVersion: "iOS 27.0",
            diagnosticID: UUID()
        ))
    }

    func testAccountDeletionPreviewNamesSuccessionSoloPotAndUnsyncedLoss() {
        let preview = NumaAccountDeletionPreview(pots: [
            .init(
                potID: "shared",
                name: "Casa Mar",
                outcome: .anonymized,
                successorName: "Maya"
            ),
            .init(
                potID: "solo",
                name: "Archive",
                outcome: .deleted,
                successorName: nil
            ),
        ])

        let copy = AppModel.accountDeletionMessage(preview: preview, unsyncedCount: 2)
        XCTAssertTrue(copy.contains("Former member"))
        XCTAssertTrue(copy.contains("Ownership of “Casa Mar” will transfer to Maya."))
        XCTAssertTrue(copy.contains("“Archive” will be deleted"))
        XCTAssertTrue(copy.contains("2 unsynced records"))
    }

#if DEBUG
    func testE2EIdentitySeedIsStableUUIDv7AndRunScoped() throws {
        let first = try AppLedgerIdentitySet.deterministicE2E(seed: "01ab23cd")
        let repeatValue = try AppLedgerIdentitySet.deterministicE2E(seed: "01ab23cd")
        let other = try AppLedgerIdentitySet.deterministicE2E(seed: "01ab23ce")

        XCTAssertEqual(first, repeatValue)
        XCTAssertNotEqual(first.potID, other.potID)
        XCTAssertNotNil(UUIDv7.timestampMilliseconds(of: first.potID.rawValue))
        XCTAssertNotNil(UUIDv7.timestampMilliseconds(of: first.ownerMemberID.rawValue))
        XCTAssertTrue(first.orderedUnitIDs.allSatisfy {
            UUIDv7.timestampMilliseconds(of: $0.rawValue) != nil
        })
    }

    @MainActor
    func testE2ELoginBootstrapsRunAccountDespiteStaleCachedToken() async throws {
        let expected = NumaSession.fixture(
            accessToken: "run-access",
            refreshToken: "run-refresh",
            accountID: "public-run-account"
        )
        let server = SessionServerStub(
            exchangeResult: expected,
            refreshResult: .fixture(
                accessToken: "stale-access",
                refreshToken: "stale-refresh",
                accountID: "stale-account"
            )
        )
        let tokens = MemoryRefreshTokenStore(token: "stale-fixed-token")
        let provider = NumaAuthProvider(server: server, refreshTokens: tokens)
        provider.prepareE2ELogin(
            accountKey: "p2-single-account-run",
            bootstrapSecret: String(repeating: "s", count: 32)
        )

        let session = try await provider.login { _ in }
        let bootstrap = await server.lastE2EBootstrap()
        let presentedRefresh = await server.lastRefreshToken()
        let storedToken = await tokens.read()

        XCTAssertEqual(session.accountID, "public-run-account")
        XCTAssertEqual(bootstrap?.accountKey, "p2-single-account-run")
        XCTAssertNil(presentedRefresh)
        XCTAssertEqual(storedToken, "run-refresh")
    }

    func testE2ERolesUseDistinctLocalIdentitiesAndKeychainNamespaces() throws {
        let common: [String: String] = [
            "NUMA_SHARED_E2E_RUN_ID": "run-123",
            "NUMA_SHARED_E2E_BOOTSTRAP_SECRET": String(repeating: "s", count: 32),
            "NUMA_SHARED_E2E_COMMAND": "observe",
            "NUMA_SHARED_E2E_CONVEX_URL": "http://127.0.0.1:3210",
            "NUMA_SHARED_E2E_SITE_URL": "http://127.0.0.1:3211",
        ]
        let a = try XCTUnwrap(NumaSharedE2EConfiguration.process(
            arguments: [NumaSharedE2EConfiguration.launchArgument],
            environment: common.merging([
                "NUMA_SHARED_E2E_ROLE": "A",
                "NUMA_SHARED_E2E_RUN_SEED": "aa01",
            ]) { _, new in new }
        ))
        let b = try XCTUnwrap(NumaSharedE2EConfiguration.process(
            arguments: [NumaSharedE2EConfiguration.launchArgument],
            environment: common.merging([
                "NUMA_SHARED_E2E_ROLE": "B",
                "NUMA_SHARED_E2E_RUN_SEED": "bb02",
            ]) { _, new in new }
        ))

        XCTAssertEqual(a.accountKey, b.accountKey)
        XCTAssertNotEqual(a.identities.potID, b.identities.potID)
        XCTAssertNotEqual(a.refreshTokenAccount, b.refreshTokenAccount)

        let p3A = try XCTUnwrap(NumaSharedE2EConfiguration.process(
            arguments: [NumaSharedE2EConfiguration.launchArgument],
            environment: common.merging([
                "NUMA_SHARED_E2E_RUN_ID": "p3-run-123",
                "NUMA_SHARED_E2E_ROLE": "A",
                "NUMA_SHARED_E2E_RUN_SEED": "aa01",
            ]) { _, new in new }
        ))
        let p3B = try XCTUnwrap(NumaSharedE2EConfiguration.process(
            arguments: [NumaSharedE2EConfiguration.launchArgument],
            environment: common.merging([
                "NUMA_SHARED_E2E_RUN_ID": "p3-run-123",
                "NUMA_SHARED_E2E_ROLE": "B",
                "NUMA_SHARED_E2E_RUN_SEED": "bb02",
            ]) { _, new in new }
        ))
        XCTAssertNotEqual(p3A.accountKey, p3B.accountKey)
    }
#endif

    @MainActor
    func testSyncPresentationUsesCalmExactCapsuleCopy() {
        let local = SyncPresentation.local
        let offline = SyncPresentation.offline(pendingCount: 0)
        let terminal = SyncPresentation.paused(
            pendingCount: 20,
            code: "INVALID_SERVER_RESPONSE"
        )
        let update = SyncPresentation.paused(
            pendingCount: 0,
            code: "READER_UPDATE_REQUIRED"
        )
        let signIn = SyncPresentation.paused(
            pendingCount: 0,
            code: "ACCOUNT_IDENTITY_MISMATCH"
        )
        let access = SyncPresentation.paused(
            pendingCount: 0,
            code: "NOT_MEMBER"
        )

        XCTAssertEqual(local.action, .enableSync)
        XCTAssertEqual(offline.title, "Offline")
        XCTAssertEqual(offline.action, .retry)
        XCTAssertEqual(offline.actionTitle, "Retry")
        XCTAssertEqual(
            terminal.title,
            "Sync paused"
        )
        XCTAssertEqual(terminal.detail, "20 records waiting")
        XCTAssertEqual(terminal.pauseDisposition, .terminal)
        XCTAssertEqual(terminal.action, .retry)
        XCTAssertEqual(terminal.actionTitle, "Retry")
        XCTAssertEqual(update.title, "Update required")
        XCTAssertEqual(update.pauseDisposition, .updateRequired)
        XCTAssertEqual(update.action, .none)
        XCTAssertEqual(signIn.title, "Sign in required")
        XCTAssertEqual(signIn.pauseDisposition, .signInRequired)
        XCTAssertEqual(signIn.action, .signIn)
        XCTAssertEqual(access.title, "Access changed")
        XCTAssertEqual(access.pauseDisposition, .accessRemoved)
        XCTAssertEqual(access.action, .none)
        for code in SyncAuthenticationFailureCodeContract.signInRequiredCodes {
            let presentation = SyncPresentation.paused(pendingCount: 2, code: code)
            XCTAssertEqual(presentation.title, "Sign in required", code)
            XCTAssertEqual(presentation.pauseDisposition, .signInRequired, code)
            XCTAssertEqual(presentation.action, .signIn, code)
        }
        for code in SyncAuthenticationFailureCodeContract.configurationInvalidCodes {
            let presentation = SyncPresentation.paused(pendingCount: 2, code: code)
            XCTAssertEqual(presentation.title, "Sync setup issue", code)
            XCTAssertEqual(presentation.pauseDisposition, .configurationInvalid, code)
            XCTAssertEqual(presentation.action, .none, code)
        }
        XCTAssertEqual(SyncPresentation.synced.title, "Synced")
        XCTAssertTrue(SyncPresentation.synced.dismissesAutomatically)
        XCTAssertFalse(SyncPresentation.offline(pendingCount: 0).dismissesAutomatically)
        XCTAssertNil(
            SyncPresentation.paused(
                pendingCount: 0,
                code: "NOT_MEMBER"
            ).detail
        )
    }

    func testDynamicUnitSplitUsesIntegerMoneyAndRemainderToLast() throws {
        let units = (0..<10).compactMap { UnitID(rawValue: "dynamic-\($0)") }
        let weights = Dictionary(uniqueKeysWithValues: units.map { ($0, Int64(1)) })

        let allocation = try XCTUnwrap(AppModel.allocateMinorUnits(
            total: 101,
            weights: weights,
            orderedUnitIDs: units
        ))

        XCTAssertEqual(allocation.values.reduce(0, +), 101)
        XCTAssertEqual(units.dropLast().map { allocation[$0] }, Array(repeating: 10, count: 9))
        XCTAssertEqual(allocation[units.last!], 11)
    }

    func testActivityHistoryCopyNeverClaimsUnsyncedRowsAreShared() {
        XCTAssertEqual(
            AppModel.activityHistoryCopy(
                for: .synced,
                hasUnsyncedEvents: true
            ),
            "Some records are only on this iPhone."
        )
        XCTAssertEqual(
            AppModel.activityHistoryCopy(for: .local),
            "On this iPhone until you enable sync."
        )
        XCTAssertEqual(
            AppModel.activityHistoryCopy(for: .offline(pendingCount: 2)),
            "Waiting records stay on this iPhone."
        )
        XCTAssertEqual(
            AppModel.activityHistoryCopy(for: .synced),
            "Synced with everyone in this pot."
        )
        XCTAssertEqual(
            AppModel.activityHistoryCopy(
                for: .synced,
                hasPendingDeliveryEvents: true
            ),
            "Waiting records stay on this iPhone."
        )
        XCTAssertEqual(
            AppModel.activityHistoryCopy(
                for: .paused(pendingCount: 0, code: "NOT_MEMBER")
            ),
            "Available on this iPhone."
        )
    }

    func testEveryRecordKindHasLocalizedHumanReadableCopy() {
        XCTAssertEqual(
            Set(RecordKind.allCases.map(\.displayName)).count,
            RecordKind.allCases.count
        )
        for kind in RecordKind.allCases {
            XCTAssertFalse(kind.displayName.isEmpty, kind.rawValue)
            XCTAssertNotEqual(kind.displayName, kind.rawValue, kind.rawValue)
            XCTAssertFalse(kind.displayName.contains("Revision"), kind.rawValue)
            XCTAssertFalse(kind.displayName.contains("Attempt"), kind.rawValue)
        }
    }

    @MainActor
    func testActivityHistoryCopyDoesNotClaimHeldRecordIsShared() async throws {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        _ = try await repository.bootstrap(seedCasaMar: false)
        let heldRecord = ExpenseRecord(
            id: "held-record",
            sortOrdinal: 1,
            kind: .expense,
            title: "Held for Undo",
            amountCents: 125,
            payer: .am,
            parts: [.sam: 125],
            to: nil,
            occurredAt: Date(timeIntervalSince1970: 1_700_000_000),
            originatingTimeZoneIdentifier: "UTC",
            category: nil,
            recordedBy: "Arseny",
            voided: false,
            flagged: false,
            deliveryState: .waiting
        )
        let snapshot = AppLedgerSnapshot(
            revision: 1,
            balances: [.am: 125, .sam: -125, .leo: 0],
            spend: 125,
            plan: [],
            records: [heldRecord],
            pendingDeliveryEventCount: 1,
            unsyncedEventCount: 1,
            isArchived: false,
            reductionAccess: .readWrite,
            minimumReaderSchemaVersion: nil
        )
        let model = AppModel(repository: repository, snapshot: snapshot)
        model.setSyncPresentationForTesting(.synced)

        XCTAssertEqual(
            model.activityHistoryCopy,
            "Waiting records stay on this iPhone."
        )
    }

    @MainActor
    func testEffectiveSyncPresentationTracksHeldCorrectionThroughUndo() async throws {
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let expense = try await repository.appendExpense(
            title: "Already synced expense",
            amountMinorUnits: 125,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: baseDate,
            savedAt: baseDate
        )
        _ = try store.expireHeldEvents(now: baseDate.addingTimeInterval(6))
        _ = try store.markDispatching(
            eventID: expense.eventID,
            at: baseDate.addingTimeInterval(6)
        )
        _ = try store.acknowledge(
            eventID: expense.eventID,
            serverSequence: 1,
            at: baseDate.addingTimeInterval(7)
        )
        let synced = try await repository.refreshSnapshot()
        let recordID = try XCTUnwrap(synced.records.first?.id)
        XCTAssertEqual(synced.records.first?.deliveryState, .synced)
        XCTAssertFalse(synced.hasPendingDeliveryEvents)
        let model = AppModel(repository: repository, snapshot: synced)
        model.setSyncPresentationForTesting(.synced)
        XCTAssertEqual(model.syncPresentation, .synced)

        let heldVoidMutation = try await repository.appendVoid(
            recordID: recordID,
            reason: "double entry",
            occurredAt: baseDate.addingTimeInterval(8),
            savedAt: baseDate.addingTimeInterval(8)
        )
        let heldVoid = heldVoidMutation.snapshot
        XCTAssertEqual(heldVoid.records.first?.deliveryState, .synced)
        XCTAssertTrue(heldVoid.hasPendingDeliveryEvents)
        model.applySnapshotForTesting(heldVoid)

        XCTAssertEqual(model.syncPresentation, .syncing(pendingCount: 1))
        XCTAssertEqual(
            model.activityHistoryCopy,
            "Waiting records stay on this iPhone."
        )
        XCTAssertNotEqual(
            model.activityHistoryCopy,
            "Synced with everyone in this pot."
        )

        model.setSyncPresentationForTesting(.offline(pendingCount: 7))
        XCTAssertEqual(model.syncPresentation, .offline(pendingCount: 7))
        model.setSyncPresentationForTesting(
            .paused(pendingCount: 1, code: "NOT_MEMBER")
        )
        XCTAssertEqual(
            model.syncPresentation,
            .paused(pendingCount: 1, code: "NOT_MEMBER")
        )
        model.setSyncPresentationForTesting(.local)
        XCTAssertEqual(model.syncPresentation, .local)
        model.setSyncPresentationForTesting(.synced)
        XCTAssertEqual(model.syncPresentation, .syncing(pendingCount: 1))

        let undone = try await repository.undoHeldEvent(
            eventID: heldVoidMutation.eventID,
            now: baseDate.addingTimeInterval(9)
        )
        let undoneSnapshot = try XCTUnwrap(undone)
        XCTAssertFalse(undoneSnapshot.hasPendingDeliveryEvents)
        model.applySnapshotForTesting(undoneSnapshot)
        XCTAssertEqual(model.syncPresentation, .synced)
        XCTAssertEqual(
            model.activityHistoryCopy,
            "Synced with everyone in this pot."
        )
    }

    @MainActor
    func testActivityRowRendersCentralReasonSpecificFailedCopy() {
        let record = ExpenseRecord(
            id: "failed:01900000-0000-7000-8000-000000000001",
            sortOrdinal: 0,
            kind: .expense,
            title: "Attempted expense",
            amountCents: 125,
            payer: .am,
            parts: [.sam: 125],
            to: nil,
            occurredAt: Date(timeIntervalSince1970: 1_700_000_000),
            originatingTimeZoneIdentifier: "UTC",
            category: nil,
            recordedBy: "Arseny",
            voided: false,
            flagged: false,
            deliveryState: .failed,
            terminalReason: "NOT_MEMBER",
            targetRecordID: "01900000-0000-7000-8000-000000000002"
        )
        let row = ActivityRowView(
            record: record,
            palette: Pal.light,
            amountText: "€1.25"
        )

        XCTAssertEqual(
            row.visibleDeliveryCopy,
            "Couldn’t be added — you’re no longer a member"
        )
        XCTAssertTrue(record.failureSupportText?.contains("Attempted expense") == true)
        XCTAssertTrue(record.failureSupportText?.contains("Target record:") == true)
    }

    func testUserFacingSyncErrorsMatchBackendTerminalCodes() {
        XCTAssertEqual(
            AppModel.userFacingSyncError("AUTH_SESSION_REVOKED"),
            "Sync session ended. Sign in again to resume."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError("NOT_MEMBER"),
            "You’re no longer a member of this pot."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError("MEMBERSHIP_ARCHIVED"),
            "You’re no longer a member of this pot."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError("TRANSPORT_UNAVAILABLE"),
            "Your records are safe here. Retry when you’re online."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError("READER_UPDATE_REQUIRED"),
            "Update Numa Shared to continue syncing this pot."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError("ACCOUNT_IDENTITY_MISMATCH"),
            "This pot belongs to a different account. Sign back in with the original account."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError(
                "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
                presentation: .paused(
                    pendingCount: 0,
                    code: "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED"
                )
            ),
            "This pot reached its safe record capacity. Copy the failed record details and contact support."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError(
                "UNKNOWN_TERMINAL",
                presentation: .paused(
                    pendingCount: 0,
                    code: "UNKNOWN_TERMINAL"
                )
            ),
            "This record couldn’t be added. It remains on this iPhone; copy its details and contact support."
        )
        XCTAssertEqual(
            AppModel.userFacingSyncError(
                "TRANSPORT_UNAVAILABLE",
                presentation: .offline(pendingCount: 1)
            ),
            "Your records are safe here. Retry when you’re online."
        )
    }
}

private final class TokenRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String] = []
    private var signOuts = 0

    func record(_ token: String?) {
        lock.lock()
        defer { lock.unlock() }
        if let token { tokens.append(token) } else { signOuts += 1 }
    }

    func values() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return tokens
    }

    func signOutCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return signOuts
    }
}

private actor MemoryRefreshTokenStore: RefreshTokenStoring {
    private var token: String?

    init(token: String? = nil) {
        self.token = token
    }

    func read() -> String? { token }
    func write(_ token: String) { self.token = token }
    func clear() { token = nil }
}

private actor SuspendedWriteTokenStore: RefreshTokenStoring {
    private var token: String?
    private let gate: ValidationGate
    private var suspendsNextWrite = true

    init(token: String, gate: ValidationGate) {
        self.token = token
        self.gate = gate
    }

    func read() -> String? { token }

    func write(_ token: String) async {
        if suspendsNextWrite {
            suspendsNextWrite = false
            await gate.enterAndWait()
        }
        self.token = token
    }

    func clear() { token = nil }
}

private actor SuspendedRefreshServerStub: NumaSessionServing {
    private let gate: ValidationGate
    private let result: Result<NumaSession, NumaSessionError>
    private var revokedTokens: [String] = []

    init(gate: ValidationGate, result: Result<NumaSession, NumaSessionError>) {
        self.gate = gate
        self.result = result
    }

    func exchangeApple(_ credential: NumaAppleCredential) -> NumaSession {
        .fixture(accessToken: "new-access", refreshToken: "new-refresh")
    }

    func refresh(refreshToken: String) async throws -> NumaSession {
        await gate.enterAndWait()
        return try result.get()
    }

    func logout(refreshToken: String) { revokedTokens.append(refreshToken) }
    func logoutTokens() -> [String] { revokedTokens }

#if DEBUG
    func bootstrapE2E(accountKey: String, bootstrapSecret: String) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }
#endif
}

private actor SessionServerStub: NumaSessionServing {
    private let exchangeResult: NumaSession
    private let refreshResult: NumaSession
    private var appleCredential: NumaAppleCredential?
    private var refreshToken: String?
    private var revokedRefreshTokens: [String] = []
    private var accountDeletion: (
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    )?
    private let logoutError: NumaSessionError?
#if DEBUG
    private var e2eBootstrap: (accountKey: String, bootstrapSecret: String)?
#endif

    init(
        exchangeResult: NumaSession,
        refreshResult: NumaSession,
        logoutError: NumaSessionError? = nil
    ) {
        self.exchangeResult = exchangeResult
        self.refreshResult = refreshResult
        self.logoutError = logoutError
    }

    func exchangeApple(_ credential: NumaAppleCredential) -> NumaSession {
        appleCredential = credential
        return exchangeResult
    }

    func refresh(refreshToken: String) -> NumaSession {
        self.refreshToken = refreshToken
        return refreshResult
    }

    func logout(refreshToken: String) throws {
        revokedRefreshTokens.append(refreshToken)
        if let logoutError { throw logoutError }
    }

    func accountDeletionPreview(refreshToken: String) -> NumaAccountDeletionPreview {
        NumaAccountDeletionPreview(pots: [
            .init(
                potID: "01890f5e-7b00-7000-8000-000000000001",
                name: "Casa Mar",
                outcome: .anonymized,
                successorName: "Maya"
            ),
        ])
    }

    func deleteAccount(
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    ) {
        accountDeletion = (refreshToken, requestID, originatingTimeZone)
    }

#if DEBUG
    func bootstrapE2E(accountKey: String, bootstrapSecret: String) -> NumaSession {
        e2eBootstrap = (accountKey, bootstrapSecret)
        return exchangeResult
    }
#endif

    func lastAppleCredential() -> NumaAppleCredential? { appleCredential }
    func lastRefreshToken() -> String? { refreshToken }
    func logoutTokens() -> [String] { revokedRefreshTokens }
    func lastAccountDeletion() -> (
        refreshToken: String,
        requestID: String,
        originatingTimeZone: String
    )? { accountDeletion }
#if DEBUG
    func lastE2EBootstrap() -> (accountKey: String, bootstrapSecret: String)? {
        e2eBootstrap
    }
#endif
}

private actor RetryableRefreshServerStub: NumaSessionServing {
    func exchangeApple(_ credential: NumaAppleCredential) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }

    func refresh(refreshToken: String) throws -> NumaSession {
        throw NumaSessionError.server(code: "RATE_LIMITED", retryable: true)
    }

    func logout(refreshToken: String) {}

#if DEBUG
    func bootstrapE2E(accountKey: String, bootstrapSecret: String) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }
#endif
}

private actor CountingSessionServerStub: NumaSessionServing {
    private let refreshResult: NumaSession
    private var count = 0

    init(refreshResult: NumaSession) {
        self.refreshResult = refreshResult
    }

    func exchangeApple(_ credential: NumaAppleCredential) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }

    func refresh(refreshToken: String) -> NumaSession {
        count += 1
        return refreshResult
    }

    func refreshCount() -> Int { count }
    func logout(refreshToken: String) {}

#if DEBUG
    func bootstrapE2E(accountKey: String, bootstrapSecret: String) throws -> NumaSession {
        throw NumaSessionError.appleCredentialInvalid
    }
#endif
}

private actor ValidationGate {
    private var entered = 0
    private var isReleased = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func enterAndWait() async {
        entered += 1
        entryWaiters.forEach { $0.resume() }
        entryWaiters.removeAll()
        guard !isReleased else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilEntered() async {
        guard entered == 0 else { return }
        await withCheckedContinuation { entryWaiters.append($0) }
    }

    func release() {
        isReleased = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }

    func entryCount() -> Int { entered }
}

private struct HTTPDataLoaderStub: HTTPDataLoading {
    let handler: @Sendable (URLRequest) async throws -> (Data, URLResponse)

    init(
        handler: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse)
    ) {
        self.handler = handler
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await handler(request)
    }
}

private extension NumaSession {
    static func fixture(
        accessToken: String,
        refreshToken: String,
        accountID: String = "account"
    ) -> NumaSession {
        NumaSession(
            accessToken: accessToken,
            accessTokenExpiresInSeconds: 300,
            refreshToken: refreshToken,
            refreshExpiresAt: 1_900_000_000_000,
            accountID: accountID
        )
    }
}
