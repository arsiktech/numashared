import Foundation
import NumaSharedCore
import NumaSharedSync
import XCTest
@testable import NumaShared

final class LedgerRepositoryTests: XCTestCase {
    @MainActor
    func testReferenceLaunchNeverRestoresExternalServicesOrDeletionRecovery() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let recoveryURL = directory.appendingPathComponent("account-deletion-v1.json")
        let sentinel = Data("not a recovery record".utf8)
        try sentinel.write(to: recoveryURL)
        let recovery = AccountDeletionRecoveryStore(directory: directory)
        let suite = "ReferenceIsolation-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let privacy = DevicePrivacyPreferences(defaults: defaults)
        let model = AppModel(
            launchArguments: ["--qa-shared-table-reference", "--numa-shared-e2e"],
            privacyPreferences: privacy,
            accountDeletionRecoveryStore: recovery
        )
        for _ in 0..<100 where model.isBootstrapping {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(model.isBootstrapping)
        XCTAssertFalse(model.hasBlockingLocalDataFailure)
        XCTAssertFalse(model.hasExternalServicesForTesting)
        XCTAssertFalse(model.isSyncEnabled)
        XCTAssertEqual(model.plan.first?.amountCents, 8_400)
        XCTAssertEqual(model.records.count, 2)
        XCTAssertEqual(model.homePresentationDate, Date(timeIntervalSince1970: 1_789_200_000))
        XCTAssertEqual(try Data(contentsOf: recoveryURL), sentinel)

        // Ordinary recovery still rejects malformed data; isolation is not a
        // global bypass of the real deletion recovery contract.
        let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let ordinary = AppModel(repository: repository, snapshot: snapshot,
                                privacyPreferences: privacy, accountDeletionRecoveryStore: recovery)
        XCTAssertTrue(ordinary.hasBlockingLocalDataFailure)
        XCTAssertEqual(try Data(contentsOf: recoveryURL), sentinel)
    }

    @MainActor
    func testEveryEphemeralQALaunchSkipsRealRecoveryAndExternalServices() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("account-deletion-v1.json")
        let sentinel = Data("never read by ephemeral QA".utf8)
        try sentinel.write(to: file)
        let suite = "EphemeralIsolation-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for argument in ["--qa-onboarding", "--qa-home", "--qa-seeded-home", "--qa-add-sheet", "--qa-contested-record"] {
            let model = AppModel(launchArguments: [argument], privacyPreferences: DevicePrivacyPreferences(defaults: defaults),
                accountDeletionRecoveryStore: AccountDeletionRecoveryStore(directory: directory))
            for _ in 0..<100 where model.isBootstrapping { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertFalse(model.isBootstrapping, argument)
            XCTAssertFalse(model.hasBlockingLocalDataFailure, argument)
            XCTAssertFalse(model.hasExternalServicesForTesting, argument)
            XCTAssertFalse(model.isSyncEnabled, argument)
            XCTAssertEqual(try Data(contentsOf: file), sentinel)
        }
    }

    func testHomeRelativeDateUsesTheSuppliedDayAndOriginatingTimeZone() {
        let reference = Date(timeIntervalSince1970: 1_789_200_000)
        let dinner = reference.addingTimeInterval(-86_400)
        XCTAssertEqual(HomeReceiptRow.dateLabel(dinner, timeZoneIdentifier: "UTC", now: reference), "yesterday")
        XCTAssertEqual(HomeReceiptRow.dateLabel(dinner, timeZoneIdentifier: "UTC", now: dinner), "today")
        XCTAssertEqual(HomeReceiptRow.dateLabel(dinner, timeZoneIdentifier: "UTC", now: reference.addingTimeInterval(86_400)), "11 September")
    }

    @MainActor
    func testSharedTableReferenceFixtureUsesRealGroupsAndActualPayers() async throws {
        let repository = AppLedgerRepository(storageMode: .inMemory, readerSchemaVersion: 2)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = try await repository.loadSharedTableReferenceFixture()
        let app = AppModel(repository: repository, snapshot: snapshot)
        XCTAssertEqual(app.potName, "Our place")
        XCTAssertEqual(snapshot.currency, .eur)
        XCTAssertEqual(snapshot.memberProfiles.compactMap(\.displayName), ["You", "Sam", "Alex", "Jo"])
        XCTAssertEqual(snapshot.records.count, 2)
        XCTAssertEqual(snapshot.balances[app.currentUnitID], -8_400)
        XCTAssertEqual(snapshot.balances.values.reduce(0, +), 0)
        XCTAssertEqual(app.plan.count, 1)
        XCTAssertEqual(app.plan.first?.from, app.currentUnitID)
        XCTAssertEqual(app.plan.first?.amountCents, 8_400)
        XCTAssertEqual(app.unitInfo(for: try XCTUnwrap(app.plan.first?.to)).name, "Alex + Jo")
        for (title, payer, amount) in [("Dinner together", "Alex", Int64(9_600)), ("Internet", "Jo", Int64(7_200))] {
            let record = try XCTUnwrap(snapshot.records.first { $0.title == title })
            XCTAssertEqual(record.payerDisplayName, payer)
            XCTAssertNotNil(record.payerMemberID)
            XCTAssertEqual(record.amountCents, amount)
            XCTAssertEqual(record.parts.count, 2)
            XCTAssertEqual(Set(record.parts.values), [amount / 2])
        }
        let replay = try await repository.refreshSnapshot()
        XCTAssertEqual(replay.balances, snapshot.balances)
        XCTAssertEqual(replay.records.map(\.id), snapshot.records.map(\.id))
    }

    @MainActor
    func testGroupOpeningExplanationAndHistoricZeroUnitCorrectionPreview() async throws {
        let identity = AppLedgerIdentitySet.fresh()
        let store = try LedgerStore.inMemory(readerSchemaVersion: 2)
        let repository = AppLedgerRepository(store: store, identities: identity)
        let setup = try await repository.completeBudgetGroupSetup(potName: "Opening history", currency: .eur,
            people: [(.am, "You"), (.sam, "Sam"), (.leo, "Alex")], pairs: [[.am, .sam]])
        let ours = try XCTUnwrap(setup.memberProfiles.first { $0.role == .owner }?.budgetUnitID)
        let opening = try await repository.appendOpeningBalance(title: "Before this household", entries: [ours: 4_000, .leo: -4_000])
        let app = AppModel(repository: repository, snapshot: opening.snapshot)
        app.activityFilter = .leo
        let explanation = try XCTUnwrap(app.filterExplain)
        XCTAssertTrue(explanation.title.contains("owes " + app.fmtMagnitude(-4_000)))
        XCTAssertEqual(explanation.lines.first { $0.0 == "Starting balance" }?.1, "−" + app.fmt(4_000))
        XCTAssertEqual(explanation.lines.first { $0.0 == "Share of expenses" }?.1, "−" + app.fmt(0))
        XCTAssertEqual(app.spend, 0)
        _ = try await repository.appendExpense(title: "Historical purchase", amountMinorUnits: 600,
            payer: ours, orderedUnits: [.leo, ours], weights: [.leo: 1, ours: 1], category: nil,
            payerMemberID: identity.samMemberID)
        let purchased = try await repository.refreshSnapshot()
        let expense = try XCTUnwrap(purchased.records.first { $0.kind == .expense })
        _ = try await repository.appendSettlement(title: "Repaid outside app", amountMinorUnits: 4_300, from: .leo, to: ours)
        _ = try store.appendHeldLocalEvent(EventEnvelope(potID: identity.potID, actorMemberID: identity.ownerMemberID,
            occurredAt: Date(), originatingTimeZone: try IANATimeZone("UTC"), schemaVersion: 2,
            payload: .memberArchived(MemberArchivedPayload(memberID: identity.leoMemberID))))
        let archived = try await repository.refreshSnapshot()
        let editor = AppModel(repository: repository, snapshot: archived)
        XCTAssertFalse(editor.expenseBeneficiaryUnitIDs.contains(.leo))
        XCTAssertFalse(editor.ledgerUnitIDs.contains(.leo))
        editor.detailID = expense.id; editor.beginEditRecord(); editor.editAmountInt = "9"
        let impacts = editor.editBalanceImpacts
        XCTAssertEqual(impacts.first { $0.id == .leo }?.afterMinorUnits, -150)
        XCTAssertEqual(impacts.first { $0.id == ours }?.afterMinorUnits, 150)
        editor.saveExpenseEdit()
        let saved = await eventually { !editor.isRecordMutationInFlight }
        XCTAssertTrue(saved)
        XCTAssertEqual(editor.balances[.leo], -150)
        XCTAssertEqual(editor.records.first { $0.id == expense.id }?.payerMemberID, identity.samMemberID)
    }

    func testBudgetGroupKnownIdentityCapAndFailedPayerAttribution() async throws {
        let identity = AppLedgerIdentitySet.fresh()
        let store = try LedgerStore.inMemory(readerSchemaVersion: 2)
        let repository = AppLedgerRepository(store: store, identities: identity)
        var people: [(NumaShared.UnitID, String)] = [(.am, "You"), (.sam, "Sam"), (.leo, "Alex")]
        people += (3..<64).map { (.remote(NumaSharedCore.UnitID.generate()), "Person \($0)") }
        do {
            _ = try await repository.completeBudgetGroupSetup(potName: "Too many identities", currency: .eur,
                people: people, pairs: [[.am, .sam]])
            XCTFail("64 people plus a group exceeds the server's total known-unit cap")
        } catch { }
        XCTAssertTrue(try store.loadEvents(for: identity.potID).isEmpty)
        _ = try await repository.completeBudgetGroupSetup(potName: "At the cap", currency: .eur,
            people: people, pairs: [])
        do { _ = try await repository.changeBudgetGroups(pairs: [[identity.ownerMemberID, identity.samMemberID]]); XCTFail("Group identity overflow") } catch { }
        let now = Date()
        let saved = try await repository.appendExpense(title: "Failed purchase", amountMinorUnits: 40,
            payer: .sam, orderedUnits: [.am], weights: [.am: 1], category: nil,
            occurredAt: now, savedAt: now, payerMemberID: identity.samMemberID)
        _ = try store.expireHeldEvents(now: now.addingTimeInterval(10))
        // The real outbound prefix must be acknowledged before its money event can dispatch.
        for (index, event) in try store.loadEvents(for: identity.potID).enumerated() where event.id != saved.eventID {
            _ = try store.markDispatching(eventID: event.id, at: now.addingTimeInterval(11))
            _ = try store.acknowledge(eventID: event.id, serverSequence: Int64(index + 1), at: now.addingTimeInterval(11))
        }
        _ = try store.markDispatching(eventID: saved.eventID, at: now.addingTimeInterval(11))
        _ = try store.markTerminal(eventID: saved.eventID, reason: "NOT_MEMBER", at: now.addingTimeInterval(12))
        let failed = try await repository.refreshSnapshot()
        XCTAssertEqual(failed.records.first?.payerMemberID, identity.samMemberID)
        XCTAssertEqual(failed.records.first?.payerDisplayName, "Sam")
        let erased = try await repository.replaceAuthoritativeMemberRoster(failed.memberProfiles.map { profile in
            PotMemberProfile(memberID: profile.memberID, unitID: identity.coreUnit(for: profile.unitID!),
                displayName: profile.memberID == identity.samMemberID ? nil : profile.displayName,
                role: profile.role, state: profile.memberID == identity.samMemberID ? .archived : profile.state)
        })
        XCTAssertEqual(erased.records.first?.payerMemberID, identity.samMemberID)
        XCTAssertEqual(erased.records.first?.payerDisplayName, "Former member")
    }


    @MainActor
    func testFourPeopleTwoCouplesUseActualPayerAndGroupBalances() async throws {
        let identity = AppLedgerIdentitySet.fresh()
        let store = try LedgerStore.inMemory(readerSchemaVersion: 2)
        let repository = AppLedgerRepository(store: store, identities: identity)
        let initial = try await repository.bootstrap(seedCasaMar: false)
        let app = AppModel(repository: repository, snapshot: initial)
        app.potName = "Two couples"
        app.ownerDisplayName = "You"
        app.addSetupPerson(); app.samDisplayName = "Sam"
        app.addSetupPerson(); app.leoDisplayName = "Alex"
        let fourth = try XCTUnwrap(app.addSetupPerson())
        app.additionalSetupNames[fourth] = "Jo"
        XCTAssertTrue(app.groupSetupUnits(.am, with: .sam))
        XCTAssertTrue(app.groupSetupUnits(.leo, with: fourth))
        XCTAssertFalse(app.groupSetupUnits(.sam, with: .leo))
        XCTAssertEqual(app.setupSettlementUnitCount, 2)
        app.selectPotCurrency(.eur)
        app.goPeople(); app.finishSetup()
        let completed = await eventually { !app.isCompletingSetup && app.screen == .home }
        XCTAssertTrue(completed, app.setupErrorMessage ?? "Setup did not complete")
        XCTAssertEqual(app.memberProfiles.count, 4)
        XCTAssertEqual(app.ledgerUnitIDs.count, 2)
        XCTAssertEqual(app.payerPeople.count, 4) // unclaimed people can have paid
        let config = try XCTUnwrap(store.potConfiguration(for: identity.potID))
        XCTAssertEqual(config.orderedUnitIDs.count, 4)
        XCTAssertTrue(config.orderedUnitIDs.contains(try XCTUnwrap(fourth.remoteCoreUnitID)))
        let sam = try XCTUnwrap(app.payerPeople.first { $0.displayName == "Sam" })
        let alex = try XCTUnwrap(app.payerPeople.first { $0.displayName == "Alex" })
        let ours = app.currentUnitID
        let theirs = try XCTUnwrap(alex.budgetUnitID)
        XCTAssertNotEqual(ours, theirs)
        XCTAssertEqual(app.unitInfo(for: ours).name, "You + Sam")
        app.beginAdd(); app.amountInt = "96"; app.merchant = "Shared shopping"
        app.selectExpensePayer(sam); app.dropAll()
        XCTAssertEqual(Set(app.allocatedParts().values), [4_800])
        app.saveExpense(); app.saveExpense()
        let saved = await eventually { app.records.count == 1 && !app.isRecordMutationInFlight }
        XCTAssertTrue(saved)
        XCTAssertEqual(app.records.first?.payerMemberID, sam.memberID)
        XCTAssertEqual(app.records.first?.payerDisplayName, "Sam")
        XCTAssertNotEqual(app.records.first?.recordedBy, "Sam")
        XCTAssertEqual(app.balances[theirs], -4_800)
        XCTAssertFalse(app.canEditBudgetGroups)
        app.beginAdd(); app.amountInt = "72"; app.dropAll(); app.selectExpenseSplitMode(.exact)
        XCTAssertEqual(Set(app.allocatedParts().values), [3_600])
        app.saveExpense()
        let second = await eventually { app.records.count == 2 && !app.isRecordMutationInFlight }
        XCTAssertTrue(second)
        app.beginAdd(prefilling: [ours]); app.amountInt = "24"; app.selectExpensePayer(alex)
        app.saveExpense()
        let third = await eventually { app.records.count == 3 && !app.isRecordMutationInFlight }
        XCTAssertTrue(third)
        XCTAssertEqual(app.balances[theirs], -6_000)
        XCTAssertEqual(app.records.first { $0.amountCents == 2_400 }?.kind, .personal)
        app.beginManualSettlement(); app.selectManualSettlementFrom(theirs); app.selectManualSettlementTo(ours)
        app.sInt = "20"; app.markPaid(); app.markPaid()
        let repaid = await eventually { app.records.count == 4 && !app.isRecordMutationInFlight }
        XCTAssertTrue(repaid)
        XCTAssertEqual(app.balances[theirs], -4_000)
        app.beginManualSettlement(); app.selectManualSettlementFrom(theirs); app.selectManualSettlementTo(ours)
        app.sInt = "50"
        XCTAssertTrue(app.settlePreviewText.contains("Overpayment reverses"))
        XCTAssertEqual(app.settlementBalanceAfter(for: ours), -1_000)
        app.selectManualSettlementTo(theirs)
        XCTAssertEqual(app.settleTo, ours)
        let before = try await repository.budgetGroupSnapshot()
        do { _ = try await repository.changeBudgetGroups(pairs: []); XCTFail("Frozen grouping accepted") } catch { }
        do { try store.confirmPotCurrency(.eur, for: identity.potID, orderedUnitIDs: [identity.householdUnitID]); XCTFail("Used baseline changed") } catch { }
        let after = try await repository.budgetGroupSnapshot()
        XCTAssertEqual(after.storedEvents.map(\.event.id), before.storedEvents.map(\.event.id))
        let reopened = AppLedgerRepository(store: store, identities: identity)
        let replayed = try await reopened.refreshSnapshot()
        XCTAssertEqual(replayed.balances, app.balances)
        XCTAssertEqual(replayed.memberProfiles.count, 4)
        let csv = try LedgerCSVExporter.make(potName: "Two couples", configuration: config, snapshot: after)
        XCTAssertTrue(String(decoding: csv.data, as: UTF8.self).lowercased().contains(sam.memberID.description.lowercased()))
    }

    @MainActor
    func testThreeSingletonOddCentAndPreFinancialPairChanges() async throws {
        let identity = AppLedgerIdentitySet.fresh()
        let store = try LedgerStore.inMemory(readerSchemaVersion: 2)
        let repository = AppLedgerRepository(store: store, identities: identity)
        let setup = try await repository.completeBudgetGroupSetup(potName: "Three people", currency: .eur,
            people: [(.am, "You"), (.sam, "Sam"), (.leo, "Alex")], pairs: [])
        let app = AppModel(repository: repository, snapshot: setup)
        XCTAssertTrue(app.canEditBudgetGroups)
        _ = try await repository.changeBudgetGroups(pairs: [[identity.ownerMemberID, identity.samMemberID]])
        let separate = try await repository.changeBudgetGroups(pairs: [])
        XCTAssertEqual(separate.activeBudgetUnitIDs.count, 3)
        let current = AppModel(repository: repository, snapshot: separate)
        current.beginAdd(); current.amountInt = "10"; current.dropAll()
        XCTAssertEqual(current.attachedKeys.map { current.allocatedParts()[$0] }, [333, 333, 334])
        current.saveExpense()
        let saved = await eventually { current.records.count == 1 && !current.isRecordMutationInFlight }
        XCTAssertTrue(saved)
        XCTAssertEqual(current.balances[.am], 667)
        XCTAssertEqual(current.balances[.sam], -333)
        XCTAssertEqual(current.balances[.leo], -334)
        let record = try XCTUnwrap(current.records.first)
        _ = try await repository.appendVoid(recordID: record.id, reason: "Corrected outside app")
        let voided = try await repository.refreshSnapshot()
        XCTAssertTrue(voided.structure?.hasFinancialHistory == true)
        XCTAssertTrue(voided.records.first?.voided == true)
        do { _ = try await repository.changeBudgetGroups(pairs: [[identity.ownerMemberID, identity.samMemberID]]); XCTFail("Voided history unlocked groups") } catch { }
    }


    func testBudgetGroupRepositoryRestartPayerErasureReplayAndCSV() async throws {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: date)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("GroupRepository-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("ledger.sqlite").path
        let store = try LedgerStore(path: path, now: date, readerSchemaVersion: 2)
        let repository = AppLedgerRepository(store: store, identities: identities)
        let payer = identities.memberID(for: .sam)
        let groupUnit = NumaSharedCore.UnitID.generate(at: date)
        let group = SettlementGroupSnapshot(groupID: .generate(at: date), unitID: groupUnit,
            orderedMemberIDs: [identities.ownerMemberID, payer], defaultShareWeight: 1)
        let members = UnitID.allCases.map { unit in
            LocalPotSetupMember(memberID: identities.memberID(for: unit), unitID: identities.coreUnit(for: unit),
                displayName: unit == .sam ? "Private payer name" : "Recorder or neighbor", role: unit == .am ? .owner : .member)
        }
        _ = try await repository.configureLocalBudgetGroups(potName: "Synthetic house", members: members, groups: [group], at: date)
        let expense = try await repository.appendBudgetGroupExpense(content: ExpenseContent(kind: .personal,
            title: "Private purchase title", amount: Money(minorUnits: 4_000, currency: .eur), payerUnitID: groupUnit,
            allocations: [ExpenseAllocation(unitID: identities.coreUnit(for: .leo), amount: Money(minorUnits: 4_000, currency: .eur))],
            payerMemberID: payer), at: date.addingTimeInterval(1))
        let purchased = try await repository.budgetGroupSnapshot()
        XCTAssertEqual(purchased.reduction.projection.balances[groupUnit]?.minorUnits, 4_000)
        guard case let .expenseAdded(added) = expense.event.payload else { return XCTFail("Expected expense") }
        _ = try await repository.appendExpenseRevision(recordID: added.recordID.description, title: "Corrected entry",
            amountMinorUnits: 4_000, category: nil, occurredAt: date.addingTimeInterval(2), savedAt: date)
        _ = try await repository.appendSettlement(title: "Paid elsewhere", amountMinorUnits: 4_000,
            from: .leo, to: .remote(groupUnit), occurredAt: date.addingTimeInterval(3), savedAt: date)
        let initial = try await repository.budgetGroupSnapshot()
        XCTAssertEqual(initial.reduction.projection.balances[groupUnit]?.minorUnits, 0)
        XCTAssertEqual(initial.storedEvents.suffix(2).map(\.event.schemaVersion), [2, 2])
        guard case let .expenseRevised(revised) = initial.storedEvents[6].event.payload,
              case let .expense(corrected) = revised.content else { return XCTFail("Expected correction") }
        XCTAssertEqual(corrected.payerMemberID, payer)
        XCTAssertEqual(corrected.payerUnitID, groupUnit)
        let baseline = try XCTUnwrap(store.potConfiguration(for: identities.potID))
        let discovered = RemotePotDescriptor(configuration: baseline, memberID: identities.ownerMemberID, role: .owner,
            minimumReaderSchemaVersion: 2, lastSequence: Int64(initial.storedEvents.count),
            currentKnownUnitIDs: baseline.orderedUnitIDs + [groupUnit])
        XCTAssertEqual(SyncPotSelection.decide(localPotID: identities.potID, localEventCount: initial.storedEvents.count,
            remotePots: [discovered]), .adoptRemote(discovered))
        let adopted = try await repository.activateRemotePot(discovered, accountID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        XCTAssertEqual(adopted.configuration, baseline)
        XCTAssertEqual(try store.potConfiguration(for: identities.potID), baseline)
        let freshStore = try LedgerStore.inMemory(readerSchemaVersion: 2)
        let freshRepository = AppLedgerRepository(store: freshStore, identities: AppLedgerIdentitySet.fresh())
        _ = try await freshRepository.activateRemotePot(discovered, accountID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        for (index, stored) in initial.storedEvents.enumerated() {
            let event = stored.event
            _ = try freshStore.ingestRemoteEvent(EventEnvelope(id: event.id, potID: event.potID,
                actorMemberID: event.actorMemberID, occurredAt: event.occurredAt, originatingTimeZone: event.originatingTimeZone,
                schemaVersion: event.schemaVersion, serverSequence: Int64(index + 1), payload: event.payload))
        }
        let fresh = try await freshRepository.budgetGroupSnapshot()
        XCTAssertEqual(fresh.reduction.access, .readWrite)
        XCTAssertEqual(fresh.reduction.projection.balances, initial.reduction.projection.balances)
        let missingBaseline = RemotePotDescriptor(configuration: try PotConfiguration(id: identities.potID, currency: .eur,
            orderedUnitIDs: baseline.orderedUnitIDs + [groupUnit]), memberID: identities.ownerMemberID, role: .owner,
            minimumReaderSchemaVersion: 2, lastSequence: 8, hasInitialUnitBaseline: false)
        // A same-pot device can preserve its verified original baseline even for an older server pot.
        _ = try await repository.activateRemotePot(missingBaseline, accountID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        let emptyRepository = AppLedgerRepository(store: try LedgerStore.inMemory(readerSchemaVersion: 2), identities: AppLedgerIdentitySet.fresh())
        do {
            _ = try await emptyRepository.activateRemotePot(missingBaseline, accountID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            XCTFail("Fresh device guessed a schema2 bootstrap baseline")
        } catch let error as SyncTransportError {
            XCTAssertEqual(error.code, "BOOTSTRAP_BASELINE_UNAVAILABLE")
        }

        XCTAssertEqual(expense.event.actorMemberID, identities.ownerMemberID)
        XCTAssertNotEqual(expense.event.actorMemberID, payer)
        let invalidChange = EventEnvelope(potID: identities.potID, actorMemberID: identities.ownerMemberID,
            occurredAt: date.addingTimeInterval(2), originatingTimeZone: try IANATimeZone("UTC"), schemaVersion: 2,
            payload: .groupChanged(GroupChangedPayload(groups: [])))
        XCTAssertThrowsError(try store.appendBudgetGroupChange(invalidChange, expectedTopologyRevision: 5))
        XCTAssertEqual(try store.loadStoredEvents(for: identities.potID).count, initial.storedEvents.count)
        _ = try store.redactAuthoredText(for: expense.event.id, fields: [.title])
        let owner = PotMemberProfile(memberID: identities.ownerMemberID, unitID: identities.coreUnit(for: .am),
            displayName: "Recorder", role: .owner, state: .active, budgetUnitID: groupUnit)
        _ = try store.replaceCachedMemberRoster([owner,
            PotMemberProfile(memberID: payer, unitID: identities.coreUnit(for: .sam), displayName: nil,
                role: .member, state: .archived, budgetUnitID: groupUnit)], for: identities.potID)
        XCTAssertEqual(try store.payerDisplayName(memberID: payer, potID: identities.potID), "Former member")
        // A later incomplete roster must not expose the older local setup name.
        _ = try store.replaceCachedMemberRoster([owner], for: identities.potID)
        XCTAssertNil(try store.payerDisplayName(memberID: payer, potID: identities.potID))
        let reopened = try LedgerStore(path: path, now: date.addingTimeInterval(8), readerSchemaVersion: 2)
        let resumed = AppLedgerRepository(store: reopened, identities: identities)
        let snapshot = try await resumed.budgetGroupSnapshot()
        XCTAssertEqual(snapshot.storedEvents.map(\.event.id), initial.storedEvents.map(\.event.id))
        XCTAssertEqual(snapshot.storedEvents.map(\.localOrdinal), initial.storedEvents.map(\.localOrdinal))
        XCTAssertNil(try reopened.payerDisplayName(memberID: payer, potID: identities.potID))
        XCTAssertNil(try reopened.payerDisplayName(memberID: nil, potID: identities.potID))
        let configuration = try XCTUnwrap(reopened.potConfiguration(for: identities.potID))
        let csv = try LedgerCSVExporter.make(potName: "Synthetic house", configuration: configuration, snapshot: snapshot)
        let text = String(decoding: csv.data, as: UTF8.self)
        XCTAssertFalse(text.contains("Private payer name"))
        XCTAssertFalse(text.contains("Private purchase title"))
        XCTAssertTrue(text.lowercased().contains(payer.description.lowercased()))
        let replay = LedgerReducer(supportedSchemaVersion: 2).reduce(pot: configuration, events: snapshot.reductionOrderedEvents.map(\.event))
        XCTAssertEqual(replay.projection.balances, snapshot.reduction.projection.balances)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(replay.projection), as: UTF8.self).contains("Private purchase title"))
    }

#if DEBUG
    func testE2ECreateCommandPersistsCompletePromotionSetup() async throws {
        let seed = "a11ce5e7"
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = try AppLedgerIdentitySet.deterministicE2E(seed: seed)
        let store = try LedgerStore.inMemory(now: baseDate)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)

        let snapshot = try await repository.prepareE2ECommand(
            .createOne,
            runSeed: seed,
            now: baseDate
        )

        XCTAssertTrue(snapshot.potSetup.isComplete)
        XCTAssertEqual(snapshot.potSetup.potName, "Casa Mar")
        XCTAssertEqual(snapshot.potSetup.displayNames[.am], "Arseny")
        XCTAssertEqual(snapshot.potSetup.displayNames[.sam], "Sam")
        XCTAssertEqual(snapshot.potSetup.displayNames[.leo], "Leo")
        let syncContext = try await repository.syncContext()
        XCTAssertEqual(syncContext.ownerDisplayName, "Arseny")
        XCTAssertTrue(try XCTUnwrap(
            try store.localPotSetup(for: identities.potID)
        ).isComplete)
    }

    func testE2EArtifactPreservesImmutableLocalOrdinalEventOrder() async throws {
        let seed = "a11ce"
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = try AppLedgerIdentitySet.deterministicE2E(seed: seed)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: baseDate),
            identities: identities
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.prepareE2ECommand(
            .queueTwenty,
            runSeed: seed,
            now: baseDate
        )

        let factory = try E2EUUIDFactory(seed: seed)
        let expected = try (0..<20).map { index in
            try EventID(validating: factory.uuid(
                discriminator: 0x200 + UInt64(index)
            )).description
        }
        let state = try await repository.e2eLedgerState()

        XCTAssertEqual(state.localOrdinalEventIDs, expected)
        XCTAssertEqual(Set(state.localOrdinalEventIDs), Set(state.eventIDs))
    }

    func testE2ESeedRandomizesPayerAndBeneficiaryWithoutSelfAllocation() async throws {
        var choices = Set<String>()
        let baseDate = Date(timeIntervalSince1970: 1_700_000_000)

        for seed in ["01", "02", "03", "04", "05", "06", "07", "08"] {
            let store = try LedgerStore.inMemory(now: baseDate)
            let repository = AppLedgerRepository(
                store: store,
                identities: try AppLedgerIdentitySet.deterministicE2E(seed: seed)
            )
            _ = try await repository.bootstrap(seedCasaMar: false)
            let snapshot = try await repository.prepareE2ECommand(
                .createOne,
                runSeed: seed,
                now: baseDate
            )
            let record = try XCTUnwrap(snapshot.records.first)
            let beneficiaries = record.parts.keys.sorted { $0.rawValue < $1.rawValue }

            XCTAssertFalse(beneficiaries.contains(record.payer))
            XCTAssertEqual(record.parts.values.reduce(0, +), record.amountCents)
            choices.insert(
                "\(record.kind.rawValue):\(record.amountCents):\(record.payer.rawValue)->"
                    + beneficiaries.map(\.rawValue).joined(separator: ",")
            )
        }

        XCTAssertGreaterThan(choices.count, 4)
    }
#endif

    @MainActor
    func testContestedExpenseProjectsBothHeadsAndAppendsExplicitChoice() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        try store.registerPot(fixture.configuration, at: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        let initial = try fixture.expense(
            eventIndex: 1,
            recordIndex: 1,
            title: "Original",
            sequence: 1
        )
        let recordID = try AppLedgerIDs.seedRecordID(21)
        let revisionA = EventEnvelope(
            id: try AppLedgerIDs.seedEventID(40),
            potID: fixture.potID,
            actorMemberID: try AppLedgerIDs.actorMemberID(for: .sam),
            occurredAt: fixture.date(2),
            originatingTimeZone: fixture.timeZone,
            serverSequence: 2,
            payload: .expenseRevised(ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(ExpenseContent(
                    kind: .shared,
                    title: "Sam version",
                    amount: Money(minorUnits: 120, currency: .eur),
                    payerUnitID: fixture.am,
                    allocations: [ExpenseAllocation(
                        unitID: fixture.sam,
                        amount: Money(minorUnits: 120, currency: .eur)
                    )]
                ))
            ))
        )
        let revisionB = EventEnvelope(
            id: try AppLedgerIDs.seedEventID(41),
            potID: fixture.potID,
            actorMemberID: try AppLedgerIDs.actorMemberID(for: .leo),
            occurredAt: fixture.date(3),
            originatingTimeZone: fixture.timeZone,
            serverSequence: 3,
            payload: .expenseRevised(ExpenseRevisedPayload(
                recordID: recordID,
                basis: .parent(initial.id),
                content: .expense(ExpenseContent(
                    kind: .shared,
                    title: "Leo version",
                    amount: Money(minorUnits: 80, currency: .eur),
                    payerUnitID: fixture.am,
                    allocations: [ExpenseAllocation(
                        unitID: fixture.sam,
                        amount: Money(minorUnits: 80, currency: .eur)
                    )]
                ))
            ))
        )
        for event in [initial, revisionA, revisionB] {
            _ = try store.ingestRemoteEvent(event, receivedAt: fixture.date(4))
        }

        let contested = try await repository.refreshSnapshot()
        let record = try XCTUnwrap(contested.records.first)
        XCTAssertEqual(record.title, "Leo version")
        XCTAssertEqual(record.revisionHistory.map(\.title), [
            "Original", "Sam version", "Leo version",
        ])
        XCTAssertEqual(record.contest?.headRevisionIDs, [
            revisionA.id.description,
            revisionB.id.description,
        ])
        XCTAssertEqual(record.contest?.provisionalRevisionID, revisionB.id.description)

        let model = AppModel(repository: repository, snapshot: contested)
        let chosen = try XCTUnwrap(
            model.contestedHeadRevisions(for: record).first
        )
        XCTAssertEqual(chosen.title, "Sam version")
        XCTAssertEqual(
            model.contestBalanceImpacts(for: record, choosing: chosen),
            [
                ExpenseBalanceImpact(
                    id: .am,
                    beforeMinorUnits: 80,
                    afterMinorUnits: 120
                ),
                ExpenseBalanceImpact(
                    id: .sam,
                    beforeMinorUnits: -80,
                    afterMinorUnits: -120
                ),
            ]
        )

        let mutation = try await repository.resolveExpenseContest(
            recordID: record.id,
            choosing: revisionA.id.description,
            comparedWith: revisionB.id.description,
            occurredAt: fixture.date(5),
            savedAt: fixture.date(5)
        )

        let resolved = try XCTUnwrap(mutation.snapshot.records.first)
        XCTAssertEqual(resolved.title, "Sam version")
        XCTAssertNil(resolved.contest)
        XCTAssertEqual(resolved.amountCents, 120)
        guard case let .expenseRevised(payload) = try XCTUnwrap(
            try store.loadStoredEvents(for: fixture.potID).last
        ).event.payload else {
            return XCTFail("Expected an append-only resolution revision")
        }
        XCTAssertEqual(
            payload.basis,
            .resolution(try RevisionPair(revisionA.id, revisionB.id))
        )
        guard case let .expense(chosenContent) = payload.content else {
            return XCTFail("Expected the selected expense content")
        }
        XCTAssertEqual(chosenContent.title, "Sam version")
        XCTAssertEqual(chosenContent.amount.minorUnits, 120)
    }

    func testOpeningBalanceAppendsAndProjectsCompleteRevisableRecord() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        try store.registerPot(fixture.configuration, at: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)

        let mutation = try await repository.appendOpeningBalance(
            title: "Before Numa Shared",
            entries: [.am: 4_000, .sam: -2_500, .leo: -1_500],
            note: "Imported from our previous ledger",
            occurredAt: fixture.date(1),
            savedAt: fixture.date(1)
        )

        XCTAssertEqual(mutation.snapshot.balances, [
            .am: 4_000,
            .sam: -2_500,
            .leo: -1_500,
        ])
        XCTAssertEqual(mutation.snapshot.spend, 0)
        let record = try XCTUnwrap(mutation.snapshot.records.first)
        XCTAssertEqual(record.kind, .openingBalance)
        XCTAssertEqual(record.title, "Before Numa Shared")
        XCTAssertEqual(record.amountCents, 0)
        XCTAssertEqual(record.parts, [
            .am: 4_000,
            .sam: -2_500,
            .leo: -1_500,
        ])
        XCTAssertEqual(record.revisionHistory.map(\.title), [
            "Before Numa Shared",
        ])
        XCTAssertEqual(record.appliedRevisionID, mutation.eventID.description)
    }

    func testOpeningBalanceDraftParsesExactLocaleAmountsAndDerivesZeroSum() {
        XCTAssertEqual(
            AppModel.openingBalanceEntries(
                samText: "25.40",
                samRelation: .owesHousehold,
                leoText: "10.50",
                leoRelation: .householdOwesMember,
                locale: Locale(identifier: "en_US")
            ),
            [.am: 1_490, .sam: -2_540, .leo: 1_050]
        )
        XCTAssertEqual(
            AppModel.openingBalanceEntries(
                samText: "12,34",
                samRelation: .owesHousehold,
                leoText: "",
                leoRelation: .owesHousehold,
                locale: Locale(identifier: "de_DE")
            ),
            [.am: 1_234, .sam: -1_234, .leo: 0]
        )
        XCTAssertNil(AppModel.openingBalanceEntries(
            samText: "12.345",
            samRelation: .owesHousehold,
            leoText: "0",
            leoRelation: .owesHousehold,
            locale: Locale(identifier: "en_US")
        ))
    }

    func testLocalSetupIsDurableAndFeedsProjectionAndSyncIdentity() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let store = try LedgerStore.inMemory(now: savedAt)
        let repository = AppLedgerRepository(
            store: store,
            identities: identities
        )
        let initial = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertFalse(initial.potSetup.isComplete)

        let completed = try await repository.completeLocalSetup(
            potName: "Casa Norte",
            ownerDisplayName: "Ari",
            samDisplayName: "Samira",
            leoDisplayName: "Leon",
            at: savedAt
        )

        XCTAssertEqual(
            completed.potSetup,
            AppPotSetupSnapshot(
                potName: "Casa Norte",
                displayNames: [.am: "Ari", .sam: "Samira", .leo: "Leon"],
                isComplete: true
            )
        )
        XCTAssertEqual(try store.loadStoredEvents(for: identities.potID).count, 0)
        let syncContext = try await repository.syncContext()
        XCTAssertEqual(syncContext.ownerDisplayName, "Ari")

        let mutation = try await repository.appendExpense(
            title: "Tea",
            amountMinorUnits: 300,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: savedAt,
            savedAt: savedAt
        )
        XCTAssertEqual(mutation.snapshot.records.first?.recordedBy, "Ari")

        let reopened = AppLedgerRepository(store: store, identities: identities)
        let relaunched = try await reopened.bootstrap(seedCasaMar: false)
        XCTAssertEqual(relaunched.potSetup, completed.potSetup)
        XCTAssertEqual(relaunched.records.first?.recordedBy, "Ari")
    }

    func testLocalSetupPersistsARealSettlementGroup() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let store = try LedgerStore.inMemory(now: savedAt)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)

        let completed = try await repository.completeLocalSetup(
            potName: "Casa Norte",
            ownerDisplayName: "Ari",
            samDisplayName: "Samira",
            leoDisplayName: "Leon",
            groupedMemberUnits: [.am, .sam],
            at: savedAt
        )

        let owner = try XCTUnwrap(completed.memberProfiles.first {
            $0.memberID == identities.ownerMemberID
        })
        let sam = try XCTUnwrap(completed.memberProfiles.first {
            $0.memberID == identities.samMemberID
        })
        let leo = try XCTUnwrap(completed.memberProfiles.first {
            $0.memberID == identities.leoMemberID
        })
        XCTAssertEqual(owner.unitID, .am) // personal binding stays distinct from financial ownership
        XCTAssertEqual(sam.unitID, .sam)
        XCTAssertEqual(owner.budgetUnitID, sam.budgetUnitID)
        XCTAssertNotEqual(owner.budgetUnitID, .am)
        XCTAssertEqual(leo.unitID, .leo)
        XCTAssertEqual(completed.balances[owner.budgetUnitID ?? .am], 0)

        let relaunched = try await AppLedgerRepository(
            store: store,
            identities: identities
        ).bootstrap(seedCasaMar: false)
        XCTAssertEqual(relaunched.memberProfiles, completed.memberProfiles)
    }

    func testLocalSetupPersistsOneAddedPersonWithoutPhantomMember() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let store = try LedgerStore.inMemory(now: savedAt)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)

        let completed = try await repository.completeLocalSetup(
            potName: "Casa Norte",
            ownerDisplayName: "Ari",
            samDisplayName: "Samira",
            leoDisplayName: nil,
            at: savedAt
        )

        XCTAssertEqual(completed.memberProfiles.count, 2)
        XCTAssertEqual(completed.potSetup.displayNames, [.am: "Ari", .sam: "Samira"])
        XCTAssertFalse(completed.memberProfiles.contains {
            $0.memberID == identities.leoMemberID
        })

        let reopened = AppLedgerRepository(store: store, identities: identities)
        let relaunched = try await reopened.bootstrap(seedCasaMar: false)
        XCTAssertEqual(relaunched.memberProfiles, completed.memberProfiles)
        XCTAssertEqual(relaunched.potSetup, completed.potSetup)
    }

    func testConfirmedPotCurrencyDrivesEventsAndCannotChangeAfterSetup() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let store = try LedgerStore.inMemory(now: savedAt)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)

        let completed = try await repository.completeLocalSetup(
            potName: "Tokyo home",
            currency: .jpy,
            ownerDisplayName: "Ari",
            samDisplayName: "Sam",
            leoDisplayName: "Leo",
            at: savedAt
        )
        XCTAssertEqual(completed.currency, .jpy)

        let mutation = try await repository.appendExpense(
            title: "Market",
            amountMinorUnits: 1_201,
            orderedUnits: [.am, .sam],
            weights: [.am: 1, .sam: 1],
            category: nil,
            occurredAt: savedAt,
            savedAt: savedAt
        )
        XCTAssertEqual(mutation.snapshot.currency, .jpy)
        let event = try XCTUnwrap(store.loadEvents(for: identities.potID).last)
        guard case let .expenseAdded(payload) = event.payload else {
            return XCTFail("Expected expenseAdded")
        }
        XCTAssertEqual(payload.content.amount.currency, .jpy)
        XCTAssertEqual(payload.content.allocations.map(\.amount.minorUnits), [600, 601])
        XCTAssertThrowsError(try store.confirmPotCurrency(.eur, for: identities.potID))
    }

    @MainActor
    func testAccountExitPurgesCacheBindingEventsAndPreparedExports() async throws {
        let date = Date(timeIntervalSince1970: 1_783_814_400)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedSignOut-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadataURL = directory.appendingPathComponent("identity.json")
        let store = try LedgerStore.inMemory(now: date)
        let repository = AppLedgerRepository(
            store: store,
            identityMetadataURL: metadataURL
        )
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.completeLocalSetup(
            potName: "Private pot",
            ownerDisplayName: "Owner",
            samDisplayName: "Sam",
            leoDisplayName: "Leo",
            at: date
        )
        let accountID = UUID().uuidString.lowercased()
        let bound = try await repository.bindActiveIdentity(
            to: accountID,
            minimumReaderSchemaVersion: EventEnvelope.currentSchemaVersion
        )
        let units = bound.configuration.orderedUnitIDs
        let event = EventEnvelope(
            id: .generate(at: date),
            potID: bound.configuration.id,
            actorMemberID: bound.ownerMemberID,
            occurredAt: date,
            originatingTimeZone: try IANATimeZone("Europe/Madrid"),
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: .generate(at: date),
                content: ExpenseContent(
                    kind: .shared,
                    title: "Private record",
                    amount: Money(minorUnits: 500, currency: .eur),
                    payerUnitID: units[0],
                    allocations: [
                        ExpenseAllocation(
                            unitID: units[1],
                            amount: Money(minorUnits: 500, currency: .eur)
                        ),
                    ]
                )
            ))
        )
        _ = try store.appendHeldLocalEvent(event, savedAt: date)
        let export = try await repository.writeCSVExport(
            potName: "Private pot",
            temporaryDirectory: directory
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: export.url.path))

        let clean = try await repository.eraseLocalAccountState(
            temporaryDirectory: directory
        )
        let fresh = try await repository.syncContext()

        XCTAssertNotEqual(fresh.configuration.id, bound.configuration.id)
        XCTAssertNil(fresh.accountID)
        XCTAssertFalse(clean.potSetup.isComplete)
        XCTAssertTrue(clean.records.isEmpty)
        XCTAssertEqual(clean.unsyncedEventCount, 0)
        XCTAssertEqual(try store.potConfigurations().map(\.id), [fresh.configuration.id])
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("NumaSharedExports").path
        ))
        let metadata = try String(contentsOf: metadataURL, encoding: .utf8)
        XCTAssertFalse(metadata.contains(accountID))
        XCTAssertFalse(metadata.contains("Private"))
    }

    func testAuthoritativeRosterReplacesLocalNamesAndIdentifiesCurrentMember() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let store = try LedgerStore.inMemory(now: savedAt)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.completeLocalSetup(
            potName: "Casa Norte",
            ownerDisplayName: "Local owner",
            samDisplayName: "Local Sam",
            leoDisplayName: "Local Leo",
            at: savedAt
        )
        let roster = [
            PotMemberProfile(
                memberID: identities.ownerMemberID,
                unitID: identities.householdUnitID,
                displayName: "Ari",
                role: .owner,
                state: .active
            ),
            PotMemberProfile(
                memberID: identities.samMemberID,
                unitID: identities.samUnitID,
                displayName: "Samira",
                role: .member,
                state: .pending
            ),
            PotMemberProfile(
                memberID: identities.leoMemberID,
                unitID: identities.leoUnitID,
                displayName: nil,
                role: .member,
                state: .archived
            ),
        ]

        let snapshot = try await repository.replaceAuthoritativeMemberRoster(
            roster,
            at: savedAt.addingTimeInterval(1)
        )

        XCTAssertEqual(snapshot.memberProfiles.map(\.displayName), ["Ari", "Samira", nil])
        XCTAssertEqual(snapshot.currentMemberID, identities.ownerMemberID)
        XCTAssertEqual(snapshot.currentMemberProfile?.role, .owner)
        XCTAssertEqual(
            snapshot.potSetup.displayNames,
            [.am: "Ari", .sam: "Samira", .leo: String(localized: "Former member")]
        )
        XCTAssertEqual(snapshot.potSetup.potName, "Casa Norte")
        XCTAssertEqual(
            try store.cachedMemberRoster(for: identities.potID),
            roster
        )
    }

    @MainActor
    func testProjectedCurrentMemberDrivesDynamicUnitIdentity() async throws {
        let identities = AppLedgerIdentitySet.fresh()
        let snapshot = AppLedgerSnapshot(
            revision: 1,
            balances: [.am: 400, .sam: -250, .leo: -150],
            spend: 800,
            plan: [],
            records: [],
            pendingDeliveryEventCount: 0,
            unsyncedEventCount: 0,
            isArchived: false,
            reductionAccess: .readWrite,
            minimumReaderSchemaVersion: nil,
            potSetup: AppPotSetupSnapshot(
                potName: "Casa Norte",
                displayNames: [.am: "Ari", .sam: "Samira", .leo: "Leon"],
                isComplete: true
            ),
            memberProfiles: [
                AppMemberProfile(
                    memberID: identities.ownerMemberID,
                    unitID: .am,
                    displayName: "Ari",
                    role: .owner,
                    state: .active
                ),
                AppMemberProfile(
                    memberID: identities.samMemberID,
                    unitID: .sam,
                    displayName: "Samira",
                    role: .member,
                    state: .active
                ),
                AppMemberProfile(
                    memberID: identities.leoMemberID,
                    unitID: .leo,
                    displayName: "Leon",
                    role: .member,
                    state: .pending
                ),
            ],
            currentMemberID: identities.samMemberID
        )
        let model = AppModel(
            repository: AppLedgerRepository(store: try LedgerStore.inMemory()),
            snapshot: snapshot
        )

        XCTAssertEqual(model.currentUnitID, .sam)
        XCTAssertFalse(model.isCurrentMemberOwner)
        XCTAssertEqual(model.potName, "Casa Norte")
        XCTAssertEqual(model.unitInfo(for: .am).name, "Arseny + Maya")
        XCTAssertEqual(model.unitInfo(for: .sam).name, "Samira")
        XCTAssertEqual(model.unitInfo(for: .sam).initials, "S")
        XCTAssertTrue(model.unitInfo(for: .sam).isYou)
        XCTAssertFalse(model.unitInfo(for: .am).isYou)

        model.amountInt = "3"
        model.merchant = "Tea"
        model.attached = [.leo]
        model.saveExpense()

        let savedByCurrentMember = await eventually {
            model.records.first?.payer == .sam
                && model.records.first?.kind == .personal
        }
        XCTAssertTrue(savedByCurrentMember)
    }

    func testExpensePayerIsExplicitInsteadOfAssumingFirstUnit() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: savedAt),
            identities: identities
        )
        _ = try await repository.bootstrap(seedCasaMar: false)

        let mutation = try await repository.appendExpense(
            title: "Tea",
            amountMinorUnits: 300,
            payer: .sam,
            orderedUnits: [.leo],
            weights: [.leo: 1],
            category: nil,
            occurredAt: savedAt,
            savedAt: savedAt
        )

        XCTAssertEqual(mutation.snapshot.records.first?.payer, .sam)
        XCTAssertEqual(mutation.snapshot.records.first?.kind, .personal)
    }

    func testExactExpenseAllocationsPersistWithoutWeightConversion() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: savedAt),
            identities: identities
        )
        _ = try await repository.bootstrap(seedCasaMar: false)

        let mutation = try await repository.appendExpense(
            title: "Groceries",
            amountMinorUnits: 1_000,
            payer: .leo,
            orderedUnits: [.am, .sam, .leo],
            weights: [:],
            explicitAllocations: [.am: 101, .sam: 299, .leo: 600],
            category: "Food",
            occurredAt: savedAt,
            savedAt: savedAt
        )

        let record = try XCTUnwrap(mutation.snapshot.records.first)
        XCTAssertEqual(record.payer, .leo)
        XCTAssertEqual(record.parts, [.am: 101, .sam: 299, .leo: 600])
        XCTAssertEqual(record.parts.values.reduce(0, +), record.amountCents)
    }

    @MainActor
    func testExactSplitLocksEditedAmountAndRedistributesRemainder() async throws {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)

        model.beginAdd(prefilling: [.am, .sam, .leo])
        model.amountInt = "100"
        model.openSplitPreview()
        model.selectExpenseSplitMode(.exact)
        model.updateExactSplitDraft("20.00", for: .sam)

        XCTAssertEqual(model.exactParts[.sam], 2_000)
        XCTAssertEqual(model.exactParts[.am], 5_333)
        XCTAssertEqual(model.exactParts[.leo], 2_667)
        XCTAssertEqual(model.exactParts.values.reduce(0, +), 10_000)
        XCTAssertTrue(model.lockedExactUnits.contains(.sam))
        XCTAssertNil(model.exactSplitErrorMessage)
        XCTAssertTrue(model.canSaveExpense)
    }

    @MainActor
    func testExactSplitRejectsLockedAmountsAboveExpenseTotal() async throws {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)

        model.beginAdd(prefilling: [.am, .sam])
        model.amountInt = "10"
        model.openSplitPreview()
        model.selectExpenseSplitMode(.exact)
        model.updateExactSplitDraft("11.00", for: .sam)

        XCTAssertEqual(
            model.exactSplitErrorMessage,
            String(localized: "Locked amounts exceed the expense total.")
        )
        XCTAssertFalse(model.canSaveExpense)
    }

    @MainActor
    func testExactSplitRecalculatesAfterExpenseTotalChanges() async throws {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)

        model.beginAdd(prefilling: [.am, .sam])
        model.amountInt = "10"
        model.openSplitPreview()
        model.selectExpenseSplitMode(.exact)
        XCTAssertEqual(model.exactParts.values.reduce(0, +), 1_000)

        model.closeSplitPreview()
        model.amountInt = "12"
        model.openSplitPreview()
        model.selectExpenseSplitMode(.exact)

        XCTAssertEqual(model.exactParts.values.reduce(0, +), 1_200)
        XCTAssertNil(model.exactSplitErrorMessage)
        XCTAssertTrue(model.canSaveExpense)
    }

    @MainActor
    func testManualSettlementRecordsAnyTwoDistinctUnits() async throws {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        let snapshot = try await repository.loadCasaMarSeed()
        let model = AppModel(repository: repository, snapshot: snapshot)

        model.openSettlePlan()
        model.beginManualSettlement()
        model.selectManualSettlementFrom(.leo)
        model.selectManualSettlementTo(.sam)
        model.sInt = "12"
        model.sFrac = "50"

        XCTAssertTrue(model.isManualSettlement)
        XCTAssertEqual(
            model.settlePreviewText,
            "Leo paid Sam \(model.fmt(1_250, forceCents: true))."
        )
        model.markPaid()

        let saved = await eventually {
            model.records.contains {
                $0.kind == .settlement
                    && $0.payer == .leo
                    && $0.to == .sam
                    && $0.amountCents == 1_250
            }
        }
        XCTAssertTrue(saved)
        XCTAssertFalse(model.isManualSettlement)
    }

    @MainActor
    func testFinishSetupPersistsBeforeEnteringHome() async throws {
        let savedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let identities = AppLedgerIdentitySet.fresh(at: savedAt)
        let store = try LedgerStore.inMemory(now: savedAt)
        let repository = AppLedgerRepository(
            store: store,
            identities: identities
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)
        model.potName = "Casa Norte"
        model.ownerDisplayName = "Ari"
        model.addSetupPerson()
        model.samDisplayName = "Samira"
        model.addSetupPerson()
        model.leoDisplayName = "Leon"
        model.selectPotCurrency(.eur)
        model.goPeople()

        model.finishSetup()

        XCTAssertTrue(model.isCompletingSetup)
        XCTAssertEqual(model.screen, .people)
        let didComplete = await eventually {
            model.screen == .home && !model.isCompletingSetup
        }
        XCTAssertTrue(didComplete)
        XCTAssertNil(model.setupErrorMessage)
        let persisted = try await repository.refreshSnapshot()
        XCTAssertEqual(
            persisted.potSetup.displayNames,
            [.am: "Ari", .sam: "Samira", .leo: "Leon"]
        )

        let relaunchedSnapshot = try await repository.refreshSnapshot()
        let relaunched = AppModel(
            repository: repository,
            snapshot: relaunchedSnapshot
        )
        XCTAssertEqual(relaunched.screen, .home)
        XCTAssertEqual(relaunched.potName, "Casa Norte")
    }

    func testProjectionUsesAuthoritativePrefixThenLocalTailAcrossServerGap() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        try store.registerPot(fixture.configuration, at: fixture.baseDate)

        let remoteOne = try fixture.expense(
            eventIndex: 1,
            recordIndex: 1,
            title: "Remote one",
            sequence: 1
        )
        _ = try store.ingestRemoteEvent(remoteOne, receivedAt: fixture.date(1))

        let earlierPending = try fixture.expense(
            eventIndex: 4,
            recordIndex: 4,
            title: "Earlier pending",
            sequence: nil
        )
        _ = try store.appendHeldLocalEvent(earlierPending, savedAt: fixture.date(2))

        let acknowledgedAboveGap = try fixture.expense(
            eventIndex: 3,
            recordIndex: 3,
            title: "Acknowledged later",
            sequence: nil
        )
        _ = try store.appendHeldLocalEvent(acknowledgedAboveGap, savedAt: fixture.date(3))
        let serverEcho = try fixture.expense(
            eventIndex: 3,
            recordIndex: 3,
            title: "Acknowledged later",
            sequence: 3
        )
        XCTAssertEqual(
            try store.ingestRemoteEvent(serverEcho, receivedAt: fixture.date(4)),
            .acknowledgedExistingLocal
        )

        let repository = AppLedgerRepository(store: store)
        let beforeGapCloses = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(
            beforeGapCloses.records.map { $0.title },
            ["Remote one", "Earlier pending", "Acknowledged later"]
        )
        XCTAssertEqual(beforeGapCloses.records.map { $0.sortOrdinal }, [0, 1, 2])

        let remoteTwo = try fixture.expense(
            eventIndex: 2,
            recordIndex: 2,
            title: "Remote two",
            sequence: 2
        )
        _ = try store.ingestRemoteEvent(remoteTwo, receivedAt: fixture.date(12))

        let converged = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(
            converged.records.map { $0.title },
            ["Remote one", "Remote two", "Acknowledged later", "Earlier pending"]
        )
        XCTAssertEqual(converged.records.map { $0.sortOrdinal }, [0, 1, 2, 3])
    }

    func testUnknownActorIsNeverAttributedToCurrentUser() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        try store.registerPot(fixture.configuration, at: fixture.baseDate)
        let unknownActor = NumaSharedCore.MemberID.generate(at: fixture.date(30))
        let event = try fixture.expense(
            eventIndex: 7,
            recordIndex: 7,
            title: "Unknown author",
            sequence: 1,
            actorOverride: unknownActor
        )
        _ = try store.ingestRemoteEvent(event, receivedAt: fixture.date(8))

        let repository = AppLedgerRepository(store: store)
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(snapshot.records.count, 1)
        XCTAssertEqual(
            snapshot.records.first?.recordedBy,
            String(localized: "Unknown member")
        )
        XCTAssertNotEqual(snapshot.records.first?.recordedBy, "Arseny")
    }

    @MainActor
    func testTerminalFinancialRootsRemainVisibleWithoutChangingMoneyAcrossRelaunch() async throws {
        let fixture = try AppAdapterFixture()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedFailedRoots-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let databasePath = directory.appendingPathComponent("ledger.sqlite").path
        let expense = try fixture.expense(
            eventIndex: 8,
            recordIndex: 8,
            title: "Attempted expense",
            sequence: nil
        )
        let settlement = try fixture.settlement(
            eventIndex: 9,
            recordIndex: 9,
            title: "Attempted settlement"
        )
        let opening = try fixture.openingBalance(
            eventIndex: 10,
            recordIndex: 10,
            title: "Attempted opening balance"
        )

        do {
            let store = try LedgerStore(
                path: databasePath,
                fileProtection: .none,
                now: fixture.baseDate
            )
            let repository = AppLedgerRepository(store: store)
            _ = try await repository.bootstrap(seedCasaMar: false)
            for event in [expense, settlement, opening] {
                _ = try store.appendHeldLocalEvent(event, savedAt: fixture.baseDate)
            }
            _ = try store.expireHeldEvents(now: fixture.date(20))
            for (event, reason) in zip(
                [expense, settlement, opening],
                ["NOT_MEMBER", "INVALID_SERVER_RESPONSE", "MEMBERSHIP_ARCHIVED"]
            ) {
                _ = try store.markDispatching(eventID: event.id, at: fixture.date(21))
                _ = try store.markTerminal(
                    eventID: event.id,
                    reason: reason,
                    at: fixture.date(22)
                )
            }
            _ = try store.purgeErasureSidecars(for: opening.id)

            let snapshot = try await repository.refreshSnapshot()
            assertFailedRoots(snapshot, openingTitle: "[redacted]")
        }

        let reopenedStore = try LedgerStore(
            path: databasePath,
            fileProtection: .none,
            now: fixture.date(30)
        )
        let reopened = AppLedgerRepository(store: reopenedStore)
        let relaunched = try await reopened.bootstrap(seedCasaMar: false)
        assertFailedRoots(relaunched, openingTitle: "[redacted]")
    }

    @MainActor
    func testUnsupportedTerminalAttemptRemainsGenericAndRedactedAcrossRelaunch() async throws {
        let fixture = try AppAdapterFixture()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedUnsupportedAttempt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let databasePath = directory.appendingPathComponent("ledger.sqlite").path
        let opaqueSecret = "opaque-private-future-payload"
        let unsupported = try fixture.unsupportedAttempt(
            eventIndex: 11,
            opaqueValue: opaqueSecret
        )

        do {
            let store = try LedgerStore(
                path: databasePath,
                fileProtection: .none,
                now: fixture.baseDate
            )
            let repository = AppLedgerRepository(store: store)
            _ = try await repository.bootstrap(seedCasaMar: false)
            _ = try store.appendHeldLocalEvent(unsupported, savedAt: fixture.baseDate)
            _ = try store.expireHeldEvents(now: fixture.date(20))
            _ = try store.markDispatching(eventID: unsupported.id, at: fixture.date(21))
            _ = try store.markTerminal(
                eventID: unsupported.id,
                reason: "UNSUPPORTED_WIRE_EVENT",
                at: fixture.date(22)
            )
            assertGenericFailedAttempt(
                try await repository.refreshSnapshot(),
                excludes: opaqueSecret
            )
        }

        let reopenedStore = try LedgerStore(
            path: databasePath,
            fileProtection: .none,
            now: fixture.date(30)
        )
        let reopened = AppLedgerRepository(store: reopenedStore)
        assertGenericFailedAttempt(
            try await reopened.bootstrap(seedCasaMar: false),
            excludes: opaqueSecret
        )
    }

    @MainActor
    func testTerminalFinancialCorrectionsRemainVisibleAndRedactedAcrossRelaunch() async throws {
        let fixture = try AppAdapterFixture()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedFailedCorrections-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let databasePath = directory.appendingPathComponent("ledger.sqlite").path
        let expenseRoot = try fixture.expense(
            eventIndex: 1,
            recordIndex: 1,
            title: "Original expense",
            sequence: 1
        )
        let settlementRoot = try fixture.settlement(
            eventIndex: 2,
            recordIndex: 2,
            title: "Original settlement",
            sequence: 2
        )
        let expenseRecordID = try AppLedgerIDs.seedRecordID(21)
        let settlementRecordID = try AppLedgerIDs.seedRecordID(22)
        let actor = try AppLedgerIDs.actorMemberID(for: .am)
        let revision = EventEnvelope(
            id: try AppLedgerIDs.seedEventID(40),
            potID: fixture.potID,
            actorMemberID: actor,
            occurredAt: fixture.date(3),
            originatingTimeZone: fixture.timeZone,
            payload: .expenseRevised(ExpenseRevisedPayload(
                recordID: expenseRecordID,
                basis: .parent(expenseRoot.id),
                content: .expense(ExpenseContent(
                    kind: .shared,
                    title: "Attempted revision",
                    amount: Money(minorUnits: 500, currency: .eur),
                    payerUnitID: fixture.am,
                    allocations: [ExpenseAllocation(
                        unitID: fixture.sam,
                        amount: Money(minorUnits: 500, currency: .eur)
                    )],
                    category: "Attempted category"
                ))
            ))
        )
        let voidAttempt = EventEnvelope(
            id: try AppLedgerIDs.seedEventID(41),
            potID: fixture.potID,
            actorMemberID: actor,
            occurredAt: fixture.date(4),
            originatingTimeZone: fixture.timeZone,
            payload: .recordVoided(RecordVoidedPayload(
                recordID: expenseRecordID,
                reason: "Attempted void reason"
            ))
        )
        let restoreAttempt = EventEnvelope(
            id: try AppLedgerIDs.seedEventID(42),
            potID: fixture.potID,
            actorMemberID: actor,
            occurredAt: fixture.date(5),
            originatingTimeZone: fixture.timeZone,
            payload: .recordRestored(RecordRestoredPayload(
                recordID: expenseRecordID
            ))
        )
        let flagAttempt = EventEnvelope(
            id: try AppLedgerIDs.seedEventID(43),
            potID: fixture.potID,
            actorMemberID: actor,
            occurredAt: fixture.date(6),
            originatingTimeZone: fixture.timeZone,
            payload: .settlementFlagged(SettlementFlaggedPayload(
                recordID: settlementRecordID,
                reason: "Attempted flag reason"
            ))
        )
        let attempts = [revision, voidAttempt, restoreAttempt, flagAttempt]

        do {
            let store = try LedgerStore(
                path: databasePath,
                fileProtection: .none,
                now: fixture.baseDate
            )
            try store.registerPot(fixture.configuration, at: fixture.baseDate)
            _ = try store.ingestRemoteEvent(expenseRoot, receivedAt: fixture.date(1))
            _ = try store.ingestRemoteEvent(settlementRoot, receivedAt: fixture.date(2))
            for event in attempts {
                _ = try store.appendHeldLocalEvent(event, savedAt: fixture.date(7))
            }
            _ = try store.expireHeldEvents(now: fixture.date(20))
            for (event, reason) in zip(attempts, [
                "INVALID_SERVER_RESPONSE",
                "NOT_MEMBER",
                "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
                "DUPLICATE_RECORD",
            ]) {
                _ = try store.markDispatching(eventID: event.id, at: fixture.date(21))
                _ = try store.markTerminal(
                    eventID: event.id,
                    reason: reason,
                    at: fixture.date(22)
                )
            }
            for event in [revision, voidAttempt, flagAttempt] {
                _ = try store.purgeErasureSidecars(for: event.id)
            }
            let repository = AppLedgerRepository(store: store)
            assertFailedCorrections(try await repository.refreshSnapshot())
        }

        let reopened = AppLedgerRepository(store: try LedgerStore(
            path: databasePath,
            fileProtection: .none,
            now: fixture.date(30)
        ))
        assertFailedCorrections(try await reopened.bootstrap(seedCasaMar: false))
    }

    @MainActor
    func testFailedRootUsesEventIdentityAndKeepsOptimisticLocalOrder() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let first = try fixture.expense(
            eventIndex: 11,
            recordIndex: 11,
            title: "First optimistic",
            sequence: nil
        )
        let rejectedDuplicate = try fixture.expense(
            eventIndex: 12,
            recordIndex: 11,
            title: "Rejected duplicate",
            sequence: nil
        )
        let third = try fixture.expense(
            eventIndex: 13,
            recordIndex: 13,
            title: "Third optimistic",
            sequence: nil
        )
        for event in [first, rejectedDuplicate, third] {
            _ = try store.appendHeldLocalEvent(event, savedAt: fixture.baseDate)
        }
        _ = try store.expireHeldEvents(now: fixture.date(20))
        _ = try store.markDispatching(
            eventID: first.id,
            at: fixture.date(21)
        )
        _ = try store.acknowledge(
            eventID: first.id,
            serverSequence: 1,
            at: fixture.date(22)
        )
        _ = try store.markDispatching(
            eventID: rejectedDuplicate.id,
            at: fixture.date(23)
        )
        _ = try store.markTerminal(
            eventID: rejectedDuplicate.id,
            reason: "DUPLICATE_RECORD",
            at: fixture.date(24)
        )

        let snapshot = try await repository.refreshSnapshot()

        XCTAssertEqual(
            snapshot.records.map(\.title),
            ["First optimistic", "Rejected duplicate", "Third optimistic"]
        )
        XCTAssertEqual(snapshot.records.map(\.sortOrdinal), [0, 1, 2])
        XCTAssertEqual(
            snapshot.records.map(\.id),
            [
                try AppLedgerIDs.seedRecordID(31).description,
                "failed:\(rejectedDuplicate.id.description)",
                try AppLedgerIDs.seedRecordID(33).description,
            ]
        )
        XCTAssertEqual(
            Set(snapshot.records.map(\.id)).count,
            snapshot.records.count
        )
        XCTAssertEqual(snapshot.spend, 200)
        XCTAssertEqual(snapshot.balances[.am], 200)
        XCTAssertEqual(snapshot.balances[.sam], -200)
    }

    @MainActor
    func testOfflineWritesRemainAvailableButAccessLossFreezesFinancialWrites() async throws {
        let fixture = try AppAdapterFixture()
        let repository = AppLedgerRepository(
            store: try LedgerStore.inMemory(now: fixture.baseDate)
        )
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(repository: repository, snapshot: snapshot)
        model.setSyncPresentationForTesting(.offline(pendingCount: 0))

        model.beginAdd(prefilling: [.sam])
        XCTAssertTrue(model.addPresented)
        model.amountInt = "1"
        model.merchant = "Saved offline"
        model.saveExpense()
        let savedOffline = await eventually {
            model.records.map(\.title) == ["Saved offline"]
        }
        XCTAssertTrue(savedOffline)

        model.chooseBridge(from: .sam, to: .am, amountCents: 100)
        guard case .settleAmount = model.sheet else {
            return XCTFail("Retryable offline mode must keep settlement entry available")
        }
        model.closeSheet()
        model.setSyncPresentationForTesting(
            .paused(pendingCount: 1, code: "NOT_MEMBER")
        )

        model.beginAdd(prefilling: [.sam])
        XCTAssertFalse(model.addPresented)
        model.openSettlePlan()
        guard case .none = model.sheet else {
            return XCTFail("Access loss must not enter settlement")
        }
        model.amountInt = "2"
        model.amountFrac = nil
        model.merchant = "Must not append"
        model.attached = [.sam]
        model.saveExpense()
        model.settleFrom = .sam
        model.settleTo = .am
        model.sInt = "1"
        model.sFrac = nil
        model.markPaid()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(model.records.map(\.title), ["Saved offline"])
    }

    @MainActor
    func testFutureSchemaPreservesLastValidProjectionAndGatesWrites() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        try store.registerPot(fixture.configuration, at: fixture.baseDate)

        let known = try fixture.expense(
            eventIndex: 5,
            recordIndex: 5,
            title: "Known event",
            sequence: 1
        )
        let future = try fixture.expense(
            eventIndex: 6,
            recordIndex: 6,
            title: "Future event",
            sequence: 2,
            schemaVersion: EventEnvelope.currentSchemaVersion + 1
        )
        _ = try store.ingestRemoteEvent(known, receivedAt: fixture.date(1))
        _ = try store.ingestRemoteEvent(future, receivedAt: fixture.date(2))

        let repository = AppLedgerRepository(store: store)
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(snapshot.records.map { $0.title }, ["Known event"])
        XCTAssertEqual(snapshot.balances[.am], 100)
        XCTAssertEqual(snapshot.balances[.sam], -100)

        let expectedIssue = ReductionIssue.unsupportedSchema(
            eventID: future.id,
            encountered: EventEnvelope.currentSchemaVersion + 1,
            supported: EventEnvelope.currentSchemaVersion
        )
        XCTAssertEqual(snapshot.reductionAccess, .readOnly(expectedIssue))

        do {
            _ = try await repository.appendExpense(
                title: "Must not append",
                amountMinorUnits: 100,
                orderedUnits: [.sam],
                weights: [.sam: 1],
                category: nil,
                occurredAt: fixture.date(3)
            )
            XCTFail("A future-schema pot must reject local appends")
        } catch let error as AppLedgerRepositoryError {
            guard case let .readOnlyReduction(issue) = error else {
                return XCTFail("Expected readOnlyReduction, got \(error)")
            }
            XCTAssertEqual(issue, expectedIssue)
        }

        let unchanged = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(unchanged.records.map { $0.title }, ["Known event"])

        let model = AppModel(repository: repository, snapshot: snapshot)
        XCTAssertTrue(model.requiresUpdate)
        model.beginAdd()
        XCTAssertFalse(model.addPresented)
        model.openSettlePlan()
        guard case .none = model.sheet else {
            return XCTFail("Read-only pots must not enter settlement")
        }
    }

    @MainActor
    func testArchivedPotBlocksRepositoryAndAppWrites() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        try store.registerPot(fixture.configuration, at: fixture.baseDate)
        let archive = EventEnvelope(
            id: try AppLedgerIDs.seedEventID(90),
            potID: fixture.potID,
            actorMemberID: try AppLedgerIDs.actorMemberID(for: .am),
            occurredAt: fixture.date(1),
            originatingTimeZone: fixture.timeZone,
            serverSequence: 1,
            payload: .potArchived(PotArchivedPayload(reason: "Household closed"))
        )
        _ = try store.ingestRemoteEvent(archive, receivedAt: fixture.date(1))

        let repository = AppLedgerRepository(store: store)
        let snapshot = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(snapshot.reductionAccess, .readWrite)
        XCTAssertTrue(snapshot.isArchived)

        do {
            _ = try await repository.appendExpense(
                title: "Must not append",
                amountMinorUnits: 100,
                orderedUnits: [.sam],
                weights: [.sam: 1],
                category: nil,
                occurredAt: fixture.date(2),
                savedAt: fixture.date(2)
            )
            XCTFail("An archived pot must reject local appends")
        } catch let error as AppLedgerRepositoryError {
            guard case .archivedPot = error else {
                return XCTFail("Expected archivedPot, got \(error)")
            }
        }
        let unchanged = try await repository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(unchanged.records.count, 0)

        let model = AppModel(repository: repository, snapshot: snapshot)
        model.beginAdd()
        XCTAssertFalse(model.addPresented)
        model.openSettlePlan()
        guard case .none = model.sheet else {
            return XCTFail("Archived pots must not enter settlement")
        }
    }

    @MainActor
    func testFrozenMemberSnapshotBlocksAppWritesButKeepsRecordsAvailable() async throws {
        let repository = AppLedgerRepository(store: try LedgerStore.inMemory())
        let seeded = try await repository.bootstrap(seedCasaMar: true)
        let frozen = AppLedgerSnapshot(
            revision: seeded.revision,
            balances: seeded.balances,
            spend: seeded.spend,
            plan: seeded.plan,
            records: seeded.records,
            pendingDeliveryEventCount: seeded.pendingDeliveryEventCount,
            unsyncedEventCount: seeded.unsyncedEventCount,
            isArchived: seeded.isArchived,
            isCurrentMemberArchived: true,
            reductionAccess: seeded.reductionAccess,
            minimumReaderSchemaVersion: seeded.minimumReaderSchemaVersion,
            potSetup: seeded.potSetup,
            memberProfiles: seeded.memberProfiles,
            currentMemberID: seeded.currentMemberID
        )
        let model = AppModel(repository: repository, snapshot: frozen)

        XCTAssertEqual(model.potCurrency, .eur)
        XCTAssertTrue(model.isCurrentMemberArchived)
        XCTAssertFalse(model.records.isEmpty)
        model.beginAdd()
        XCTAssertFalse(model.addPresented)
        model.openSettlePlan()
        guard case .none = model.sheet else {
            return XCTFail("A frozen member snapshot must remain read-only")
        }
    }

    func testFileBackedRelaunchKeepsRecordAndLapsesUndo() async throws {
        let fixture = try AppAdapterFixture()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("NumaSharedAppTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let databasePath = directory.appendingPathComponent("ledger.sqlite").path

        let eventID: EventID
        do {
            let store = try LedgerStore(
                path: databasePath,
                fileProtection: .none,
                now: fixture.baseDate
            )
            let repository = AppLedgerRepository(store: store)
            _ = try await repository.bootstrap(seedCasaMar: false)
            let mutation = try await repository.appendExpense(
                title: "Durable expense",
                amountMinorUnits: 100,
                orderedUnits: [.sam],
                weights: [.sam: 1],
                category: nil,
                occurredAt: fixture.date(1)
            )
            XCTAssertEqual(mutation.snapshot.records.map { $0.title }, ["Durable expense"])
            eventID = mutation.eventID
        }

        let reopenedStore = try LedgerStore(
            path: databasePath,
            fileProtection: .none,
            now: fixture.date(2)
        )
        let reopenedRepository = AppLedgerRepository(store: reopenedStore)
        let relaunched = try await reopenedRepository.bootstrap(seedCasaMar: false)
        XCTAssertEqual(relaunched.records.map { $0.title }, ["Durable expense"])
        let undone = try await reopenedRepository.undoHeldEvent(
            eventID: eventID,
            now: fixture.date(2)
        )
        XCTAssertNil(undone)
    }

    func testBackdatedOccurrenceUsesSaveTimeUndoWindow() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let occurredAt = fixture.baseDate.addingTimeInterval(-31_536_000)
        let savedAt = fixture.baseDate

        let mutation = try await repository.appendExpense(
            title: "Backdated expense",
            amountMinorUnits: 100,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: occurredAt,
            savedAt: savedAt
        )

        XCTAssertEqual(
            mutation.undoDeadline,
            savedAt.addingTimeInterval(UndoPolicy.window)
        )
        let undone = try await repository.undoHeldEvent(
            eventID: mutation.eventID,
            now: savedAt.addingTimeInterval(UndoPolicy.window - 0.001)
        )
        XCTAssertNotNil(undone)
        XCTAssertTrue(undone?.records.isEmpty == true)
    }

    func testOverpaySuggestionStopsAtInt64OverflowBoundary() {
        XCTAssertEqual(
            AppModel.overpaySuggestion(for: Int64.max - 2_500),
            Int64.max
        )
        XCTAssertNil(AppModel.overpaySuggestion(for: Int64.max - 2_499))
    }

    @MainActor
    func testFlaggedSettlementReversalUsesOppositeDirectionAndExactPreview() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let original = try await repository.appendSettlement(
            title: "Settlement target",
            amountMinorUnits: 1_000,
            from: .sam,
            to: .am
        )
        let targetID = try XCTUnwrap(
            original.snapshot.records.first { $0.kind == .settlement }?.id
        )
        let flagged = try await repository.appendFlag(recordID: targetID)
        let model = AppModel(repository: repository, snapshot: flagged.snapshot)
        model.openDetail(targetID)

        model.beginSettlementReversal()

        XCTAssertTrue(model.isRecordingSettlementReversal)
        XCTAssertEqual(model.settleFrom, .am)
        XCTAssertEqual(model.settleTo, .sam)
        XCTAssertEqual(model.settleDebt, 1_000)
        XCTAssertEqual(model.settlementBalanceAfter(for: .am), 0)
        XCTAssertEqual(model.settlementBalanceAfter(for: .sam), 0)
        model.sInt = "4"
        model.sFrac = nil
        XCTAssertEqual(
            model.settlePreviewText,
            localizedFormat(
                "%@ will remain linked for correction.",
                model.fmt(600, forceCents: true)
            )
        )

        model.markPaid()
        let recorded = await eventually {
            model.records.contains {
                $0.reversalOfRecordID == targetID && $0.amountCents == 400
            }
        }
        XCTAssertTrue(recorded)
        let projectedTarget = try XCTUnwrap(
            model.records.first { $0.id == targetID }
        )
        XCTAssertEqual(model.remainingSettlementReversal(for: projectedTarget), 600)

        do {
            _ = try await repository.appendSettlement(
                title: "Excess reversal",
                amountMinorUnits: 601,
                from: .am,
                to: .sam,
                reversalOfRecordID: targetID
            )
            XCTFail("A linked reversal must not exceed the remaining amount")
        } catch let error as AppLedgerRepositoryError {
            guard case let .invalidLocalMutation(issue) = error,
                  case let .invalidEvent(_, reason) = issue,
                  case .settlementReversalExceedsOriginal = reason
            else { return XCTFail("Unexpected reversal failure: \(error)") }
        }
        let final = try await repository.appendSettlement(
            title: "Final reversal",
            amountMinorUnits: 600,
            from: .am,
            to: .sam,
            reversalOfRecordID: targetID
        )
        XCTAssertTrue(final.snapshot.balances.values.allSatisfy { $0 == 0 })
        XCTAssertEqual(
            final.snapshot.records.filter { $0.reversalOfRecordID == targetID }.count,
            2
        )
    }

    @MainActor
    func testRestoreAndFlagReplacePriorUndoTarget() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)

        let expense = try await repository.appendExpense(
            title: "Restore target",
            amountMinorUnits: 100,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil
        )
        let restoreTargetID = try XCTUnwrap(expense.snapshot.records.first?.id)
        _ = try await repository.appendVoid(
            recordID: restoreTargetID,
            reason: "double entry"
        )
        let settlement = try await repository.appendSettlement(
            title: "Settlement target",
            amountMinorUnits: 25,
            from: .sam,
            to: .am
        )
        let settlementID = try XCTUnwrap(
            settlement.snapshot.records.first { $0.kind == .settlement }?.id
        )
        let model = AppModel(repository: repository, snapshot: settlement.snapshot)

        model.beginAdd(prefilling: [.leo])
        model.amountInt = "1"
        model.merchant = "Prior undo expense"
        model.saveExpense()
        let priorSaveCompleted = await eventually {
            model.records.contains { $0.title == "Prior undo expense" }
                && model.undoText != nil
        }
        XCTAssertTrue(priorSaveCompleted)
        let priorExpenseID = try XCTUnwrap(
            model.records.first { $0.title == "Prior undo expense" }?.id
        )
        let staleSaveBanner = model.undoText

        model.openDetail(restoreTargetID)
        model.restoreRecord()
        let restoreCompleted = await eventually {
            model.records.first { $0.id == restoreTargetID }?.voided == false
                && model.undoText == localizedFormat("%@ restored", "Restore target")
        }
        XCTAssertTrue(restoreCompleted)
        XCTAssertNotEqual(model.undoText, staleSaveBanner)

        model.undoNow()
        let restoreUndone = await eventually {
            model.records.first { $0.id == restoreTargetID }?.voided == true
                && model.undoText == nil
        }
        XCTAssertTrue(restoreUndone)
        XCTAssertTrue(model.records.contains { $0.id == priorExpenseID })

        model.openDetail(priorExpenseID)
        model.beginVoidRecord()
        model.voidReasonDraft = "Duplicate record"
        model.confirmVoidRecord()
        let priorVoidCompleted = await eventually {
            model.records.first { $0.id == priorExpenseID }?.voided == true
                && model.undoText != nil
        }
        XCTAssertTrue(priorVoidCompleted)
        let staleVoidBanner = model.undoText

        model.openDetail(settlementID)
        model.flagRecord()
        let flagCompleted = await eventually {
            model.records.first { $0.id == settlementID }?.flagged == true
                && model.undoText == localizedFormat("%@ flagged", "Settlement target")
        }
        XCTAssertTrue(flagCompleted)
        XCTAssertNotEqual(model.undoText, staleVoidBanner)

        model.undoNow()
        let flagUndone = await eventually {
            model.records.first { $0.id == settlementID }?.flagged == false
                && model.undoText == nil
        }
        XCTAssertTrue(flagUndone)
        XCTAssertEqual(
            model.records.first { $0.id == priorExpenseID }?.voided,
            true
        )
        XCTAssertEqual(
            model.records.first { $0.id == restoreTargetID }?.voided,
            true
        )
    }

    @MainActor
    func testSettlementPreviewUsesFullDebtorBalanceAcrossMultipleCreditors() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let snapshot = AppLedgerSnapshot(
            revision: 1,
            balances: [.am: 60, .sam: -100, .leo: 40],
            spend: 0,
            plan: [
                SettlementStep(from: .sam, to: .am, amountCents: 60),
                SettlementStep(from: .sam, to: .leo, amountCents: 40),
            ],
            records: [],
            pendingDeliveryEventCount: 0,
            unsyncedEventCount: 0,
            isArchived: false,
            reductionAccess: .readWrite,
            minimumReaderSchemaVersion: nil
        )
        let model = AppModel(repository: repository, snapshot: snapshot)

        model.chooseBridge(from: .sam, to: .am, amountCents: 60)

        XCTAssertEqual(model.settleDebt, 60)
        XCTAssertEqual(model.centsOf(model.sInt, model.sFrac), 60)
        XCTAssertEqual(
            model.settlePreviewText,
            localizedFormat(
                "%1$@ will still owe %2$@ after this.",
                "Sam",
                model.fmt(40)
            )
        )
    }

    @MainActor
    func testFilterExplainAccumulatesSettlementHistoryBeyondInt64() async throws {
        let maximum = Int64.max
        let records = [
            ExpenseRecord(
                id: "voided-expense",
                sortOrdinal: 0,
                kind: .expense,
                title: "Voided expense",
                amountCents: maximum,
                payer: .am,
                parts: [.sam: maximum],
                to: nil,
                occurredAt: .distantPast,
                originatingTimeZoneIdentifier: "UTC",
                category: nil,
                recordedBy: "Arseny",
                voided: true,
                flagged: false
            ),
            ExpenseRecord(
                id: "first-settlement",
                sortOrdinal: 1,
                kind: .settlement,
                title: "First settlement",
                amountCents: maximum,
                payer: .sam,
                parts: [:],
                to: .am,
                occurredAt: .distantPast,
                originatingTimeZoneIdentifier: "UTC",
                category: nil,
                recordedBy: "Sam",
                voided: false,
                flagged: false
            ),
            ExpenseRecord(
                id: "second-expense",
                sortOrdinal: 2,
                kind: .expense,
                title: "Second expense",
                amountCents: maximum,
                payer: .am,
                parts: [.sam: maximum],
                to: nil,
                occurredAt: .distantPast,
                originatingTimeZoneIdentifier: "UTC",
                category: nil,
                recordedBy: "Arseny",
                voided: false,
                flagged: false
            ),
            ExpenseRecord(
                id: "second-settlement",
                sortOrdinal: 3,
                kind: .settlement,
                title: "Second settlement",
                amountCents: maximum,
                payer: .sam,
                parts: [:],
                to: .am,
                occurredAt: .distantPast,
                originatingTimeZoneIdentifier: "UTC",
                category: nil,
                recordedBy: "Sam",
                voided: false,
                flagged: false
            ),
        ]
        let snapshot = AppLedgerSnapshot(
            revision: 1,
            balances: [.am: -maximum, .sam: maximum, .leo: 0],
            spend: maximum,
            plan: [],
            records: records,
            pendingDeliveryEventCount: 0,
            unsyncedEventCount: 0,
            isArchived: false,
            reductionAccess: .readWrite,
            minimumReaderSchemaVersion: nil
        )
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let model = AppModel(
            repository: repository,
            snapshot: snapshot
        )
        model.activityFilter = .sam

        let exactMinorUnits = Decimal(maximum) * 2
        XCTAssertEqual(
            money(decimalMinorUnits: exactMinorUnits, locale: Locale(identifier: "en_US")),
            "€184,467,440,737,095,516.14"
        )
        let settledLine = try XCTUnwrap(
            model.filterExplain?.lines.first { $0.0 == "Settled so far" }
        )
        XCTAssertEqual(
            settledLine.1,
            "+" + money(decimalMinorUnits: exactMinorUnits)
        )
    }

    func testBackwardWallClockCannotExtendExpiredUndo() async throws {
        let fixture = try AppAdapterFixture()
        let store = try LedgerStore.inMemory(now: fixture.baseDate)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let mutation = try await repository.appendExpense(
            title: "Expiry boundary",
            amountMinorUnits: 100,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: nil,
            occurredAt: fixture.date(1)
        )

        let backwardsWallClock = fixture.baseDate.addingTimeInterval(-3_600)
        let effectiveNow = AppModel.effectiveExpiryNow(
            wallClockNow: backwardsWallClock,
            scheduledDeadline: mutation.undoDeadline
        )
        XCTAssertEqual(effectiveNow, mutation.undoDeadline)

        switch try await repository.expireHeldEvent(
            eventID: mutation.eventID,
            now: effectiveNow
        ) {
        case let .transitioned(eventIDs):
            XCTAssertTrue(eventIDs.contains(mutation.eventID))
        case let result:
            XCTFail("Expected expiry at the monotonic deadline, got \(result)")
        }
        let undone = try await repository.undoHeldEvent(
            eventID: mutation.eventID,
            now: effectiveNow
        )
        XCTAssertNil(undone)
    }

    func testAppFormattingUsesViewingLocaleForMoneyDatesAndEntry() throws {
        let english = Locale(identifier: "en_US")
        let german = Locale(identifier: "de_DE")

        XCTAssertEqual(
            money(123_456, forceCents: true, locale: english),
            "€1,234.56"
        )
        let germanMoney = money(123_456, forceCents: true, locale: german)
        XCTAssertTrue(germanMoney.contains("1.234,56"))
        XCTAssertTrue(germanMoney.hasSuffix("€"))

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Europe/Madrid"))
        let occurredAt = try XCTUnwrap(calendar.date(from: DateComponents(
            calendar: calendar,
            timeZone: calendar.timeZone,
            year: 2026,
            month: 7,
            day: 1,
            hour: 12
        )))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(
            calendar: calendar,
            timeZone: calendar.timeZone,
            year: 2026,
            month: 7,
            day: 2,
            hour: 12
        )))
        let record = ExpenseRecord(
            id: "locale-record",
            sortOrdinal: 0,
            kind: .expense,
            title: "Locale record",
            amountCents: 100,
            payer: .am,
            parts: [.sam: 100],
            to: nil,
            occurredAt: occurredAt,
            originatingTimeZoneIdentifier: "Europe/Madrid",
            category: nil,
            recordedBy: "Arseny",
            voided: false,
            flagged: false
        )
        XCTAssertEqual(
            record.formattedWhen(locale: english, now: now),
            "Wed, Jul 1"
        )
        XCTAssertEqual(
            record.formattedWhen(locale: german, now: now),
            "Mi. 1. Juli"
        )

        let commaEntry = AppModel.editKey("12", nil, ",", locale: german)
        XCTAssertEqual(commaEntry.0, "12")
        XCTAssertEqual(commaEntry.1, "")
        XCTAssertTrue(
            AppModel.displayAmount("12", "3", locale: german).contains("12,3")
        )
        XCTAssertTrue(
            AppModel.displayAmount("12", "", locale: german).contains("12,")
        )

        let dotEntry = AppModel.editKey("12", nil, ".", locale: german)
        XCTAssertEqual(dotEntry.1, "")
        XCTAssertEqual(
            AppModel.displayAmount("12", "30", locale: english),
            "€12.30"
        )

        XCTAssertNil(AppModel.editKey(
            "12", nil, ".", locale: english, currency: .jpy
        ).1)
        let bhd = AppModel.editKey(
            "12", "34", "5", locale: english, currency: .bhd
        )
        XCTAssertEqual(bhd.1, "345")
        XCTAssertTrue(AppModel.displayAmount(
            "12", "345", locale: english, currency: .bhd
        ).contains("12.345"))
    }

    @MainActor
    private func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<200 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    @MainActor
    private func assertFailedRoots(
        _ snapshot: AppLedgerSnapshot,
        openingTitle: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(snapshot.balances, [.am: 0, .sam: 0, .leo: 0], file: file, line: line)
        XCTAssertEqual(snapshot.spend, 0, file: file, line: line)
        XCTAssertTrue(snapshot.plan.isEmpty, file: file, line: line)
        XCTAssertEqual(
            snapshot.records.map(\.title),
            ["Attempted expense", "Attempted settlement", openingTitle],
            file: file,
            line: line
        )
        XCTAssertEqual(
            snapshot.records.map(\.kind),
            [.expense, .settlement, .openingBalance],
            file: file,
            line: line
        )
        XCTAssertEqual(
            snapshot.records.map(\.deliveryState),
            [.failed, .failed, .failed],
            file: file,
            line: line
        )
        XCTAssertEqual(
            snapshot.records.map(\.terminalReason),
            ["NOT_MEMBER", "INVALID_SERVER_RESPONSE", "MEMBERSHIP_ARCHIVED"],
            file: file,
            line: line
        )
        XCTAssertEqual(
            snapshot.records.first?.deliveryCopy,
            "Couldn’t be added — you’re no longer a member",
            file: file,
            line: line
        )
        XCTAssertTrue(
            snapshot.records.allSatisfy { $0.deliveryState != .waiting },
            file: file,
            line: line
        )
    }

    @MainActor
    private func assertGenericFailedAttempt(
        _ snapshot: AppLedgerSnapshot,
        excludes opaqueSecret: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(snapshot.balances, [.am: 0, .sam: 0, .leo: 0], file: file, line: line)
        XCTAssertEqual(snapshot.spend, 0, file: file, line: line)
        XCTAssertTrue(snapshot.plan.isEmpty, file: file, line: line)
        XCTAssertEqual(snapshot.pendingDeliveryEventCount, 0, file: file, line: line)
        XCTAssertEqual(snapshot.records.count, 1, file: file, line: line)
        let record = snapshot.records[0]
        XCTAssertEqual(record.kind, .failedAttempt, file: file, line: line)
        XCTAssertEqual(record.title, "Shared pot change attempt", file: file, line: line)
        XCTAssertEqual(record.deliveryState, .failed, file: file, line: line)
        XCTAssertEqual(record.terminalReason, "UNSUPPORTED_WIRE_EVENT", file: file, line: line)
        XCTAssertFalse(record.title.contains(opaqueSecret), file: file, line: line)
        XCTAssertFalse(record.subtitle.contains(opaqueSecret), file: file, line: line)
        XCTAssertFalse(record.failureSupportText?.contains(opaqueSecret) ?? false, file: file, line: line)
    }

    @MainActor
    private func assertFailedCorrections(
        _ snapshot: AppLedgerSnapshot,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(snapshot.spend, 100, file: file, line: line)
        XCTAssertEqual(snapshot.balances[.am], 75, file: file, line: line)
        XCTAssertEqual(snapshot.balances[.sam], -75, file: file, line: line)
        XCTAssertEqual(snapshot.plan.count, 1, file: file, line: line)
        let failed = snapshot.records.filter { $0.deliveryState == .failed }
        XCTAssertEqual(
            failed.map(\.title),
            [
                "[redacted]",
                "Void attempt: [redacted]",
                "Restore attempt",
                "Flag attempt: [redacted]",
            ],
            file: file,
            line: line
        )
        XCTAssertEqual(
            failed.map(\.kind),
            [.expenseRevision, .voidAttempt, .restoreAttempt, .settlementFlagAttempt],
            file: file,
            line: line
        )
        XCTAssertEqual(
            failed.map(\.sortOrdinal),
            [2, 3, 4, 5],
            file: file,
            line: line
        )
        XCTAssertTrue(
            failed.allSatisfy { $0.id.hasPrefix("failed:") },
            file: file,
            line: line
        )
        XCTAssertEqual(Set(failed.map(\.id)).count, 4, file: file, line: line)
        XCTAssertTrue(
            failed.allSatisfy { $0.failureSupportText?.contains("Target record:") == true },
            file: file,
            line: line
        )
        XCTAssertEqual(
            failed[2].deliveryCopy,
            "Couldn’t be added — this pot reached its safe record capacity. Copy the details and contact support.",
            file: file,
            line: line
        )
    }

    @MainActor
    func testActivityCombinesSearchKindAndPeriodFilters() async throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(calendar.date(from: DateComponents(
            year: 2026,
            month: 7,
            day: 17,
            hour: 12
        )))
        let store = try LedgerStore.inMemory(now: now)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        _ = try await repository.appendExpense(
            title: "Groceries at Lidl",
            amountMinorUnits: 1_000,
            payer: .am,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: "Groceries",
            occurredAt: try XCTUnwrap(calendar.date(byAdding: .month, value: -1, to: now)),
            savedAt: now
        )
        _ = try await repository.appendExpense(
            title: "Internet",
            amountMinorUnits: 2_000,
            payer: .am,
            orderedUnits: [.am, .sam],
            weights: [.am: 1, .sam: 1],
            category: "Utilities",
            occurredAt: try XCTUnwrap(calendar.date(byAdding: .day, value: -2, to: now)),
            savedAt: now
        )
        let latest = try await repository.appendSettlement(
            title: "Sam paid Arseny",
            amountMinorUnits: 500,
            from: .sam,
            to: .am,
            occurredAt: try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: now)),
            savedAt: now
        )
        let model = AppModel(repository: repository, snapshot: latest.snapshot)

        XCTAssertEqual(
            model.filteredActivityRows(now: now).map(\.title),
            ["Sam paid Arseny", "Internet", "Groceries at Lidl"]
        )
        model.activitySearchQuery = "groceries"
        XCTAssertEqual(model.filteredActivityRows(now: now).map(\.title), ["Groceries at Lidl"])

        model.activitySearchQuery = ""
        model.activityKindFilter = .settlements
        XCTAssertEqual(model.filteredActivityRows(now: now).map(\.title), ["Sam paid Arseny"])

        model.activityKindFilter = .all
        model.activityPeriodFilter = .month
        XCTAssertEqual(
            Set(model.filteredActivityRows(now: now).map(\.title)),
            ["Internet", "Sam paid Arseny"]
        )

        model.activitySearchQuery = "sam"
        XCTAssertEqual(model.filteredActivityRows(now: now).count, 2)
        XCTAssertEqual(
            model.filteredActivityRows(now: now).map(\.title),
            ["Sam paid Arseny", "Internet"]
        )

        model.activitySearchQuery = "no matching household record"
        XCTAssertTrue(model.filteredActivityRows(now: now).isEmpty)
    }

    @MainActor
    func testOrdinaryExpenseEditPreviewsAndPersistsBalanceImpact() async throws {
        let now = Date(timeIntervalSince1970: 1_783_814_400)
        let store = try LedgerStore.inMemory(now: now)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let added = try await repository.appendExpense(
            title: "Dinner",
            amountMinorUnits: 1_000,
            payer: .am,
            orderedUnits: [.sam, .leo],
            weights: [.sam: 1, .leo: 1],
            category: "Food",
            occurredAt: now,
            savedAt: now
        )
        let originalParts = try XCTUnwrap(added.snapshot.records.first?.parts)
        let metadataOnly = try await repository.appendExpenseRevision(
            recordID: try XCTUnwrap(added.snapshot.records.first?.id),
            title: "Dinner renamed",
            amountMinorUnits: 1_000,
            category: "Food",
            occurredAt: now.addingTimeInterval(1),
            savedAt: now.addingTimeInterval(1)
        )
        XCTAssertEqual(metadataOnly.snapshot.records.first?.parts, originalParts)

        let model = AppModel(repository: repository, snapshot: metadataOnly.snapshot)
        let recordID = try XCTUnwrap(model.records.first?.id)
        model.openDetail(recordID)
        model.beginEditRecord()
        model.editTitle = "Dinner corrected"
        model.editAmountInt = "12"
        model.editAmountFrac = "00"
        model.editCategory = "Dining"

        let impacts = Dictionary(uniqueKeysWithValues: model.editBalanceImpacts.map {
            ($0.id, $0)
        })
        XCTAssertEqual(impacts[.am]?.beforeMinorUnits, Decimal(1_000))
        XCTAssertEqual(impacts[.am]?.afterMinorUnits, Decimal(1_200))
        XCTAssertEqual(impacts[.sam]?.beforeMinorUnits, Decimal(-500))
        XCTAssertEqual(impacts[.sam]?.afterMinorUnits, Decimal(-600))
        XCTAssertEqual(impacts[.leo]?.beforeMinorUnits, Decimal(-500))
        XCTAssertEqual(impacts[.leo]?.afterMinorUnits, Decimal(-600))

        model.saveExpenseEdit()
        let editCompleted = await eventually {
            model.records.first?.revisionHistory.count == 3
        }
        XCTAssertTrue(editCompleted)
        let revised = try XCTUnwrap(model.records.first)
        XCTAssertEqual(revised.title, "Dinner corrected")
        XCTAssertEqual(revised.amountCents, 1_200)
        XCTAssertEqual(revised.category, "Dining")
        XCTAssertEqual(revised.parts[.sam], 600)
        XCTAssertEqual(revised.parts[.leo], 600)
        XCTAssertEqual(model.balances[.am], 1_200)
        XCTAssertEqual(model.balances[.sam], -600)
        XCTAssertEqual(model.balances[.leo], -600)
    }

    func testRepeatPastExpenseCopiesCurrentContentIntoANewUndoableRecord() async throws {
        let now = Date(timeIntervalSince1970: 1_783_814_400)
        let store = try LedgerStore.inMemory(now: now)
        let repository = AppLedgerRepository(store: store)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let added = try await repository.appendExpense(
            title: "Dinner",
            amountMinorUnits: 1_001,
            payer: .sam,
            orderedUnits: [.am, .leo],
            weights: [.am: 2, .leo: 1],
            category: "Food",
            occurredAt: now,
            savedAt: now
        )
        let original = try XCTUnwrap(added.snapshot.records.first)
        let repeated = try await repository.repeatExpense(
            recordID: original.id,
            occurredAt: now.addingTimeInterval(1),
            savedAt: now.addingTimeInterval(1)
        )

        XCTAssertEqual(repeated.snapshot.records.count, 2)
        let copy = try XCTUnwrap(
            repeated.snapshot.records.first { $0.id != original.id }
        )
        XCTAssertEqual(copy.title, original.title)
        XCTAssertEqual(copy.amountCents, original.amountCents)
        XCTAssertEqual(copy.payer, original.payer)
        XCTAssertEqual(copy.parts, original.parts)
        XCTAssertEqual(copy.category, original.category)
        XCTAssertNotNil(repeated.undoDeadline)
    }

    @MainActor
    func testVoidRequiresEnteredReasonAndPersistsIt() async throws {
        let now = Date(timeIntervalSince1970: 1_783_814_400)
        let identities = AppLedgerIdentitySet.fresh(at: now)
        let store = try LedgerStore.inMemory(now: now)
        let repository = AppLedgerRepository(store: store, identities: identities)
        _ = try await repository.bootstrap(seedCasaMar: false)
        let added = try await repository.appendExpense(
            title: "Duplicate lunch",
            amountMinorUnits: 900,
            payer: .am,
            orderedUnits: [.sam],
            weights: [.sam: 1],
            category: "Food",
            occurredAt: now,
            savedAt: now
        )
        let model = AppModel(repository: repository, snapshot: added.snapshot)
        model.openDetail(try XCTUnwrap(model.records.first?.id))
        model.beginVoidRecord()

        let eventCount = try store.loadStoredEvents(for: identities.potID).count
        model.voidReasonDraft = "   "
        model.confirmVoidRecord()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(try store.loadStoredEvents(for: identities.potID).count, eventCount)

        model.voidReasonDraft = "Duplicate receipt"
        model.confirmVoidRecord()
        let voidCompleted = await eventually {
            model.records.first?.voided == true
        }
        XCTAssertTrue(voidCompleted)
        XCTAssertEqual(model.records.first?.voidReason, "Duplicate receipt")
        let reasons: [String] = try store.loadStoredEvents(
            for: identities.potID
        ).compactMap { stored in
            guard case let .recordVoided(payload) = stored.event.payload else { return nil }
            return payload.reason
        }
        XCTAssertEqual(reasons.last, "Duplicate receipt")
    }
}

private struct AppAdapterFixture {
    let baseDate = Date(timeIntervalSince1970: 1_783_814_400)
    let potID: PotID
    let am: NumaSharedCore.UnitID
    let sam: NumaSharedCore.UnitID
    let configuration: PotConfiguration
    let timeZone: IANATimeZone

    init() throws {
        potID = try AppLedgerIDs.potID()
        am = try AppLedgerIDs.coreUnit(for: .am)
        sam = try AppLedgerIDs.coreUnit(for: .sam)
        configuration = try PotConfiguration(
            id: potID,
            currency: .eur,
            orderedUnitIDs: try UnitID.allCases.map(AppLedgerIDs.coreUnit(for:))
        )
        timeZone = try IANATimeZone("Europe/Madrid")
    }

    func date(_ offset: TimeInterval) -> Date {
        baseDate.addingTimeInterval(offset)
    }

    func expense(
        eventIndex: UInt8,
        recordIndex: UInt8,
        title: String,
        sequence: Int64?,
        schemaVersion: UInt16 = EventEnvelope.currentSchemaVersion,
        actorOverride: NumaSharedCore.MemberID? = nil
    ) throws -> EventEnvelope {
        EventEnvelope(
            id: try AppLedgerIDs.seedEventID(20 &+ eventIndex),
            potID: potID,
            actorMemberID: try actorOverride ?? AppLedgerIDs.actorMemberID(for: .am),
            occurredAt: date(TimeInterval(eventIndex)),
            originatingTimeZone: timeZone,
            schemaVersion: schemaVersion,
            serverSequence: sequence,
            payload: .expenseAdded(ExpenseAddedPayload(
                recordID: try AppLedgerIDs.seedRecordID(20 &+ recordIndex),
                content: ExpenseContent(
                    kind: .shared,
                    title: title,
                    amount: Money(minorUnits: 100, currency: .eur),
                    payerUnitID: am,
                    allocations: [
                        ExpenseAllocation(
                            unitID: sam,
                            amount: Money(minorUnits: 100, currency: .eur)
                        ),
                    ]
                )
            ))
        )
    }

    func settlement(
        eventIndex: UInt8,
        recordIndex: UInt8,
        title: String,
        sequence: Int64? = nil
    ) throws -> EventEnvelope {
        EventEnvelope(
            id: try AppLedgerIDs.seedEventID(20 &+ eventIndex),
            potID: potID,
            actorMemberID: try AppLedgerIDs.actorMemberID(for: .am),
            occurredAt: date(TimeInterval(eventIndex)),
            originatingTimeZone: timeZone,
            serverSequence: sequence,
            payload: .settlementRecorded(SettlementRecordedPayload(
                recordID: try AppLedgerIDs.seedRecordID(20 &+ recordIndex),
                content: SettlementContent(
                    title: title,
                    amount: Money(minorUnits: 25, currency: .eur),
                    fromUnitID: sam,
                    toUnitID: am
                )
            ))
        )
    }

    func openingBalance(
        eventIndex: UInt8,
        recordIndex: UInt8,
        title: String
    ) throws -> EventEnvelope {
        EventEnvelope(
            id: try AppLedgerIDs.seedEventID(20 &+ eventIndex),
            potID: potID,
            actorMemberID: try AppLedgerIDs.actorMemberID(for: .am),
            occurredAt: date(TimeInterval(eventIndex)),
            originatingTimeZone: timeZone,
            payload: .openingBalanceSet(OpeningBalanceSetPayload(
                recordID: try AppLedgerIDs.seedRecordID(20 &+ recordIndex),
                content: OpeningBalanceContent(
                    title: title,
                    entries: [
                        OpeningBalanceEntry(
                            unitID: am,
                            amount: Money(minorUnits: 40, currency: .eur)
                        ),
                        OpeningBalanceEntry(
                            unitID: sam,
                            amount: Money(minorUnits: -40, currency: .eur)
                        ),
                    ]
                )
            ))
        )
    }

    func unsupportedAttempt(
        eventIndex: UInt8,
        opaqueValue: String
    ) throws -> EventEnvelope {
        EventEnvelope(
            id: try AppLedgerIDs.seedEventID(20 &+ eventIndex),
            potID: potID,
            actorMemberID: try AppLedgerIDs.actorMemberID(for: .am),
            occurredAt: date(TimeInterval(eventIndex)),
            originatingTimeZone: timeZone,
            payload: .unsupported(
                kind: "futurePrivateAction",
                payload: .object(["private": .string(opaqueValue)])
            )
        )
    }
}
