import Foundation

// MARK: - Formatting

/// Fraction rendering choices for display-only money formatting.
public enum MoneyFractionDisplay: Hashable, Sendable {
    case automatic
    case always
}

/// Locale-aware `FormatStyle` rendering that converts integer minor units
/// through Decimal, never through binary floating point.
public enum MoneyFormatter {
    public static func string(
        from money: Money,
        locale: Locale = .current,
        fractionDisplay: MoneyFractionDisplay = .automatic
    ) -> String {
        string(
            decimalMinorUnits: Decimal(money.minorUnits),
            currency: money.currency,
            locale: locale,
            fractionDigits: fractionDisplay == .always ? money.currency.exponent : nil
        )
    }

    /// Formats an exact Decimal total expressed in the currency's minor units.
    ///
    /// This overload accepts totals outside `Int64` while keeping exponent and
    /// locale handling identical to ordinary `Money` values.
    public static func string(
        decimalMinorUnits: Decimal,
        currency: Currency,
        locale: Locale = .current,
        fractionDigits: Int? = nil
    ) -> String {
        let majorUnits = decimalMinorUnits / Decimal(currency.minorUnitScale)
        let digits = resolvedFractionDigits(
            majorUnits: majorUnits,
            currency: currency,
            requested: fractionDigits
        )
        let style = Decimal.FormatStyle.Currency(code: currency.code)
            .locale(locale)
            .precision(.fractionLength(digits))
        return majorUnits.formatted(style).replacingOccurrences(of: "-", with: "−")
    }

    /// Produces a locale-positioned currency mask without exposing an amount.
    public static func hiddenString(currency: Currency, locale: Locale = .current) -> String {
        let visibleZero = string(
            from: .zero(currency: currency),
            locale: locale,
            fractionDisplay: .automatic
        )
        var output = ""
        var insertedMask = false
        for character in visibleZero {
            if character.wholeNumberValue != nil {
                if !insertedMask {
                    output.append("•••")
                    insertedMask = true
                }
            } else {
                output.append(character)
            }
        }
        return insertedMask ? output : "••• \(currency.code)"
    }

    private static func resolvedFractionDigits(
        majorUnits: Decimal,
        currency: Currency,
        requested: Int?
    ) -> Int {
        if let requested { return max(0, min(currency.exponent, requested)) }
        var value = majorUnits
        var integral = Decimal()
        NSDecimalRound(&integral, &value, 0, .down)
        return integral == majorUnits ? 0 : currency.exponent
    }
}
