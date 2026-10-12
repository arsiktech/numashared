import Foundation
import XCTest
@testable import NumaSharedCore

final class IdentifiersAndMoneyTests: XCTestCase {
    private struct FixedRandomNumberGenerator: RandomNumberGenerator {
        var value: UInt64

        mutating func next() -> UInt64 {
            defer { value &+= 1 }
            return value
        }
    }

    func testCurrencyRequiresISOShapedCodeAndSupportedExponent() throws {
        let eur = try Currency(code: "EUR", exponent: 2)

        XCTAssertEqual(eur.code, "EUR")
        XCTAssertEqual(eur.exponent, 2)
        XCTAssertThrowsError(try Currency(code: "eur", exponent: 2))
        XCTAssertThrowsError(try Currency(code: "EURO", exponent: 2))
        XCTAssertEqual(try Currency(code: "CLF", exponent: 4).exponent, 4)
        XCTAssertThrowsError(try Currency(code: "EUR", exponent: 5))
    }

    func testCurrencyCatalogContainsTheFullISOExponentMatrix() throws {
        let currencies = CurrencyCatalog.all

        XCTAssertGreaterThan(currencies.count, 150)
        XCTAssertEqual(currencies.map(\.code), currencies.map(\.code).sorted())
        XCTAssertEqual(Set(currencies.map(\.code)).count, currencies.count)
        XCTAssertEqual(CurrencyCatalog.currency(code: "JPY"), .jpy)
        XCTAssertEqual(CurrencyCatalog.currency(code: "EUR"), .eur)
        XCTAssertEqual(CurrencyCatalog.currency(code: "BHD"), .bhd)
        XCTAssertEqual(CurrencyCatalog.currency(code: "CLF")?.exponent, 4)
        // Foundation display precision is not the ISO minor-unit contract.
        XCTAssertEqual(CurrencyCatalog.currency(code: "HUF")?.exponent, 2)
        XCTAssertEqual(CurrencyCatalog.currency(code: "IDR")?.exponent, 2)
        XCTAssertEqual(CurrencyCatalog.currency(code: "IQD")?.exponent, 3)
        for code in ["DEM", "XAU", "XXX"] {
            XCTAssertNil(CurrencyCatalog.currency(code: code))
        }
        XCTAssertNil(CurrencyCatalog.currency(code: "ZZZ"))
    }

    func testCurrencyCatalogMatchesEveryBackendAdmissionPair() throws {
        // Source-bound parity check: these package tests run from the repository,
        // where the backend table is the new-pot admission source of truth.
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let backendSource = try String(
            contentsOf: repository.appendingPathComponent("convex/iso4217.ts"),
            encoding: .utf8
        ) as NSString
        let entryPattern = try NSRegularExpression(
            pattern: #"(?m)^\s*([A-Z]{3}): ([0-9]+),$"#
        )
        let matches = entryPattern.matches(
            in: backendSource as String,
            range: NSRange(location: 0, length: backendSource.length)
        )
        var backendExponents = [String: Int]()
        for match in matches {
            let code = backendSource.substring(with: match.range(at: 1))
            let exponent = try XCTUnwrap(Int(
                backendSource.substring(with: match.range(at: 2))
            ))
            XCTAssertNil(backendExponents.updateValue(exponent, forKey: code))
        }
        XCTAssertGreaterThan(backendExponents.count, 150)
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: CurrencyCatalog.all.map {
                ($0.code, $0.exponent)
            }),
            backendExponents
        )
    }

    func testCurrencySuggestionUsesAdmissionPrecisionAndFallsBackForUnsupportedCodes() {
        let suggested = CurrencyCatalog.suggested(
            for: Locale(identifier: "en_US@currency=HUF")
        )
        XCTAssertEqual(suggested, CurrencyCatalog.currency(code: "HUF"))
        XCTAssertEqual(suggested.exponent, 2)
        XCTAssertEqual(
            CurrencyCatalog.suggested(for: Locale(identifier: "en_US@currency=XXX")),
            .eur
        )
    }

    func testCurrencyDecodingPreservesExistingAndFutureMetadataOutsideCreationCatalog() throws {
        for currency in [
            try Currency(code: "HUF", exponent: 0),
            try Currency(code: "DEM", exponent: 2),
            try Currency(code: "ZZZ", exponent: 4),
        ] {
            XCTAssertEqual(
                try JSONDecoder().decode(Currency.self, from: JSONEncoder().encode(currency)),
                currency
            )
        }
    }

    func testUUIDv7UsesFixedTimestampVersionAndVariantBits() throws {
        let timestamp: UInt64 = 1_783_814_400_123
        var generator = FixedRandomNumberGenerator(value: 0)

        let uuid = try UUIDv7.generate(
            timestampMilliseconds: timestamp,
            using: &generator
        )

        XCTAssertEqual(UUIDv7.timestampMilliseconds(of: uuid), timestamp)
        XCTAssertEqual(uuid.uuidString.split(separator: "-")[2].first, "7")
        XCTAssertTrue(["8", "9", "A", "B"].contains(uuid.uuidString.split(separator: "-")[3].first))
    }

    func testUUIDv7TypedIDsSortByTimestampWithoutUsingTheClock() throws {
        var firstGenerator = FixedRandomNumberGenerator(value: 99)
        var secondGenerator = FixedRandomNumberGenerator(value: 0)
        let first = EventID(unchecked: try UUIDv7.generate(
            timestampMilliseconds: 1_000,
            using: &firstGenerator
        ))
        let second = EventID(unchecked: try UUIDv7.generate(
            timestampMilliseconds: 1_001,
            using: &secondGenerator
        ))

        XCTAssertLessThan(first, second)
    }

    func testTypedIDComparisonMatchesNormalizedDescriptionOrdering() throws {
        let identifiers = try [
            "00000000-0000-7000-8000-00000000000f",
            "00000000-0000-7000-8000-000000000009",
            "00000000-0000-7000-8000-00000000000a",
        ].map { value in
            try EventID(validating: XCTUnwrap(UUID(uuidString: value)))
        }

        XCTAssertEqual(
            identifiers.sorted().map(\.description),
            identifiers.map(\.description).sorted()
        )
    }

    func testTypedIDsRejectNonV7ConstructionAndDecoding() throws {
        let versionFour = UUID(uuid: (
            0, 0, 0, 0, 0, 0, 0x40, 0,
            0x80, 0, 0, 0, 0, 0, 0, 1
        ))

        XCTAssertThrowsError(try EventID(validating: versionFour))
        XCTAssertThrowsError(try JSONDecoder().decode(
            EventID.self,
            from: JSONEncoder().encode(versionFour)
        ))
        XCTAssertEqual(
            try EventID(validating: testUUID(99)).rawValue,
            testUUID(99)
        )
    }

    func testMoneyInputPortsCanonicalDigitAndBackspaceStateMachine() throws {
        var input = try MoneyInput()
        input = input.applying(.digit(5), currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5"))
        input = input.applying(.decimalSeparator, currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5", fractionalDigits: ""))
        input = input.applying(.digit(2), currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5", fractionalDigits: "2"))
        input = input.applying(.digit(0), currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5", fractionalDigits: "20"))
        input = input.applying(.digit(9), currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5", fractionalDigits: "20"))
        input = input.applying(.backspace, currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5", fractionalDigits: "2"))
        input = input.applying(.backspace, currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5", fractionalDigits: ""))
        input = input.applying(.backspace, currency: .eur)
        XCTAssertEqual(input, try MoneyInput(wholeDigits: "5"))
        input = input.applying(.backspace, currency: .eur)
        XCTAssertEqual(input, try MoneyInput())

        var leadingZero = try MoneyInput()
        leadingZero = leadingZero.applying(.digit(0), currency: .eur)
        XCTAssertEqual(leadingZero.wholeDigits, "0")
        leadingZero = leadingZero.applying(.digit(5), currency: .eur)
        XCTAssertEqual(leadingZero.wholeDigits, "5")

        let capped = try MoneyInput(wholeDigits: "123456")
            .applying(.digit(7), currency: .eur)
        XCTAssertEqual(capped.wholeDigits, "123456")
    }

    func testMoneyInputNormalizesDecimalDigitsBeforeConversionAndEditing() throws {
        for (whole, fraction) in [("١٢", "٣٤"), ("۱۲", "۳۴"), ("１２", "３４"), ("1٢", "３4")] {
            let input = try MoneyInput(wholeDigits: whole, fractionalDigits: fraction)
            XCTAssertEqual(input.wholeDigits, "12")
            XCTAssertEqual(input.fractionalDigits, "34")
            XCTAssertEqual(try input.money(currency: .eur).minorUnits, 1_234)
            XCTAssertEqual(
                try input.applying(.backspace, currency: .eur).money(currency: .eur).minorUnits,
                1_230
            )
        }
        let zero = try MoneyInput(wholeDigits: "٠")
        XCTAssertEqual(zero.applying(.digit(5), currency: .eur).wholeDigits, "5")
    }

    func testMoneyInputRejectsNonDecimalNumeralsAndPreservesExactLimits() throws {
        for invalid in ["²", "Ⅷ", "½", "-1", "+1", "1 2", "1,2", "1.2", "1\u{200B}2"] {
            XCTAssertThrowsError(try MoneyInput(wholeDigits: invalid), invalid)
            XCTAssertThrowsError(try MoneyInput(wholeDigits: "1", fractionalDigits: invalid), invalid)
        }
        XCTAssertEqual(
            try MoneyInput(wholeDigits: "９２２３３７２０３６８５４７７５８", fractionalDigits: "０７")
                .money(currency: .eur).minorUnits,
            Int64.max
        )
        XCTAssertThrowsError(
            try MoneyInput(wholeDigits: "９２２３３７２０３６８５４７７５８", fractionalDigits: "０８")
                .money(currency: .eur)
        )
        XCTAssertThrowsError(try MoneyInput(wholeDigits: "١", fractionalDigits: "٢٣٤").money(currency: .eur))
        XCTAssertThrowsError(try MoneyInput(wholeDigits: "١", fractionalDigits: "٢").money(currency: .jpy))
        XCTAssertEqual(try MoneyInput(wholeDigits: "١", fractionalDigits: "٢٣٤").money(currency: .bhd).minorUnits, 1_234)
    }

    func testMoneyInputConvertsDigitsForExponentZeroTwoThreeAndFour() throws {
        XCTAssertEqual(
            try MoneyInput(wholeDigits: "5", fractionalDigits: "2")
                .money(currency: .eur).minorUnits,
            520
        )
        XCTAssertEqual(
            try MoneyInput(wholeDigits: "5", fractionalDigits: "20")
                .money(currency: .eur).minorUnits,
            520
        )
        XCTAssertEqual(try MoneyInput(wholeDigits: "12").money(currency: .eur).minorUnits, 1_200)
        XCTAssertEqual(try MoneyInput().money(currency: .eur).minorUnits, 0)

        let jpy = try MoneyInput(wholeDigits: "12")
            .applying(.decimalSeparator, currency: .jpy)
            .applying(.digit(3), currency: .jpy)
        XCTAssertNil(jpy.fractionalDigits)
        XCTAssertEqual(try jpy.money(currency: .jpy).minorUnits, 123)
        XCTAssertThrowsError(try MoneyInput(
            wholeDigits: "12",
            fractionalDigits: "1"
        ).money(currency: .jpy))

        let bhd = try MoneyInput(wholeDigits: "1")
            .applying(.decimalSeparator, currency: .bhd)
            .applying(.digit(2), currency: .bhd)
            .applying(.digit(3), currency: .bhd)
            .applying(.digit(4), currency: .bhd)
            .applying(.digit(5), currency: .bhd)
        XCTAssertEqual(bhd.fractionalDigits, "234")
        XCTAssertEqual(try bhd.money(currency: .bhd).minorUnits, 1_234)

        let clf = try Currency(code: "CLF", exponent: 4)
        let fourDigits = try MoneyInput(wholeDigits: "1")
            .applying(.decimalSeparator, currency: clf)
            .applying(.digit(2), currency: clf)
            .applying(.digit(3), currency: clf)
            .applying(.digit(4), currency: clf)
            .applying(.digit(5), currency: clf)
            .applying(.digit(6), currency: clf)
        XCTAssertEqual(fourDigits.fractionalDigits, "2345")
        XCTAssertEqual(try fourDigits.money(currency: clf).minorUnits, 12_345)
    }

    func testMoneyFormattingPortsCanonicalEURAssertions() {
        let locale = Locale(identifier: "en_IE")

        XCTAssertEqual(
            MoneyFormatter.string(from: Money(minorUnits: 13_000, currency: .eur), locale: locale),
            "€130"
        )
        XCTAssertEqual(
            MoneyFormatter.string(
                from: Money(minorUnits: 520, currency: .eur),
                locale: locale,
                fractionDisplay: .always
            ),
            "€5.20"
        )
        XCTAssertEqual(
            MoneyFormatter.string(from: Money(minorUnits: 200_000, currency: .eur), locale: locale),
            "€2,000"
        )
        XCTAssertEqual(MoneyFormatter.hiddenString(currency: .eur, locale: locale), "€•••")
        XCTAssertEqual(
            MoneyFormatter.string(from: Money(minorUnits: -13_000, currency: .eur), locale: locale),
            "−€130"
        )
        XCTAssertEqual(
            MoneyFormatter.string(
                from: Money(minorUnits: 13_000, currency: .eur),
                locale: locale,
                fractionDisplay: .always
            ),
            "€130.00"
        )
    }

    func testMoneyFormattingRespectsLocaleAndCurrencyExponentMatrix() {
        let german = MoneyFormatter.string(
            from: Money(minorUnits: 123_456, currency: .eur),
            locale: Locale(identifier: "de_DE"),
            fractionDisplay: .always
        )
        let japanese = MoneyFormatter.string(
            from: Money(minorUnits: 1_235, currency: .jpy),
            locale: Locale(identifier: "ja_JP"),
            fractionDisplay: .always
        )
        let bahraini = MoneyFormatter.string(
            from: Money(minorUnits: 1_234, currency: .bhd),
            locale: Locale(identifier: "en_US"),
            fractionDisplay: .always
        )

        XCTAssertTrue(german.contains("1.234,56"))
        XCTAssertTrue(german.hasSuffix("€"))
        XCTAssertFalse(japanese.contains("."))
        XCTAssertFalse(japanese.contains(",00"))
        XCTAssertTrue(bahraini.contains("1.234"))
    }

    func testDecimalMinorUnitFormattingRespectsCurrencyExponentAndLocale() {
        let locale = Locale(identifier: "en_US")

        XCTAssertEqual(
            MoneyFormatter.string(
                decimalMinorUnits: 123_456,
                currency: .eur,
                locale: locale
            ),
            "€1,234.56"
        )
        XCTAssertEqual(
            MoneyFormatter.string(
                decimalMinorUnits: 1_235,
                currency: .jpy,
                locale: locale
            ),
            "¥1,235"
        )
        XCTAssertEqual(
            MoneyFormatter.string(
                decimalMinorUnits: 1_234,
                currency: .bhd,
                locale: locale
            ),
            "BHD 1.234"
        )
    }

    func testDecimalMinorUnitFormattingPreservesTotalsBeyondInt64() {
        let total = Decimal(Int64.max) * 2
        let locale = Locale(identifier: "en_US")

        XCTAssertEqual(
            MoneyFormatter.string(
                decimalMinorUnits: total,
                currency: .eur,
                locale: locale
            ),
            "€184,467,440,737,095,516.14"
        )
        XCTAssertEqual(
            MoneyFormatter.string(
                decimalMinorUnits: total,
                currency: .jpy,
                locale: locale
            ),
            "¥18,446,744,073,709,551,614"
        )
        XCTAssertEqual(
            MoneyFormatter.string(
                decimalMinorUnits: total,
                currency: .bhd,
                locale: locale
            ),
            "BHD 18,446,744,073,709,551.614"
        )
    }
}
