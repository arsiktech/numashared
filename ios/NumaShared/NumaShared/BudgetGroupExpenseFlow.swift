import NumaSharedCore
import SwiftUI

/// Entry, explicit payer choice, then an editable receipt. Draft choices stay in AppModel; only
/// its existing guarded append seam can save a record. Legacy ledgers keep
/// their original schema-1 entry path rather than acquiring new semantics.
struct BudgetGroupExpenseFlow: View {
    private enum Page: Hashable { case payer, split, details }
    private enum SplitChoice: String, CaseIterable { case equal = "Equally", exact = "Exact amounts", one = "For one group" }
    @EnvironmentObject var app: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    let palette: Pal.Palette
    @State private var path: [Page] = []
    @State private var chosePayer = false
    @State private var split: SplitChoice = .equal
    @State private var saveRequested = false
    @FocusState private var descriptionFocused: Bool
    @FocusState private var exactShareFocus: UnitID?

    var body: some View {
        NavigationStack(path: Binding(get: { path }, set: { if !saveInProgress { path = $0 } })) {
            entry
                .navigationDestination(for: Page.self) { page in
                    switch page {
                    case .payer: payer
                    case .split: allocation
                    case .details: details
                    }
                }
        }
        .interactiveDismissDisabled(saveInProgress)
        .tint(palette.ink)
        .background(palette.bg.ignoresSafeArea())
    }

    private var entry: some View {
        page(title: "Add an expense", back: app.closeAdd,
             action: "Who paid?", actionID: "expense-next-payer", enabled: app.addedAmountCents > 0,
             perform: { descriptionFocused = false; path.append(.payer) }) {
            ExpenseFlowHeading("What was it for?")
            VStack(alignment: .leading, spacing: 9) {
                Text("Description · optional").font(NumaFont.system(13)).foregroundStyle(palette.ink2)
                TextField("What was it?", text: $app.merchant)
                    .font(NumaFont.system(20))
                    .textInputAutocapitalization(.sentences).submitLabel(.done)
                    .focused($descriptionFocused)
                    .onSubmit { descriptionFocused = false }
                    .accessibilityIdentifier("expense-merchant")
                    .padding(.top, 10).padding(.bottom, 13).frame(minHeight: 44)
                    .overlay(alignment: .bottom) { Rectangle().fill(palette.ink).frame(height: 1.5) }
            }.padding(.top, 22)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 7) {
                    Text("\(currencyName) · \(app.potCurrency.code)")
                    HomeIcon(kind: .lock, size: 20)
                }.font(NumaFont.system(14, weight: .medium)).foregroundStyle(palette.ink2)
                ExpenseFlowAmount(text: app.fmt(app.addedAmountCents, forceCents: true))
                    .accessibilityIdentifier("expense-entry-amount")
                HStack {
                    Text("Paid \(dateLabel.lowercased())").font(NumaFont.system(13)).foregroundStyle(palette.ink2)
                    Spacer(minLength: 8)
                    Button { descriptionFocused = false; path.append(.details) } label: {
                        Text("Change date").font(NumaFont.system(15, weight: .semibold))
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("expense-date-details")
                }.padding(.top, 14)
            }.padding(.top, 27)
            ExpenseFlowKeypad(palette: palette, decimalEnabled: app.potCurrency.exponent > 0) { key in
                descriptionFocused = false; app.key(key)
            }.padding(.top, 16)
        }
    }

    private var payer: some View {
        page(title: "Paid by") {
            ExpenseFlowHeading("Whose money\npaid for it?")
            intro("Choose the person who actually paid the \(app.fmt(app.addedAmountCents, forceCents: true)) bill.")
            ForEach(app.payerPeople, id: \.memberID) { person in
                Button {
                    guard path.last == .payer else { return }
                    app.selectExpensePayer(person); chosePayer = true
                    if app.attached.isEmpty { app.dropAll() }
                    path.append(.split)
                } label: {
                    ExpenseFlowRow(title: app.personName(person),
                        subtitle: person.budgetUnitID.map { app.unitInfo(for: $0).name } ?? "Shared budget",
                        palette: palette) {
                            ExpenseFlowAvatars(names: [app.personName(person)],
                                color: app.unitInfo(for: person.budgetUnitID ?? person.unitID ?? app.expensePayer).color)
                        } trailing: {
                            ExpenseFlowSelection(selected: chosePayer && person.memberID == app.expensePayerMemberID, palette: palette)
                        }
                }.buttonStyle(.plain)
                    .accessibilityIdentifier("expense-payer-\(person.memberID.description)")
                    .accessibilityAddTraits(chosePayer && person.memberID == app.expensePayerMemberID ? .isSelected : [])
                    .accessibilityHint("Choose this payer and review the split.")
            }
        }
    }

    private var allocation: some View {
        page(title: "Review expense", action: "Save expense", actionID: "expense-save",
             enabled: chosePayer && app.canSaveExpense && app.canWrite && !app.isRecordMutationInFlight,
             perform: {
                 guard !saveInProgress else { return }
                 saveRequested = app.saveExpense()
             }) {
            ExpenseFlowHeading(app.merchant.isEmpty ? "Expense" : app.merchant)
            Text("\(dateLabel) · \(app.expensePayerDescription) paid · Added by you")
                .font(.body).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 13).padding(.bottom, 15)
                .accessibilityIdentifier("expense-receipt-attribution")
            ExpenseFlowAmount(text: app.fmt(app.addedAmountCents, forceCents: true))
                .accessibilityIdentifier("expense-review-amount")
            Text("Who was it for?").font(.headline).padding(.top, 24).padding(.bottom, 13)
            splitControl
            ForEach(app.expenseBeneficiaryUnitIDs, id: \.self) { unit in
                if split == .exact && app.attached.contains(unit) {
                    groupRow(unit, subtitle: "Exact share") {
                        TextField("Amount", text: Binding(get: { app.exactSplitDraft(for: unit) },
                            set: { app.updateExactSplitDraft($0, for: unit) }))
                            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                            .focused($exactShareFocus, equals: unit)
                            .font(NumaFont.system(17, weight: .semibold).monospacedDigit())
                            .frame(minWidth: 72, idealWidth: 92, maxWidth: 130, minHeight: 44)
                            .accessibilityLabel("\(app.unitInfo(for: unit).name) exact share")
                            .accessibilityIdentifier("exact-split-\(unit.rawValue)")
                    }
                } else {
                    Button { selectBeneficiary(unit) } label: {
                        groupRow(unit, subtitle: groupSubtitle(unit)) {
                            if split == .one || !app.attached.contains(unit) {
                                ExpenseFlowSelection(selected: app.attached.contains(unit), palette: palette)
                            } else {
                                Text(app.fmt(app.allocatedParts()[unit] ?? 0, forceCents: true))
                                    .font(NumaFont.system(17, weight: .semibold).monospacedDigit())
                            }
                        }
                    }.buttonStyle(.plain)
                        .accessibilityIdentifier("expense-beneficiary-\(unit.rawValue)")
                        .accessibilityAddTraits(app.attached.contains(unit) ? .isSelected : [])
                }
            }
            if split != .one && !app.attachedKeys.isEmpty {
                allocationStrip.padding(.top, 20)
                Text(split == .exact ? "Shares must add up to \(app.fmt(app.addedAmountCents, forceCents: true))."
                     : "Equal shares for \(app.attachedKeys.count) budget groups—not per person.")
                    .font(NumaFont.system(13)).foregroundStyle(palette.ink2).padding(.top, 13)
            }
            if let error = app.exactSplitErrorMessage, split == .exact {
                Text(error).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                    .padding(.top, 14).accessibilityIdentifier("exact-split-error")
            }
            if let impact = app.expenseImpactDescription { debtStrip(impact) }
            Text("You’re recording an expense, not making a payment.")
                .font(NumaFont.system(13)).foregroundStyle(palette.ink2).padding(.vertical, 14)
        }
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

    private var details: some View {
        page(title: "Expense details", action: "Keep these details", actionID: "expense-keep-details", perform: { path.removeLast() }) {
            ExpenseFlowHeading("Keep the\nuseful details.")
            DatePicker("Date paid", selection: $app.expenseDate, displayedComponents: .date)
                .font(.body).padding(.vertical, 22).accessibilityIdentifier("expense-date")
            Text("Category · optional").font(.subheadline).foregroundStyle(palette.ink2)
            TextField("Category", text: $app.category).font(.body)
                .textInputAutocapitalization(.words).padding(.vertical, 13).frame(minHeight: 44)
                .overlay(alignment: .bottom) { Rectangle().fill(palette.ink).frame(height: 1.5) }
                .accessibilityIdentifier("expense-category")
            explanation(title: "Visible to your household.",
                message: "Use the description and category for useful context. Don’t include card numbers or sensitive details.", icon: .info)
        }
    }

    private var saveInProgress: Bool { saveRequested && app.isRecordMutationInFlight }

    private var currencyName: String {
        let name = Locale(identifier: "en").localizedString(forCurrencyCode: app.potCurrency.code) ?? app.potCurrency.code
        return name.prefix(1).uppercased() + name.dropFirst()
    }
    private var dateLabel: String {
        let label = HomeReceiptRow.dateLabel(app.expenseDate, timeZoneIdentifier: TimeZone.current.identifier, now: app.homePresentationDate)
        return label.prefix(1).uppercased() + label.dropFirst()
    }
    private var splitControl: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 3) { splitButtons }.fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 3) { splitButtons }
        }
        .padding(4).background(palette.chip, in: RoundedRectangle(cornerRadius: 24))
        .padding(.bottom, 10).accessibilityIdentifier("expense-split-mode")
    }
    @ViewBuilder private var splitButtons: some View {
        ForEach(SplitChoice.allCases, id: \.self) { choice in
            Button { chooseSplit(choice) } label: {
                Text(choice.rawValue).font(NumaFont.system(13, weight: .semibold))
                    .fixedSize(horizontal: true, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 8)
                    .contentShape(Capsule()).foregroundStyle(split == choice ? palette.bg : palette.ink)
                    .background(split == choice ? palette.ink : .clear, in: Capsule())
            }.buttonStyle(.plain).accessibilityAddTraits(split == choice ? .isSelected : [])
        }
    }
    private func chooseSplit(_ choice: SplitChoice) {
        split = choice
        if choice == .one {
            let target = app.attachedKeys.first(where: { $0 != app.expensePayer })
                ?? app.expenseBeneficiaryUnitIDs.first(where: { $0 != app.expensePayer })
                ?? app.expensePayer
            app.attached = [target]
            app.selectExpenseSplitMode(.shares)
        } else {
            if app.attached.count < 2 { app.dropAll() }
            app.selectExpenseSplitMode(choice == .exact ? .exact : .shares)
        }
    }
    private func selectBeneficiary(_ unit: UnitID) {
        if split == .one { app.attached = [unit] }
        else { app.toggleUnit(unit) }
    }
    private func groupSubtitle(_ unit: UnitID) -> String {
        guard app.attached.contains(unit) else { return "Not included" }
        if split == .one { return "Full amount · \(app.fmt(app.addedAmountCents, forceCents: true))" }
        return "\(app.memberProfiles.filter { $0.budgetUnitID == unit }.count) people · one budget"
    }
    private func groupRow<Trailing: View>(_ unit: UnitID, subtitle: String, @ViewBuilder trailing: @escaping () -> Trailing) -> some View {
        ExpenseFlowRow(title: app.unitInfo(for: unit).name, subtitle: subtitle, palette: palette) {
            ExpenseFlowAvatars(names: app.memberProfiles.filter { $0.budgetUnitID == unit }.map(app.personName), color: app.unitInfo(for: unit).color)
        } trailing: { trailing() }
    }
    private var allocationStrip: some View {
        GeometryReader { proxy in
            let parts = app.allocatedParts()
            let keys = app.attachedKeys
            HStack(spacing: 3) {
                ForEach(keys, id: \.self) { unit in
                    RoundedRectangle(cornerRadius: 2).fill(app.unitInfo(for: unit).color)
                        .frame(width: max(0, proxy.size.width - CGFloat(max(0, keys.count - 1) * 3))
                            * CGFloat(parts[unit] ?? 0) / CGFloat(max(1, app.addedAmountCents)))
                }
            }
        }.frame(height: 9).accessibilityHidden(true)
    }
    private func intro(_ text: String) -> some View {
        Text(text).font(.body).foregroundStyle(palette.ink2)
            .fixedSize(horizontal: false, vertical: true).padding(.top, 13).padding(.bottom, 26)
    }
    private func debtStrip(_ text: String) -> some View {
        HStack(spacing: 9) {
            HomeIcon(kind: .swap, size: 20)
            Text(text).font(NumaFont.system(14)).fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 14).padding(.horizontal, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.home, in: RoundedRectangle(cornerRadius: 14)).padding(.top, 24)
            .accessibilityIdentifier("expense-impact")
    }
    private func explanation(title: String, message: String, icon: HomeIcon.Kind) -> some View {
        HStack(alignment: .top, spacing: 11) {
            HomeIcon(kind: icon)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(NumaFont.system(13, weight: .semibold))
                Text(message).font(NumaFont.system(13)).lineSpacing(3)
            }.fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 17).padding(.horizontal, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.chip, in: RoundedRectangle(cornerRadius: 14)).padding(.vertical, 20)
    }
    private func page<Content: View>(title: String, back: (() -> Void)? = nil,
        action: String? = nil, actionID: String = "", enabled: Bool = true,
        perform: @escaping () -> Void = {},
        @ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    Button { if let back { back() } else { path.removeLast() } } label: {
                        HomeIcon(kind: .back).frame(width: 44, height: 44)
                            .background(palette.chip, in: Circle()).contentShape(Circle())
                    }.buttonStyle(.plain).accessibilityLabel("Back").accessibilityIdentifier("expense-back-\(title)")
                    Spacer(minLength: 0)
                    Text(title).font(NumaFont.system(15, weight: .semibold))
                    Spacer(minLength: 0)
                    Button(action: app.closeAdd) {
                        HomeIcon(kind: .close).frame(width: 44, height: 44)
                            .background(palette.chip, in: Circle()).contentShape(Circle())
                    }.buttonStyle(.plain).accessibilityLabel("Cancel expense").accessibilityIdentifier("expense-cancel")
                }.frame(minHeight: 59).padding(.bottom, 12)
                content()
            }.padding(.horizontal, 25).padding(.bottom, 20)
        }
        .accessibilityIdentifier("expense-page-\(title)")
        .disabled(saveInProgress)
        .scrollDismissesKeyboard(.interactively)
        .background(palette.bg.ignoresSafeArea()).foregroundStyle(palette.ink)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom) {
            if let action {
                Button(action: perform) {
                HStack(spacing: 10) {
                    Text(action).font(NumaFont.system(16, weight: .semibold))
                    HomeIcon(kind: .arrow)
                }.fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 56).padding(.vertical, typeSize.isAccessibilitySize ? 8 : 0)
                    .contentShape(Capsule()).foregroundStyle(enabled ? palette.bg : palette.ink2)
                    .background(enabled ? palette.ink : palette.chip, in: Capsule())
                }.buttonStyle(.plain).disabled(!enabled || saveInProgress).accessibilityIdentifier(actionID)
                    .padding(.horizontal, 25).padding(.top, 12).background(palette.bg)
            }
        }
    }
}

private struct ExpenseFlowHeading: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        ViewThatFits(in: .horizontal) {
            if typeSize == .large {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                        Text(line).font(NumaFont.display(37, relativeTo: .largeTitle)).tracking(-1.2)
                            .fixedSize(horizontal: true, vertical: true)
                            .offset(y: -NumaFont.referenceLeadingInset(size: 37, lineHeight: 38.85))
                            .frame(height: 38.85, alignment: .top)
                    }
                }
            }
            Text(text).font(NumaFont.display(37, relativeTo: .largeTitle)).tracking(-1.2)
                .fixedSize(horizontal: false, vertical: true)
        }.accessibilityElement(children: .ignore).accessibilityLabel(text).accessibilityAddTraits(.isHeader)
    }
}
private struct ExpenseFlowAmount: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let text: String
    var body: some View {
        ViewThatFits(in: .horizontal) {
            if typeSize == .large {
                amount.fixedSize(horizontal: true, vertical: true)
                    .offset(y: -NumaFont.referenceLeadingInset(size: 69, lineHeight: 75.9))
                    .frame(height: 75.9, alignment: .top)
            }
            amount.fixedSize(horizontal: false, vertical: true)
        }.accessibilityElement(children: .ignore).accessibilityLabel("Total amount, \(text)")
    }
    private var amount: Text {
        if text.hasPrefix("€") {
            Text("\(Text("€").font(NumaFont.display(37)).baselineOffset(12).kerning(1.7))\(Text(String(text.dropFirst())).font(NumaFont.display(69)).tracking(-2.3))")
        } else { Text(text).font(NumaFont.display(69)).tracking(-2.3) }
    }
}
private struct ExpenseFlowAvatars: View {
    let names: [String]
    let color: Color
    @ScaledMetric(relativeTo: .body) private var size = 42.0
    var body: some View {
        HStack(spacing: -9) {
            ForEach(Array(names.prefix(2).enumerated()), id: \.offset) { _, name in
                Text(String(name.prefix(1)).uppercased()).font(NumaFont.display(17, relativeTo: .body))
                    .foregroundStyle(Pal.light.identityInk).frame(width: size, height: size)
                    .background(color, in: Circle())
            }
        }.accessibilityHidden(true)
    }
}
private struct ExpenseFlowSelection: View {
    let selected: Bool
    let palette: Pal.Palette
    var body: some View {
        Circle().fill(selected ? palette.ink : .clear).frame(width: 23, height: 23)
            .overlay(Circle().stroke(selected ? palette.ink : palette.ink2, lineWidth: 1.5))
            .overlay { if selected { HomeIcon(kind: .check, size: 15).foregroundStyle(palette.bg) } }
            .accessibilityHidden(true)
    }
}
private struct ExpenseFlowRow<Leading: View, Trailing: View>: View {
    let title: String
    let subtitle: String
    let palette: Pal.Palette
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 13) {
                leading()
                labels
                Spacer(minLength: 8)
                trailing().fixedSize(horizontal: true, vertical: true)
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 13) { leading(); labels }
                trailing()
            }
        }
        .padding(.vertical, 16).frame(maxWidth: .infinity, minHeight: 72, alignment: .leading).contentShape(Rectangle())
        .overlay(alignment: .bottom) { Rectangle().fill(palette.hair).frame(height: 1) }
    }
    private var labels: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(NumaFont.system(16, weight: .semibold))
            Text(subtitle).font(NumaFont.system(13)).foregroundStyle(palette.ink2)
        }.fixedSize(horizontal: false, vertical: true)
    }
}
private struct ExpenseFlowKeypad: View {
    let palette: Pal.Palette
    let decimalEnabled: Bool
    let action: (String) -> Void
    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 5), count: 3), spacing: 5) {
            ForEach(["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"], id: \.self) { key in
                Button { action(key) } label: {
                    Group {
                        if key == "⌫" { HomeIcon(kind: .delete, size: 24) }
                        else { Text(key == "." ? (Locale.current.decimalSeparator ?? ".") : key).font(NumaFont.system(27)) }
                    }.frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(key == "." && !decimalEnabled)
                    .accessibilityLabel(key == "⌫" ? "Delete digit" : key)
            }
        }.foregroundStyle(palette.ink).padding(.horizontal, -6)
    }
}
