import Foundation

// MARK: - Input

/// Keys understood by the exact minor-unit entry state machine.
public enum MoneyInputKey: Hashable, Sendable {
    case digit(Int)
    case decimalSeparator
    case backspace
}

/// A UI-independent digit-entry state that respects the currency exponent.
public struct MoneyInput: Hashable, Sendable {
    public let wholeDigits: String
    public let fractionalDigits: String?

    /// Accepts Unicode decimal digits and stores ASCII digits for exact
    /// conversion and keypad editing. Separators belong to the caller.
    public init(wholeDigits: String = "", fractionalDigits: String? = nil) throws {
        self.wholeDigits = try Self.normalizedDigits(wholeDigits)
        self.fractionalDigits = try fractionalDigits.map(Self.normalizedDigits)
    }

    private static func normalizedDigits(_ value: String) throws -> String {
        var normalized = ""
        for character in value {
            guard character.unicodeScalars.count == 1,
                  character.unicodeScalars.allSatisfy(CharacterSet.decimalDigits.contains),
                  let digit = character.wholeNumberValue,
                  (0 ... 9).contains(digit)
            else { throw MoneyError.invalidInput }
            normalized.append(String(digit))
        }
        return normalized
    }

    public func applying(
        _ key: MoneyInputKey,
        currency: Currency,
        maximumWholeDigits: Int = 6
    ) -> MoneyInput {
        var whole = wholeDigits
        var fraction = fractionalDigits

        switch key {
        case let .digit(digit):
            guard (0 ... 9).contains(digit) else { return self }
            let character = String(digit)
            if fraction == nil {
                guard whole.count < maximumWholeDigits else { return self }
                whole = whole == "0" || whole.isEmpty ? character : whole + character
            } else if let currentFraction = fraction,
                      currentFraction.count < currency.exponent {
                fraction = currentFraction + character
            }
        case .decimalSeparator:
            if currency.exponent > 0, fraction == nil {
                fraction = ""
            }
        case .backspace:
            if let currentFraction = fraction {
                fraction = currentFraction.isEmpty ? nil : String(currentFraction.dropLast())
            } else {
                whole = String(whole.dropLast())
            }
        }

        return MoneyInput(validatedWholeDigits: whole, fractionalDigits: fraction)
    }

    public func money(currency: Currency) throws -> Money {
        guard let whole = Int64(wholeDigits.isEmpty ? "0" : wholeDigits),
              let fraction = fractionalMinorUnits(exponent: currency.exponent)
        else {
            throw MoneyError.invalidInput
        }
        let (scaledWhole, multiplyOverflow) = whole.multipliedReportingOverflow(
            by: currency.minorUnitScale
        )
        let (minorUnits, addOverflow) = scaledWhole.addingReportingOverflow(fraction)
        guard !multiplyOverflow, !addOverflow else { throw MoneyError.arithmeticOverflow }
        return Money(minorUnits: minorUnits, currency: currency)
    }

    private init(validatedWholeDigits: String, fractionalDigits: String?) {
        wholeDigits = validatedWholeDigits
        self.fractionalDigits = fractionalDigits
    }

    private func fractionalMinorUnits(exponent: Int) -> Int64? {
        let digits = fractionalDigits ?? ""
        guard exponent > 0 else { return digits.isEmpty ? 0 : nil }
        guard digits.count <= exponent else { return nil }
        let padded = digits + String(repeating: "0", count: exponent - digits.count)
        return Int64(padded.isEmpty ? "0" : padded)
    }
}
