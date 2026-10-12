import Foundation
import NumaSharedCore
import NumaSharedSync
import XCTest
@testable import NumaShared

final class InviteRoutingTests: XCTestCase {
    private let siteURL = URL(string: "https://steady-otter-123.convex.site")!

    func testUniversalLinkParserAcceptsOnlyTheConfiguredSiteAndCanonicalJoinShapes() throws {
        let parser = InviteRouteParser(siteURL: siteURL)
        let token = String(repeating: "a", count: 32)

        XCTAssertEqual(
            try parser.parse(URL(string: "https://steady-otter-123.convex.site/join/\(token)?code=AB12CD")!),
            .token(token, pairedCode: "AB12CD")
        )
        XCTAssertEqual(
            try parser.parse(URL(string: "https://steady-otter-123.convex.site/join/a-b%2012-cd")!),
            .code("AB12CD")
        )

        let rejected = [
            "http://steady-otter-123.convex.site/join/AB12CD",
            "https://other.convex.site/join/AB12CD",
            "https://user@steady-otter-123.convex.site/join/AB12CD",
            "https://steady-otter-123.convex.site:443/join/AB12CD",
            "https://steady-otter-123.convex.site/join/AB12CD/extra",
            "https://steady-otter-123.convex.site/join/AB12CD?unexpected=1",
            "https://steady-otter-123.convex.site/join/\(token)",
            "https://steady-otter-123.convex.site/join/\(token)?code=AB12CD&code=EF34GH",
            "https://steady-otter-123.convex.site/join/\(token)?code=AB12CD#secret",
        ]
        for value in rejected {
            XCTAssertThrowsError(try parser.parse(URL(string: value)!))
        }
    }

    func testTypedCodeNormalizationIsBoundedAndASCIIOnly() {
        XCTAssertEqual(InviteCredential.typedCode(" ab-12 cd "), .code("AB12CD"))
        XCTAssertNil(InviteCredential.typedCode("ABCDE"))
        XCTAssertNil(InviteCredential.typedCode("ABCDEFG"))
        XCTAssertNil(InviteCredential.typedCode("AB12CÉ"))
        XCTAssertNil(InviteCredential.typedCode("AB12C_") )
    }

    func testGeneratedInviteCredentialsRoundTripThroughTheShareRoute() throws {
        let credentials = try NumaInviteCredentialGenerator.generate()
        let parser = InviteRouteParser(siteURL: siteURL)
        let url = try parser.url(for: .token(
            credentials.token,
            pairedCode: credentials.code
        ))

        XCTAssertEqual(
            try parser.parse(url),
            .token(credentials.token, pairedCode: credentials.code)
        )
        XCTAssertEqual(credentials.token.utf8.count, 43)
        XCTAssertEqual(credentials.code.utf8.count, 6)
    }

    func testPreviewClientUsesDeliberateNoStoreJSONPostAndValidatesActiveShape() async throws {
        let ticket = "v1.01890f5e-7b00-7000-9000-000000000001.1700000000000.signature"
        let loader = InviteHTTPDataLoaderStub { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://steady-otter-123.convex.site/join/AB12CD"
            )
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            XCTAssertNil(request.httpBody)
            let url = try XCTUnwrap(request.url)
            let response = try XCTUnwrap(HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Cache-Control": "no-store"]
            ))
            return (
                Data(#"{"status":"active","kind":"perMember","potName":"Casa Mar","expiresAt":1900000000000,"minimumReaderSchemaVersion":2,"claimTicket":"__TICKET__"}"#
                    .replacingOccurrences(of: "__TICKET__", with: ticket).utf8),
                response
            )
        }
        let client = NumaInviteHTTPClient(siteURL: siteURL, loader: loader)

        let preview = try await client.resolve(.code("AB12CD"))

        XCTAssertEqual(preview.status, .active)
        XCTAssertEqual(preview.kind, .perMember)
        XCTAssertEqual(preview.potName, "Casa Mar")
        XCTAssertEqual(preview.claimTicket, ticket)
        XCTAssertEqual(preview.minimumReaderSchemaVersion, 2)
    }

    func testPreviewClientRejectsMalformedActiveResponsesWithoutLeakingCredential() async throws {
        let secretCode = "ZX98YU"
        let loader = InviteHTTPDataLoaderStub { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            ))
            return (
                Data(#"{"status":"active","kind":"perMember","potName":"Casa Mar","expiresAt":1900000000000}"#.utf8),
                response
            )
        }
        let client = NumaInviteHTTPClient(siteURL: siteURL, loader: loader)

        do {
            _ = try await client.resolve(.code(secretCode))
            XCTFail("An active preview without a claim ticket must fail closed")
        } catch {
            XCTAssertFalse(String(describing: error).contains(secretCode))
        }
    }

    func testPreviewClientMapsCalmInactiveAndRateLimitedStates() async throws {
        let statuses: [(Int, String, InvitePreviewStatus)] = [
            (200, "invalid", .invalid),
            (200, "expired", .expired),
            (200, "revoked", .revoked),
            (200, "used", .used),
            (429, "rateLimited", .rateLimited),
        ]
        for (statusCode, rawStatus, expected) in statuses {
            let loader = InviteHTTPDataLoaderStub { request in
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: statusCode,
                    httpVersion: "HTTP/1.1",
                    headerFields: nil
                ))
                return (Data("{\"status\":\"\(rawStatus)\"}".utf8), response)
            }
            let client = NumaInviteHTTPClient(siteURL: siteURL, loader: loader)

            let preview = try await client.resolve(.code("AB12CD"))

            XCTAssertEqual(preview.status, expected)
            XCTAssertNil(preview.kind)
            XCTAssertNil(preview.potName)
            XCTAssertNil(preview.claimTicket)
        }
    }

    @MainActor
    func testJoinStatePublishesPreviewWithoutPublishingClaimTicket() async throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: now),
            identities: .fresh(at: now)
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)
        let ticket = "v1.01890f5e-7b00-7000-9000-000000000001.signature"
        let service = InvitePreviewServiceStub(result: .success(InvitePreview(
            status: .active,
            kind: .perMember,
            potName: "Casa Mar",
            expiresAt: 1_900_000_000_000,
            claimTicket: ticket,
            minimumReaderSchemaVersion: 1
        )))
        model.setInvitePreviewServiceForTesting(siteURL: siteURL, service: service)

        await model.resolveJoinCodeForTesting("ab-12 cd")

        XCTAssertEqual(model.joinPhase, .preview(potName: "Casa Mar", kind: .perMember))
        XCTAssertNil(model.joinErrorMessage)
        XCTAssertFalse(String(describing: model.joinPhase).contains(ticket))
        let credentials = await service.credentials()
        XCTAssertEqual(credentials, [.code("AB12CD")])
    }

    @MainActor
    func testJoinStateRejectsForeignUniversalLinkWithoutOpeningSheet() async throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: now),
            identities: .fresh(at: now)
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)
        model.setInvitePreviewServiceForTesting(
            siteURL: siteURL,
            service: InvitePreviewServiceStub(result: .failure(NumaInviteHTTPError.invalidResponse))
        )

        XCTAssertFalse(model.handleOpenURL(URL(string: "https://other.convex.site/join/AB12CD")!))
        XCTAssertFalse(model.joinPresented)
        XCTAssertEqual(model.joinPhase, .entry)
    }
}

private actor InviteHTTPDataLoaderStub: HTTPDataLoading {
    private let handler: @Sendable (URLRequest) throws -> (Data, URLResponse)

    init(handler: @escaping @Sendable (URLRequest) throws -> (Data, URLResponse)) {
        self.handler = handler
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try handler(request)
    }
}

private actor InvitePreviewServiceStub: InvitePreviewServing {
    private let result: Result<InvitePreview, NumaInviteHTTPError>
    private var received: [InviteCredential] = []

    init(result: Result<InvitePreview, NumaInviteHTTPError>) {
        self.result = result
    }

    func resolve(_ credential: InviteCredential) async throws -> InvitePreview {
        received.append(credential)
        return try result.get()
    }

    func credentials() -> [InviteCredential] {
        received
    }
}
