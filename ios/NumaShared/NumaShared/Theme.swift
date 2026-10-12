import NumaSharedCore
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Owner-approved “shared table”: warm content, expressive Home and stable identity hues.
enum Pal {
    struct Palette {
        let bg: Color
        let surface: Color
        let ink: Color
        let ink2: Color
        let ink3: Color
        let hair: Color
        let chip: Color
        let attn: Color
        let glass: Color
        let glassBorder: Color
        let scrim: Color
        let undoDivider: Color
        let kpBg: Color
        let keyBg: Color
        let discFill: Color
        let vesselBg: [Color]
        let vesselBorder: Color
        let vesselShadow: Color
        let isDark: Bool

        var home: Color { isDark ? Color(hex: 0x3E3E28) : Pal.butter }
        var homeSecondary: Color { isDark ? ink2 : Color(hex: 0x655832) }
        var identityInk: Color { Color(hex: 0x252B27) }
    }

    static let light = Palette(
        bg: Color(hex: 0xF8F6F0),
        surface: Color(hex: 0xFFFFFF),
        ink: Color(hex: 0x252B27),
        ink2: Color(hex: 0x62655D),
        ink3: Color(hex: 0x62655D),
        hair: Color(hex: 0xDEDCD1),
        chip: Color(hex: 0xEEEBE2),
        attn: Color(hex: 0x8A5C0B),
        glass: Color.white.opacity(0.66),
        glassBorder: Color.white.opacity(0.8),
        scrim: Color(hex: 0x1C211E).opacity(0.30),
        undoDivider: Color.white.opacity(0.25),
        kpBg: Color(hex: 0xF8F6F0),
        keyBg: Color(hex: 0xFFFFFF),
        discFill: Color(hex: 0xF8F6F0),
        vesselBg: [Color.white.opacity(0.95), Color(hex: 0xE6ECEE).opacity(0.5)],
        vesselBorder: Color.white.opacity(0.95),
        vesselShadow: Color(hex: 0x252B27).opacity(0.18),
        isDark: false
    )

    static let dark = Palette(
        bg: Color(hex: 0x1C211E),
        surface: Color(hex: 0x282F29),
        ink: Color(hex: 0xF8F6F0),
        ink2: Color(hex: 0xC4C8BC),
        ink3: Color(hex: 0xADB3A5),
        hair: Color(hex: 0x454D42),
        chip: Color(hex: 0x343C33),
        attn: Color(hex: 0xE5A84B),
        glass: Color(hex: 0x282F29).opacity(0.72),
        glassBorder: Color.white.opacity(0.14),
        scrim: Color.black.opacity(0.5),
        undoDivider: Color(hex: 0x1C211E).opacity(0.25),
        kpBg: Color(hex: 0x1C211E),
        keyBg: Color(hex: 0x343C33),
        discFill: Color(hex: 0x343C33),
        vesselBg: [Color(hex: 0x3E4854).opacity(0.75), Color(hex: 0x161C23).opacity(0.55)],
        vesselBorder: Color.white.opacity(0.22),
        vesselShadow: Color.black.opacity(0.5),
        isDark: true
    )

    static let butter = Color(hex: 0xF4DE8A)
    static let orange = Color(hex: 0xE9522D)
    static let orangeInk = Color(hex: 0x572B20)

    // Identity hues — accessible ink pairings, identity only, never financial meaning.
    static let indigo = Color(hex: 0x52672B)
    static let purple = Color(hex: 0xCAB8ED)
    static let purpleInk = Color(hex: 0x302440)
    static let teal = Color(hex: 0xD8EF7F)
    static let tealInk = Color(hex: 0x303C1E)
    static let amber = Color(hex: 0xBBD8EA)
    static let amberInk = Color(hex: 0x243B47)
    static let destructive = Color(hex: 0xBE3A4A)

    static let wovenRing = AngularGradient(
        gradient: Gradient(colors: [indigo, purple, indigo]),
        center: .center,
        startAngle: .degrees(200),
        endAngle: .degrees(560)
    )
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

enum Metrics {
    // Spacing — 4pt base.
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let space5: CGFloat = 20
    static let space6: CGFloat = 24

    // Radii — concentric with hardware.
    static let radiusS: CGFloat = 12
    static let radiusM: CGFloat = 16
    static let radiusL: CGFloat = 20
    static let sheetRadius: CGFloat = 34
    static let pill: CGFloat = 100

    // Minimum tap target per the design's accessibility notes.
    static let minTarget: CGFloat = 44
    static let minOrdinaryText: CGFloat = 11

    // Magnetic capture physics (from the source prototype's drag engine).
    static let captureRadius: CGFloat = 46
    static let exitRadius: CGFloat = 66
    static let approachRadius: CGFloat = 80
}

enum NumaFont {
    static func display(_ size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
        .custom("BricolageGrotesque-Bold", size: size, relativeTo: style)
    }

    /// Optical half-leading for explicit approved default-size line boxes.
    /// This does not constrain or measure wrapping; scaled text uses natural layout.
    static func referenceLeadingInset(size: CGFloat, lineHeight: CGFloat) -> CGFloat {
#if canImport(UIKit)
        guard let font = UIFont(name: "BricolageGrotesque-Bold", size: size) else { return 0 }
        return max(0, (font.lineHeight - lineHeight) / 2)
#else
        return 0
#endif
    }

    static func rounded(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        dynamic(size, weight: weight, design: .rounded)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        dynamic(size, weight: weight, design: .monospaced)
    }

    static func system(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        dynamic(size, weight: weight, design: nil)
    }

    private static func dynamic(
        _ size: CGFloat,
        weight: Font.Weight,
        design: UIFontDescriptor.SystemDesign?
    ) -> Font {
#if canImport(UIKit)
        Font(scaledUIFont(size, weight: weight, design: design))
#else
        return .system(size: size, weight: weight)
#endif
    }

#if canImport(UIKit)
    static func scaledUIFont(
        _ size: CGFloat,
        weight: Font.Weight,
        design: UIFontDescriptor.SystemDesign?
    ) -> UIFont {
        let systemFont = UIFont.systemFont(ofSize: size, weight: uiWeight(weight))
        let descriptor = design.flatMap(systemFont.fontDescriptor.withDesign)
            ?? systemFont.fontDescriptor
        let designedFont = UIFont(descriptor: descriptor, size: size)
        return UIFontMetrics(forTextStyle: uiTextStyle(for: size))
            .scaledFont(for: designedFont)
    }

    static func uiWeight(_ weight: Font.Weight) -> UIFont.Weight {
        if weight == .ultraLight { return .ultraLight }
        if weight == .thin { return .thin }
        if weight == .light { return .light }
        if weight == .medium { return .medium }
        if weight == .semibold { return .semibold }
        if weight == .bold { return .bold }
        if weight == .heavy { return .heavy }
        if weight == .black { return .black }
        return .regular
    }

    static func uiTextStyle(for size: CGFloat) -> UIFont.TextStyle {
        switch size {
        case ..<10: .caption2
        case ..<12: .caption1
        case ..<14: .footnote
        case ..<16: .subheadline
        case ..<20: .body
        case ..<23: .title3
        case ..<27: .title2
        case ..<35: .title1
        default: .largeTitle
        }
    }
#endif

}

/// Formats exact minor units with the viewing device's currency conventions.
nonisolated func money(
    _ cents: Int64,
    forceCents: Bool = false,
    hidden: Bool = false,
    locale: Locale = .current
) -> String {
    let currency = Currency.eur
    if hidden {
        return MoneyFormatter.hiddenString(currency: currency, locale: locale)
    }
    return MoneyFormatter.string(
        from: Money(minorUnits: cents, currency: currency),
        locale: locale,
        fractionDisplay: forceCents ? .always : .automatic
    )
}

nonisolated func moneyMagnitude(
    _ cents: Int64,
    forceCents: Bool = false,
    hidden: Bool = false,
    locale: Locale = .current
) -> String {
    guard let magnitude = Int64(exactly: cents.magnitude) else {
        let signed = money(
            cents,
            forceCents: forceCents,
            hidden: hidden,
            locale: locale
        )
        if signed.first == "−" || signed.first == "-" {
            return String(signed.dropFirst())
        }
        return signed
    }
    return money(
        magnitude,
        forceCents: forceCents,
        hidden: hidden,
        locale: locale
    )
}

nonisolated func money(
    decimalMinorUnits: Decimal,
    currency: Currency = .eur,
    fractionDigits: Int? = nil,
    hidden: Bool = false,
    locale: Locale = .current
) -> String {
    if hidden {
        return MoneyFormatter.hiddenString(currency: currency, locale: locale)
    }
    return MoneyFormatter.string(
        decimalMinorUnits: decimalMinorUnits,
        currency: currency,
        locale: locale,
        fractionDigits: fractionDigits
    )
}
