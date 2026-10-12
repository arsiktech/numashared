import Foundation
import XCTest
@testable import NumaSharedCore

final class UndoPolicyTests: XCTestCase {
    func testOnlyActiveNeverDispatchedEventInsideSixSecondsCanBeDeleted() {
        let savedAt = Date(timeIntervalSince1970: 1_000)

        XCTAssertTrue(UndoPolicy.canDeleteLocalEvent(
            savedAt: savedAt,
            now: savedAt.addingTimeInterval(5.999),
            dispatchState: .heldLocally,
            undoSessionIsActive: true
        ))
        XCTAssertFalse(UndoPolicy.canDeleteLocalEvent(
            savedAt: savedAt,
            now: savedAt.addingTimeInterval(6),
            dispatchState: .heldLocally,
            undoSessionIsActive: true
        ))
        XCTAssertFalse(UndoPolicy.canDeleteLocalEvent(
            savedAt: savedAt,
            now: savedAt.addingTimeInterval(2),
            dispatchState: .dispatched,
            undoSessionIsActive: true
        ))
        XCTAssertFalse(UndoPolicy.canDeleteLocalEvent(
            savedAt: savedAt,
            now: savedAt.addingTimeInterval(2),
            dispatchState: .dispatching,
            undoSessionIsActive: true
        ))
        XCTAssertFalse(UndoPolicy.canDeleteLocalEvent(
            savedAt: savedAt,
            now: savedAt.addingTimeInterval(2),
            dispatchState: .heldLocally,
            undoSessionIsActive: false
        ))
        XCTAssertFalse(UndoPolicy.canDeleteLocalEvent(
            savedAt: savedAt,
            now: savedAt.addingTimeInterval(-0.001),
            dispatchState: .heldLocally,
            undoSessionIsActive: true
        ))
    }
}
