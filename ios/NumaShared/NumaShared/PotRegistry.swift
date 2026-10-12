import Foundation

/// One locally stored pot: which database file holds it and how the
/// switcher shows it. Sync state is deliberately not recorded here —
/// v1.1 multi-pot is local-first, and sync stays bound to the pot it
/// was enabled on.
nonisolated struct LocalPotDescriptor: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    var name: String
    var currencyCode: String
    let databaseName: String
    let createdAt: Date
}

/// Persists the pot list and active selection as one JSON beside the
/// ledger databases. A legacy single-pot install migrates on first read:
/// its `ledger.sqlite` becomes the first registry entry.
nonisolated enum PotRegistry {
    enum RegistryError: Error, Equatable {
        case emptyState
        case missingActivePot
        case duplicatePotID
        case duplicateDatabaseName
        case cannotDeleteLegacyStore
        case unmanagedDatabaseName(String)
    }

    struct State: Codable, Equatable, Sendable {
        var pots: [LocalPotDescriptor]
        var activeID: UUID
    }

    static let legacyDatabaseName = "ledger.sqlite"
    private static let filename = "pots-v1.json"

    static func newDatabaseName() -> String {
        "pot-\(UUID().uuidString.lowercased().prefix(8)).sqlite"
    }

    static func load(from explicitDirectory: URL? = nil) throws -> State? {
        let directory = try explicitDirectory ?? storageDirectory()
        let url = directory.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        let state = try JSONDecoder().decode(State.self, from: data)
        try validate(state)
        return state
    }

    static func save(
        _ state: State,
        in explicitDirectory: URL? = nil
    ) throws {
        try validate(state)
        let directory = try explicitDirectory ?? storageDirectory()
        let data = try JSONEncoder().encode(state)
        try data.write(
            to: directory.appendingPathComponent(filename),
            options: .atomic
        )
    }

    /// Removes an abandoned pot's store files (database, SQLite sidecars,
    /// identity metadata). Never called for a registered pot.
    static func deleteStore(named databaseName: String) throws {
        guard databaseName != legacyDatabaseName else {
            throw RegistryError.cannotDeleteLegacyStore
        }
        try removeAccountStores(named: [databaseName])
    }

    static func removeAccountStores(
        named databaseNames: [String],
        from explicitDirectory: URL? = nil
    ) throws {
        let uniqueNames = Array(Set(databaseNames))
        for databaseName in uniqueNames where !isManagedDatabaseName(databaseName) {
            throw RegistryError.unmanagedDatabaseName(databaseName)
        }
        let directory = try explicitDirectory ?? storageDirectory()
        let fileManager = FileManager.default
        for databaseName in uniqueNames {
            for suffix in ["", "-wal", "-shm"] {
                try removeIfPresent(
                    directory.appendingPathComponent(databaseName + suffix),
                    fileManager: fileManager
                )
            }
            let identityFilename = databaseName == legacyDatabaseName
                ? "identity-v1.json"
                : "\(databaseName).identity-v1.json"
            try removeIfPresent(
                directory.appendingPathComponent(identityFilename),
                fileManager: fileManager
            )
        }
    }

    static func persist(
        _ state: State,
        in explicitDirectory: URL? = nil
    ) throws {
        try save(state, in: explicitDirectory)
    }

    private static func validate(_ state: State) throws {
        guard !state.pots.isEmpty else { throw RegistryError.emptyState }
        guard state.pots.contains(where: { $0.id == state.activeID }) else {
            throw RegistryError.missingActivePot
        }
        guard Set(state.pots.map(\.id)).count == state.pots.count else {
            throw RegistryError.duplicatePotID
        }
        guard Set(state.pots.map(\.databaseName)).count == state.pots.count else {
            throw RegistryError.duplicateDatabaseName
        }
        for pot in state.pots where !isManagedDatabaseName(pot.databaseName) {
            throw RegistryError.unmanagedDatabaseName(pot.databaseName)
        }
    }

    private static func isManagedDatabaseName(_ databaseName: String) -> Bool {
        if databaseName == legacyDatabaseName { return true }
        guard databaseName.hasPrefix("pot-"),
              databaseName.hasSuffix(".sqlite")
        else { return false }
        let start = databaseName.index(databaseName.startIndex, offsetBy: 4)
        let end = databaseName.index(databaseName.endIndex, offsetBy: -7)
        let identifier = databaseName[start ..< end]
        return identifier.count == 8 && identifier.allSatisfy { character in
            character.isASCII && character.isHexDigit
        }
    }

    private static func removeIfPresent(
        _ url: URL,
        fileManager: FileManager
    ) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        try fileManager.removeItem(at: url)
    }

    private static func storageDirectory() throws -> URL {
        guard let baseURL = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw CocoaError(.fileNoSuchFile)
        }
        let directory = baseURL.appendingPathComponent("NumaShared", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }
}
