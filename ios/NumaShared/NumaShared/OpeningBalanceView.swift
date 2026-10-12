import SwiftUI

struct OpeningBalanceView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.locale) private var locale
    let palette: Pal.Palette

    @State private var groupTexts: [UnitID: String] = [:]
    @State private var groupRelations: [UnitID: OpeningBalanceRelation] = [:]

    @State private var samText = ""
    @State private var leoText = ""
    @State private var samRelation = OpeningBalanceRelation.owesHousehold
    @State private var leoRelation = OpeningBalanceRelation.owesHousehold

    private var entries: [UnitID: Int64]? {
        if app.usesBudgetGroups {
            return AppModel.groupOpeningBalanceEntries(texts: groupTexts, relations: groupRelations,
                units: app.activeBudgetUnitIDs, owner: app.currentUnitID, locale: locale, currency: app.potCurrency)
        }
        return AppModel.openingBalanceEntries(
            samText: samText,
            samRelation: samRelation,
            leoText: leoText,
            leoRelation: leoRelation,
            locale: locale,
            currency: app.potCurrency
        )
    }

    private var canSave: Bool {
        entries?.values.contains(where: { $0 != 0 }) == true
            && !app.isSavingOpeningBalance
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                CloseCircleButton(
                    palette: palette,
                    action: app.skipOpeningBalance
                )
                Spacer()
                Button(String(localized: "Skip"), action: app.skipOpeningBalance)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(palette.ink2)
                    .frame(minHeight: Metrics.minTarget)
                    .buttonStyle(PressableButtonStyle())
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(String(localized: "Opening balances"))
                            .font(.title.bold())
                            .foregroundStyle(palette.ink)
                        Text(String(localized: "Add only what was already owed before this pot. Your budget group amount is calculated so the pot stays exactly balanced."))
                            .font(.body)
                            .foregroundStyle(palette.ink2)
                    }

                    ForEach(app.usesBudgetGroups ? app.activeBudgetUnitIDs.filter { $0 != app.currentUnitID } : app.setupPersonUnits, id: \.self) { unitID in
                        balanceRow(
                            unitID: unitID,
                            text: amountBinding(for: unitID),
                            relation: relationBinding(for: unitID)
                        )
                    }
                    householdPreview

                    if let error = app.openingBalanceErrorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(palette.ink2)
                            .accessibilityLabel(
                                localizedFormat("Opening balance error: %@", error)
                            )
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(palette.bg)
        .safeAreaInset(edge: .bottom) {
            PrimaryPillButton(
                title: app.isSavingOpeningBalance
                    ? String(localized: "Saving")
                    : String(localized: "Save opening balances"),
                palette: palette
            ) {
                if app.usesBudgetGroups, let entries { app.saveBudgetGroupOpeningBalance(entries: entries) }
                else { app.saveOpeningBalance(
                    samText: samText,
                    samRelation: samRelation,
                    leoText: leoText,
                    leoRelation: leoRelation,
                    locale: locale
                ) }
            }
            .disabled(!canSave)
            .opacity(canSave ? 1 : 0.5)
            .accessibilityIdentifier("save-opening-balances")
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .background(palette.bg)
        }
    }

    private func amountBinding(for unitID: UnitID) -> Binding<String> {
        if app.usesBudgetGroups {
            return Binding(get: { groupTexts[unitID] ?? "" }, set: { groupTexts[unitID] = $0 })
        }
        return unitID == .sam ? $samText : $leoText
    }

    private func relationBinding(
        for unitID: UnitID
    ) -> Binding<OpeningBalanceRelation> {
        if app.usesBudgetGroups {
            return Binding(get: { groupRelations[unitID] ?? .owesHousehold }, set: { groupRelations[unitID] = $0 })
        }
        return unitID == .sam ? $samRelation : $leoRelation
    }

    private func balanceRow(
        unitID: UnitID,
        text: Binding<String>,
        relation: Binding<OpeningBalanceRelation>
    ) -> some View {
        let name = app.unitInfo(for: unitID).name
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                AvatarView(
                    unit: app.unitInfo(for: unitID),
                    size: 38,
                    palette: palette
                )
                Text(name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.ink)
                Spacer()
                TextField(inputPlaceholder, text: text)
                    .keyboardType(app.potCurrency.exponent == 0 ? .numberPad : .decimalPad)
                    .multilineTextAlignment(.trailing)
                    .font(NumaFont.rounded(17).monospacedDigit())
                    .foregroundStyle(palette.ink)
                    .frame(width: 112)
                    .frame(minHeight: 44)
                    .padding(.horizontal, 12)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.hair))
                    .accessibilityLabel(localizedFormat("Amount for %@", name))
                    .accessibilityIdentifier("opening-\(unitID.rawValue)-amount")
            }
            Button {
                relation.wrappedValue = switch relation.wrappedValue {
                case .owesHousehold: .householdOwesMember
                case .householdOwesMember: .owesHousehold
                }
            } label: {
                HStack {
                    Text(relationCopy(name: name, relation: relation.wrappedValue))
                    Spacer()
                    Image(systemName: "arrow.left.arrow.right")
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.ink2)
                .frame(minHeight: Metrics.minTarget)
                .padding(.horizontal, 13)
                .background(palette.chip, in: Capsule())
                .overlay(Capsule().stroke(palette.hair))
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityIdentifier("opening-\(unitID.rawValue)-direction")
            .accessibilityHint(String(localized: "Double-tap to reverse who owed whom."))
        }
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(palette.hair))
    }

    private var householdPreview: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(String(localized: "Your budget group starts"))
                .font(.caption)
                .foregroundStyle(palette.ink2)
            Text(householdState)
                .font(NumaFont.rounded(20, weight: .semibold).monospacedDigit())
                .foregroundStyle(palette.ink)
                .accessibilityIdentifier("opening-household-preview")
            Text(String(localized: "This only records the starting balances."))
                .font(.caption)
                .foregroundStyle(palette.ink3)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.chip, in: RoundedRectangle(cornerRadius: 18))
    }

    private var householdState: String {
        guard let amount = entries?[app.usesBudgetGroups ? app.currentUnitID : .am] else {
            return String(localized: "Check the amounts")
        }
        if amount > 0 {
            return localizedFormat(
                "gets back %@",
                app.fmtMagnitude(amount)
            )
        }
        if amount < 0 {
            return localizedFormat(
                "owes %@",
                app.fmtMagnitude(amount)
            )
        }
        return String(localized: "even")
    }

    private func relationCopy(
        name: String,
        relation: OpeningBalanceRelation
    ) -> String {
        switch relation {
        case .owesHousehold:
            localizedFormat("%@ owed your budget group", name)
        case .householdOwesMember:
            localizedFormat("Your budget group owed %@", name)
        }
    }

    private var inputPlaceholder: String {
        guard app.potCurrency.exponent > 0 else { return "0" }
        return "0." + String(repeating: "0", count: app.potCurrency.exponent)
    }
}
