import SwiftUI

/// The field's atmospheric backdrop — night sky in dark, porcelain sky in
/// light. Pure decoration behind the constellation: hit-testing off,
/// hidden from accessibility, frozen under Reduce Motion, Low Power, and
/// still-motion QA captures. Luminance hugs the canvas so every text
/// pair keeps its contract.
struct FieldSpaceView: View {
    let palette: Pal.Palette
    let lineY: CGFloat
    let size: CGSize
    var paused: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24.0, paused: paused)) { tl in
            Rectangle()
                .fill(.white)
                .colorEffect(ShaderLibrary.fieldSpace(
                    .boundingRect,
                    .float(Float(tl.date.timeIntervalSinceReferenceDate
                        .truncatingRemainder(dividingBy: 1200))),
                    .float(Float(lineY / max(size.height, 1))),
                    .float(palette.isDark ? 1 : 0),
                    .color(colors.baseTop),
                    .color(colors.baseBottom),
                    .color(colors.auroraA),
                    .color(colors.auroraB),
                    .color(colors.dust)
                ))
        }
        .frame(width: size.width, height: size.height)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Woven household hues only — atmosphere, never financial meaning.
    private var colors: (baseTop: Color, baseBottom: Color, auroraA: Color, auroraB: Color, dust: Color) {
        if palette.isDark {
            return (
                baseTop: Color(hex: 0x0C1014),
                baseBottom: Color(hex: 0x10161F),
                auroraA: Color(hex: 0x4A57B8),
                auroraB: Color(hex: 0x6B4FB0),
                dust: Color(hex: 0xC9D4E4).opacity(0.8)
            )
        }
        return (
            baseTop: Color(hex: 0xF4F6F6),
            baseBottom: Color(hex: 0xEDF1F6),
            auroraA: Color(hex: 0x8B97E8),
            auroraB: Color(hex: 0xA98FE0),
            dust: Color(hex: 0x8A96AC).opacity(0.55)
        )
    }
}
