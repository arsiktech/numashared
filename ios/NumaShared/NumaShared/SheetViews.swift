import SwiftUI
import UIKit

/// Hosts whichever sheet is active in `AppModel.sheet`. A single container
/// mirrors the source design's single bottom-sheet system for activity,
/// record detail, and settlement flows.
struct SheetContainerView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let palette: Pal.Palette

    var body: some View {
        Group {
            switch app.sheet {
            case .none: EmptyView()
            case .activity: ActivitySheet(palette: palette)
            case .detail: RecordDetailSheet(palette: palette)
            case .editExpense: ExpenseEditSheet(palette: palette)
            case .voidRecord: VoidRecordSheet(palette: palette)
            case .settlePlan: SettlePlanSheet(palette: palette)
            case .settleAmount: SettleAmountSheet(palette: palette)
            }
        }
        .presentationDetents(sheetDetents)
        .presentationDragIndicator(.hidden)
        .background(palette.surface)
        .foregroundStyle(palette.ink)
        // The undo toast must be reachable while this sheet covers Home —
        // voiding keeps the activity sheet up, so the 6s window lives here too.
        .safeAreaInset(edge: .bottom, spacing: 8) {
            ZStack {
                if let text = app.undoText {
                    UndoBar(text: text, palette: palette, onUndo: app.undoNow)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: app.undoText)
            .padding(.horizontal, 16).padding(.bottom, 8)
        }
    }

    private var sheetDetents: Set<PresentationDetent> {
        [.large]
    }
}

struct ActivitySheet: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let palette: Pal.Palette

    private var filterLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 10))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetGrabber(palette: palette).frame(maxWidth: .infinity)
            HStack {
                Text("Activity").font(NumaFont.system(21, weight: .bold))
                Spacer()
                CloseCircleButton(palette: palette, action: app.closeSheet)
            }
            .padding(.top, 12)

            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(palette.ink3)
                TextField(
                    "Search merchant, person, or note",
                    text: $app.activitySearchQuery
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("activity-search")
                if !app.activitySearchQuery.isEmpty {
                    Button { app.activitySearchQuery = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(PressableButtonStyle())
                    .accessibilityLabel("Clear search")
                }
            }
            .font(NumaFont.system(14))
            .padding(.leading, 14)
            .frame(minHeight: Metrics.minTarget)
            .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
            .padding(.top, 12)

            filterLayout {
                Menu {
                    Picker("Record kind", selection: $app.activityKindFilter) {
                        ForEach(ActivityKindFilter.allCases) { filter in
                            Text(filter.displayName).tag(filter)
                        }
                    }
                } label: {
                    filterLabel(app.activityKindFilter.displayName)
                }
                .accessibilityIdentifier("activity-kind-filter")

                Menu {
                    Picker("Period", selection: $app.activityPeriodFilter) {
                        ForEach(ActivityPeriodFilter.allCases) { filter in
                            Text(filter.displayName).tag(filter)
                        }
                    }
                } label: {
                    filterLabel(app.activityPeriodFilter.displayName)
                }
                .accessibilityIdentifier("activity-period-filter")
                if !dynamicTypeSize.isAccessibilitySize { Spacer() }
            }
            .padding(.top, 10)

            if let f = app.activityFilter {
                Button {
                    app.activityFilter = nil
                } label: {
                    HStack(spacing: 6) {
                        Text(app.unitInfo(for: f).name).font(NumaFont.system(12, weight: .semibold))
                        Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                    }
                    .foregroundStyle(palette.bg)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(palette.ink, in: Capsule())
                }
                .buttonStyle(PressableButtonStyle())
                .padding(.top, 10)

                if let explain = app.filterExplain {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(explain.title).font(NumaFont.system(15, weight: .bold))
                        ForEach(Array(explain.lines.enumerated()), id: \.offset) { _, line in
                            HStack {
                                Text(line.0).font(NumaFont.system(12.5)).foregroundStyle(palette.ink2)
                                Spacer()
                                Text(line.1).font(NumaFont.system(12.5, weight: .semibold).monospacedDigit())
                            }.padding(.top, 2)
                        }
                        Text(String(localized: "Balances cover the full pot history."))
                            .font(.caption).foregroundStyle(palette.ink3).padding(.top, 6)
                    }
                    .padding(13)
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.hair))
                    .padding(.top, 12)
                }
            }

            ScrollView {
                VStack(spacing: 0) {
                    let rows = app.filteredActivityRows()
                    if rows.isEmpty {
                        ContentUnavailableView(
                            "No matching records",
                            systemImage: "line.3.horizontal.decrease.circle",
                            description: Text("Try a different search or filter.")
                        )
                        .padding(.top, 40)
                        .accessibilityIdentifier("activity-no-results")
                    }
                    ForEach(rows) { r in
                        Button { app.openDetail(r.id) } label: {
                            ActivityRowView(
                                record: r,
                                palette: palette,
                                amountText: r.displaysAmount ? app.fmt(r.amountCents) : "—",
                                showsSyncState: app.isSyncEnabled,
                                unitInfos: app.unitInfos,
                                subtitleText: app.recordSubtitle(r)
                            )
                        }
                        .buttonStyle(PressableButtonStyle(scale: 0.98))
                        .accessibilityIdentifier("activity-row-\(r.id)")
                        Divider().overlay(palette.chip)
                    }
                    Text(app.activityHistoryCopy)
                        .font(.caption).foregroundStyle(palette.ink3)
                        .padding(.vertical, 14)
                }
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 22)
    }

    private func filterLabel(_ title: String) -> some View {
        HStack(spacing: 6) {
            Text(title).fixedSize(horizontal: false, vertical: true)
            if dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 6) }
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
        }
        .font(NumaFont.system(12.5, weight: .semibold))
        .foregroundStyle(palette.ink)
        .padding(.horizontal, 13)
        .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
        .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil,
               minHeight: Metrics.minTarget)
        .overlay(Capsule().stroke(palette.hair))
    }
}

struct RecordDetailSheet: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let palette: Pal.Palette

    private var record: ExpenseRecord? { app.records.first { $0.id == app.detailID } }

    private var valueLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 5))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetGrabber(palette: palette).frame(maxWidth: .infinity)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                if let r = record {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(r.title).font(NumaFont.display(30, relativeTo: .title))
                        Text("\(r.displaysAmount ? app.fmt(r.amountCents) : "—") · \(r.kind == .settlement ? localizedFormat("%@ — immutable", r.kind.displayName) : r.kind.displayName)")
                            .font(NumaFont.system(12.5).monospacedDigit()).foregroundStyle(palette.ink2)
                    }
                    Spacer()
                    Button(action: app.leaveDetail) {
                        Image(systemName: app.detailReturnsToActivity ? "chevron.left" : "xmark")
                            .font(.system(size: 13))
                            .frame(width: Metrics.minTarget, height: Metrics.minTarget)
                    }
                    .buttonStyle(PressableButtonStyle())
                    .foregroundStyle(palette.ink2).background(palette.chip, in: Circle())
                    .accessibilityLabel(app.detailReturnsToActivity ? "Back to Activity" : "Close receipt")
                    .accessibilityIdentifier("detail-back")
                }
                .padding(.top, 12)

                if r.voided {
                    Text(r.voidReason.map {
                        localizedFormat("Voided — %@. Balances restored; the record stays visible.", $0)
                    } ?? String(localized: "Voided — balances restored. The record stays visible."))
                        .font(NumaFont.system(12.5)).foregroundStyle(palette.ink2)
                        .padding(11).overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.hair)).padding(.top, 12)
                }

                if r.contest != nil {
                    contestedComparison(for: r)
                        .padding(.top, 12)
                }

                if r.deliveryState == .failed, let deliveryCopy = r.deliveryCopy {
                    Text(deliveryCopy)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(palette.ink2)
                        .padding(11)
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.hair))
                        .padding(.top, 12)
                }

                if let supportText = r.failureSupportText {
                    HStack(spacing: 10) {
                        Button {
                            UIPasteboard.general.string = supportText
                        } label: {
                            Label("Copy details", systemImage: "doc.on.doc")
                                .frame(maxWidth: .infinity)
                                .frame(minHeight: Metrics.minTarget)
                                .background(palette.chip, in: Capsule())
                                .overlay(Capsule().stroke(palette.hair))
                        }
                        .buttonStyle(PressableButtonStyle())
                        .accessibilityIdentifier("failed-record-copy")

                        ShareLink(item: supportText) {
                            Label("Share details", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                                .frame(minHeight: Metrics.minTarget)
                                .background(palette.chip, in: Capsule())
                                .overlay(Capsule().stroke(palette.hair))
                        }
                        .buttonStyle(PressableButtonStyle())
                        .accessibilityIdentifier("failed-record-share")
                    }
                    .font(.caption.weight(.semibold))
                    .tint(palette.ink)
                    .padding(.top, 10)
                }

                VStack(spacing: 0) {
                    if r.kind == .voidAttempt
                        || r.kind == .restoreAttempt
                        || r.kind == .settlementFlagAttempt {
                        kv("Target record", r.targetRecordID ?? String(localized: "Unavailable"))
                        kv("When", r.when)
                    } else if r.kind == .openingBalance
                        || r.kind == .openingBalanceRevision {
                        kv("Recorded by", r.recordedBy)
                        kv("When", r.when)
                    } else {
                        kv(
                            r.reversalOfRecordID == nil ? "Paid by" : "Correction from",
                            r.kind == .settlement ? app.unitInfo(for: r.payer).name
                                : r.payerDisplayName ?? "Person not recorded"
                        )
                        if r.kind != .settlement {
                            kv("Payer’s budget group", app.unitInfo(for: r.payer).name)
                            kv("Recorded by", r.recordedBy)
                        }
                        kv("When", r.when)
                        if r.kind == .settlement {
                            kv("To", app.unitInfo(for: r.to ?? app.currentUnitID).name)
                            if let targetID = r.reversalOfRecordID {
                                kv(
                                    "Correction of",
                                    app.records.first { $0.id == targetID }?.title
                                        ?? String(localized: "Earlier settlement")
                                )
                            } else if r.flagged {
                                kv(
                                    "Linked reversals",
                                    app.fmt(
                                        app.linkedSettlementReversalAmount(for: r),
                                        forceCents: true
                                    )
                                )
                            }
                        } else {
                            kv("Category", r.category ?? "")
                        }
                    }
                }
                .padding(.top, 8)

                if !r.parts.isEmpty {
                    Text("ALLOCATION").font(NumaFont.mono(9.5)).foregroundStyle(palette.ink3).padding(.top, 12)
                    ForEach(r.parts.keys.sorted { $0.rawValue < $1.rawValue }, id: \.self) { u in
                        valueLayout {
                            Text(app.unitInfo(for: u).name).font(NumaFont.system(13.5, weight: .semibold))
                                .fixedSize(horizontal: false, vertical: true)
                            if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                            Text(app.fmt(r.parts[u] ?? 0, forceCents: true)).font(NumaFont.rounded(13.5).monospacedDigit())
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 7)
                        Divider().overlay(palette.chip)
                    }
                }

                if r.revisionHistory.count > 1 {
                    revisionHistory(for: r)
                        .padding(.top, 16)
                }

                if r.kind == .settlement, r.deliveryState != .failed {
                    Text("Settlements are immutable — flag it if something is wrong; it stays visible while you sort it out.")
                        .font(NumaFont.system(12)).padding(11)
                        .background(palette.chip, in: RoundedRectangle(cornerRadius: 14)).padding(.top, 12)
                }

                Spacer(minLength: 24)

                // Stroke lives inside the label so the whole pill compresses on touch-down.
                VStack(spacing: 10) {
                    if r.deliveryState != .failed, r.kind != .settlement,
                       r.kind != .openingBalance {
                        if !r.voided {
                            if r.contest == nil {
                                if r.kind == .expense || r.kind == .personal {
                                    Button { app.repeatRecord() } label: {
                                        Text(String(localized: "Repeat expense"))
                                            .font(NumaFont.system(15, weight: .semibold))
                                            .foregroundStyle(palette.ink)
                                            .fixedSize(horizontal: false, vertical: true)
                                            .padding(.horizontal, 16).padding(.vertical, 14)
                                            .frame(maxWidth: .infinity, minHeight: 50)
                                            .background(palette.chip, in: Capsule())
                                    }
                                    .buttonStyle(PressableButtonStyle())
                                    .disabled(!app.canRepeatRecord)
                                    .accessibilityIdentifier("repeat-record")
                                }
                                Button { app.beginEditRecord() } label: {
                                    Text("Edit expense")
                                        .font(NumaFont.system(15, weight: .semibold))
                                        .foregroundStyle(palette.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(.horizontal, 16).padding(.vertical, 14)
                                        .frame(maxWidth: .infinity, minHeight: 50)
                                        .overlay(Capsule().stroke(palette.ink, lineWidth: 1.5))
                                }
                                .buttonStyle(PressableButtonStyle())
                                .accessibilityIdentifier("edit-record")
                            }
                            Button { app.beginVoidRecord() } label: {
                                Text("Void record")
                                    .font(NumaFont.system(15, weight: .semibold)).foregroundStyle(Pal.destructive)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 16).padding(.vertical, 14)
                                    .frame(maxWidth: .infinity, minHeight: 50)
                                    .overlay(Capsule().stroke(Pal.destructive, lineWidth: 1.5))
                            }
                            .buttonStyle(PressableButtonStyle())
                            .accessibilityIdentifier("void-record")
                            .padding(.top, 6)
                        } else {
                            Button { app.restoreRecord() } label: {
                                Text("Restore record")
                                    .font(NumaFont.system(15, weight: .semibold)).foregroundStyle(palette.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 16).padding(.vertical, 14)
                                    .frame(maxWidth: .infinity, minHeight: 50)
                                    .overlay(Capsule().stroke(palette.ink, lineWidth: 1.5))
                            }
                            .buttonStyle(PressableButtonStyle())
                        }
                    } else if r.deliveryState != .failed, r.kind == .settlement {
                        if r.flagged {
                            if app.remainingSettlementReversal(for: r) > 0 {
                                Button { app.beginSettlementReversal() } label: {
                                    Text(String(localized: "Record reversal"))
                                        .font(NumaFont.system(15, weight: .semibold))
                                        .foregroundStyle(palette.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(.horizontal, 16).padding(.vertical, 14)
                                        .frame(maxWidth: .infinity, minHeight: 50)
                                        .overlay(Capsule().stroke(palette.ink, lineWidth: 1.5))
                                }
                                .buttonStyle(PressableButtonStyle())
                                .accessibilityIdentifier("record-settlement-reversal")
                            } else {
                                Text(String(localized: "Fully reversed by linked records."))
                                    .font(NumaFont.system(13, weight: .semibold))
                                    .foregroundStyle(palette.ink2)
                            }
                        } else {
                            Button { app.flagRecord() } label: {
                                Text(String(localized: "Flag as incorrect"))
                                    .font(NumaFont.system(15, weight: .semibold)).foregroundStyle(Pal.destructive)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 16).padding(.vertical, 14)
                                    .frame(maxWidth: .infinity, minHeight: 50)
                                    .overlay(Capsule().stroke(Pal.destructive, lineWidth: 1.5))
                            }
                            .buttonStyle(PressableButtonStyle())
                        }
                    }
                }
                } else {
                    Spacer(minLength: 24)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 22).padding(.bottom, 28)
    }

    @ViewBuilder
    private func contestedComparison(for record: ExpenseRecord) -> some View {
        let heads = app.contestedHeadRevisions(for: record)
        VStack(alignment: .leading, spacing: 12) {
            Text("Two edits need your choice")
                .font(NumaFont.system(16, weight: .bold))
            Text("The later edit is applied for now. Compare both versions and choose what this record should say.")
                .font(.caption)
                .foregroundStyle(palette.ink2)
            if (record.contest?.headRevisionIDs.count ?? 0) > 2 {
                Text("More edits are waiting. Choose between these two first.")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.ink2)
            }
            if heads.count == 2 {
                contestVersionCard(
                    heads[0],
                    other: heads[1],
                    record: record,
                    index: 1
                )
                contestVersionCard(
                    heads[1],
                    other: heads[0],
                    record: record,
                    index: 2
                )
            } else {
                Text("These edits cannot be compared safely on this iPhone. Sync again before choosing.")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.ink2)
            }
        }
        .padding(14)
        .background(palette.chip, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(palette.hair))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("contested-record-comparison")
    }

    private func contestVersionCard(
        _ revision: ExpenseRevisionVersion,
        other: ExpenseRevisionVersion,
        record: ExpenseRecord,
        index: Int
    ) -> some View {
        let impacts = app.contestBalanceImpacts(
            for: record,
            choosing: revision
        )
        let isProvisional = revision.id == record.contest?.provisionalRevisionID
        return VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(isProvisional ? "Applied for now" : "Other version")
                    .font(NumaFont.mono(9.5))
                    .foregroundStyle(palette.ink3)
                Spacer()
                Text(revision.recordedBy)
                    .font(.caption.weight(.semibold))
            }
            Text(revision.title)
                .font(NumaFont.system(15, weight: .bold))
            Text(app.fmt(revision.amountCents, forceCents: true))
                .font(NumaFont.rounded(17).monospacedDigit())
            Text(localizedFormat(
                "Paid by %@",
                revision.payerDisplayName ?? "Person not recorded"
            ))
                .font(.caption)
                .foregroundStyle(palette.ink2)
            Divider().overlay(palette.hair)
            Text("Balance impact")
                .font(.caption.weight(.semibold))
            if impacts.isEmpty {
                Text("Balances stay the same.")
                    .font(.caption)
                    .foregroundStyle(palette.ink2)
            } else {
                ForEach(impacts) { impact in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.contestBalanceState(
                            impact.beforeMinorUnits,
                            for: impact.id
                        ))
                        .foregroundStyle(palette.ink2)
                        Text(app.contestBalanceState(
                            impact.afterMinorUnits,
                            for: impact.id
                        ))
                        .fontWeight(.semibold)
                    }
                    .font(.caption.monospacedDigit())
                }
            }
            Button {
                app.resolveContestedRecord(
                    choosing: revision,
                    comparedWith: other
                )
            } label: {
                Text("Use this version")
                    .font(NumaFont.system(14, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: Metrics.minTarget)
                    .background(palette.surface, in: Capsule())
                    .overlay(Capsule().stroke(palette.ink, lineWidth: 1.2))
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(app.isRecordMutationInFlight)
            .accessibilityIdentifier("contest-use-\(index)")
            .accessibilityLabel(localizedFormat(
                "Use %1$@ by %2$@",
                revision.title,
                revision.recordedBy
            ))
        }
        .padding(12)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 15))
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(palette.hair))
    }

    private func revisionHistory(for record: ExpenseRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("REVISION HISTORY")
                .font(NumaFont.mono(9.5))
                .foregroundStyle(palette.ink3)
            ForEach(record.revisionHistory.reversed()) { revision in
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(revision.title)
                            .font(.caption.weight(.semibold))
                        Text(revision.recordedBy)
                            .font(.caption2)
                            .foregroundStyle(palette.ink2)
                        Text(revision.formattedWhen())
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(palette.ink3)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(app.fmt(revision.amountCents, forceCents: true))
                            .font(.caption.monospacedDigit().weight(.semibold))
                        if revision.id == record.appliedRevisionID {
                            Text(record.contest == nil ? "Current" : "Applied for now")
                                .font(NumaFont.mono(8.5))
                                .foregroundStyle(palette.ink2)
                        } else if record.contest?.headRevisionIDs.contains(revision.id) == true {
                            Text("Needs choice")
                                .font(NumaFont.mono(8.5))
                                .foregroundStyle(palette.ink2)
                        }
                    }
                }
                .padding(.vertical, 7)
                .overlay(
                    Rectangle().fill(palette.chip).frame(height: 1),
                    alignment: .bottom
                )
            }
        }
    }

    private func kv(_ l: LocalizedStringKey, _ v: String) -> some View {
        valueLayout {
            Text(l).font(.callout).foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            if !dynamicTypeSize.isAccessibilitySize { Spacer() }
            Text(v).font(.callout.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 9)
        .overlay(Rectangle().fill(palette.chip).frame(height: 1), alignment: .bottom)
    }
}

struct ExpenseEditSheet: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette

    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            SheetGrabber(palette: palette).frame(maxWidth: .infinity)
            HStack {
                Text("Edit expense")
                    .font(.system(size: 21, weight: .bold))
                Spacer()
                CloseCircleButton(palette: palette, action: app.cancelRecordAction)
            }

            TextField("What was it?", text: $app.editTitle)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .frame(minHeight: Metrics.minTarget)
                .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
                .accessibilityIdentifier("edit-record-title")

            TextField("Category", text: $app.editCategory)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .frame(minHeight: Metrics.minTarget)
                .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
                .accessibilityIdentifier("edit-record-category")

            Text(app.displayAmount(app.editAmountInt, app.editAmountFrac))
                .font(NumaFont.rounded(36).monospacedDigit())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .accessibilityIdentifier("edit-record-amount")

            Button("Clear amount", action: app.clearExpenseEditAmount)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityIdentifier("edit-clear-amount")

            balanceImpact(app.editBalanceImpacts)

            Spacer(minLength: 0)
            AmountKeypadView(
                palette: palette,
                decimalDimmed: app.potCurrency.exponent == 0
                    || app.editAmountFrac != nil
            ) { app.editExpenseKey($0) }
            .accessibilityIdentifier("edit-record-keypad")

            PrimaryPillButton(
                title: "Save edit",
                palette: palette,
                height: 52,
                action: app.saveExpenseEdit
            )
            .disabled(!app.canSaveExpenseEdit)
            .opacity(app.canSaveExpenseEdit ? 1 : 0.45)
            .accessibilityIdentifier("save-record-edit")
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 24)
        .disabled(app.isRecordMutationInFlight)
        }
        .scrollDismissesKeyboard(.interactively)
        .interactiveDismissDisabled(app.isRecordMutationInFlight)
    }

    private func balanceImpact(
        _ impacts: [ExpenseBalanceImpact]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Balance impact")
                .font(.caption.weight(.semibold))
            if impacts.isEmpty {
                Text("Balances stay the same.")
                    .font(.caption)
                    .foregroundStyle(palette.ink2)
            } else {
                ForEach(impacts) { impact in
                    Text(
                        app.contestBalanceState(impact.beforeMinorUnits, for: impact.id)
                            + " → "
                            + app.contestBalanceState(impact.afterMinorUnits, for: impact.id)
                    )
                    .font(.caption.monospacedDigit())
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.hair))
        .accessibilityIdentifier("edit-balance-impact")
    }
}

struct VoidRecordSheet: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette

    private var hasReason: Bool {
        !app.voidReasonDraft.trimmingCharacters(
            in: .whitespacesAndNewlines
        ).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SheetGrabber(palette: palette).frame(maxWidth: .infinity)
            HStack {
                Text("Void record")
                    .font(.system(size: 21, weight: .bold))
                Spacer()
                CloseCircleButton(palette: palette, action: app.cancelRecordAction)
            }
            Text("The record stays in Activity. Its financial effect is removed and can be restored later.")
                .font(.callout)
                .foregroundStyle(palette.ink2)

            TextField(
                "Why is this record wrong?",
                text: $app.voidReasonDraft,
                axis: .vertical
            )
            .lineLimit(2 ... 4)
            .padding(14)
            .frame(minHeight: 72, alignment: .topLeading)
            .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
            .accessibilityIdentifier("void-reason")

            VStack(alignment: .leading, spacing: 8) {
                Text("Balance impact")
                    .font(.caption.weight(.semibold))
                ForEach(app.voidBalanceImpacts) { impact in
                    Text(
                        app.contestBalanceState(impact.beforeMinorUnits, for: impact.id)
                            + " → "
                            + app.contestBalanceState(impact.afterMinorUnits, for: impact.id)
                    )
                    .font(.caption.monospacedDigit())
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.hair))

            Spacer()
            PrimaryPillButton(
                title: "Confirm void",
                palette: palette,
                height: 52,
                action: app.confirmVoidRecord
            )
            .disabled(!hasReason)
            .opacity(hasReason ? 1 : 0.45)
            .accessibilityIdentifier("confirm-void-record")
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 24)
    }
}

struct SettlePlanSheet: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    Text("Record a repayment").font(NumaFont.display(30, relativeTo: .title))
                    Spacer()
                    CloseCircleButton(palette: palette, action: app.closeSheet)
                }
                Text("Money changes hands outside Numa Shared. Record it here after it was sent.")
                    .font(.body).foregroundStyle(palette.ink2)
                ForEach(Array(app.plan.enumerated()), id: \.offset) { _, step in
                    Button { app.chooseBridge(from: step.from, to: step.to, amountCents: step.amountCents) } label: {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(alignment: .top, spacing: 12) {
                                SharedIdentityMark(unit: app.unitInfo(for: step.from), background: palette.bg)
                                Text("\(app.unitInfo(for: step.from).name) pays \(app.unitInfo(for: step.to).name)")
                                    .font(.headline).fixedSize(horizontal: false, vertical: true)
                            }
                            HStack {
                                Text(app.fmt(step.amountCents)).font(.title2.weight(.semibold).monospacedDigit())
                                Spacer()
                                Label("Record", systemImage: "arrow.right").font(.subheadline.weight(.semibold))
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.vertical, 12).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(palette.hair)
                }
                Button(action: app.beginManualSettlement) {
                    Label("Record another transfer", systemImage: "plus")
                        .font(.headline).padding(.vertical, 12)
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Choose two different balance groups and record money already sent.")
                .accessibilityIdentifier("manual-settlement")
            }
            .padding(24)
        }
        .background(palette.bg)
    }
}

struct SettleAmountSheet: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette

    var body: some View {
        ScrollView { amountContent.disabled(app.isRecordMutationInFlight) }
            .background(palette.bg)
            .interactiveDismissDisabled(app.isRecordMutationInFlight)
    }

    private var amountContent: some View {
        VStack(spacing: 0) {
            SheetGrabber(palette: palette).frame(maxWidth: .infinity)
            HStack {
                Text(sheetTitle)
                    .font(NumaFont.display(30, relativeTo: .title))
                Spacer()
                Button { app.backToPlan() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13))
                        .frame(width: Metrics.minTarget, height: Metrics.minTarget)
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(String(localized: "Back"))
                .foregroundStyle(palette.ink2).background(palette.chip, in: Circle())
            }
            .padding(.top, 12)

            if app.isManualSettlement {
                manualParties
                    .padding(.top, 14)
            } else {
                HStack(alignment: .top, spacing: 12) {
                    if let from = app.settleFrom {
                        SharedIdentityMark(unit: app.unitInfo(for: from), background: palette.bg)
                        Text(app.unitInfo(for: from).name).font(.headline)
                    }
                    Image(systemName: "arrow.right").font(.body).accessibilityHidden(true)
                    Text(app.unitInfo(for: app.settleTo).name).font(.headline)
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 18)
            }

            VStack(spacing: 9) {
                HStack(spacing: 2) {
                    Text(app.displayAmount(app.sInt, app.sFrac)).font(.largeTitle.weight(.semibold).monospacedDigit())
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 20).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                Text("\(app.potCurrency.code) · fixed household currency").font(.footnote).foregroundStyle(palette.ink2)

                Button("Clear amount", action: app.clearSettlementAmount)
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("settlement-clear-amount")

                if !app.isManualSettlement {
                    HStack(spacing: 8) {
                    Button(
                        app.isRecordingSettlementReversal
                            ? localizedFormat(
                                "Full reversal %@",
                                app.fmt(app.settleDebt, forceCents: true)
                            )
                            : localizedFormat(
                                "Exact %@",
                                app.fmt(app.settleDebt, forceCents: true)
                            )
                    ) { app.useExactDebt() }
                    }
                    .font(.subheadline).foregroundStyle(palette.ink2)
                    .buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 12)

            Text(app.settlePreviewText).font(.subheadline.weight(.semibold).monospacedDigit())
                .fixedSize(horizontal: false, vertical: true).padding(.top, 10)

            if app.centsOf(app.sInt, app.sFrac) == 0 {
                Text("Enter the amount already paid.")
                    .font(.subheadline).foregroundStyle(palette.ink2)
                    .accessibilityIdentifier("settlement-amount-guidance")
            }

            if (app.isRecordingSettlementReversal || app.isManualSettlement),
               let from = app.settleFrom {
                VStack(spacing: 6) {
                    settlementImpactRow(from)
                    settlementImpactRow(app.settleTo)
                }
                .padding(10)
                .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
                .padding(.top, 8)
            }

            Text(app.isRecordingSettlementReversal
                ? String(localized: "This records a correction. The original settlement stays visible. Numa Shared moves no money.")
                : String(localized: "Record this only after the payment was made outside the app."))
                .font(.subheadline).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 14)

            AmountKeypadView(palette: palette, decimalDimmed: app.sFrac != nil) { app.sKey($0) }
                .padding(8)
                .background(palette.kpBg, in: RoundedRectangle(cornerRadius: 16))
                .padding(.top, 10)

            Spacer()

            VStack(spacing: 10) {
                PrimaryPillButton(
                    title: app.isRecordingSettlementReversal
                        ? String(localized: "Record reversal")
                        : app.isManualSettlement
                            ? String(localized: "Record transfer")
                            : String(localized: "Mark as paid"),
                    palette: palette,
                    height: 52
                ) { app.markPaid() }
                .disabled(!app.canRecordSettlement)
                .opacity(app.canRecordSettlement ? 1 : 0.45)
                .accessibilityIdentifier("save-settlement")
                if !app.isManualSettlement && !app.isRecordingSettlementReversal {
                    Button("Record another transfer", action: app.beginManualSettlement)
                        .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                        .accessibilityIdentifier("manual-settlement")
                }
                Button { app.backToPlan() } label: {
                    Text("Not yet").font(.headline).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.ink)
            }
            .padding(.bottom, 26)
        }
        .padding(.horizontal, 22)
    }

    private var sheetTitle: String {
        if app.isRecordingSettlementReversal {
            return String(localized: "Reverse flagged settlement")
        }
        if app.isManualSettlement {
            return String(localized: "Record a transfer")
        }
        return "Record a repayment"
    }

    private var manualParties: some View {
        HStack(spacing: 8) {
            partyMenu(
                title: String(localized: "From"),
                selected: app.settleFrom ?? app.currentUnitID,
                options: app.ledgerUnitIDs,
                identifier: "settlement-from",
                action: { app.selectManualSettlementFrom($0) }
            )
            Image(systemName: "arrow.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.ink2)
            partyMenu(
                title: String(localized: "To"),
                selected: app.settleTo,
                options: app.ledgerUnitIDs.filter { $0 != app.settleFrom },
                identifier: "settlement-to",
                action: { app.selectManualSettlementTo($0) }
            )
        }
    }

    private func partyMenu(
        title: String,
        selected: UnitID,
        options: [UnitID],
        identifier: String,
        action: @escaping (UnitID) -> Void
    ) -> some View {
        Menu {
            ForEach(options, id: \.self) { unitID in
                Button(app.unitInfo(for: unitID).name) { action(unitID) }
            }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: Metrics.minOrdinaryText))
                    .foregroundStyle(palette.ink3)
                HStack(spacing: 7) {
                    AvatarView(unit: app.unitInfo(for: selected), size: 28, palette: palette)
                    Text(app.unitInfo(for: selected).name)
                        .font(.body.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }
            }
            .foregroundStyle(palette.ink)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(PressableButtonStyle())
        .frame(minHeight: 44)
        .accessibilityIdentifier(identifier)
    }

    private func settlementImpactRow(_ unitID: UnitID) -> some View {
        HStack {
            Text(app.unitInfo(for: unitID).name)
            Spacer()
            Text(
                "\(app.fmt(app.balances[unitID] ?? 0, forceCents: true)) → "
                    + app.fmt(
                        app.settlementBalanceAfter(for: unitID)
                            ?? app.balances[unitID]
                            ?? 0,
                        forceCents: true
                    )
            )
            .font(NumaFont.rounded(12).monospacedDigit())
        }
        .font(.system(size: 12, weight: .semibold))
    }
}
