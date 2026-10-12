import SwiftUI
import Combine
#if DEBUG
import QuartzCore
#endif

#if DEBUG
@MainActor
private final class FieldFrameRateMonitor: NSObject, ObservableObject {
    @Published private(set) var sustainedFramesPerSecond = 0.0

    private var displayLink: CADisplayLink?
    private var timestamps: [CFTimeInterval] = []
    private var lastPublishedAt: CFTimeInterval = 0

    func start() {
        guard displayLink == nil else { return }
        timestamps.removeAll(keepingCapacity: true)
        let link = CADisplayLink(target: self, selector: #selector(frameDidRender(_:)))
        link.preferredFramesPerSecond = 60
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func frameDidRender(_ link: CADisplayLink) {
        timestamps.append(link.timestamp)
        let cutoff = link.timestamp - 1
        timestamps.removeAll { $0 < cutoff }
        guard let first = timestamps.first,
              let last = timestamps.last,
              last - first >= 0.9,
              last - lastPublishedAt >= 0.25 else { return }
        sustainedFramesPerSecond = Double(timestamps.count - 1) / (last - first)
        lastPublishedAt = last
    }
}
#endif


/// The approved shared table. Financial content always comes from the reducer;
/// compact reference geometry expands into a scrolling layout at accessibility sizes.
struct HomeView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let palette: Pal.Palette
#if DEBUG
    @StateObject private var fieldFrameRateMonitor = FieldFrameRateMonitor()
#endif
    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                VStack(spacing: 0) {
                    SharedTableBalance(palette: palette).id("home-top")
                    SharedTableAddAction(palette: palette)
                        .padding(.horizontal, 25).padding(.top, 21).padding(.bottom, 8)
                    SharedTableHistory(palette: palette)
                        .padding(.horizontal, 25).padding(.bottom, 20)
                }
            }
            .accessibilityIdentifier("home-scroll")
            .background(palette.bg)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 8) {
                    if let text = app.undoText {
                        UndoBar(text: text, palette: palette, onUndo: app.undoNow)
                            .accessibilityIdentifier("home-undo-lane")
                    }
                    SharedTableNavigation(palette: palette) {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) {
                            scroll.scrollTo("home-top", anchor: .top)
                        }
                    }
                }
                .padding(.horizontal, 23).padding(.bottom, 24)
            }
        }
        .ignoresSafeArea(.container)
#if DEBUG
        .overlay(alignment: .topTrailing) {
            if app.qaEightUnitField {
                Text("Field \(Int(fieldFrameRateMonitor.sustainedFramesPerSecond.rounded())) fps")
                    .font(.caption2.monospacedDigit()).padding(6).background(palette.bg, in: Capsule())
                    .accessibilityIdentifier("field-sustained-fps")
                    .accessibilityValue(String(format: "%.1f", fieldFrameRateMonitor.sustainedFramesPerSecond))
            }
        }
        .onAppear { if app.qaEightUnitField { fieldFrameRateMonitor.start() } }
        .onDisappear { fieldFrameRateMonitor.stop() }
        .onChange(of: app.addPresented) { _, presented in
            guard app.qaEightUnitField else { return }
            if presented { fieldFrameRateMonitor.stop() } else { fieldFrameRateMonitor.start() }
        }
#endif
        .onAppear { Haptics.prepare(); app.reduceMotion = reduceMotion }
        .onChange(of: reduceMotion) { _, value in app.reduceMotion = value }
    }
}

private struct SharedTableBalance: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    let palette: Pal.Palette
    private var compactPair: Bool { app.ledgerUnitIDs.count == 2 && typeSize == .large }
    private var ownBalance: Int64 { app.balances[app.currentUnitID] ?? 0 }
    private var headline: String {
        if app.isEmpty { return "Our everyday,\ntogether." }
        if app.isAllEven { return "All square.\nNo one owes anyone." }
        if app.plan.count == 1, let transfer = app.plan.first {
            return "\(app.unitInfo(for: transfer.from).name) owe\n\(app.unitInfo(for: transfer.to).name)"
        }
        let name = app.unitInfo(for: app.currentUnitID).name
        if ownBalance < 0 { return "\(name) owe\nacross the household" }
        if ownBalance > 0 { return "\(name) get back\nfrom the household" }
        return "\(name) are even.\nSee every group below."
    }
    private var amount: String {
        if app.isEmpty { return "Nothing shared yet" }
        if app.isAllEven { return app.fmt(0) }
        if app.plan.count == 1, let transfer = app.plan.first { return app.fmt(transfer.amountCents) }
        return app.fmtMagnitude(ownBalance)
    }
    private var whyUnit: UnitID { app.plan.count == 1 ? app.plan[0].from : app.currentUnitID }
    private var homeSecondary: Color { palette.homeSecondary }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center) {
                Button(action: app.openPotSwitcher) {
                    ViewThatFits(in: .horizontal) {
                        if compactPair {
                            householdTitle.fixedSize(horizontal: true, vertical: true)
                                .frame(height: 50.5, alignment: .top)
                        }
                        householdTitle.fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityIdentifier("pot-switcher")
                .accessibilityLabel(app.potName).accessibilityHint("Opens the pot switcher.")
                Spacer(minLength: 8)
                if app.syncPresentation != .local { SyncStatusCapsuleView(palette: palette) }
                Button(action: app.openSettings) {
                    HomeIcon(kind: .gear)
                        .frame(width: 44, height: 44)
                        .background(palette.isDark ? palette.chip : .white.opacity(0.4), in: Circle())
                }
                .buttonStyle(.plain).accessibilityLabel("Settings")
            }

            .padding(.bottom, 24)

            ViewThatFits(in: .horizontal) {
                if compactPair {
                    HStack(spacing: 8) {
                        ForEach(Array(app.ledgerUnitIDs.enumerated()), id: \.element) { index, id in
                            if index > 0 { Rectangle().fill(homeSecondary.opacity(0.7)).frame(width: 16, height: 1).accessibilityHidden(true) }
                            SharedTableGroupChip(unitID: id, palette: palette, compact: true)
                        }
                    }
                    .fixedSize(horizontal: true, vertical: true)
                    .frame(height: 28)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), alignment: .leading)], alignment: .leading, spacing: 12) {
                    ForEach(app.fieldUnitIDs, id: \.self) { id in SharedTableGroupChip(unitID: id, palette: palette) }
                }
            }

            Button { app.tapOrb(whyUnit) } label: {
                VStack(alignment: .leading, spacing: 10) {
                    obligationSentence
                    HStack(spacing: 12) {
                        balanceAmount
                            .accessibilityIdentifier("balance-headline-amount")
                        Spacer(minLength: 0)
                        HomeIcon(kind: .arrow)
                            .foregroundStyle(palette.home).frame(width: 47, height: 47)
                            .background(palette.ink, in: Circle()).accessibilityHidden(true)
                    }
                    .frame(minHeight: compactPair && !app.isEmpty ? 82.5 : nil)
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("balance-explanation")
            .accessibilityHint("See the expenses and repayments behind this balance.")
            .padding(.top, 16)

            if !app.plan.isEmpty {
                // One view tree at every text size: AnyLayout keeps these
                // labels' identity, so Dynamic Type grows them in place
                // instead of swapping in different copies.
                let stacked = typeSize.isAccessibilitySize
                let layout = stacked
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                    : AnyLayout(HStackLayout(spacing: 16))
                layout {
                    repaymentButton
                    if !stacked { Spacer(minLength: 0) }
                    WrappingTextLabel(
                        text: String(localized: "Money changes hands\noutside Numa Shared."),
                        size: 11,
                        weight: .regular,
                        color: homeSecondary,
                        alignment: stacked ? .leading : .trailing
                    )
                }
                .frame(height: compactPair ? 43 : nil)
                .padding(.top, 14)
            } else {
                Text(app.isEmpty ? "Start here, on this iPhone. Invite people when you're ready." : "Every shared moment is still in your history.")
                    .font(.subheadline).foregroundStyle(homeSecondary).padding(.top, 14)
            }
        }
        .foregroundStyle(palette.ink)
        .padding(.horizontal, 25).padding(.top, 75).padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.home, in: UnevenRoundedRectangle(bottomLeadingRadius: 30, bottomTrailingRadius: 30))

    }

    private var householdTitle: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Two UIKit-backed labels: the concatenated SwiftUI Text becomes a
            // synthetic AccessibilityNode the system contrast audit crops
            // mid-glyph and misreports as "Contrast failed" (repo precedent
            // 5d860f5). Same tokens, same colors.
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                NativeTextLabel(text: "numa", size: 28, weight: .bold, color: palette.ink)
                NativeTextLabel(
                    text: ".",
                    size: 28,
                    weight: .bold,
                    color: palette.isDark ? palette.ink2 : Color(hex: 0x8B702E)
                )
            }
            .tracking(-1)
            // UIKit-backed pot name: compact SwiftUI Text becomes a synthetic
            // AccessibilityNode the system contrast audit crops mid-glyph and
            // misreports as "Contrast failed" (repo precedent 5d860f5).
            NativeTextLabel(text: app.potName, size: 12, weight: .regular, color: homeSecondary)
        }
    }

    private var naturalSentence: some View {
        Text(headline).font(NumaFont.display(33, relativeTo: .title)).tracking(-0.9)
            .fixedSize(horizontal: false, vertical: true)
    }
    private var obligationSentence: some View {
        Group {
            if compactPair && !app.isEmpty && !app.isAllEven {
                ViewThatFits(in: .horizontal) {
                    // Explicit typographic line boxes match the approved 1.08
                    // leading, not UIKit's 1.2 default. No glyphs are clipped.
                    // Long names and accessibility sizes use natural reflow.
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(headline.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                            Text(line).font(NumaFont.display(33, relativeTo: .title)).tracking(-0.9)
                                .fixedSize(horizontal: true, vertical: true)
                                .offset(y: -NumaFont.referenceLeadingInset(size: 33, lineHeight: 35.635))
                                .frame(height: 35.635, alignment: .top)
                        }
                    }
                    naturalSentence
                }
            } else { naturalSentence }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(headline)
        .accessibilityIdentifier("home-obligation-sentence")
    }
    private var balanceAmount: some View {
        Group {
            if !app.isEmpty && amount.hasPrefix("€") && typeSize == .large {
                let glyph = Text("€").font(NumaFont.display(37)).kerning(1.7).baselineOffset(12)
                let digits = Text(String(amount.dropFirst())).font(NumaFont.display(75)).tracking(-2.3)
                let value = Text("\(glyph)\(digits)").monospacedDigit()
                ViewThatFits(in: .horizontal) {
                    value.fixedSize()
                        .offset(y: -NumaFont.referenceLeadingInset(size: 75, lineHeight: 82.5))
                        .frame(height: 82.5, alignment: .top)
                    value.fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(amount).font(app.isEmpty ? .title2.bold() : NumaFont.display(75)).monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private var repaymentButton: some View {
        Button(action: app.openSettlePlan) {
            Text("Record a repayment").font(.footnote.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 17).padding(.vertical, 12)
                .frame(minHeight: 44)
                .background {
                    Capsule().fill(palette.isDark ? palette.chip : .white.opacity(0.56))
                        .frame(height: compactPair ? 43 : nil)
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain).accessibilityIdentifier("record-repayment").disabled(!app.canWrite)
    }
}

private struct SharedTableGroupChip: View {
    @EnvironmentObject var app: AppModel
    let unitID: UnitID
    let palette: Pal.Palette
    var compact = false
    private var info: UnitInfo { app.unitInfo(for: unitID) }
    private var direction: String {
        let balance = app.fieldBalances[unitID] ?? 0
        if unitID == .more { return "More groups" }
        if balance > 0 { return "gets back \(app.fmt(balance))" }
        if balance < 0 { return "owes \(app.fmtMagnitude(balance))" }
        return "even"
    }
    var body: some View {
        Button { app.tapOrb(unitID) } label: {
            HStack(spacing: compact ? 8 : 9) {
                if compact { HomeIdentityPair(unit: info, names: app.memberProfiles.filter { ($0.budgetUnitID ?? $0.unitID) == unitID }.map { app.personName($0) }, palette: palette) }
                else { SharedIdentityMark(unit: info, background: palette.home) }
                VStack(alignment: .leading, spacing: 3) {
                    // UIKit-backed labels: compact SwiftUI Text becomes a
                    // synthetic AccessibilityNode the system contrast audit
                    // crops mid-glyph and misreports as "Contrast failed"
                    // (repo precedent 5d860f5).
                    // Full-size chips share a grid column, so long group
                    // names wrap inside it instead of running off screen.
                    if compact {
                        NativeTextLabel(text: info.name, size: 12, weight: .semibold, color: palette.ink)
                    } else {
                        WrappingTextLabel(text: info.name, size: 15, weight: .semibold, color: palette.ink)
                        WrappingTextLabel(text: direction, size: 12, weight: .regular, color: palette.homeSecondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier("orb-\(unitID.rawValue)")
        .accessibilityLabel("\(info.name), \(direction)")
        .accessibilityHint("See this group's history and balance explanation.")
    }
}

private struct HomeIdentityPair: View {
    let unit: UnitInfo
    let names: [String]
    let palette: Pal.Palette
    var body: some View {
        HStack(spacing: -7) {
            ForEach(Array(names.prefix(2).enumerated()), id: \.offset) { _, name in
                Text(String(name.prefix(1)).uppercased())
                    .font(NumaFont.display(11, relativeTo: .caption2))
                    .foregroundStyle(palette.identityInk)
                    .frame(width: 28, height: 28)
                    .background(unit.color, in: Circle())
                    .overlay(Circle().stroke(palette.home, lineWidth: 2))
            }
        }
        .accessibilityHidden(true)
    }
}

private struct SharedTableAddAction: View {
    @EnvironmentObject var app: AppModel
    // NumaFont.system bakes the current Dynamic Type size into a UIFont, so
    // re-evaluate this body when the size changes while the app is open.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let palette: Pal.Palette
    var body: some View {
        let _ = dynamicTypeSize
        Button {
            guard app.canWrite else { return }
            Haptics.activated(); app.beginAdd()
        } label: {
            HStack(spacing: 18) {
                VesselView(palette: palette, size: 78, reduceTransparency: reduceTransparency)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Add an expense").font(NumaFont.display(23, relativeTo: .title2))
                    Text("Who paid? Who was it for?").font(NumaFont.system(13)).foregroundStyle(palette.ink2)
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 78, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(SharedOrbButtonStyle(reduceMotion: reduceMotion))
        .foregroundStyle(palette.ink).disabled(!app.canWrite)
        .accessibilityIdentifier("dock-vessel").accessibilityLabel("Add expense")
        .accessibilityHint("Record who paid and which groups benefited.")
    }
}

private struct SharedTableHistory: View {
    @EnvironmentObject var app: AppModel
    // NumaFont.system bakes the current Dynamic Type size into a UIFont, so
    // re-evaluate this body when the size changes while the app is open.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let palette: Pal.Palette
    var body: some View {
        let _ = dynamicTypeSize
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Latest at home").font(NumaFont.display(22, relativeTo: .title2))
                    .accessibilityIdentifier("home-latest-heading")
                Spacer(minLength: 8)
                Button(action: app.openActivity) {
                    Text("See all").font(NumaFont.system(15, weight: .semibold))
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            .frame(minHeight: 44).padding(.top, 17).padding(.bottom, 7)
            if app.liveRecords.isEmpty {
                Text("No records yet. Your first shared expense starts the story.")
                    .font(.body).foregroundStyle(palette.ink2).padding(.vertical, 16)
            }
            ForEach(Array(app.rows(for: app.liveRecords).prefix(3))) { record in
                Button { app.openDetail(record.id) } label: {
                    HomeReceiptRow(record: record, palette: palette, now: app.homePresentationDate,
                        amount: record.displaysAmount ? app.fmt(record.amountCents, forceCents: true) : "—")
                        .frame(maxWidth: .infinity, minHeight: 79).contentShape(Rectangle())
                }.buttonStyle(.plain)
                Rectangle().fill(palette.hair).frame(height: 1)
            }
#if DEBUG
            if app.isEmpty && ProcessInfo.processInfo.arguments.contains("--qa-home") {
                Button("Skip ahead — load July's six records", action: app.loadJulySeed).font(.subheadline).frame(minHeight: 44)
            }
#endif
            // UIKit-backed footer: this SwiftUI Text became a synthetic
            // AccessibilityNode the system contrast audit crops at the screen
            // edge and misreports as "Contrast failed" (repo precedent 5d860f5).
            WrappingTextLabel(
                text: app.isSyncEnabled
                    ? String(localized: "Your household shares the same history.")
                    : String(localized: "Saved on this iPhone. Connect when you're ready to share."),
                size: 12,
                weight: .regular,
                color: palette.ink2
            )
            .padding(.top, 17)
        }.foregroundStyle(palette.ink)
    }
}

struct HomeReceiptRow: View {
    // NumaFont.system bakes the current Dynamic Type size into a UIFont, so
    // re-evaluate this body when the size changes while the app is open.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let record: ExpenseRecord
    let palette: Pal.Palette
    let now: Date
    let amount: String
    private var isInternet: Bool { record.category?.localizedCaseInsensitiveContains("internet") == true }
    private var isDinner: Bool { record.category?.localizedCaseInsensitiveContains("dining") == true }
    private var subtitle: String {
        guard record.kind == .expense || record.kind == .personal || record.kind == .expenseRevision else { return record.subtitle }
        let payer = record.payerDisplayName ?? "Person not recorded"
        return "\(payer) paid · \(Self.dateLabel(record.occurredAt, timeZoneIdentifier: record.originatingTimeZoneIdentifier, now: now))"
    }
    nonisolated static func dateLabel(_ date: Date, timeZoneIdentifier: String, now: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeZoneIdentifier) ?? .current
        if calendar.isDate(date, inSameDayAs: now) { return "today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { return "yesterday" }
        var format = Date.FormatStyle().day().month(.wide).locale(Locale(identifier: "en_GB"))
        format.timeZone = calendar.timeZone
        return date.formatted(format)
    }
    var body: some View {
        let _ = dynamicTypeSize
        HStack(spacing: 14) {
            Group {
                if isInternet { HomeIcon(kind: .wifi) }
                else if isDinner { HomeIcon(kind: .dinner) }
                else { Image(systemName: "receipt").font(.system(size: 22)) }
            }
                .foregroundStyle(palette.ink)
                .frame(width: 46, height: 46)
                .background(isInternet ? Pal.purple : isDinner ? Color(hex: 0xF9D2BF) : palette.chip, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(record.title).font(NumaFont.system(16, weight: .semibold)).strikethrough(record.voided)
                Text(subtitle).font(NumaFont.system(13)).foregroundStyle(palette.ink2)
                if record.deliveryState == .failed { Text(record.deliveryCopy ?? "Not saved").font(.caption) }
            }.fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Text(amount).font(NumaFont.system(17, weight: .semibold).monospacedDigit())
        }
    }
}

private struct SharedTableNavigation: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let palette: Pal.Palette
    let home: () -> Void
    var body: some View {
        HStack(spacing: 0) {
            SharedNavigationAction(title: "Home", symbol: "house", selected: true, palette: palette, action: home)
            SharedNavigationAction(title: "Activity", symbol: "clock.arrow.circlepath", palette: palette, action: app.openActivity)
                .accessibilityLabel("Activity, \(app.liveRecords.count) records")
            SharedNavigationAction(title: "People", symbol: "person.2", palette: palette, action: app.openPeopleManagement)
        }
        .padding(4)
        .background {
            Capsule().fill(.regularMaterial)
                .overlay(Capsule().fill(palette.isDark ? palette.surface.opacity(0.92) : Color(hex: 0xFAF9F4).opacity(reduceTransparency ? 1 : 0.95)))
        }
        .overlay(Capsule().stroke(palette.isDark ? palette.hair : .white, lineWidth: 1))
        .shadow(color: palette.ink.opacity(reduceTransparency ? 0 : 0.08), radius: 10, y: 5)

    }
}
private struct SharedNavigationAction: View {
    let title: String
    let symbol: String
    var selected = false
    let palette: Pal.Palette
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                HomeIcon(kind: title == "Home" ? .home : title == "Activity" ? .history : .people, size: 23)
                // UIKit-backed label: the system contrast audit crops compact
                // SwiftUI Text into synthetic AccessibilityNodes it cannot
                // measure, reporting false "Contrast failed" (repo precedent
                // 5d860f5; measured pixel contrast here is 12.65:1).
                NativeTextLabel(
                    text: title,
                    size: 10,
                    weight: .semibold,
                    color: palette.ink
                )
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(selected ? (palette.isDark ? palette.chip : Color(hex: 0xE8E7DD)) : .clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain).foregroundStyle(palette.ink)
        .accessibilityIdentifier("home-tab-\(title.lowercased())")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}
