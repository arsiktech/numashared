import Foundation

// MARK: - Record projections

/// One revision retained for activity history and contested-record comparison.
public struct RevisionProjection: Codable, Hashable, Sendable {
    public let eventID: EventID
    public let actorMemberID: MemberID
    public let occurredAt: Date
    public let serverSequence: Int64?
    public let content: RevisableRecordContent

    public init(
        eventID: EventID,
        actorMemberID: MemberID,
        occurredAt: Date,
        serverSequence: Int64?,
        content: RevisableRecordContent
    ) {
        self.eventID = eventID
        self.actorMemberID = actorMemberID
        self.occurredAt = occurredAt
        self.serverSequence = serverSequence
        self.content = content
    }
}

/// Active heads and the highest-ordered version applied provisionally.
public struct ContestedRecordProjection: Codable, Hashable, Sendable {
    public let headRevisionIDs: [EventID]
    public let provisionalRevisionID: EventID

    public init(headRevisionIDs: [EventID], provisionalRevisionID: EventID) {
        self.headRevisionIDs = headRevisionIDs
        self.provisionalRevisionID = provisionalRevisionID
    }
}

/// A revisable expense or opening balance after folding its full history.
public struct RevisableRecordProjection: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let currentContent: RevisableRecordContent
    public let appliedRevisionID: EventID
    public let revisions: [RevisionProjection]
    public let isVoided: Bool
    public let voidReason: String?
    public let contested: ContestedRecordProjection?

    public init(
        recordID: RecordID,
        currentContent: RevisableRecordContent,
        appliedRevisionID: EventID,
        revisions: [RevisionProjection],
        isVoided: Bool,
        voidReason: String? = nil,
        contested: ContestedRecordProjection?
    ) {
        self.recordID = recordID
        self.currentContent = currentContent
        self.appliedRevisionID = appliedRevisionID
        self.revisions = revisions
        self.isVoided = isVoided
        self.voidReason = voidReason
        self.contested = contested
    }
}

/// An immutable settlement plus its optional flag annotation.
public struct SettlementRecordProjection: Codable, Hashable, Sendable {
    public let recordID: RecordID
    public let eventID: EventID
    public let content: SettlementContent
    public let isFlagged: Bool

    public init(
        recordID: RecordID,
        eventID: EventID,
        content: SettlementContent,
        isFlagged: Bool
    ) {
        self.recordID = recordID
        self.eventID = eventID
        self.content = content
        self.isFlagged = isFlagged
    }
}

/// A projected record, preserving the settlement/revisable type boundary.
public enum RecordProjection: Codable, Hashable, Sendable {
    case revisable(RevisableRecordProjection)
    case settlement(SettlementRecordProjection)
}
