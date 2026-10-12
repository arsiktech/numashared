import Combine
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Interaction styles

/// Shared pressed feedback — respond on touch-down with a small, critically
/// damped scale (fluid-interfaces guidance). Applied to every pressable.
struct PressableButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var scale: CGFloat = 0.97
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.8 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.15, dampingFraction: 1.0), value: configuration.isPressed)
    }
}

/// One horizontal shake of ±`travel`pt — the spec's invalid-split feedback
/// (6px shake ×1, paired with a warning haptic; records nothing).
struct ShakeEffect: GeometryEffect {
    var travel: CGFloat = 6
    var animatableData: CGFloat
    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: travel * sin(animatableData * .pi * 2), y: 0))
    }
}

/// The 280ms charge arc drawn around an owing disc while a firm-hold is in
/// progress (motion spec A·7) — removed when the hold fires or the press ends.
struct HoldProgressArc: View {
    let color: Color
    let size: CGFloat
    @State private var progress: CGFloat = 0
    var body: some View {
        Circle()
            .trim(from: 0, to: progress)
            .stroke(color.opacity(0.85), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            .rotationEffect(.degrees(-90))
            .frame(width: size + 14, height: size + 14)
            .allowsHitTesting(false)
            .onAppear { withAnimation(.linear(duration: 0.28)) { progress = 1 } }
    }
}

/// Keypad keys darken their fill over 120ms with NO scale (motion spec A·7).
struct KeyButtonStyle: ButtonStyle {
    let palette: Pal.Palette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(palette.keyBg, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).fill(palette.ink.opacity(configuration.isPressed ? 0.12 : 0)))
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - Native text bridge

/// A UIKit-backed label for compact field copy. The system accessibility
/// audit currently misidentifies equivalent SwiftUI text as a synthetic node;
/// UIKit keeps the rendered label and its audit element aligned.
struct NativeTextLabel: View {
    enum Design {
        case system
        case monospaced
        case monospacedDigits
    }

    let text: String
    let size: CGFloat
    let weight: Font.Weight
    let color: Color
    var design: Design = .system

    var body: some View {
#if canImport(UIKit)
        UIKitTextLabel(
            text: text,
            size: size,
            weight: weight,
            color: color,
            design: design
        )
        .fixedSize()
#else
        switch design {
        case .system:
            Text(text)
                .font(NumaFont.system(size, weight: weight))
                .foregroundStyle(color)
        case .monospaced:
            Text(text)
                .font(NumaFont.mono(size, weight: weight))
                .foregroundStyle(color)
        case .monospacedDigits:
            Text(text)
                .font(NumaFont.system(size, weight: weight).monospacedDigit())
                .foregroundStyle(color)
        }
#endif
    }
}

#if canImport(UIKit)
private struct UIKitTextLabel: UIViewRepresentable {
    let text: String
    let size: CGFloat
    let weight: Font.Weight
    let color: Color
    let design: NativeTextLabel.Design

    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.adjustsFontForContentSizeCategory = true
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.7
        label.numberOfLines = 1
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .horizontal)
        return label
    }

    func updateUIView(_ label: UILabel, context: Context) {
        label.text = text
        let baseFont: UIFont
        switch design {
        case .system:
            baseFont = UIFont.systemFont(ofSize: size, weight: NumaFont.uiWeight(weight))
        case .monospaced:
            baseFont = UIFont.monospacedSystemFont(ofSize: size, weight: NumaFont.uiWeight(weight))
        case .monospacedDigits:
            baseFont = UIFont.monospacedDigitSystemFont(ofSize: size, weight: NumaFont.uiWeight(weight))
        }
        label.font = UIFontMetrics(forTextStyle: NumaFont.uiTextStyle(for: size))
            .scaledFont(for: baseFont)
        label.textColor = UIColor(color)
    }
}

struct NativeCapsuleButton: UIViewRepresentable {
    let title: String
    let foregroundColor: Color
    let backgroundColor: Color
    let accessibilityIdentifier: String
    let reduceMotion: Bool
    let action: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    func makeUIView(context: Context) -> CapsuleUIButton {
        let button = CapsuleUIButton(type: .custom)
        button.addTarget(
            context.coordinator,
            action: #selector(Coordinator.activate),
            for: .touchUpInside
        )
        return button
    }

    func updateUIView(_ button: CapsuleUIButton, context: Context) {
        context.coordinator.action = action
        if button.currentTitle != nil,
           button.currentTitle != title,
           !reduceMotion {
            let transition = CATransition()
            transition.duration = 0.2
            transition.timingFunction = CAMediaTimingFunction(name: .easeOut)
            transition.type = .push
            transition.subtype = .fromTop
            button.titleLabel?.layer.add(transition, forKey: "numa-numeric-title")
        }
        button.setTitle(title, for: .normal)
        button.setTitleColor(UIColor(foregroundColor), for: .normal)
        button.backgroundColor = UIColor(backgroundColor)
        button.accessibilityLabel = title
        button.accessibilityIdentifier = accessibilityIdentifier
        button.titleLabel?.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(
            for: UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        )
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.invalidateIntrinsicContentSize()
    }

    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func activate() {
            action()
        }
    }

    final class CapsuleUIButton: UIButton {
        override var intrinsicContentSize: CGSize {
            let size = super.intrinsicContentSize
            return CGSize(width: size.width + 28, height: max(40, size.height))
        }

        override var isHighlighted: Bool {
            didSet {
                UIView.animate(
                    withDuration: 0.15,
                    delay: 0,
                    options: [.allowUserInteraction, .beginFromCurrentState]
                ) {
                    self.transform = self.isHighlighted
                        ? CGAffineTransform(scaleX: 0.97, y: 0.97)
                        : .identity
                }
            }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            layer.cornerRadius = bounds.height / 2
            clipsToBounds = true
        }
    }
}
#endif

// MARK: - Haptics (prepared generators; fired only at the spec's moments)

// UIKit-gated so the pure-logic files that call Haptics (AppModel) still
// compile on macOS for the swiftc test harness in Tests/LedgerTests.swift.
#if canImport(UIKit)
enum Haptics {
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private static let notice = UINotificationFeedbackGenerator()
    static func prepare() { soft.prepare(); rigid.prepare(); notice.prepare() }
    /// One response to activating the Add row; never an idle effect.
    static func activated() { soft.impactOccurred() }
    /// .soft exactly when a firm-hold FIRES — never on touch-down.
    static func holdFired() { soft.impactOccurred() }
    /// .rigid at the exact magnetize-lock moment — lock transitions only.
    static func locked() { rigid.impactOccurred() }
    /// .success only after local persistence returns — never on button press.
    static func saved() { notice.notificationOccurred(.success) }
    static func warned() { notice.notificationOccurred(.warning) }
}
#else
enum Haptics {
    static func prepare() {}
    static func activated() {}
    static func holdFired() {}
    static func locked() {}
    static func saved() {}
    static func warned() {}
}
#endif

// MARK: - Participant avatar (shared by discs, rows, pickers)

/// The flat fill + identity initials for one settlement unit. `isWoven`
/// units (the household group) get a pearl core with a two-hue conic ring —
/// "the members' hues share one ring around a pearl core" per the design's
/// decision log (D06). Everyone else gets a flat identity-color fill.
struct AvatarView: View {
    let unit: UnitInfo
    let size: CGFloat
    let palette: Pal.Palette
    var haloed: Bool = false
    var selected: Bool = false
    var initialsFont: Font? = nil

    var body: some View {
        ZStack {
            Circle()
                .fill(unit.isWoven ? palette.discFill : unit.color)
            if unit.isWoven {
                Circle()
                    .strokeBorder(Pal.wovenRing, lineWidth: max(2, size * 0.045))
                    .padding(-size * 0.08)
            }
            Text(unit.initials)
                .font(initialsFont ?? NumaFont.rounded(size * 0.34, weight: .semibold))
                .foregroundStyle(unit.isWoven ? palette.ink : unit.inkColor)
                .accessibilityHidden(true)
            if haloed {
                Circle()
                    .strokeBorder(palette.ink.opacity(0.6), style: StrokeStyle(lineWidth: 2.5, dash: [4, 4]))
                    .padding(-size * 0.22)
            }
            if selected {
                Circle()
                    .fill(palette.ink)
                    .frame(width: size * 0.32, height: size * 0.32)
                    .overlay(Image(systemName: "checkmark").font(.system(size: size * 0.16, weight: .bold)).foregroundStyle(palette.bg))
                    .overlay(Circle().stroke(palette.bg, lineWidth: 2))
                    .offset(x: size * 0.36, y: -size * 0.36)
                    .transition(.scale(scale: 0.95).combined(with: .opacity))
            }
        }
        .frame(width: size, height: size)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: selected)
    }
}

// MARK: - Shared-table identity and purposeful Add object

/// Redundant color geometry sits beside the full semantic name, never inside a
/// fixed-size text avatar. Couple identity has two overlapping shapes.
struct SharedIdentityMark: View {
    let unit: UnitInfo
    let background: Color
    var body: some View {
        HStack(spacing: -10) {
            Circle().fill(unit.isWoven && unit.color == .clear ? Pal.teal : unit.color)
                .overlay(Circle().stroke(background, lineWidth: 2))
            if unit.isWoven {
                Circle().fill(unit.isWoven && unit.color == .clear ? Pal.teal : unit.color)
                    .overlay(Circle().stroke(background, lineWidth: 2))
            }
        }
        .frame(width: unit.isWoven ? 46 : 28, height: 28)
        .accessibilityHidden(true)
    }
}

struct SharedOrbButtonStyle: ButtonStyle {
    var reduceMotion: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(reduceMotion ? 1 : configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: configuration.isPressed ? 0.12 : 0.22), value: configuration.isPressed)
    }
}

/// Native shaded geometry: no bitmap, timeline, autonomous shimmer, or shader
/// work offscreen. The object is orange in every financial state.
struct VesselView: View {
    let palette: Pal.Palette
    var size: CGFloat = 84
    var content: Content = .plus
    var ringUnits: [UnitID] = []
    var beadUnits: [UnitID] = []
    var unitInfos: [UnitID: UnitInfo] = AllUnits
    var rotation: CGSize = .zero
    var isEngaged = false
    var reduceTransparency = false
    var pulseDate: Date? = nil
    var stillsShimmer = false
    var contentFont: Font? = nil
    var beadFont: Font? = nil
    enum Content { case plus, amount(String) }

    var body: some View {
        ZStack {
            if !reduceTransparency {
                Circle().fill(Color(hex: 0xB14534).opacity(0.22))
                    .frame(width: max(0, size - 16), height: max(0, size - 16))
                    .blur(radius: 9).offset(y: 13)
            }
            Circle().fill(Pal.orange)
            if !reduceTransparency {
                Circle().fill(RadialGradient(
                    stops: [.init(color: Color(hex: 0xFFD1A0), location: 0),
                            .init(color: Color(hex: 0xFBA574), location: 0.15),
                            .init(color: Color(hex: 0xFA6538), location: 0.43),
                            .init(color: Color(hex: 0xDC4424), location: 0.70),
                            .init(color: Color(hex: 0x993724), location: 1)],
                    center: UnitPoint(x: 0.31, y: 0.24), startRadius: 0, endRadius: size * 1.0265
                )
                    .shadow(.inner(color: .white.opacity(0.333), radius: 3, x: 2, y: 2))
                    .shadow(.inner(color: Color(hex: 0x902F22).opacity(0.29), radius: 13, x: -5, y: -7)))
                Ellipse().fill(LinearGradient(colors: [.white.opacity(0.53), .white.opacity(0)], startPoint: .top, endPoint: .bottom))
                    .frame(width: size * 0.40, height: size * 0.18)
                    .rotationEffect(.degrees(-24)).offset(x: -size * 0.12, y: -size * 0.30)
            }
            switch content {
            case .plus:
                HomeIcon(kind: .plus, size: size * 0.37)
                    .foregroundStyle(Pal.orangeInk)
            case .amount(let value):
                Text(value).font(contentFont ?? .title2.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(Pal.orangeInk)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Activity row

/// A Dynamic Type label that uses the row's available width instead of
/// extending its intrinsic width beyond the screen. Keep the UIKit bridge:
/// compact SwiftUI labels have exposed synthetic accessibility nodes on iOS 27.
struct WrappingTextLabel: View {
    let text: String
    let size: CGFloat
    let weight: Font.Weight
    let color: Color
    var alignment: TextAlignment = .leading

    var body: some View {
#if canImport(UIKit)
        UIKitWrappingLabel(text: text, size: size, weight: weight, color: color, alignment: alignment)
#else
        Text(text)
            .font(NumaFont.system(size, weight: weight))
            .foregroundStyle(color)
            .multilineTextAlignment(alignment)
            .fixedSize(horizontal: false, vertical: true)
#endif
    }
}

#if canImport(UIKit)
private struct UIKitWrappingLabel: UIViewRepresentable {
    let text: String
    let size: CGFloat
    let weight: Font.Weight
    let color: Color
    let alignment: TextAlignment

    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .vertical)
        return label
    }

    func updateUIView(_ label: UILabel, context: Context) {
        label.text = text
        label.font = NumaFont.scaledUIFont(size, weight: weight, design: nil)
        label.textColor = UIColor(color)
        label.textAlignment = switch alignment {
        case .leading: .natural
        case .center: .center
        case .trailing: UIApplication.shared.userInterfaceLayoutDirection == .rightToLeft ? .left : .right
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView label: UILabel, context: Context) -> CGSize? {
        let width = proposal.width ?? .greatestFiniteMagnitude
        let fitted = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: min(width, ceil(fitted.width)), height: ceil(fitted.height))
    }
}
#endif

struct ActivityRowView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let record: ExpenseRecord
    let palette: Pal.Palette
    let amountText: String
    var showsSyncState = false
    var unitInfos: [UnitID: UnitInfo] = AllUnits
    var subtitleText: String?

    var visibleDeliveryCopy: String? {
        guard showsSyncState || record.deliveryState == .failed else { return nil }
        return record.deliveryCopy
    }

    private var identityMark: some View {
        SharedIdentityMark(unit: unitInfos[record.payer] ?? unitInfo(for: record.payer), background: palette.bg)
    }

    private var titleLabel: some View {
        WrappingTextLabel(text: record.title, size: 17, weight: .semibold, color: record.voided ? palette.ink3 : palette.ink)
    }

    @ViewBuilder
    private var badgeView: some View {
        if let badge = record.badge {
            WrappingTextLabel(text: badge, size: 11, weight: .regular, color: palette.ink)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .overlay(Capsule().stroke(palette.ink2, lineWidth: 1.5))
        }
    }

    private var detailLines: some View {
        VStack(alignment: .leading, spacing: 1) {
            WrappingTextLabel(text: subtitleText ?? record.subtitle, size: 12, weight: .regular, color: palette.ink)
            if record.kind == .expense || record.kind == .personal || record.kind == .expenseRevision {
                WrappingTextLabel(
                    text: "Paid by \(record.payerDisplayName ?? "person not recorded")",
                    size: 12,
                    weight: .regular,
                    color: palette.ink2
                )
            }
            if let deliveryCopy = visibleDeliveryCopy {
                WrappingTextLabel(text: deliveryCopy, size: 11, weight: .medium, color: palette.ink3)
            }
        }
    }

    private var amountView: some View {
        // Even the largest supported minor-unit value remains visible at AX
        // sizes: wrapping is preferable to reducing or truncating money text.
        WrappingTextLabel(text: amountText, size: 17, weight: .semibold, color: palette.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var stackedContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            identityMark
            titleLabel
            badgeView
            detailLines
            amountView
        }
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                stackedContent
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        identityMark
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                titleLabel.layoutPriority(1)
                                badgeView
                            }
                            detailLines
                        }
                        Spacer(minLength: 4)
                        amountView.fixedSize(horizontal: true, vertical: true)
                    }
                    // A long title or large amount must not squeeze the other
                    // text into a sliver even at ordinary Dynamic Type sizes.
                    stackedContent
                }
            }
        }
        // The containing Button owns the complete row, including the UIKit
        // labels and blank space between them.
        .allowsHitTesting(false)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, minHeight: Metrics.minTarget, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Buttons

struct PrimaryPillButton: View {
    let title: String
    let palette: Pal.Palette
    var height: CGFloat = 54
    let action: () -> Void
    var body: some View {
        // Fill lives inside the label so the whole pill compresses on touch-down.
        Button(action: action) {
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, minHeight: height)
                .foregroundStyle(palette.bg)
                .background(palette.ink, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressableButtonStyle())
    }
}

struct SecondaryPillButton: View {
    let title: String
    let palette: Pal.Palette
    var height: CGFloat = 52
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20).padding(.vertical, 14)
                .frame(maxWidth: .infinity, minHeight: height)
                .contentShape(Capsule())
                .foregroundStyle(palette.ink)
                .overlay(Capsule().stroke(palette.ink, lineWidth: 1.5))
        }
        .buttonStyle(PressableButtonStyle())
    }
}

struct CloseCircleButton: View {
    let palette: Pal.Palette
    let action: () -> Void
    var systemImage = "xmark"
    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 44, height: 44)
                .foregroundStyle(palette.ink2)
                .background(palette.chip, in: Circle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(
            systemImage == "chevron.left"
                ? String(localized: "Back")
                : String(localized: "Close")
        )
    }
}

// MARK: - Amount keypad

struct AmountKeypadView: View {
    let palette: Pal.Palette
    let decimalDimmed: Bool
    let onKey: (String) -> Void
    private var decimalSeparator: String { Locale.current.decimalSeparator ?? "." }
    private var keys: [String] {
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", decimalSeparator, "0", "⌫"]
    }

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
            ForEach(keys, id: \.self) { k in
                let isDecimal = k == decimalSeparator
                Button { onKey(k) } label: {
                    Group {
                        if k == "⌫" {
                            Image(systemName: "delete.left")
                        } else {
                            Text(k)
                        }
                    }
                    .font(.title2.monospacedDigit())
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 47).padding(.vertical, 4).contentShape(Rectangle())
                }
                .accessibilityLabel(
                    k == "⌫" ? String(localized: "Delete digit") : k
                )
                .foregroundStyle(palette.ink)
                .opacity(isDecimal && decimalDimmed ? 0.35 : 1)
                .buttonStyle(KeyButtonStyle(palette: palette))
                .accessibilityIdentifier(k == "⌫" ? "key-delete" : "key-\(isDecimal ? "decimal" : k)")
            }
        }
    }
}

// MARK: - Sheet chrome

struct SheetGrabber: View {
    let palette: Pal.Palette
    var body: some View {
        Capsule().fill(palette.hair).frame(width: 36, height: 5).padding(.top, 8)
    }
}

struct UndoBar: View {
    let text: String
    let palette: Pal.Palette
    let onUndo: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            Text(text).font(.subheadline.monospacedDigit())
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(action: onUndo) {
                Text("Undo").font(.subheadline.bold())
                    .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(palette.bg)
        .padding(.leading, 18).padding(.trailing, 6).padding(.vertical, 4)
        .background(palette.ink, in: RoundedRectangle(cornerRadius: 24))
    }
}
