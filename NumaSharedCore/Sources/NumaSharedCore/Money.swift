import Foundation

// MARK: - Currency

/// Validation failures for ISO-shaped currency metadata.
public enum CurrencyError: Error, Equatable, Sendable {
    case invalidCode(String)
    case unsupportedExponent(Int)
}

/// A currency code and its number of stored minor-unit digits.
///
/// The code is deliberately ISO-shaped rather than an embedded ISO table so
/// server-delivered currencies do not require an app release. Exponents are
/// constrained to zero through four, covering ISO currencies and funds with
/// published minor-unit exponents without allowing an unbounded scale.
public struct Currency: Codable, Hashable, Sendable {
    public let code: String
    public let exponent: Int

    public init(code: String, exponent: Int) throws {
        guard code.count == 3,
              code.unicodeScalars.allSatisfy({ (65 ... 90).contains($0.value) })
        else {
            throw CurrencyError.invalidCode(code)
        }
        guard (0 ... 4).contains(exponent) else { throw CurrencyError.unsupportedExponent(exponent) }
        self.code = code
        self.exponent = exponent
    }

    public static let eur = Currency(validatedCode: "EUR", exponent: 2)
    public static let jpy = Currency(validatedCode: "JPY", exponent: 0)
    public static let bhd = Currency(validatedCode: "BHD", exponent: 3)

    public var minorUnitScale: Int64 {
        var scale: Int64 = 1
        for _ in 0 ..< exponent {
            scale *= 10
        }
        return scale
    }

    private init(validatedCode code: String, exponent: Int) {
        self.code = code
        self.exponent = exponent
    }

    private enum CodingKeys: String, CodingKey {
        case code
        case exponent
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            code: container.decode(String.self, forKey: .code),
            exponent: container.decode(Int.self, forKey: .exponent)
        )
    }
}

/// Currencies available when creating a pot, using the same code/exponent
/// contract as backend admission. Platform formatting metadata can include
/// retired codes or display precision that differs from stored minor units.
/// Existing and server-delivered currencies still decode through `Currency`.
public enum CurrencyCatalog {
    public static let all: [Currency] = CurrencyAdmissionV1.minorUnitExponents
        .compactMap { code, exponent in
            try? Currency(code: code, exponent: exponent)
        }
        .sorted { $0.code < $1.code }

    public static func currency(code: String) -> Currency? {
        all.first { $0.code == code }
    }

    public static func suggested(for locale: Locale = .current) -> Currency {
        guard let code = locale.currency?.identifier else { return .eur }
        return currency(code: code) ?? .eur
    }
}

// MARK: - Money

/// Arithmetic failures for integer money operations.
public enum MoneyError: Error, Equatable, Sendable {
    case currencyMismatch(expected: Currency, actual: Currency)
    case arithmeticOverflow
    case invalidInput
}

/// An exact amount represented exclusively in integer minor units.
public struct Money: Codable, Hashable, Sendable {
    public let minorUnits: Int64
    public let currency: Currency

    public init(minorUnits: Int64, currency: Currency) {
        self.minorUnits = minorUnits
        self.currency = currency
    }

    public static func zero(currency: Currency) -> Money {
        Money(minorUnits: 0, currency: currency)
    }

    public func adding(_ other: Money) throws -> Money {
        guard currency == other.currency else { throw MoneyError.currencyMismatch(expected: currency, actual: other.currency) }
        let (sum, overflow) = minorUnits.addingReportingOverflow(other.minorUnits)
        guard !overflow else { throw MoneyError.arithmeticOverflow }
        return Money(minorUnits: sum, currency: currency)
    }

    public func subtracting(_ other: Money) throws -> Money {
        guard currency == other.currency else { throw MoneyError.currencyMismatch(expected: currency, actual: other.currency) }
        let (difference, overflow) = minorUnits.subtractingReportingOverflow(other.minorUnits)
        guard !overflow else { throw MoneyError.arithmeticOverflow }
        return Money(minorUnits: difference, currency: currency)
    }
}
