// LedgerTests.swift — standalone test harness for Numa Shared pure logic.
// Compiled together with the REAL app sources (Theme.swift, Models.swift,
// AppModel.swift, Components.swift — Haptics is UIKit-gated to no-ops on
// macOS) for the macOS host — no Xcode target, no XCTest.
//
// Run:
//   cd ios/NumaShared && \
//   swiftc -parse-as-library -o /tmp/LedgerTests \
//     NumaShared/Theme.swift NumaShared/Models.swift NumaShared/AppModel.swift \
//     NumaShared/Components.swift Tests/LedgerTests.swift && /tmp/LedgerTests

import Foundation

@main
struct LedgerTests {
    static var failures = 0
    static var passes = 0

    static func check(_ name: String, _ cond: Bool, _ detail: @autoclosure () -> String = "") {
        if cond {
            passes += 1
            print("PASS  \(name)")
        } else {
            failures += 1
            print("FAIL  \(name)  \(detail())")
        }
    }

    static func eq<T: Equatable>(_ name: String, _ got: T, _ want: T) {
        check(name, got == want, "got \(got), want \(want)")
    }

    static func main() {
        let seed = Fixtures.seedRecords(startingID: 101)

        // MARK: Canon balances — Casa Mar July 2026
        let b = Ledger.balances(records: seed)
        eq("balances.am == +13000 (€130 back)", b[.am], 13000)
        eq("balances.sam == -7500 (owes €75)", b[.sam], -7500)
        eq("balances.leo == -5500 (owes €55)", b[.leo], -5500)
        eq("balances sum to zero", (b[.am]! + b[.sam]! + b[.leo]!), 0)

        // MARK: Spend
        eq("spend == 200000 (€2,000)", Ledger.spend(records: seed), 200_000)

        // MARK: Plan — fewest transfers, largest debtor first
        let plan = Ledger.plan(balances: b)
        eq("plan has exactly 2 steps", plan.count, 2)
        if plan.count == 2 {
            check("plan[0] == Sam→am €75",
                  plan[0].from == .sam && plan[0].to == .am && plan[0].amountCents == 7500,
                  "got \(plan[0].from)→\(plan[0].to) \(plan[0].amountCents)")
            check("plan[1] == Leo→am €55",
                  plan[1].from == .leo && plan[1].to == .am && plan[1].amountCents == 5500,
                  "got \(plan[1].from)→\(plan[1].to) \(plan[1].amountCents)")
        }

        // MARK: Voided records excluded
        var voided = seed
        voided[0].voided = true // Rent — July (am paid 180000, parts am 90000 / sam 45000 / leo 45000)
        let bv = Ledger.balances(records: voided)
        eq("void rent: am == -77000", bv[.am], -77000)
        eq("void rent: sam == +37500", bv[.sam], 37500)
        eq("void rent: leo == +39500", bv[.leo], 39500)
        eq("void rent: spend drops to 20000", Ledger.spend(records: voided), 20_000)

        // MARK: Split — remainder to last, exact sums
        let s1 = Ledger.split(total: 12000, shares: [.am: 2, .sam: 1, .leo: 1], keys: [.am, .sam, .leo])
        eq("split 12000 am2/sam1/leo1: am", s1[.am], 6000)
        eq("split 12000 am2/sam1/leo1: sam", s1[.sam], 3000)
        eq("split 12000 am2/sam1/leo1: leo", s1[.leo], 3000)

        let s2 = Ledger.split(total: 10000, shares: [.am: 1, .sam: 1, .leo: 1], keys: [.am, .sam, .leo])
        eq("split 10000 across 3 equal shares sums EXACTLY", s2.values.reduce(0, +), 10000)

        let s3 = Ledger.split(total: 9999, shares: [:], keys: [.sam])
        eq("split single key gets full total", s3[.sam], 9999)

        // MARK: AppModel.editKey state machine
        var st: (String, String?) = ("", nil)
        st = AppModel.editKey(st.0, st.1, "5")
        check("editKey '5' → (5, nil)", st.0 == "5" && st.1 == nil, "got \(st)")
        st = AppModel.editKey(st.0, st.1, ".")
        check("editKey '.' → (5, \"\")", st.0 == "5" && st.1 == "", "got \(st)")
        st = AppModel.editKey(st.0, st.1, "2")
        check("editKey '2' → (5, 2)", st.0 == "5" && st.1 == "2", "got \(st)")
        st = AppModel.editKey(st.0, st.1, "0")
        check("editKey '0' → (5, 20)", st.0 == "5" && st.1 == "20", "got \(st)")
        st = AppModel.editKey(st.0, st.1, "9")
        check("editKey extra digit ignored (frac capped at 2)", st.0 == "5" && st.1 == "20", "got \(st)")
        st = AppModel.editKey(st.0, st.1, "⌫")
        check("backspace unwinds frac: (5, 2)", st.0 == "5" && st.1 == "2", "got \(st)")
        st = AppModel.editKey(st.0, st.1, "⌫")
        check("backspace unwinds frac: (5, \"\")", st.0 == "5" && st.1 == "", "got \(st)")
        st = AppModel.editKey(st.0, st.1, "⌫")
        check("backspace clears empty frac → (5, nil)", st.0 == "5" && st.1 == nil, "got \(st)")
        st = AppModel.editKey(st.0, st.1, "⌫")
        check("backspace unwinds int → (\"\", nil)", st.0 == "" && st.1 == nil, "got \(st)")

        var lz = AppModel.editKey("", nil, "0")
        check("first '0' kept as int '0'", lz.0 == "0" && lz.1 == nil, "got \(lz)")
        lz = AppModel.editKey(lz.0, lz.1, "5")
        check("leading '0' replaced by next digit", lz.0 == "5" && lz.1 == nil, "got \(lz)")

        var cap = ("123456", String?.none)
        cap = AppModel.editKey(cap.0, cap.1, "7")
        check("int capped at 6 digits", cap.0 == "123456", "got \(cap)")

        // MARK: centsOf (instance helper, same digit model)
        let model = AppModel()
        eq("centsOf(5, 2) == 520 (single frac digit = tens)", model.centsOf("5", "2"), 520)
        eq("centsOf(5, 20) == 520", model.centsOf("5", "20"), 520)
        eq("centsOf(12, nil) == 1200 (digits are whole euros until '.')", model.centsOf("12", nil), 1200)
        eq("centsOf empty == 0", model.centsOf("", nil), 0)

        // MARK: money() formatter
        eq("money(13000) == €130", money(13000), "€130")
        eq("money(520, forceCents) == €5.20", money(520, forceCents: true), "€5.20")
        eq("money(200000) == €2,000 (en_IE grouping)", money(200_000), "€2,000")
        eq("money hidden == €•••", money(13000, hidden: true), "€•••")
        eq("money(-13000) == −€130 (minus-sign prefix)", money(-13000), "−€130")
        eq("money(13000, forceCents) == €130.00", money(13000, forceCents: true), "€130.00")

        // MARK: Settlement overpay — Sam pays €100 against €75 debt
        var over = seed
        over.append(ExpenseRecord(id: 999, kind: .settlement, title: "Sam paid your household",
                                  amountCents: 10_000, payer: .sam, to: .am, when: "Today", recordedBy: "Arseny"))
        let bo = Ledger.balances(records: over)
        eq("overpay: sam flips to +2500 (gets back €25)", bo[.sam], 2500)
        eq("overpay: am drops to +3000", bo[.am], 3000)
        eq("overpay: leo unchanged at -5500", bo[.leo], -5500)

        // MARK: summary
        print("\n\(passes) passed, \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
