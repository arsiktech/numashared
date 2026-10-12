import Foundation
import GRDB
import NumaSharedCore

extension LedgerStore {
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1_ledger_store") { db in
            try installV1Schema(in: db)
        }
        migrator.registerMigration("v2_erasure_sidecars") { db in
            try migrateAuthoredTextToSidecars(in: db)
        }
        migrator.registerMigration("v3_text_revision_cursor") { db in
            try db.execute(sql: """
                ALTER TABLE pot_sync_state
                ADD COLUMN lastTextRevision INTEGER NOT NULL DEFAULT 0
                    CHECK (lastTextRevision >= 0)
                """)
        }
        migrator.registerMigration("v4_empty_promotion_recovery") { db in
            try db.execute(sql: """
                ALTER TABLE pot_sync_state
                ADD COLUMN emptyPromotionRequired INTEGER NOT NULL DEFAULT 0
                    CHECK (emptyPromotionRequired IN (0, 1))
                """)
        }
        migrator.registerMigration("v5_future_text_sidecars") { db in
            try db.execute(sql: """
                CREATE TABLE event_future_text_sidecars (
                    eventID TEXT PRIMARY KEY NOT NULL
                        REFERENCES ledger_events(eventID) ON DELETE CASCADE,
                    metadataBlob BLOB NOT NULL
                )
                """)
            try db.execute(sql: """
                CREATE TRIGGER event_future_text_sidecars_no_update
                BEFORE UPDATE ON event_future_text_sidecars
                BEGIN
                    SELECT RAISE(ABORT, 'future event text metadata is immutable');
                END
                """)
        }
        migrator.registerMigration("v6_local_pot_setup") { db in
            try db.execute(sql: """
                CREATE TABLE local_pot_setup (
                    potID TEXT PRIMARY KEY NOT NULL
                        REFERENCES pot_configurations(potID) ON DELETE CASCADE,
                    potName TEXT NOT NULL,
                    ownerMemberID TEXT NOT NULL,
                    isComplete INTEGER NOT NULL CHECK (isComplete IN (0, 1)),
                    renameEventID TEXT NOT NULL,
                    renameEventBlob BLOB NOT NULL,
                    renameConfirmed INTEGER NOT NULL DEFAULT 0
                        CHECK (renameConfirmed IN (0, 1)),
                    createdAtMillis INTEGER NOT NULL,
                    updatedAtMillis INTEGER NOT NULL
                )
                """)
            try db.execute(sql: """
                CREATE UNIQUE INDEX local_pot_setup_rename_event
                ON local_pot_setup(renameEventID)
                """)
            try db.execute(sql: """
                CREATE TRIGGER local_pot_setup_rename_event_no_update
                BEFORE UPDATE OF renameEventID, renameEventBlob ON local_pot_setup
                WHEN OLD.renameEventID IS NOT NEW.renameEventID
                    OR OLD.renameEventBlob IS NOT NEW.renameEventBlob
                BEGIN
                    SELECT RAISE(ABORT, 'pot rename event is immutable');
                END
                """)
            try db.execute(sql: """
                CREATE TABLE local_pot_member_profiles (
                    potID TEXT NOT NULL
                        REFERENCES pot_configurations(potID) ON DELETE CASCADE,
                    memberID TEXT NOT NULL,
                    unitID TEXT,
                    displayName TEXT,
                    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
                    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'archived')),
                    sortOrdinal INTEGER NOT NULL CHECK (sortOrdinal >= 0),
                    bindingEventID TEXT,
                    bindingEventBlob BLOB,
                    bindingConfirmed INTEGER NOT NULL DEFAULT 0
                        CHECK (bindingConfirmed IN (0, 1))
                        CHECK (bindingEventID IS NOT NULL OR bindingConfirmed = 0),
                    createdAtMillis INTEGER NOT NULL,
                    updatedAtMillis INTEGER NOT NULL,
                    PRIMARY KEY (potID, memberID),
                    UNIQUE (potID, sortOrdinal)
                )
                """)
            try db.execute(sql: """
                CREATE UNIQUE INDEX local_pot_member_profiles_unit
                ON local_pot_member_profiles(potID, unitID)
                WHERE unitID IS NOT NULL
                """)
            try db.execute(sql: """
                CREATE UNIQUE INDEX local_pot_member_profiles_binding_event
                ON local_pot_member_profiles(bindingEventID)
                WHERE bindingEventID IS NOT NULL
                """)
            try db.execute(sql: """
                CREATE TRIGGER local_pot_member_binding_event_no_update
                BEFORE UPDATE OF bindingEventID, bindingEventBlob
                ON local_pot_member_profiles
                WHEN OLD.bindingEventID IS NOT NEW.bindingEventID
                    OR OLD.bindingEventBlob IS NOT NEW.bindingEventBlob
                BEGIN
                    SELECT RAISE(ABORT, 'member binding event is immutable');
                END
                """)
        }
        migrator.registerMigration("v7_member_roster_cache") { db in
            try db.execute(sql: """
                CREATE TABLE cached_pot_member_profiles (
                    potID TEXT NOT NULL
                        REFERENCES pot_configurations(potID) ON DELETE CASCADE,
                    memberID TEXT NOT NULL,
                    unitID TEXT,
                    displayName TEXT,
                    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
                    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'archived')),
                    sortOrdinal INTEGER NOT NULL CHECK (sortOrdinal >= 0),
                    updatedAtMillis INTEGER NOT NULL,
                    PRIMARY KEY (potID, memberID),
                    UNIQUE (potID, sortOrdinal)
                )
                """)
            try db.execute(sql: """
                CREATE UNIQUE INDEX cached_pot_member_profiles_unit
                ON cached_pot_member_profiles(potID, unitID)
                WHERE unitID IS NOT NULL
                """)
        }
        migrator.registerMigration("v8_budget_group_operations") { db in
            try db.execute(sql: "ALTER TABLE pot_sync_state ADD COLUMN pauseCode TEXT")
            try db.execute(sql: "ALTER TABLE cached_pot_member_profiles ADD COLUMN budgetUnitID TEXT")
            try db.execute(sql: "ALTER TABLE local_pot_setup ADD COLUMN budgetGroupActivationEventID TEXT")
            try db.execute(sql: """
                CREATE TABLE local_budget_group_operations (
                    eventID TEXT PRIMARY KEY NOT NULL REFERENCES ledger_events(eventID) ON DELETE CASCADE,
                    expectedTopologyRevision INTEGER NOT NULL CHECK (expectedTopologyRevision >= 0)
                )
                """)
        }
        return migrator
    }

    static func installV1Schema(in db: Database) throws {
        try db.execute(sql: """
            CREATE TABLE pot_configurations (
                potID TEXT PRIMARY KEY NOT NULL,
                currencyCode TEXT NOT NULL,
                currencyExponent INTEGER NOT NULL CHECK (currencyExponent BETWEEN 0 AND 4),
                configurationBlob BLOB NOT NULL,
                createdAtMillis INTEGER NOT NULL
            )
            """)
        try db.execute(sql: """
            CREATE TRIGGER pot_configurations_no_update
            BEFORE UPDATE ON pot_configurations
            BEGIN
                SELECT RAISE(ABORT, 'pot configuration is immutable');
            END
            """)
        try db.execute(sql: """
            CREATE TABLE ledger_events (
                localOrdinal INTEGER PRIMARY KEY AUTOINCREMENT,
                eventID TEXT NOT NULL UNIQUE,
                potID TEXT NOT NULL REFERENCES pot_configurations(potID),
                origin TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
                recordID TEXT,
                kind TEXT NOT NULL,
                schemaVersion INTEGER NOT NULL,
                actorMemberID TEXT NOT NULL,
                occurredAtMillis INTEGER NOT NULL,
                originatingTimeZone TEXT NOT NULL,
                currencyCode TEXT,
                parentEventID TEXT,
                resolutionHeadOne TEXT,
                resolutionHeadTwo TEXT,
                envelopeBlob BLOB NOT NULL,
                savedAtMillis INTEGER NOT NULL,
                UNIQUE (eventID, potID)
            )
            """)
        try db.execute(sql: """
            CREATE INDEX ledger_events_pot_ordinal
            ON ledger_events(potID, localOrdinal)
            """)
        try db.execute(sql: """
            CREATE TRIGGER ledger_events_no_update
            BEFORE UPDATE ON ledger_events
            BEGIN
                SELECT RAISE(ABORT, 'ledger event is immutable');
            END
            """)
        try db.execute(sql: """
            CREATE TABLE event_delivery (
                eventID TEXT PRIMARY KEY NOT NULL,
                potID TEXT NOT NULL,
                state TEXT NOT NULL CHECK (
                    state IN ('held', 'ready', 'dispatching', 'acknowledged', 'terminal')
                ),
                undoDeadlineMillis INTEGER,
                firstDispatchedAtMillis INTEGER,
                attemptCount INTEGER NOT NULL DEFAULT 0 CHECK (
                    typeof(attemptCount) = 'integer'
                    AND attemptCount BETWEEN 0 AND 9223372036854775807
                ),
                nextRetryAtMillis INTEGER,
                serverSequence INTEGER CHECK (serverSequence IS NULL OR serverSequence > 0),
                terminalReason TEXT,
                updatedAtMillis INTEGER NOT NULL,
                FOREIGN KEY (eventID, potID)
                    REFERENCES ledger_events(eventID, potID) ON DELETE CASCADE
            )
            """)
        try db.execute(sql: """
            CREATE UNIQUE INDEX event_delivery_pot_sequence
            ON event_delivery(potID, serverSequence)
            WHERE serverSequence IS NOT NULL
            """)
        try db.execute(sql: """
            CREATE INDEX event_delivery_dispatch_queue
            ON event_delivery(potID, state, nextRetryAtMillis)
            """)
        try db.execute(sql: """
            CREATE TABLE pot_sync_state (
                potID TEXT PRIMARY KEY NOT NULL
                    REFERENCES pot_configurations(potID),
                lastServerSequence INTEGER NOT NULL DEFAULT 0
                    CHECK (lastServerSequence >= 0),
                updatedAtMillis INTEGER NOT NULL
            )
            """)
    }

    private static func migrateAuthoredTextToSidecars(in db: Database) throws {
        try db.execute(sql: """
            CREATE TABLE event_text_sidecars (
                eventID TEXT NOT NULL REFERENCES ledger_events(eventID) ON DELETE CASCADE,
                field TEXT NOT NULL CHECK (field IN ('title', 'category', 'note', 'reason')),
                value TEXT NOT NULL,
                PRIMARY KEY (eventID, field)
            )
            """)
        try db.execute(sql: """
            CREATE TRIGGER event_text_sidecars_no_update
            BEFORE UPDATE ON event_text_sidecars
            BEGIN
                SELECT RAISE(ABORT, 'authored event text is immutable');
            END
            """)
        try db.execute(sql: """
            CREATE TABLE event_opaque_sidecars (
                eventID TEXT PRIMARY KEY NOT NULL
                    REFERENCES ledger_events(eventID) ON DELETE CASCADE,
                payloadBlob BLOB NOT NULL
            )
            """)
        try db.execute(sql: """
            CREATE TRIGGER event_opaque_sidecars_no_update
            BEFORE UPDATE ON event_opaque_sidecars
            BEGIN
                SELECT RAISE(ABORT, 'opaque event payload is immutable');
            END
            """)

        let rows = try Row.fetchAll(
            db,
            sql: "SELECT eventID, envelopeBlob FROM ledger_events ORDER BY localOrdinal"
        )
        try db.execute(sql: "DROP TRIGGER ledger_events_no_update")
        for row in rows {
            let eventID: String = row["eventID"]
            let legacyBlob: Data = row["envelopeBlob"]
            let legacy = try PersistenceCoding.decode(EventEnvelope.self, from: legacyBlob)
            let prepared = try PersistenceCoding.prepareForStorage(
                legacy,
                grandfatherAuthoredText: true
            )
            try db.execute(
                sql: "UPDATE ledger_events SET envelopeBlob = ? WHERE eventID = ?",
                arguments: [prepared.arithmeticBlob, eventID]
            )
            for text in prepared.authoredText {
                try db.execute(
                    sql: """
                        INSERT INTO event_text_sidecars (eventID, field, value)
                        VALUES (?, ?, ?)
                        """,
                    arguments: [eventID, text.field.rawValue, text.value]
                )
            }
            if let opaquePayloadBlob = prepared.opaquePayloadBlob {
                try db.execute(
                    sql: """
                        INSERT INTO event_opaque_sidecars (eventID, payloadBlob)
                        VALUES (?, ?)
                        """,
                    arguments: [eventID, opaquePayloadBlob]
                )
            }
        }
        try db.execute(sql: """
            CREATE TRIGGER ledger_events_no_update
            BEFORE UPDATE ON ledger_events
            BEGIN
                SELECT RAISE(ABORT, 'ledger event is immutable');
            END
            """)
    }
}
