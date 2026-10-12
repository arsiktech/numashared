import SwiftUI
import UIKit
import XCTest
@testable import NumaShared

final class IdentityColorContrastTests: XCTestCase {
    @MainActor
    func testOrdinaryInterfaceMinimumsMatchTheDesignContract() {
        XCTAssertEqual(Metrics.minTarget, 44)
        XCTAssertEqual(Metrics.minOrdinaryText, 11)
    }

    @MainActor
    func testDynamicSystemFontsDoNotResolveToFallbackSerif() {
        let fonts = [
            NumaFont.scaledUIFont(14, weight: .semibold, design: nil),
            NumaFont.scaledUIFont(14, weight: .semibold, design: .rounded),
            NumaFont.scaledUIFont(14, weight: .regular, design: .monospaced),
        ]

        for font in fonts {
            XCTAssertFalse(font.familyName.localizedCaseInsensitiveContains("Times"))
        }
    }

    @MainActor
    func testApprovedDisplayFontIsBundledAndScales() throws {
        let font = try XCTUnwrap(UIFont(name: "BricolageGrotesque-Bold", size: 32))
        let large = UIFontMetrics(forTextStyle: .title1).scaledFont(for: font,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge))
        XCTAssertGreaterThan(large.pointSize, font.pointSize)
        XCTAssertEqual(font.familyName, "Bricolage Grotesque")
    }

    @MainActor
    func testIdentityInkPairingsMeetTextContrastMinimum() throws {
        let pairs: [(name: String, foreground: Color, background: Color)] = [
            ("teal", Pal.tealInk, Pal.teal),
            ("amber", Pal.amberInk, Pal.amber),
            ("light woven", Pal.light.ink, Pal.light.discFill),
            ("dark woven", Pal.dark.ink, Pal.dark.discFill),
        ]

        for pair in pairs {
            let ratio = try contrastRatio(
                foreground: pair.foreground,
                background: pair.background
            )
            XCTAssertGreaterThanOrEqual(
                ratio,
                4.5,
                "\(pair.name) identity ink must retain 4.5:1 text contrast"
            )
        }
    }

    @MainActor
    func testEvenLineMeetsMeaningfulGraphicContrastMinimum() throws {
        let pairs: [(name: String, foreground: Color, background: Color)] = [
            ("light", Pal.light.ink2, Pal.light.bg),
            ("dark", Pal.dark.ink2, Pal.dark.bg),
        ]

        for pair in pairs {
            let ratio = try contrastRatio(
                foreground: pair.foreground,
                background: pair.background
            )
            XCTAssertGreaterThanOrEqual(
                ratio,
                3,
                "\(pair.name) even line must retain 3:1 graphic contrast"
            )
        }
    }

    @MainActor
    func testPrimaryTextMeetsTextContrastMinimumOnActivitySurface() throws {
        let pairs: [(name: String, foreground: Color, background: Color)] = [
            ("light", Pal.light.ink, Pal.light.surface),
            ("dark", Pal.dark.ink, Pal.dark.surface),
        ]

        for pair in pairs {
            let ratio = try contrastRatio(
                foreground: pair.foreground,
                background: pair.background
            )
            XCTAssertGreaterThanOrEqual(
                ratio,
                4.5,
                "\(pair.name) activity text must retain 4.5:1 text contrast"
            )
        }
    }

    @MainActor
    func testSurfaceTextPairingsMeetTextContrastMinimum() throws {
        // Deterministic WCAG math for every text-on-surface pair the home
        // screen composes. The system audit's pixel sampler has proven
        // unstable on synthetic element-less nodes (same build flips
        // pass/fail — DECISIONS.md 2026-07-18), so the real contrast
        // contract is enforced here.
        for (paletteName, palette) in [("light", Pal.light), ("dark", Pal.dark)] {
            let pairs: [(name: String, foreground: Color, background: Color)] = [
                ("ink on butter Home", palette.ink, palette.home),
                ("secondary on butter Home", palette.homeSecondary, palette.home),
                ("ink on canvas", palette.ink, palette.bg),
                ("ink on surface", palette.ink, palette.surface),
                ("ink on chip", palette.ink, palette.chip),
                ("canvas ink on ink fill", palette.bg, palette.ink),
                ("secondary ink on canvas", palette.ink2, palette.bg),
                ("secondary ink on surface", palette.ink2, palette.surface),
            ]
            for pair in pairs {
                let ratio = try contrastRatio(
                    foreground: pair.foreground,
                    background: pair.background
                )
                XCTAssertGreaterThanOrEqual(
                    ratio,
                    4.5,
                    "\(paletteName) \(pair.name) must retain 4.5:1 text contrast"
                )
            }
        }
    }

    @MainActor
    func testHomeSettleControlMeetsContrastMinimum() throws {
        for (paletteName, palette) in [("light", Pal.light), ("dark", Pal.dark)] {
            let ratio = try contrastRatio(
                foreground: palette.bg,
                background: palette.ink
            )
            XCTAssertGreaterThanOrEqual(
                ratio,
                4.5,
                "\(paletteName) settle label must retain 4.5:1 text contrast"
            )
        }
    }

    private func contrastRatio(foreground: Color, background: Color) throws -> Double {
        let foregroundLuminance = try luminance(foreground)
        let backgroundLuminance = try luminance(background)
        let lighter = max(foregroundLuminance, backgroundLuminance)
        let darker = min(foregroundLuminance, backgroundLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private func luminance(_ color: Color) throws -> Double {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha),
              alpha == 1
        else {
            throw ContrastError.nonOpaqueSRGBColor
        }

        func linear(_ component: CGFloat) -> Double {
            let value = Double(component)
            return value <= 0.04045
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }

        return 0.2126 * linear(red)
            + 0.7152 * linear(green)
            + 0.0722 * linear(blue)
    }

    private enum ContrastError: Error {
        case nonOpaqueSRGBColor
    }
}
