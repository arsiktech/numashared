import Foundation

/// Whether sync has had any opportunity to transmit a locally saved event.
public enum EventDispatchState: Codable, Hashable, Sendable {
    case heldLocally
    case dispatching
    case dispatched
}

/// The sole policy that permits deletion from the append-only event store.
public enum UndoPolicy {
    public static let window: TimeInterval = 6

    public static func canDeleteLocalEvent(
        savedAt: Date,
        now: Date,
        dispatchState: EventDispatchState,
        undoSessionIsActive: Bool
    ) -> Bool {
        let elapsed = now.timeIntervalSince(savedAt)
        return undoSessionIsActive
            && dispatchState == .heldLocally
            && elapsed >= 0
            && elapsed < window
    }
}
