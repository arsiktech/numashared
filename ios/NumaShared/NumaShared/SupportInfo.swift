import Foundation

nonisolated enum AppSupportInfo {
    static func versionDisplay(_ bundle: Bundle = .main) -> String {
        let version = normalized(
            bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        ) ?? "—"
        let build = normalized(
            bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        ) ?? "—"
        return String(
            format: String(localized: "Version %@ (%@)"),
            locale: .current,
            version,
            build
        )
    }

    static func supportDestination(
        _ bundle: Bundle = .main,
        diagnosticID: UUID = UUID()
    ) -> URL? {
        let version = normalized(
            bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        ) ?? "unknown"
        let build = normalized(
            bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        ) ?? "unknown"
        if let email = normalized(
            bundle.object(forInfoDictionaryKey: "NumaSharedSupportEmail") as? String
        ), email.contains("@") {
            return mailURL(
                recipient: email,
                version: version,
                build: build,
                systemVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                diagnosticID: diagnosticID
            )
        }
        guard let site = normalized(
            bundle.object(forInfoDictionaryKey: "NumaSharedSiteURL") as? String
        ), let url = URL(string: site), url.scheme == "https" else { return nil }
        return url.appendingPathComponent("support")
    }

    static func mailURL(
        recipient: String,
        version: String,
        build: String,
        systemVersion: String,
        diagnosticID: UUID
    ) -> URL? {
        guard recipient.contains("@"),
              !recipient.contains("\n"),
              !recipient.contains("\r")
        else { return nil }
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = recipient
        components.queryItems = [
            URLQueryItem(name: "subject", value: "Numa Shared support"),
            URLQueryItem(name: "body", value: """
            Please describe what happened:


            App version: \(version) (\(build))
            System: \(systemVersion)
            Diagnostic ID: \(diagnosticID.uuidString.lowercased())
            """),
        ]
        return components.url
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return nil }
        return trimmed
    }
}
