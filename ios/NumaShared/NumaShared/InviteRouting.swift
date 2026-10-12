import Foundation
import NumaSharedCore
import NumaSharedSync
import Security

nonisolated enum NumaInviteCredentialGenerationError: Error, Equatable, Sendable {
    case randomSourceUnavailable
}

nonisolated enum NumaInviteCredentialGenerator {
    private static let codeAlphabet = Array(
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".utf8
    )

    static func generate() throws -> InviteCredentialPair {
        var tokenBytes = [UInt8](repeating: 0, count: 32)
        var codeBytes = [UInt8](repeating: 0, count: 6)
        guard SecRandomCopyBytes(
            kSecRandomDefault,
            tokenBytes.count,
            &tokenBytes
        ) == errSecSuccess,
        SecRandomCopyBytes(
            kSecRandomDefault,
            codeBytes.count,
            &codeBytes
        ) == errSecSuccess
        else { throw NumaInviteCredentialGenerationError.randomSourceUnavailable }

        let token = Data(tokenBytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let code = String(decoding: codeBytes.map {
            codeAlphabet[Int($0 & 31)]
        }, as: UTF8.self)
        guard let credentials = InviteCredentialPair(token: token, code: code) else {
            throw NumaInviteCredentialGenerationError.randomSourceUnavailable
        }
        return credentials
    }
}

nonisolated struct ShareableInvite: Equatable, Sendable, Identifiable {
    let id: UUID
    let kind: InviteAdministrationKind
    let pendingMemberID: MemberID?
    let url: URL
    let code: String
    let expiresAtMillis: Int64
}

nonisolated enum InviteCredential: Equatable, Sendable {
    case code(String)
    case token(String, pairedCode: String)

    static func typedCode(_ value: String) -> InviteCredential? {
        var normalized = ""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 48 ... 57:
                normalized.unicodeScalars.append(scalar)
            case 65 ... 90:
                normalized.unicodeScalars.append(scalar)
            case 97 ... 122:
                guard let upper = UnicodeScalar(scalar.value - 32) else { return nil }
                normalized.unicodeScalars.append(upper)
            case 45:
                continue
            default:
                guard CharacterSet.whitespacesAndNewlines.contains(scalar) else {
                    return nil
                }
            }
            guard normalized.utf8.count <= 6 else { return nil }
        }
        guard normalized.utf8.count == 6 else { return nil }
        return .code(normalized)
    }

    fileprivate var pathCredential: String {
        switch self {
        case let .code(code): code
        case let .token(token, _): token
        }
    }

    fileprivate var pairedCode: String? {
        guard case let .token(_, pairedCode) = self else { return nil }
        return pairedCode
    }

    fileprivate static func canonicalToken(_ value: String) -> String? {
        guard (32 ... 512).contains(value.utf8.count),
              value.utf8.allSatisfy({ byte in
                  (48 ... 57).contains(byte)
                      || (65 ... 90).contains(byte)
                      || (97 ... 122).contains(byte)
                      || byte == 45
                      || byte == 95
              })
        else { return nil }
        return value
    }
}

nonisolated enum InviteRouteError: Error, Equatable, Sendable {
    case invalidRoute
}

nonisolated struct InviteRouteParser: Sendable {
    private let siteURL: URL

    init(siteURL: URL) {
        self.siteURL = siteURL
    }

    func parse(_ url: URL) throws -> InviteCredential {
        guard siteURL.scheme?.lowercased() == "https",
              siteURL.user == nil,
              siteURL.password == nil,
              siteURL.port == nil,
              siteURL.query == nil,
              siteURL.fragment == nil,
              siteURL.path.isEmpty || siteURL.path == "/",
              url.scheme?.lowercased() == "https",
              url.host?.lowercased() == siteURL.host?.lowercased(),
              url.user == nil,
              url.password == nil,
              url.port == nil,
              url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { throw InviteRouteError.invalidRoute }

        let prefix = "/join/"
        guard components.percentEncodedPath.hasPrefix(prefix) else {
            throw InviteRouteError.invalidRoute
        }
        let encoded = String(components.percentEncodedPath.dropFirst(prefix.count))
        guard !encoded.isEmpty,
              !encoded.contains("/"),
              let value = encoded.removingPercentEncoding,
              !value.contains("/")
        else { throw InviteRouteError.invalidRoute }

        if let code = InviteCredential.typedCode(value) {
            guard components.queryItems?.isEmpty != false else {
                throw InviteRouteError.invalidRoute
            }
            return code
        }

        guard let token = InviteCredential.canonicalToken(value),
              let items = components.queryItems,
              items.count == 1,
              items[0].name == "code",
              let rawCode = items[0].value,
              case let .code(code) = InviteCredential.typedCode(rawCode)
        else { throw InviteRouteError.invalidRoute }
        return .token(token, pairedCode: code)
    }

    func url(for credential: InviteCredential) throws -> URL {
        guard siteURL.scheme?.lowercased() == "https",
              siteURL.host?.isEmpty == false,
              siteURL.user == nil,
              siteURL.password == nil,
              siteURL.port == nil,
              siteURL.query == nil,
              siteURL.fragment == nil,
              siteURL.path.isEmpty || siteURL.path == "/",
              var components = URLComponents(url: siteURL, resolvingAgainstBaseURL: false)
        else { throw InviteRouteError.invalidRoute }
        components.path = "/join/\(credential.pathCredential)"
        components.queryItems = credential.pairedCode.map {
            [URLQueryItem(name: "code", value: $0)]
        }
        guard let url = components.url else { throw InviteRouteError.invalidRoute }
        return url
    }
}

nonisolated enum InvitePreviewStatus: String, Decodable, Equatable, Sendable {
    case active
    case invalid
    case expired
    case revoked
    case used
    case rateLimited
}

nonisolated enum InviteKind: String, Decodable, Equatable, Sendable {
    case perMember
    case potLink
}

nonisolated struct InvitePreview: Equatable, Sendable {
    let status: InvitePreviewStatus
    let kind: InviteKind?
    let potName: String?
    let expiresAt: Int64?
    let claimTicket: String?
    var minimumReaderSchemaVersion: UInt16? = nil
}

nonisolated protocol InvitePreviewServing: Sendable {
    func resolve(_ credential: InviteCredential) async throws -> InvitePreview
}

nonisolated enum JoinPhase: Equatable, Sendable {
    case entry
    case resolving
    case preview(potName: String?, kind: InviteKind)
    case claiming(potName: String?)
    case pendingApproval(potName: String?)
    case joined(potName: String?)
    case inactive(InvitePreviewStatus)
}

nonisolated enum NumaInviteHTTPError: Error, Equatable, Sendable {
    case invalidResponse
    case serviceUnavailable
    case transportUnavailable
}

actor NumaInviteHTTPClient: InvitePreviewServing {
    private let siteURL: URL
    private let loader: any HTTPDataLoading
    private let decoder = JSONDecoder()

    init(siteURL: URL, loader: any HTTPDataLoading = URLSession.shared) {
        self.siteURL = siteURL
        self.loader = loader
    }

    func resolve(_ credential: InviteCredential) async throws -> InvitePreview {
        let url: URL
        do {
            url = try InviteRouteParser(siteURL: siteURL).url(for: credential)
        } catch {
            throw NumaInviteHTTPError.invalidResponse
        }
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 15
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await loader.data(for: request)
        } catch {
            throw NumaInviteHTTPError.transportUnavailable
        }
        guard let http = response as? HTTPURLResponse,
              data.count <= 16_384
        else { throw NumaInviteHTTPError.invalidResponse }
        guard http.statusCode == 200 || http.statusCode == 429 else {
            throw NumaInviteHTTPError.serviceUnavailable
        }

        let decoded: Response
        do {
            decoded = try decoder.decode(Response.self, from: data)
        } catch {
            throw NumaInviteHTTPError.invalidResponse
        }
        if http.statusCode == 429 {
            guard decoded.status == .rateLimited else {
                throw NumaInviteHTTPError.invalidResponse
            }
            return InvitePreview(
                status: .rateLimited,
                kind: nil,
                potName: nil,
                expiresAt: nil,
                claimTicket: nil
            )
        }
        if decoded.status == .active {
            guard let kind = decoded.kind,
                  let expiresAt = decoded.expiresAt,
                  expiresAt > 0,
                  let ticket = decoded.claimTicket,
                  Self.isBoundedTicket(ticket),
                  let minimum = decoded.minimumReaderSchemaVersion,
                  (1...EventEnvelope.maximumSupportedSchemaVersion).contains(minimum)
            else { throw NumaInviteHTTPError.invalidResponse }
            return InvitePreview(
                status: .active,
                kind: kind,
                potName: Self.normalizedPotName(decoded.potName),
                expiresAt: expiresAt,
                claimTicket: ticket,
                minimumReaderSchemaVersion: minimum
            )
        }
        guard decoded.status != .rateLimited,
              decoded.kind == nil,
              decoded.potName == nil,
              decoded.expiresAt == nil,
              decoded.claimTicket == nil
        else { throw NumaInviteHTTPError.invalidResponse }
        return InvitePreview(
            status: decoded.status,
            kind: nil,
            potName: nil,
            expiresAt: nil,
            claimTicket: nil
        )
    }

    private static func normalizedPotName(_ value: String?) -> String? {
        guard let value,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.count <= 128
        else { return nil }
        return value
    }

    private static func isBoundedTicket(_ value: String) -> Bool {
        (32 ... 2_048).contains(value.utf8.count)
            && value.utf8.allSatisfy { (33 ... 126).contains($0) }
    }

    private struct Response: Decodable {
        let status: InvitePreviewStatus
        let kind: InviteKind?
        let potName: String?
        let expiresAt: Int64?
        let claimTicket: String?
        let minimumReaderSchemaVersion: UInt16?
    }
}
