import NumaSharedCore
import SwiftUI

/// The approved welcome is a promise, not a gesture tutorial. All actions are
/// explicit; the decorative sphere never creates a purchase or a membership.
struct WelcomeView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let palette: Pal.Palette

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("numa").font(NumaFont.display(45)).tracking(-1.7)
                        Text("shared").font(Font.subheadline.weight(.medium))
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Numa Shared")
                    .padding(.top, 10)

                    welcomeHeading.padding(.top, 30)
                    Text(typeSize == .large ? "Keep the shared bills simple.\nGet back to living together." : "Keep the shared bills simple. Get back to living together.")
                        .font(.body).lineSpacing(4)
                        .foregroundStyle(secondary)
                        .frame(maxWidth: typeSize == .large ? 260 : .infinity, alignment: .leading)
                        .padding(.vertical, typeSize == .large ? 2 : 0)
                        .padding(.top, 22)
                    welcomeIllustration
                        .padding(.top, 15)
                    Spacer(minLength: 30)
                    actions
                        .padding(.bottom, 0)
                }
                .foregroundStyle(palette.ink)
                .padding(.horizontal, 25)
                .frame(minHeight: proxy.size.height, alignment: .top)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(palette.home.ignoresSafeArea())
    }

    private var secondary: Color { palette.isDark ? palette.ink2 : Color(hex: 0x5B5237) }

    private var welcomeHeading: some View {
        Group {
            if typeSize == .large {
                ViewThatFits(in: .horizontal) {
                    welcomeLines(["Good company.", "Clear money."])
                    welcomeLines(["Good", "company.", "Clear money."])
                    naturalWelcomeHeading
                }
            } else { naturalWelcomeHeading }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Good company. Clear money.")
        .accessibilityIdentifier("welcome-headline")
        .accessibilityAddTraits(.isHeader)
    }

    private var naturalWelcomeHeading: some View {
        Text("Good company.\nClear money.")
            .font(NumaFont.display(53)).tracking(-1.75)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func welcomeLines(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(lines, id: \.self) { line in
                Text(line).font(NumaFont.display(53)).tracking(-1.75)
                    .fixedSize()
                    .offset(y: -NumaFont.referenceLeadingInset(size: 53, lineHeight: 52.47))
                    .frame(height: 52.47, alignment: .top)
            }
        }
    }

    private var welcomeIllustration: some View {
        GeometryReader { geometry in
            ZStack {
                Ellipse().stroke(Color(hex: 0x9A874A).opacity(0.4), lineWidth: 1.5)
                    .frame(width: min(306, geometry.size.width - 20), height: 143)
                    .rotationEffect(.degrees(-27))
                VesselView(palette: palette, size: 171, reduceTransparency: reduceTransparency)
                    .rotationEffect(.degrees(-9))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topLeading) {
                welcomeGroup("You + Sam", color: Pal.teal)
                    .rotationEffect(.degrees(-9)).padding(.top, 21)
            }
            .overlay(alignment: .topTrailing) {
                welcomeGroup("Alex + Jo", color: Pal.purple)
                    .rotationEffect(.degrees(9)).padding(.top, 177)
            }
        }
        .frame(height: typeSize.isAccessibilitySize ? 270 : 245)
        .accessibilityHidden(true)
    }

    private func welcomeGroup(_ name: String, color: Color) -> some View {
        Text(name).font(.custom("BricolageGrotesque-Bold", fixedSize: 17))
            .foregroundStyle(palette.identityInk)
            .padding(.horizontal, 17).padding(.vertical, 11)
            .background(color, in: Capsule())
            .shadow(color: Color(hex: 0x4B4727).opacity(0.1), radius: 7.5, y: 5)
    }

    private var actions: some View {
        VStack(spacing: 4) {
            Button(action: app.goCreate) {
                HStack(spacing: 10) {
                    Text("Create our home")
                    HomeIcon(kind: .arrow, size: 20)
                }
                .font(Font.callout.weight(.semibold)).tracking(-0.2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20).padding(.vertical, 15)
                .frame(maxWidth: .infinity, minHeight: 56)
                .foregroundStyle(palette.isDark ? palette.bg : .white)
                .background(palette.ink, in: Capsule())
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityIdentifier("create-pot")
#if DEBUG
            .accessibilityValue(app.qaLaunchReadyMilliseconds.map(String.init) ?? "pending")
#endif
            Button(action: app.beginJoin) {
                Text("I have an invite")
                    .font(Font.callout.weight(.semibold)).tracking(-0.2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, minHeight: 45)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityIdentifier("join-pot")
            Text("No bank connection. No money moved.")
                .font(Font.footnote).foregroundStyle(secondary)
                .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.center)
                .frame(maxWidth: typeSize == .large ? 260 : .infinity)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 1.5).padding(.top, 6)
        }
    }
}

struct CreatePotView: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette
    @FocusState private var nameFocused: Bool
    @State private var currencyPickerPresented = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SetupNavigation(title: "Create a home", palette: palette, back: app.goWelcome)
                SetupProgress(step: 1, palette: palette)
                SetupHeading("Make yourself\nat home.", palette: palette)
                Text("A shared space for your household’s expenses.")
                    .font(Font.callout).foregroundStyle(palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 1.8).padding(.top, 13).padding(.bottom, 26)
                VStack(alignment: .leading, spacing: 9) {
                    Text("Household name").font(Font.footnote).foregroundStyle(palette.ink2)
                    TextField("Household name", text: $app.potName)
                        .font(Font.title3).foregroundStyle(palette.ink)
                        .textInputAutocapitalization(.words).focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit { nameFocused = false }
                        .padding(.top, 10).padding(.bottom, 13)
                        .overlay(alignment: .bottom) { Rectangle().fill(palette.ink).frame(height: 1.5) }
                        .accessibilityIdentifier("setup-pot-name")
                }
                .padding(.bottom, 22)
                SetupNameGuidance(value: app.potName, empty: "Give your household a name.", palette: palette)
                VStack(alignment: .leading, spacing: 9) {
                    Text("Household currency").font(Font.footnote).foregroundStyle(palette.ink2)
                    Button { nameFocused = false; currencyPickerPresented = true } label: {
                        HStack(spacing: 8) {
                            Text(setupCurrencyName(app.potCurrency))
                            Text("· \(app.potCurrency.code)").foregroundStyle(palette.ink2)
                            Spacer(minLength: 0)
                            HomeIcon(kind: .chevron, size: 20)
                        }
                        .font(Font.title3).foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity, minHeight: 51.5, alignment: .leading)
                        .overlay(alignment: .bottom) { Rectangle().fill(palette.ink).frame(height: 1.5) }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityIdentifier("setup-currency")
                    .accessibilityHint(app.isPotCurrencyConfirmed ? "Currency confirmed." : "Choose and confirm your household currency.")
                }
                .padding(.bottom, 22)
                SetupExplanation(title: "One home, one currency.", text: "Choose carefully. Your currency is fixed once the household is created. Numa does not convert currencies.", palette: palette)
                if let error = app.setupErrorMessage {
                    Text(error).font(.footnote).foregroundStyle(palette.ink2).padding(.top, 16)
                        .accessibilityLabel("Setup error: \(error)")
                }
            }
            .padding(.horizontal, 25)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.bg.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            SetupPrimary(title: "Confirm \(app.potCurrency.code) & continue", palette: palette) {
                nameFocused = false
                app.selectPotCurrency(app.potCurrency)
                app.goPeople()
            }
                .disabled(!AppModel.isValidSetupValue(app.potName))
                .accessibilityIdentifier("setup-continue")
                .padding(.horizontal, 25).padding(.top, 12).background(palette.bg)
        }
        .accessibilityHidden(currencyPickerPresented)
        .fullScreenCover(isPresented: $currencyPickerPresented) {
            CurrencyPickerView(selected: app.potCurrency, palette: palette, onSelect: app.selectPotCurrency)
        }
        .onChange(of: app.potName) { _, _ in app.setupInputDidChange() }
        .task { if app.potName.isEmpty { nameFocused = true } }
    }
}

private struct CurrencyPickerView: View {
    let suggested: Currency
    let palette: Pal.Palette
    let onSelect: (Currency) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    let selection: Currency
    @State private var showsAll = false
    @FocusState private var searching: Bool

    init(selected: Currency, palette: Pal.Palette, onSelect: @escaping (Currency) -> Void) {
        suggested = selected
        self.palette = palette
        self.onSelect = onSelect
        selection = selected
    }

    private var currencies: [Currency] {
        let preferred = ["EUR", "GBP", "USD"]
        let ordered = preferred.compactMap { code in CurrencyCatalog.all.first { $0.code == code } }
            + CurrencyCatalog.all.filter { !preferred.contains($0.code) }
        guard !query.isEmpty else {
            return showsAll ? ordered : ordered.filter { preferred.contains($0.code) || $0 == suggested }
        }
        return ordered.filter { $0.code.localizedCaseInsensitiveContains(query) || setupCurrencyName($0).localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SetupNavigation(title: "Currency", palette: palette) { dismiss() }
                SetupHeading("One currency\nfor your home.", palette: palette)
                Text("Use the currency you normally pay shared bills in.")
                    .font(Font.callout).tracking(-0.15).foregroundStyle(palette.ink2)
                    .lineSpacing(4).fixedSize(horizontal: false, vertical: true).padding(.vertical, 1.8)
                    .padding(.top, 13).padding(.bottom, 26)
                HStack(spacing: 8) {
                    HomeIcon(kind: .search, size: 22)
                    TextField("Search currencies", text: $query)
                        .font(Font.body).focused($searching)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.search).onSubmit { searching = false }
                        .accessibilityIdentifier("currency-search")
                }
                .foregroundStyle(palette.ink2).frame(minHeight: 48.3)
                .overlay(alignment: .bottom) { Rectangle().fill(palette.ink).frame(height: 1.5) }
                LazyVStack(spacing: 0) {
                    ForEach(currencies, id: \.code) { currency in
                        Button { searching = false; onSelect(currency); dismiss() } label: {
                            HStack(spacing: 13) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(setupCurrencyName(currency)).font(Font.callout.weight(.semibold))
                                    Text(currency.code).font(Font.footnote).foregroundStyle(palette.ink2)
                                }
                                Spacer(minLength: 8)
                                Circle().fill(currency == selection ? palette.ink : .clear)
                                    .overlay(Circle().strokeBorder(currency == selection ? palette.ink : Color(hex: 0x929789), lineWidth: 1.5))
                                    .overlay { if currency == selection { HomeIcon(kind: .check, size: 16).foregroundStyle(palette.bg) } }
                                    .frame(width: 23, height: 23).accessibilityHidden(true)
                            }
                            .foregroundStyle(palette.ink).padding(.vertical, 16)
                            .frame(maxWidth: .infinity, minHeight: 75.3, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).accessibilityIdentifier("currency-\(currency.code)")
                        .accessibilityValue(currency == selection ? "Selected" : "Not selected")
                        .accessibilityHint("Select this currency and return to setup.")
                        Rectangle().fill(palette.hair).frame(height: 1)
                    }
                    if currencies.isEmpty { Text("No matching currencies.").font(.body).padding(.vertical, 24) }
                }
                if query.isEmpty && !showsAll {
                    Button("See all supported currencies") { showsAll = true }
                        .font(Font.caption).foregroundStyle(palette.ink2)
                        .frame(minHeight: 44).padding(.top, 5)
                }
            }
            .padding(.horizontal, 25)
        }
        .scrollDismissesKeyboard(.interactively).background(palette.bg.ignoresSafeArea())
    }
}

private func setupCurrencyName(_ currency: Currency) -> String {
    switch currency.code {
    case "EUR": "Euro"
    case "GBP": "British pound"
    case "USD": "US dollar"
    default: Locale(identifier: "en").localizedString(forCurrencyCode: currency.code) ?? currency.code
    }
}

private struct SetupHeading: View {
    let title: String
    let palette: Pal.Palette
    @Environment(\.dynamicTypeSize) private var typeSize
    init(_ title: String, palette: Pal.Palette) { self.title = title; self.palette = palette }
    var body: some View {
        Group {
            if typeSize == .large {
                ViewThatFits(in: .horizontal) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(title.split(separator: "\n").enumerated()), id: \.offset) { _, line in
                            Text(String(line)).font(NumaFont.display(37)).tracking(-1.2)
                                .fixedSize()
                                .offset(y: -NumaFont.referenceLeadingInset(size: 37, lineHeight: 38.85))
                                .frame(height: 38.85, alignment: .top)
                        }
                    }
                    natural
                }
            } else { natural }
        }
        .foregroundStyle(palette.ink).accessibilityElement(children: .ignore)
        .accessibilityLabel(title).accessibilityAddTraits(.isHeader)
    }
    private var natural: some View {
        Text(title).font(NumaFont.display(37)).tracking(-1.2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct SetupNavigation: View {
    let title: String
    let palette: Pal.Palette
    let back: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            Button(action: back) {
                HomeIcon(kind: .back, size: 22)
                    .frame(width: 44, height: 44)
                    .background(palette.isDark ? palette.chip : Color(hex: 0xEEECE4), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain).accessibilityLabel("Back")
            .accessibilityIdentifier("setup-back-\(title)")
            Spacer(minLength: 0)
            Text(title).font(Font.callout.weight(.semibold))
            Spacer(minLength: 0)
            Color.clear.frame(width: 44, height: 44)
        }
        .foregroundStyle(palette.ink).frame(minHeight: 59).padding(.bottom, 12)
    }
}

private struct SetupProgress: View {
    let step: Int
    let palette: Pal.Palette
    var body: some View {
        HStack(spacing: 5) {
            ForEach(1...3, id: \.self) { value in
                Capsule().fill(value <= step ? palette.ink : palette.hair).frame(height: 4)
            }
        }.padding(.bottom, 26).accessibilityElement(children: .ignore).accessibilityLabel("Setup step \(step) of 3")
            .accessibilityIdentifier("setup-progress")
            .accessibilityAddTraits(.isStaticText)
    }
}

private struct SetupPrimary: View {
    let title: String
    let palette: Pal.Palette
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(title).fixedSize(horizontal: false, vertical: true)
                HomeIcon(kind: .arrow, size: 20)
            }
            .font(Font.callout.weight(.semibold)).tracking(-0.2)
            .padding(.horizontal, 20).padding(.vertical, 15)
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(isEnabled ? palette.bg : palette.ink2)
            .background(isEnabled ? palette.ink : palette.chip, in: Capsule())
        }.buttonStyle(PressableButtonStyle())
    }
}

private struct SetupExplanation: View {
    let title: String
    let text: String
    let palette: Pal.Palette
    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            HomeIcon(kind: .lock, size: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Font.footnote.weight(.semibold)).padding(.vertical, 1.9)
                Text(text).font(Font.footnote).lineSpacing(4).padding(.vertical, 1.9)
            }.fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(palette.ink).padding(.horizontal, 18).padding(.vertical, 17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.isDark ? palette.chip : Color(hex: 0xEEEADF), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct AddPeopleView: View {
    @EnvironmentObject var app: AppModel
    let palette: Pal.Palette
    @State private var step: Step = .people
    @State private var editor: PersonEditor?
    @State private var currencyPickerPresented = false
    @FocusState private var ownerFocused: Bool
    private enum Step { case people, ready }
    private struct PersonEditor: Identifiable {
        let unit: UnitID?
        let name: String
        let isNew: Bool
        var id: String { unit?.rawValue ?? "household" }
    }
    private var people: [UnitID] { [.am] + app.setupPersonUnits }
    private var groups: [[UnitID]] {
        var seen = Set<UnitID>()
        return people.compactMap { person in
            guard !seen.contains(person) else { return nil }
            let group = app.setupPairs.first { $0.contains(person) } ?? [person]
            seen.formUnion(group)
            return people.filter { group.contains($0) }
        }
    }
    private var navigationTitle: String {
        switch step { case .people: "Your people"; case .ready: "One last look" }
    }
    private var nextTitle: String {
        switch step {
        case .people: people.count == 1 ? "Continue" : "Continue with \(people.count) people"
        case .ready: app.isCompletingSetup ? "Creating your home…" : app.hasPendingSetupRegistration ? "Retry creating home" : "Create our home"
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SetupNavigation(title: navigationTitle, palette: palette, back: back)
                    .disabled(app.isSetupDraftLocked)
                SetupProgress(step: step == .people ? 2 : 3, palette: palette)
                switch step {
                case .people: peopleContent
                case .ready: readyContent
                }
                if let error = app.setupErrorMessage {
                    Text(error).font(.footnote).foregroundStyle(palette.ink2).padding(.top, 16)
                        .accessibilityLabel("Setup error: \(error)")
                }
            }
            .padding(.horizontal, 25).padding(.bottom, 20)
            .disabled(app.isSetupDraftLocked)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("setup-people-scroll")
        .background(palette.bg.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            SetupPrimary(title: nextTitle, palette: palette, action: next)
                .disabled(!app.canCompleteSetup || app.isCompletingSetup)
                .accessibilityIdentifier("setup-people-next")
                .padding(.horizontal, 25).padding(.top, 12).background(palette.bg)
        }
        .accessibilityHidden(editor != nil || currencyPickerPresented)
        .fullScreenCover(item: $editor) { item in
            SetupNameEditorView(name: item.name, identifier: "setup-\(item.id)-name",
                kind: item.unit == nil ? .household : item.isNew ? .newPerson : .existingPerson,
                color: item.unit.map { item.isNew ? Pal.purple : personColor($0) } ?? palette.home,
                palette: palette) { name in
                if let unit = item.unit { setName(name, for: unit) }
                else { app.potName = name }
                app.setupInputDidChange()
                editor = nil
            } cancel: {
                if item.isNew, let unit = item.unit { app.removeSetupPerson(unit) }
                editor = nil
            }
        }
        .fullScreenCover(isPresented: $currencyPickerPresented) {
            CurrencyPickerView(selected: app.potCurrency, palette: palette, onSelect: app.selectPotCurrency)
        }
        .onChange(of: app.ownerDisplayName) { _, _ in app.setupInputDidChange() }
        .task { if app.ownerDisplayName.isEmpty { ownerFocused = true } }
    }
    private var peopleContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            SetupHeading("Who’s at home?", palette: palette)
            intro("Add the people sharing expenses.\nYou can invite them after setup.")
            ForEach(people, id: \.self) { person in personRow(person) }
            SetupNameGuidance(value: app.ownerDisplayName, empty: "Enter your name to continue.", palette: palette)
            if app.canAddSetupPerson {
                Button {
                    ownerFocused = false
                    if let person = app.addSetupPerson() { editor = PersonEditor(unit: person, name: "", isNew: true) }
                } label: {
                    HStack(spacing: 10) { HomeIcon(kind: .plus, size: 20); Text("Add a person") }
                        .font(Font.callout.weight(.semibold)).foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .background(palette.isDark ? palette.chip : Color(hex: 0xEBE8DD), in: Capsule())
                }
                .buttonStyle(PressableButtonStyle()).accessibilityIdentifier("setup-add-person").padding(.top, 18)
            }
            footnote(people.count == 1 ? "Add at least one other person to share expenses with." : "Names are editable. Everyone records purchases as themselves.")
            if people.count > 1 && groups.count < 2 {
                minimumGroupExplanation
            }
        }
    }
    private var readyContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            SetupHeading("\(app.potName).\nOur rules.", palette: palette)
            intro("\(setupCountWord(people.count)) people. \(setupCountWord(groups.count)) shared budgets.\nOne less thing to figure out.")
            Button { editor = PersonEditor(unit: nil, name: app.potName, isNew: false) } label: {
                readyRow("Household", detail: app.potName, icon: .home)
            }.buttonStyle(.plain).accessibilityIdentifier("setup-edit-household")
                .accessibilityHint("Edit the household name.")
            Button { currencyPickerPresented = true } label: {
                readyRow("Currency", detail: "\(setupCurrencyName(app.potCurrency)) · fixed after creation", icon: .lock, tail: app.potCurrency.code)
            }.buttonStyle(.plain).accessibilityIdentifier("setup-edit-currency")
                .accessibilityHint("Change the household currency before creating it.")
            Text("Who shares a budget?")
                .font(Font.body.weight(.semibold))
                .accessibilityAddTraits(.isHeader).padding(.top, 24)
            Text("A couple can share one balance. Everyone else has their own.")
                .font(Font.footnote).foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 6)
            ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
                HStack(alignment: .top, spacing: 13) {
                    HStack(spacing: -10) {
                        ForEach(group, id: \.self) { person in
                            avatar(person, tint: palette.bg.opacity(0.47))
                        }
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(groupName(group)).font(Font.body.weight(.semibold))
                        Text(group.count == 2 ? "One balance shared by two people." : "One person, one balance.")
                            .font(Font.footnote)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    groupMenu(group[0], members: group)
                }
                .foregroundStyle(palette.identityInk).padding(.horizontal, 20).padding(.vertical, 19)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(groupColor(index), in: RoundedRectangle(cornerRadius: 18))
                .padding(.top, 14)
            }
            Text(groups.count == 1 ? "1 balance group" : "\(groups.count) balance groups").font(.footnote).foregroundStyle(palette.ink2)
                .accessibilityIdentifier("setup-group-count").padding(.top, 12)
            if groups.count < 2 {
                minimumGroupExplanation
            } else {
                footnote(groups.count == 2 ? "A 50/50 bill is split between these two groups—not \(people.count) people." : "An equal bill is split between these \(groups.count) groups, not individual people.")
            }
            SetupExplanation(title: "Once you add money, groups stay put.", text: "You can still edit names and record corrections. Existing debt will never be quietly moved between people.", palette: palette).padding(.top, 20)
            Button("Set opening balances", action: app.continueToOpeningBalance)
                .font(.footnote.weight(.semibold)).frame(minHeight: 44)
                .disabled(!app.canCompleteSetup || app.isCompletingSetup)
        }.foregroundStyle(palette.ink)
    }
    private var minimumGroupExplanation: some View {
        Text("Keep at least two balance groups separate.")
            .font(.footnote).foregroundStyle(palette.ink2)
            .fixedSize(horizontal: false, vertical: true).padding(.top, 8)
            .accessibilityIdentifier("setup-group-requirement")
    }
    private func personRow(_ person: UnitID) -> some View {
        HStack(spacing: 13) {
            avatar(person)
            VStack(alignment: .leading, spacing: 4) {
                if person == .am {
                    TextField("Your name", text: $app.ownerDisplayName)
                        .font(Font.callout.weight(.semibold)).textContentType(.name)
                        .textInputAutocapitalization(.words).submitLabel(.done)
                        .focused($ownerFocused).onSubmit { ownerFocused = false }
                        .accessibilityIdentifier("setup-owner-name")
                } else { Text(app.setupName(for: person)).font(Font.callout.weight(.semibold)) }
                Text(person == .am ? "This is you" : "Not invited yet")
                    .font(Font.footnote).foregroundStyle(palette.ink2)
            }
            Spacer(minLength: 8)
            if person == .am {
                Text("You").font(Font.caption.weight(.semibold))
                    .padding(.horizontal, 10).padding(.vertical, 6).background(palette.chip, in: Capsule())
            } else { groupMenu(person) }
        }
        .foregroundStyle(palette.ink).padding(.vertical, 16).frame(minHeight: 75)
        .overlay(alignment: .bottom) { Rectangle().fill(palette.hair).frame(height: 1) }
        .draggable(person.rawValue)
        .dropDestination(for: String.self) { values, _ in
            guard let raw = values.first, let source = UnitID(rawValue: raw) else { return false }
            return app.groupSetupUnits(source, with: person)
        }
    }
    private func groupMenu(_ person: UnitID, members: [UnitID]? = nil) -> some View {
        Menu {
            if let members {
                ForEach(members, id: \.self) { member in
                    Button("Edit \(app.setupName(for: member))") {
                        editor = PersonEditor(unit: member, name: app.setupName(for: member), isNew: false)
                    }
                }
            } else {
                Button("Edit name") { editor = PersonEditor(unit: person, name: app.setupName(for: person), isNew: false) }
            }
            if app.setupGroupedUnits.contains(person) {
                Button("Keep balances separate") { app.toggleSetupGrouping(person) }
            } else {
                ForEach(people.filter { $0 != person && !app.setupGroupedUnits.contains($0) }, id: \.self) { other in
                    Button("Share a balance with \(app.setupName(for: other))") { _ = app.groupSetupUnits(person, with: other) }
                }
            }
            ForEach((members ?? [person]).filter { $0 != .am }, id: \.self) { member in
                Button(members == nil ? "Remove person" : "Remove \(app.setupName(for: member))", role: .destructive) { app.removeSetupPerson(member) }
            }
        } label: {
            HomeIcon(kind: .edit, size: 22)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }.accessibilityLabel("Group options for \(app.setupName(for: person))")
    }
    private func avatar(_ person: UnitID, tint: Color? = nil) -> some View {
        Text(String(app.setupName(for: person).prefix(1)).uppercased())
            .font(.custom("BricolageGrotesque-Bold", fixedSize: 16)).foregroundStyle(palette.identityInk)
            .frame(width: 42, height: 42).background(tint ?? personColor(person), in: Circle())
            .overlay(Circle().stroke(palette.bg, lineWidth: 2)).accessibilityHidden(true)
    }
    private func groupColor(_ index: Int) -> Color { [Pal.teal, Pal.purple, Pal.amber, Color(hex: 0xF5B995)][index % 4] }
    private func personColor(_ person: UnitID) -> Color { groupColor(groups.firstIndex { $0.contains(person) } ?? 0) }
    private func groupName(_ group: [UnitID]) -> String { group.map(app.setupName(for:)).joined(separator: " + ") }
    private func intro(_ text: String) -> some View {
        Text(text).font(.callout).lineSpacing(4).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true)
            .padding(.top, 13).padding(.bottom, 26)
    }
    private func footnote(_ text: String) -> some View {
        Text(text).font(Font.caption).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true).padding(.top, 17)
    }
    private func readyRow(_ title: String, detail: String, icon: HomeIcon.Kind, tail: String = "") -> some View {
        HStack(spacing: 13) {
            HomeIcon(kind: icon).frame(width: 46, height: 46).background(palette.chip, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Font.callout.weight(.semibold))
                Text(detail).font(Font.footnote).foregroundStyle(palette.ink2)
            }
            Spacer(minLength: 8)
            if !tail.isEmpty { Text(tail).font(Font.body.weight(.semibold)) }
            HomeIcon(kind: .chevron, size: 20)
        }.padding(.vertical, 16).frame(minHeight: 75)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { Rectangle().fill(palette.hair).frame(height: 1) }
    }
    private func setName(_ name: String, for person: UnitID) {
        if person == .am { app.ownerDisplayName = name }
        else if person == .sam { app.samDisplayName = name }
        else if person == .leo { app.leoDisplayName = name }
        else { app.additionalSetupNames[person] = name }
    }
    private func back() {
        switch step { case .people: app.goCreate(); case .ready: step = .people }
    }
    private func next() {
        ownerFocused = false
        switch step { case .people: step = .ready; case .ready: app.finishSetup() }
    }
}

private struct SetupNameGuidance: View {
    let value: String
    let empty: String
    let palette: Pal.Palette
    var body: some View {
        if !AppModel.isValidSetupValue(value) {
            Text(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? empty : value.trimmingCharacters(in: .whitespacesAndNewlines) == WireEventV1.redactedTextPlaceholder ? "Choose a different name." : "Use a shorter name.")
                .font(.footnote).foregroundStyle(palette.ink2)
                .fixedSize(horizontal: false, vertical: true).padding(.vertical, 8)
        }
    }
}

private struct SetupNameEditorView: View {
    enum Kind { case newPerson, existingPerson, household }
    @State private var name: String
    @FocusState private var focused: Bool
    let identifier: String
    let kind: Kind
    let color: Color
    let palette: Pal.Palette
    let save: (String) -> Void
    let cancel: () -> Void
    init(name: String, identifier: String, kind: Kind, color: Color, palette: Pal.Palette, save: @escaping (String) -> Void, cancel: @escaping () -> Void) {
        _name = State(initialValue: name)
        self.identifier = identifier; self.kind = kind; self.color = color; self.palette = palette; self.save = save; self.cancel = cancel
    }
    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool {
        AppModel.isValidSetupValue(name)
    }
    private func saveIfValid() {
        guard canSave else { return }
        focused = false
        save(trimmed)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SetupNavigation(title: kind == .newPerson ? "Add a person" : kind == .household ? "Household name" : "Edit name", palette: palette, back: cancel)
                Text(String(trimmed.prefix(1)).uppercased()).font(NumaFont.display(16))
                    .foregroundStyle(palette.identityInk).frame(width: 42, height: 42).background(color, in: Circle())
                    .padding(.top, 18).accessibilityHidden(true)
                SetupHeading(kind == .household ? "A name for\nyour home." : kind == .newPerson ? "What should\nwe call them?" : "Make it\nfamiliar.", palette: palette).padding(.top, 18)
                VStack(alignment: .leading, spacing: 9) {
                    Text("Name").font(Font.footnote).foregroundStyle(palette.ink2)
                    TextField("Name", text: $name).font(Font.title3).focused($focused)
                        .textContentType(.name).textInputAutocapitalization(.words).submitLabel(.done)
                        .onSubmit {
                            if canSave { saveIfValid() }
                            else {
                                // Done resigns the native field even when its
                                // submit action rejects an empty name. Restore
                                // focus so correcting it needs no extra tap.
                                focused = false
                                DispatchQueue.main.async { focused = true }
                            }
                        }
                        .padding(.top, 10).padding(.bottom, 13)
                        .overlay(alignment: .bottom) { Rectangle().fill(palette.ink).frame(height: 1.5) }
                        .accessibilityIdentifier(identifier)
                }.padding(.vertical, 22)
                SetupNameGuidance(value: name, empty: "Enter a name to continue.", palette: palette)
                Text(kind == .newPerson ? "You’re adding a name to your household, not sending an invitation yet." : "This name will be visible to your household.")
                    .font(.body).foregroundStyle(palette.ink2).fixedSize(horizontal: false, vertical: true)
            }.padding(.horizontal, 25)
        }
        .foregroundStyle(palette.ink).background(palette.bg.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            SetupPrimary(title: kind == .newPerson ? "Save person" : "Save name", palette: palette, action: saveIfValid)
                .disabled(!canSave).accessibilityIdentifier("setup-person-save")
                .padding(.horizontal, 25).padding(.top, 12).background(palette.bg)
        }
        .task { focused = true }
    }
}

private func setupCountWord(_ count: Int) -> String {
    let formatter = NumberFormatter()
    formatter.locale = Locale(identifier: "en")
    formatter.numberStyle = .spellOut
    return (formatter.string(from: NSNumber(value: count)) ?? String(count)).capitalized
}
