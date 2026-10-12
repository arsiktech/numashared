import ConvexMobile
import Foundation
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class ArchivedTextChangesTests: XCTestCase {
    func testSkippedRevisionsAndVisibleRedactionsAdvanceOneExactCursor() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try fixture.event(id: 890, sequence: 1)
        _ = try store.ingestRemoteEvent(event)
        _ = try store.ingestTextChangePage(SyncTextChangePage(changes: [], hasMore: true,
            nextAfterRevision: 500, skippedRevisions: Array(1...500)), in: fixture.potID)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 500)
        _ = try store.ingestTextChangePage(SyncTextChangePage(changes: [
            TextRedactionChange(eventID: event.id, field: .title, revision: 501),
        ], hasMore: false, nextAfterRevision: 502, skippedRevisions: [502]), in: fixture.potID)
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 502)
        XCTAssertEqual(try store.textStates(for: event.id), [.redacted(field: .title)])
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastServerSequence, 1)
    }

    func testUnseenVisibleEventRollsBackEarlierRedactionsAndSkipsInPage() throws {
        let fixture = try SyncFixture()
        let store = try LedgerStore.inMemory()
        try store.registerPot(fixture.configuration)
        let event = try fixture.event(id: 892, sequence: 1)
        let missing = try fixture.event(id: 894)
        _ = try store.ingestRemoteEvent(event)
        let page = SyncTextChangePage(changes: [
            TextRedactionChange(eventID: event.id, field: .title, revision: 2),
            TextRedactionChange(eventID: missing.id, field: .title, revision: 3),
        ], hasMore: false, nextAfterRevision: 3, skippedRevisions: [1])
        XCTAssertThrowsError(try store.ingestTextChangePage(page, in: fixture.potID))
        XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 0)
        XCTAssertEqual(try store.textStates(for: event.id), [.present(field: .title, value: "Groceries")])
    }

    func testMissingDuplicateReorderedOrOverlappingRevisionsFailClosed() throws {
        let fixture = try SyncFixture()
        let event = try fixture.event(id: 896, sequence: 1)
        let change = TextRedactionChange(eventID: event.id, field: .title, revision: 2)
        let pages = [
            SyncTextChangePage(changes: [change], hasMore: false, nextAfterRevision: 2),
            SyncTextChangePage(changes: [change], hasMore: false, nextAfterRevision: 2, skippedRevisions: [1, 2]),
            SyncTextChangePage(changes: [], hasMore: false, nextAfterRevision: 2, skippedRevisions: [2, 1]),
            SyncTextChangePage(changes: [], hasMore: false, nextAfterRevision: 1, skippedRevisions: [1, 1]),
            SyncTextChangePage(changes: [], hasMore: true, nextAfterRevision: 0),
        ]
        for page in pages {
            let store = try LedgerStore.inMemory()
            try store.registerPot(fixture.configuration)
            _ = try store.ingestRemoteEvent(event)
            XCTAssertThrowsError(try store.ingestTextChangePage(page, in: fixture.potID))
            XCTAssertEqual(try store.syncState(for: fixture.potID)?.lastTextRevision, 0)
            XCTAssertEqual(try store.textStates(for: event.id), [.present(field: .title, value: "Groceries")])
        }
    }

    func testNewEndpointRequiresSkipContractAndLegacyFallbackIsExplicit() throws {
        let legacy = try JSONDecoder().decode(ConvexDecodedValue.self, from: Data(
            #"{"changes":[],"hasMore":false,"nextAfterRevision":{"$integer":"AAAAAAAAAAA="}}"#.utf8))
        XCTAssertThrowsError(try ConvexSyncTransport.textChangePage(from: legacy))
        XCTAssertEqual(try ConvexSyncTransport.textChangePage(from: legacy, allowsLegacyResponse: true),
            SyncTextChangePage(changes: [], hasMore: false, nextAfterRevision: 0))
    }
}
