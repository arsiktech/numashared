import Foundation
import NumaSharedCore
import XCTest
@testable import NumaSharedSync

final class SerializedAuthenticatedConvexClientTests: XCTestCase {
    func testConcurrentAuthenticationAndSyncRequestsNeverOverlapTheSDKBoundary() async {
        let driver = await MainActor.run { OverlapRejectingConvexDriver() }
        let client = await MainActor.run {
            SerializedAuthenticatedConvexClient(driver: driver)
        }

        let successes = await withTaskGroup(of: Bool.self) { group in
            for index in 0 ..< 60 {
                group.addTask {
                    switch index % 3 {
                    case 0:
                        if case .success = await client.login() { return true }
                        return false
                    case 1:
                        if case .success = await client.loginFromCache() { return true }
                        return false
                    default:
                        return (try? await client.listPots().isEmpty) == true
                    }
                }
            }

            var completed = 0
            for await success in group where success { completed += 1 }
            return completed
        }

        XCTAssertEqual(successes, 60)
    }

    func testCancelledQueuedOperationNeverReachesTheSDKDriver() async throws {
        let driver = await MainActor.run { BlockingConvexDriver() }
        let client = await MainActor.run {
            SerializedAuthenticatedConvexClient(driver: driver)
        }

        let first = Task { try await client.listPots() }
        await driver.waitUntilFirstOperationStarts()
        let cancelled = Task { try await client.listPots() }
        try await Task.sleep(for: .milliseconds(20))
        cancelled.cancel()
        await driver.releaseFirstOperation()

        _ = try await first.value
        do {
            _ = try await cancelled.value
            XCTFail("Cancelled queued operation unexpectedly executed")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        let operationCount = await driver.operationCount()
        XCTAssertEqual(operationCount, 1)
    }

    func testMutationTimeoutReturnsPromptlyButRetainsTheSDKLease() async throws {
        let fixture = try SyncFixture()
        let event = try WireEventV1(fixture.event(id: 861))
        let driver = await MainActor.run { HeldMutationConvexDriver() }
        let client = await MainActor.run {
            SerializedAuthenticatedConvexClient(
                driver: driver,
                mutationTimeout: .milliseconds(20)
            )
        }
        let clock = ContinuousClock()
        let startedAt = clock.now
        let first = Task<Result<[EventAcknowledgement], any Error>, Never> {
            do {
                return .success(try await client.appendEvents(
                    potID: fixture.potID,
                    events: [event]
                ))
            } catch {
                return .failure(error)
            }
        }
        await driver.waitUntilFirstAppendStarts()
        let failSafe = Self.releaseAfterTestDeadline(driver)
        defer { failSafe.cancel() }

        let firstResult = await first.value

        guard case let .failure(firstError) = firstResult else {
            return XCTFail("Expected the first mutation to time out")
        }
        XCTAssertEqual(
            firstError as? SyncTransportError,
            .retryable(code: "TRANSPORT_TIMEOUT")
        )
        XCTAssertLessThan(clock.now - startedAt, .seconds(1))

        let queued = Task { try await client.listPots() }
        try await Task.sleep(for: .milliseconds(60))
        let operationsWhileHeld = await driver.startedOperations()
        let concurrencyWhileHeld = await driver.maximumConcurrentOperations()
        XCTAssertEqual(operationsWhileHeld, ["append"])
        XCTAssertEqual(concurrencyWhileHeld, 1)

        await driver.releaseFirstAppend()
        _ = try await queued.value
        let retry = try await client.appendEvents(
            potID: fixture.potID,
            events: [event]
        )

        XCTAssertEqual(retry.map { $0.eventID }, [event.eventId])
        let completedOperations = await driver.startedOperations()
        let appendedEventIDs = await driver.appendedEventIDs()
        let maximumConcurrency = await driver.maximumConcurrentOperations()
        XCTAssertEqual(
            completedOperations,
            ["append", "listPots", "append"]
        )
        XCTAssertEqual(appendedEventIDs, [event.eventId, event.eventId])
        XCTAssertEqual(maximumConcurrency, 1)
    }

    func testMutationCancellationReturnsPromptlyButRetainsTheSDKLease() async throws {
        let fixture = try SyncFixture()
        let event = try WireEventV1(fixture.event(id: 863))
        let driver = await MainActor.run { HeldMutationConvexDriver() }
        let client = await MainActor.run {
            SerializedAuthenticatedConvexClient(
                driver: driver,
                mutationTimeout: .seconds(10)
            )
        }
        let first = Task<Result<[EventAcknowledgement], any Error>, Never> {
            do {
                return .success(try await client.appendEvents(
                    potID: fixture.potID,
                    events: [event]
                ))
            } catch {
                return .failure(error)
            }
        }
        await driver.waitUntilFirstAppendStarts()
        let failSafe = Self.releaseAfterTestDeadline(driver)
        defer { failSafe.cancel() }
        let clock = ContinuousClock()
        let cancelledAt = clock.now

        first.cancel()
        let firstResult = await first.value

        guard case let .failure(firstError) = firstResult else {
            return XCTFail("Expected the first mutation caller to be cancelled")
        }
        XCTAssertTrue(firstError is CancellationError)
        XCTAssertLessThan(clock.now - cancelledAt, .seconds(1))

        let queued = Task { await client.login() }
        try await Task.sleep(for: .milliseconds(60))
        let operationsWhileHeld = await driver.startedOperations()
        let concurrencyWhileHeld = await driver.maximumConcurrentOperations()
        XCTAssertEqual(operationsWhileHeld, ["append"])
        XCTAssertEqual(concurrencyWhileHeld, 1)

        await driver.releaseFirstAppend()
        guard case .success = await queued.value else {
            return XCTFail("Queued authentication should run after the SDK mutation finishes")
        }
        let completedOperations = await driver.startedOperations()
        let maximumConcurrency = await driver.maximumConcurrentOperations()
        XCTAssertEqual(completedOperations, ["append", "login"])
        XCTAssertEqual(maximumConcurrency, 1)
    }

    private static func releaseAfterTestDeadline(
        _ driver: HeldMutationConvexDriver
    ) -> Task<Void, Never> {
        Task {
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
            await driver.releaseFirstAppend()
        }
    }
}

private struct TestSession: Equatable, Sendable {
    let value: Int
}

@MainActor
private final class OverlapRejectingConvexDriver: AuthenticatedConvexDriving {
    typealias AuthResult = TestSession

    private var operationIsActive = false
    private var nextSession = 0

    func login() async -> Result<TestSession, any Error> {
        await authenticationResult()
    }

    func loginFromCache() async -> Result<TestSession, any Error> {
        await authenticationResult()
    }

    func logout() async {
        _ = try? await exclusiveValue(())
    }

    func connectionStates() async -> AsyncStream<SyncConnectionState> {
        AsyncStream { continuation in
            continuation.yield(.connected)
            continuation.finish()
        }
    }

    func listPots() async throws -> [RemotePotDescriptor] {
        try await exclusiveValue([])
    }

    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        _ = request
        return try await exclusiveValue([])
    }

    func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        _ = potID
        _ = events
        return try await exclusiveValue([])
    }

    func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage {
        _ = potID
        return try await exclusiveValue(SyncEventPage(
            events: [],
            hasMore: false,
            nextAfterSequence: afterSequence
        ))
    }

    func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        _ = potID
        return try await exclusiveValue(SyncTextChangePage(
            changes: [],
            hasMore: false,
            nextAfterRevision: afterRevision
        ))
    }

    private func authenticationResult() async -> Result<TestSession, any Error> {
        do {
            let session = TestSession(value: nextSession % 2)
            nextSession += 1
            return .success(try await exclusiveValue(session))
        } catch {
            return .failure(error)
        }
    }

    private func exclusiveValue<Value: Sendable>(_ value: Value) async throws -> Value {
        guard !operationIsActive else { throw OverlapError.concurrentOperation }
        operationIsActive = true
        defer { operationIsActive = false }
        try await Task.sleep(for: .milliseconds(2))
        return value
    }

    private enum OverlapError: Error {
        case concurrentOperation
    }
}

@MainActor
private final class BlockingConvexDriver: AuthenticatedConvexDriving {
    typealias AuthResult = TestSession

    private var calls = 0
    private var firstRelease: CheckedContinuation<Void, Never>?

    func login() async -> Result<TestSession, any Error> {
        .success(TestSession(value: 0))
    }

    func loginFromCache() async -> Result<TestSession, any Error> {
        .success(TestSession(value: 0))
    }

    func logout() async {}

    func connectionStates() async -> AsyncStream<SyncConnectionState> {
        AsyncStream { $0.finish() }
    }

    func listPots() async throws -> [RemotePotDescriptor] {
        calls += 1
        if calls == 1 {
            await withCheckedContinuation { firstRelease = $0 }
        }
        return []
    }

    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        _ = request
        return []
    }

    func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        _ = potID
        _ = events
        return []
    }

    func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage {
        _ = potID
        return SyncEventPage(
            events: [],
            hasMore: false,
            nextAfterSequence: afterSequence
        )
    }

    func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        _ = potID
        return SyncTextChangePage(
            changes: [],
            hasMore: false,
            nextAfterRevision: afterRevision
        )
    }

    func waitUntilFirstOperationStarts() async {
        while calls == 0 { await Task.yield() }
    }

    func releaseFirstOperation() {
        firstRelease?.resume()
        firstRelease = nil
    }

    func operationCount() -> Int { calls }
}

@MainActor
private final class HeldMutationConvexDriver: AuthenticatedConvexDriving {
    typealias AuthResult = TestSession

    private var activeOperationCount = 0
    private var maximumActiveOperationCount = 0
    private var operationNames: [String] = []
    private var appendEventIDs: [EventID] = []
    private var appendCalls = 0
    private var firstAppendRelease: CheckedContinuation<Void, Never>?

    func login() async -> Result<TestSession, any Error> {
        begin("login")
        defer { end() }
        await Task.yield()
        return .success(TestSession(value: 1))
    }

    func loginFromCache() async -> Result<TestSession, any Error> {
        begin("loginFromCache")
        defer { end() }
        await Task.yield()
        return .success(TestSession(value: 1))
    }

    func logout() async {
        begin("logout")
        defer { end() }
        await Task.yield()
    }

    func connectionStates() async -> AsyncStream<SyncConnectionState> {
        AsyncStream { $0.finish() }
    }

    func listPots() async throws -> [RemotePotDescriptor] {
        begin("listPots")
        defer { end() }
        await Task.yield()
        return []
    }

    func promoteLocalPot(
        _ request: LocalPotPromotionRequest
    ) async throws -> [EventAcknowledgement] {
        _ = request
        begin("promote")
        defer { end() }
        await Task.yield()
        return []
    }

    func appendEvents(
        potID: PotID,
        events: [WireEventV1]
    ) async throws -> [EventAcknowledgement] {
        _ = potID
        begin("append")
        defer { end() }
        appendCalls += 1
        appendEventIDs.append(contentsOf: events.map(\.eventId))
        if appendCalls == 1 {
            await withCheckedContinuation { firstAppendRelease = $0 }
        }
        return events.map {
            EventAcknowledgement(eventID: $0.eventId, serverSequence: 1)
        }
    }

    func listEvents(
        potID: PotID,
        afterSequence: Int64
    ) async throws -> SyncEventPage {
        _ = potID
        begin("listEvents")
        defer { end() }
        await Task.yield()
        return SyncEventPage(
            events: [],
            hasMore: false,
            nextAfterSequence: afterSequence
        )
    }

    func listTextChanges(
        potID: PotID,
        afterRevision: Int64
    ) async throws -> SyncTextChangePage {
        _ = potID
        begin("listTextChanges")
        defer { end() }
        await Task.yield()
        return SyncTextChangePage(
            changes: [],
            hasMore: false,
            nextAfterRevision: afterRevision
        )
    }

    func waitUntilFirstAppendStarts() async {
        while appendCalls == 0 { await Task.yield() }
    }

    func releaseFirstAppend() {
        firstAppendRelease?.resume()
        firstAppendRelease = nil
    }

    func startedOperations() -> [String] { operationNames }
    func appendedEventIDs() -> [EventID] { appendEventIDs }
    func maximumConcurrentOperations() -> Int { maximumActiveOperationCount }

    private func begin(_ name: String) {
        activeOperationCount += 1
        maximumActiveOperationCount = max(
            maximumActiveOperationCount,
            activeOperationCount
        )
        operationNames.append(name)
    }

    private func end() {
        activeOperationCount -= 1
    }
}
