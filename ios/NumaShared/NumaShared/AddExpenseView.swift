import SwiftUI

struct AddExpenseView: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette
    var body: some View {
        if app.usesBudgetGroups { BudgetGroupExpenseFlow(palette: palette) }
        else { LegacyAddExpenseView(palette: palette) }
    }
}

private struct LegacyAddExpenseView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let palette: Pal.Palette
    @State private var showPeoplePicker = false
    @State private var invalidShakes = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("New expense").font(NumaFont.display(30, relativeTo: .title))
                    Spacer()
                    CloseCircleButton(palette: palette, action: app.closeAdd)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(app.displayAmount(app.amountInt, app.amountFrac))
                        .font(.largeTitle.weight(.semibold).monospacedDigit())
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("expense-entry-amount")
                    Label("\(app.potCurrency.code) · fixed for \(app.potName)", systemImage: "lock")
                        .font(.footnote).foregroundStyle(palette.ink2)
                }
                ExpenseDetailsEditor(palette: palette)
                Button { showPeoplePicker = true } label: {
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(app.usesBudgetGroups ? "Benefiting groups" : "Who shared it?")
                                .font(.body.weight(.semibold))
                            Text(app.attachedKeys.isEmpty ? "Choose who it was for" : app.attachedKeys.map { app.unitInfo(for: $0).name }.joined(separator: " · "))
                                .font(.subheadline).foregroundStyle(palette.ink2)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.subheadline)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityIdentifier("choose-expense-people")
                Divider().overlay(palette.hair)
                PrimaryPillButton(title: "Review split →", palette: palette) {
                    if app.canReviewSplit { app.openSplitPreview() }
                    else {
                        Haptics.warned()
                        if !reduceMotion { withAnimation(.linear(duration: 0.3)) { invalidShakes += 1 } }
                    }
                }
                .modifier(ShakeEffect(animatableData: CGFloat(invalidShakes)))
                AmountKeypadView(palette: palette, decimalDimmed: app.potCurrency.exponent == 0 || app.amountFrac != nil) { app.key($0) }
            }
            .padding(.horizontal, 24).padding(.top, 10).padding(.bottom, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.bg.ignoresSafeArea()).foregroundStyle(palette.ink)
        .accessibilityHidden(showPeoplePicker || app.showSplitPreview)
        .sheet(isPresented: $app.showSplitPreview) { SplitPreviewView(palette: palette) }
        .sheet(isPresented: $showPeoplePicker) { ExpensePeoplePicker(palette: palette) }
        .onAppear { Haptics.prepare() }
    }
}

private struct ExpensePeoplePicker: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    let palette: Pal.Palette

    var body: some View {
        NavigationStack {
            List {
                Button { app.dropAll() } label: {
                    Text(String(localized: "Everyone"))
                        .font(.body.weight(.semibold))
                        .foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("expense-people-everyone")

                ForEach(app.expenseBeneficiaryUnitIDs, id: \.self) { unitID in
                    Button { app.toggleUnit(unitID) } label: {
                        HStack(spacing: 12) {
                            Circle()
                                .fill(app.unitInfo(for: unitID).color)
                                .frame(width: 12, height: 12)
                                .accessibilityHidden(true)
                            Text(app.unitInfo(for: unitID).name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(palette.ink)
                            Spacer()
                            Image(systemName: app.attached.contains(unitID) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(palette.ink)
                                .accessibilityHidden(true)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(
                        app.attached.contains(unitID)
                            ? String(localized: "Selected")
                            : String(localized: "Not selected")
                    )
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.bg)
            .navigationTitle(app.usesBudgetGroups ? "Benefiting groups" : "Who shared it?")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                PrimaryPillButton(title: String(localized: "Done"), palette: palette) { dismiss() }
                    .accessibilityIdentifier("expense-people-done")
                    .padding(.horizontal, 22)
                    .padding(.vertical, 12)
                    .background(palette.bg)
            }
        }
        .presentationDetents(app.usesBudgetGroups ? [.large] : [.medium, .large])
    }
}

private struct ExpenseDetailsEditor: View {
    private enum Focus: Hashable {
        case merchant
        case category
    }

    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette
    @FocusState private var focus: Focus?

    private var suggestions: [(title: String, category: String)] {
        var seen = Set<String>()
        return app.liveRecords
            .filter { $0.kind == .expense || $0.kind == .personal }
            .sorted { $0.sortOrdinal > $1.sortOrdinal }
            .compactMap { record -> (title: String, category: String)? in
                let title = record.title.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty, seen.insert(title).inserted else { return nil }
                return (title, record.category ?? "")
            }
            .prefix(3)
            .map { $0 }
    }

    var body: some View {
        VStack(spacing: 9) {
            merchantField
            suggestionsRow
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { payerMenu; categoryField }
                VStack(alignment: .leading, spacing: 10) { payerMenu; categoryField }
            }
        }
    }

    private var merchantField: some View {
        TextField("What was it?", text: $app.merchant)
            .font(.body.weight(.semibold))
            .foregroundStyle(palette.ink)
            .textInputAutocapitalization(.sentences)
            .submitLabel(.next)
            .focused($focus, equals: .merchant)
            .onSubmit { focus = .category }
            .accessibilityIdentifier("expense-merchant")
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(alignment: .bottom) { Rectangle().fill(palette.hair).frame(height: 1) }
    }

    private var suggestionsRow: some View {
        Group {
            if !suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 7) {
                        ForEach(suggestions, id: \.title) { suggestion in
                            Button {
                                app.merchant = suggestion.title
                                app.category = suggestion.category
                                focus = nil
                            } label: {
                                Text(suggestion.title)
                                    .font(.subheadline)
                                    .foregroundStyle(palette.ink)
                                    .padding(.horizontal, 13)
                                    .padding(.vertical, 7).frame(minHeight: 44).contentShape(Capsule())
                                    .background(palette.surface, in: Capsule())
                                    .overlay(Capsule().stroke(palette.hair))
                            }
                            .buttonStyle(PressableButtonStyle())
                        }
                    }
                }
            }
        }
    }

    private var payerMenu: some View {
        Menu {
            if app.usesBudgetGroups {
                ForEach(app.payerPeople, id: \.memberID) { person in
                    Button(app.personName(person)) { app.selectExpensePayer(person) }
                }
            } else {
                ForEach(app.expenseBeneficiaryUnitIDs, id: \.self) { unitID in
                    Button(app.unitInfo(for: unitID).name) { app.expensePayer = unitID }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Circle().fill(app.unitInfo(for: app.expensePayer).color)
                    .frame(width: 12, height: 12).accessibilityHidden(true)
                Text(payerLabel)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9))
            }
            .foregroundStyle(palette.ink)
            .padding(.horizontal, 13)
            .padding(.vertical, 6).frame(minHeight: 44).contentShape(Capsule())
            .overlay(Capsule().stroke(palette.hair))
        }
        .buttonStyle(PressableButtonStyle())
        .frame(minHeight: 44)
        .accessibilityIdentifier("expense-payer")
        .accessibilityHint("Choose the person who actually paid, not necessarily the person recording.")
    }

    private var categoryField: some View {
        TextField("Category", text: $app.category)
            .font(.subheadline)
            .textInputAutocapitalization(.words)
            .submitLabel(.done)
            .focused($focus, equals: .category)
            .onSubmit { focus = nil }
            .padding(.horizontal, 13)
            .padding(.vertical, 8).frame(minHeight: 44)
            .background(palette.chip, in: Capsule())
            .overlay(Capsule().stroke(palette.hair))
            .accessibilityIdentifier("expense-category")
    }

    private var payerLabel: String {
        "Paid by \(app.expensePayerDescription)"

    }
}

struct SplitPreviewView: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var exactShareFocus: UnitID?

    var body: some View {
        NavigationStack {
            Group {
                if dynamicTypeSize.isAccessibilitySize { ScrollView { reviewContent }.presentationDetents([.large]) }
                else { reviewContent }
            }
            .toolbar(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    if exactShareFocus != nil {
                        Spacer()
                        Button(String(localized: "Done")) { exactShareFocus = nil }
                            .accessibilityIdentifier("expense-exact-done")
                    }
                }
            }
        }
    }

    private var reviewContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            SheetGrabber(palette: palette).frame(maxWidth: .infinity)
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(app.merchant.isEmpty ? "Expense" : app.merchant) — \(app.fmt(app.addedAmountCents, forceCents: true))")
                        .font(NumaFont.display(28, relativeTo: .title2))
                        .accessibilityIdentifier("expense-split-title")
                    Text("Paid by \(app.expensePayerDescription) · today")
                        .font(.subheadline).foregroundStyle(palette.ink2)
                }
                Spacer()
                CloseCircleButton(palette: palette) { app.closeSplitPreview(); dismiss() }
                    .accessibilityIdentifier("expense-split-close")
            }

            Picker(
                String(localized: "Split method"),
                selection: Binding(
                    get: { app.expenseSplitMode },
                    set: { mode in app.selectExpenseSplitMode(mode) }
                )
            ) {
                Text(app.usesBudgetGroups ? "Equal per group" : "Shares").tag(ExpenseSplitMode.shares)
                Text(String(localized: "Exact amounts")).tag(ExpenseSplitMode.exact)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("expense-split-mode")

            if app.attachedKeys.count == 1 && app.attachedKeys[0] != app.expensePayer {
                Text(localizedFormat(
                    "Personal charge — %@ owes %@ the full amount.",
                    app.unitInfo(for: app.attachedKeys[0]).name,
                    app.unitInfo(for: app.expensePayer).name
                ))
                .font(.subheadline)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.chip, in: RoundedRectangle(cornerRadius: 14))
            }

            let keys = app.attachedKeys
            let parts = app.allocatedParts()
            let totalShares = max(1, keys.reduce(0) { $0 + (app.shares[$1] ?? 1) })
            if keys.count > 4 {
                ScrollView {
                    allocationRows(keys: keys, parts: parts, totalShares: totalShares)
                }
                .scrollIndicators(.visible)
                .frame(maxHeight: 390)
            } else {
                allocationRows(keys: keys, parts: parts, totalShares: totalShares)
            }

            if let error = app.exactSplitErrorMessage {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(palette.ink)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.chip, in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("exact-split-error")
            }

            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 16))
                Text("Adds up to \(app.fmt(app.addedAmountCents, forceCents: true)) · paid by \(app.expensePayerDescription)")
                    .font(.subheadline)
            }
            .padding(9).padding(.horizontal, 5)
            .background(palette.chip, in: RoundedRectangle(cornerRadius: 12))

            PrimaryPillButton(title: app.attachedKeys.count == 1 && app.attachedKeys[0] != app.expensePayer
                ? String(localized: "Save personal charge")
                : String(localized: "Save expense"),
                               palette: palette, height: 52) {
                app.saveExpense()
            }
            .disabled(!app.canSaveExpense)
            .opacity(app.canSaveExpense ? 1 : 0.45)
        }
        .padding(.horizontal, 22).padding(.bottom, 26)
        .presentationDetents(
            (app.usesBudgetGroups || app.attachedKeys.count > 4 || app.expenseSplitMode == .exact)
                ? [.large] : [.medium, .large]
        )
        .presentationDragIndicator(.hidden)
        .background(palette.bg)
        .foregroundStyle(palette.ink)
    }

    private func allocationRows(
        keys: [UnitID],
        parts: [UnitID: Int64],
        totalShares: Int64
    ) -> some View {
        VStack(spacing: 0) {
            ForEach(keys, id: \.self) { unitID in
                SplitAllocationRow(
                    unitID: unitID,
                    part: parts[unitID] ?? 0,
                    totalShares: totalShares,
                    palette: palette,
                    exactShareFocus: $exactShareFocus
                )
                Divider().overlay(palette.chip)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 1.0), value: app.shares)
    }
}

private struct SplitAllocationRow: View {
    @EnvironmentObject var app: AppModel
    let unitID: UnitID
    let part: Int64
    let totalShares: Int64
    let palette: Pal.Palette
    let exactShareFocus: FocusState<UnitID?>.Binding

    var body: some View {
        HStack(spacing: 11) {
            SharedIdentityMark(unit: unit, background: palette.bg)
            VStack(alignment: .leading, spacing: 1) {
                Text(unit.name)
                    .font(.body.weight(.semibold))
                Text(detail)
                    .font(.system(size: Metrics.minOrdinaryText))
                    .foregroundStyle(palette.ink3)
            }
            Spacer()
            if app.expenseSplitMode == .shares {
                if !app.usesBudgetGroups { shareControls }
                Text(app.fmt(part, forceCents: true))
                    .font(.body.monospacedDigit())
                    .fixedSize(horizontal: true, vertical: false)
            } else {
                exactControls
            }
        }
        .padding(.vertical, 10)
    }

    private var unit: UnitInfo { app.unitInfo(for: unitID) }

    private var detail: String {
        if app.expenseSplitMode == .exact {
            return app.lockedExactUnits.contains(unitID)
                ? String(localized: "Locked")
                : String(localized: "Open")
        }
        let share = app.shares[unitID] ?? 1
        let percent = Int((100 * Double(share) / Double(max(1, totalShares))).rounded())
        return localizedFormat(
            share == 1 ? "%1$lld share · %2$lld%%" : "%1$lld shares · %2$lld%%",
            share,
            Int64(percent)
        )
    }

    private var shareControls: some View {
        HStack(spacing: 0) {
            Button { app.bumpShare(unitID, by: -1) } label: {
                Image(systemName: "minus")
                    .frame(width: Metrics.minTarget, height: Metrics.minTarget)
            }
            .buttonStyle(PressableButtonStyle(scale: 0.94))
            Text("\(app.shares[unitID] ?? 1)")
                .font(.system(size: 13, weight: .semibold).monospacedDigit())
                .frame(width: 22)
            Button { app.bumpShare(unitID, by: 1) } label: {
                Image(systemName: "plus")
                    .frame(width: Metrics.minTarget, height: Metrics.minTarget)
            }
            .buttonStyle(PressableButtonStyle(scale: 0.94))
        }
        .overlay(Capsule().stroke(palette.hair))
    }

    private var exactControls: some View {
        HStack(spacing: 4) {
            Button { app.toggleExactSplitLock(unitID) } label: {
                Image(systemName: app.lockedExactUnits.contains(unitID) ? "lock.fill" : "lock.open")
                    .frame(width: Metrics.minTarget, height: Metrics.minTarget)
                    .foregroundStyle(palette.ink)
            }
            .buttonStyle(PressableButtonStyle(scale: 0.94))
            .accessibilityLabel(
                app.lockedExactUnits.contains(unitID)
                    ? String(localized: "Unlock amount")
                    : String(localized: "Lock amount")
            )
            TextField(
                String(localized: "Amount"),
                text: Binding(
                    get: { app.exactSplitDraft(for: unitID) },
                    set: { app.updateExactSplitDraft($0, for: unitID) }
                )
            )
            .keyboardType(.decimalPad)
            .focused(exactShareFocus, equals: unitID)
            .multilineTextAlignment(.trailing)
            .font(NumaFont.rounded(14.5).monospacedDigit())
            .padding(.horizontal, 10)
            .frame(width: 92, height: Metrics.minTarget)
            .background(palette.chip, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.hair))
            .accessibilityIdentifier("exact-split-\(unitID.rawValue)")
        }
    }
}
