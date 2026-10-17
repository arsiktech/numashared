# 02 Adding an expense: speed and clarity

Scope: `BudgetGroupExpenseFlow.swift` (the live flow for every new household), `AddExpenseView.swift` (legacy schema-1 flow), `ExpenseFlowKeypad` and `AmountKeypadView`, `VesselView`/`SharedOrbButtonStyle`, and the `AppModel` seams (`beginAdd`, `key`, `saveExpense`, exact-split drafts, `persistenceFailed`, undo). Frames 22-34 and 58.

Evidence labels: "verified in code" means I read the lines. "Inferred" means a conclusion from code that I could not run (no Xcode here). "Design only" means the PNG or `screens.js`. Layout fit estimates are my arithmetic, not measurements.

## Verdict

The flow is correct and careful. Save is double-tap safe, the consequence line ("After saving, You + Sam owe Alex + Jo €36.") is the right trust device, and the code already merged the design's separate split and review screens into one, so the real flow is 3 screens, not 5. But it is not the fastest thing in the app: the 80% case ("I paid, split equally") takes 8 taps and 3 screens, two of which are pure confirmations. Several defects are worse than slow. Amounts are masked while typing if Hide amounts is on, the 6-digit cap silently blocks rent in high-denomination currencies, VoiceOver gets no running total, and the exact-split editor (the restaurant case) is the roughest part of the app. The explicit-payer decision is the main reason the flow is long, and I challenge it below.

### Tap and screen counts (current code, 2 groups, EUR, taps include each digit key)

| Task | Current taps | Screens | Notes |
|---|---|---|---|
| (a) I paid €12.40 groceries, equal | 8 without a description (orb, 1 2 , 4, Who paid?, You, Save). 19 touches if "Groceries" is typed (focus, 9 keys, Done). | Entry, Payer, Review (+ Home) | `testExpenseEqualUsesFourActionsAndReturnsHomeWithUndo` documents "four actions": Add, Who paid?, payer, Save. |
| (b) Sam paid rent €1,200, 50/50 | 8 without a description, 14 touches with "Rent". | Same 3 | 50/50 is the default, so no split taps. Nothing remembers "Rent" or Sam. |
| (c) Bought only for the other group | 9 (+1 if the segmented control is below the fold, inferred). 3 groups: +1 to pick which. | Same 3 | `chooseSplit(.one)` preselects the first non-payer group (`BudgetGroupExpenseFlow.swift:213-225`). |
| (d) Restaurant €96, exact 60/36 | 13 touches: orb, 9, 6, Who paid?, payer, Exact amounts, field tap, long-press, Select All, 6, 0, Done, Save. | Same 3, with the system decimal pad appearing mid-flow | Select All is needed because the caret may land at the start (comment in `GoldenPathUITests+ExpenseFidelity.swift:262`). |

Best-in-class for comparison (Splitwise, Tricount style): one screen with description, amount, and "Paid by you · split equally" chips. (a) is 6 taps (orb, 4 digits, Save). (b) is 3 taps with a history suggestion. (d) is about 9.

## Findings

1. **Hide amounts masks the amount while you type it**
   - Severity: S1 broken/trust
   - Evidence: `ExpenseFlowAmount(text: app.fmt(app.addedAmountCents, forceCents: true))` at `BudgetGroupExpenseFlow.swift:57` and `:113`. `fmt` passes `hidden: hideAmounts` (`AppModel.swift:910-917`), and the hidden string is `€•••` (`MoneyFormatting.swift:50-66`). The legacy view used `displayAmount`, which is not masked (`AddExpenseView.swift:28`). `testHideAmountsPersistsOnThisDevice` never opens Add.
   - Why it matters: with the privacy toggle on, the user types digits into a blank `€•••`. They also cannot check the payer-page copy ("the €••• bill"), the split rows or the undo text ("Rent €••• saved").
   - Fix: the entry and review screens are the user authoring the number, so always show it. If masking must apply, mask only after Save, and add a tap-and-hold eye on review. Add a UI test with `hide-amounts` on and a typed amount.
   - Effort: S. Confidence: inferred (code path is clear; not run).

2. **Six whole digits max, silently, with no currency awareness**
   - Severity: S1 broken/trust (for households in high-denomination currencies; S3 for EUR)
   - Evidence: `MoneyInput.applying(... maximumWholeDigits: Int = 6)` at `MoneyInput.swift:40` and `:50` (`guard whole.count < maximumWholeDigits else { return self }`). The caller passes no override (`AppModel.key`). `CurrencyAdmissionV1` admits the whole ISO 4217 table (VND, IDR, COP, KRW, UZS and so on). `amountEntryHint` exists (`AppModel.swift:933`) but nothing in the flow shows it.
   - Why it matters: a 7th digit is ignored with no haptic or message. VND 8,000,000 rent or IDR 3,000,000 cannot be entered at all, and the user thinks the keypad is broken.
   - Fix: cap by magnitude, not digits (for example total minor units under 10^12, which is safe for Int64 sums), so JPY and VND get 10+ whole digits and EUR keeps about €10 billion. When a key is rejected, play `Haptics.warned()` and shake the amount once (the legacy view already had `ShakeEffect`). Keep the cap well above realistic household amounts but below overflow in `allocate`.
   - Effort: S. Confidence: verified in code.

3. **The 80% case takes 8 taps because payer and review are pass-throughs** (Challenges a decision)
   - Severity: S2 friction
   - Evidence: `entry` -> `payer` -> `allocation` (`BudgetGroupExpenseFlow.swift:36-167`). `beginAdd` already sets `expensePayerMemberID = currentMemberID` (`AppModel.swift:3754`), but `chosePayer` stays false and Save needs `chosePayer` (`:103`). The test asserts "An actual payer must still be chosen explicitly." Design note on frame 24: "Actual payer never silently defaults to the recorder."
   - Why it matters: when you paid (probably most entries), "Who paid?" and your own row are 2 taps and a screen transition that confirm what the app already knows. Then the review page is a third read of the same numbers.
   - Fix: put two visible chips on the entry screen between the amount and the keypad: `Paid by You ▾` and `Split equally ▾`. They default to the recorder and Equal, but they are on screen next to the CTA, so nothing is silent. The CTA becomes `Save €12.40` and a one-line consequence ("You + Sam owe Alex + Jo €36") sits above it, reusing `expenseImpactDescription`. Each chip opens a half-sheet (payer list; split modes). The existing payer page and review page become those sheets. Trade-off: this relaxes the owner's rule. The mitigation is that the default is always visible in the CTA row, and today's edit cannot change a payer after saving (finding 6), so an exception path must stay one tap away. Keep the full review for Exact and For one group.
   - Effort: M. Confidence: verified in code.

4. **No description suggestions or repeat in the live flow; history fills with "Expense"**
   - Severity: S2 friction
   - Evidence: the 3 recent-title chips exist only in `ExpenseDetailsEditor.suggestionsRow` (`AddExpenseView.swift:144-208`), used by the legacy view. The live entry has none (`BudgetGroupExpenseFlow.swift:41-51`). An empty description saves as `String(localized: "Expense")` (`AppModel.swift:4130`). `repeatExpense` exists (`LedgerRepository.swift:683`) but is reachable only via Home -> row -> detail -> "Repeat expense" (`SheetViews.swift:377`), and it saves instantly with no amount change.
   - Why it matters: the product promise is "exactly why". People skip the optional field because typing costs 10+ touches, and then Home shows "Expense, Expense, Expense". Rent and weekly groceries are retyped every time.
   - Fix: under the description show up to 3 chips from past descriptions (distinct, most recent, filter as you type). Tapping one fills the description and also the amount, payer and split from that last record, then the user edits the amount if needed. Exact-string match on history only, no AI and no recurring automation. Make the description placeholder an example ("Groceries") and drop the redundant "Description · optional" label (three labels today: heading "What was it for?", the small label, and the placeholder "What was it?").
   - Effort: M. Confidence: verified in code.

5. **Exact split (restaurant case) is clumsy and looks uneditable**
   - Severity: S2 friction
   - Evidence: `BudgetGroupExpenseFlow.swift:119-128`. The share is a bare right-aligned `TextField` with `.decimalPad`: no chip, border or currency, 92pt wide. Attached rows in exact mode are not Buttons, so tapping the name does nothing. The field starts as "48.00" with no select-all on focus. The UI test comment says "Tapping a trailing-aligned field may place the caret at its start. Select the actual contents" (`GoldenPathUITests+ExpenseFidelity.swift:255-262`), and its helper long-presses, taps Select All, types, then taps Done. This is the legacy view's pattern (chip background and border) with the affordance removed.
   - Why it matters: a human cannot tell the number is editable. If they find it, they need long-press, Select All, type and Done, switching from the app's big keypad to the system keyboard mid-flow.
   - Fix: (a) tapping anywhere on the row focuses its field; (b) select-all on focus (bridge to `UITextField` and call `selectAll`), or better, (c) make the focused row drive the same big `ExpenseFlowKeypad` so exact entry uses the same entry model as the amount, and (d) give the field a visible chip (`palette.chip` fill, hair stroke, 44pt). Start the focused field empty with the current value as placeholder.
   - Effort: M. Confidence: verified in code and test comment.

6. **Exact split has a dead end and an unexplained error (stale parts, "Locked", no remainder)**
   - Severity: S2 friction
   - Evidence: `prepareExactSplit()` runs only from `selectExpenseSplitMode`, `toggleUnit`, `dropAll` and `openSplitPreview` (`AppModel.swift:3968-3971`, `4002`). The review page has no `onAppear` that recomputes. Path: choose Exact, edit to 60/36, go Back twice, change the amount to €100, return. `exactParts` still sums to 96, so `canSaveExpense` is false (`:3870-3882`), `exactSplitErrorMessage` is nil, and the only hint is a 13pt grey "Shares must add up to €100.00." (`BudgetGroupExpenseFlow.swift:146`). The error strings say "Locked amounts exceed the expense total." and "Locked amounts must add up to the expense total." (`AppModel.swift:4053`, `4060`), but the live flow has no lock control (`toggleExactSplitLock` is only used by the legacy row, `AddExpenseView.swift:469`). Frame 58 shows "Allocated €90.00 / Left to allocate €6.00 / €6 still needs a home." and "Fix allocation". Code has none of these.
   - Why it matters: Save is disabled with no visible reason, and the error uses a word for a control the user never saw.
   - Fix: re-run `prepareExactSplit()` when the review page appears or when `addedAmountCents` changes (re-split equally and say "Amount changed, shares reset"). Always show `Allocated` and `Left to allocate` rows in exact mode (frame 58) and replace "Locked amounts" with "Shares are €6.00 short of €96.00" or "€4.00 over".
   - Effort: S/M. Confidence: inferred (state flow read, not run).

7. **VoiceOver gets no running total, and the decimal key is read as "dot"**
   - Severity: S2 friction
   - Evidence: the amount is `.accessibilityElement(children: .ignore).accessibilityLabel("Total amount, \(text)")` (`BudgetGroupExpenseFlow.swift:353`). Keys are labelled `key` itself, so the decimal key is "." not the locale separator (`:427`). No file in the app calls `AccessibilityNotification` or `UIAccessibility.post` (grep).
   - Why it matters: pressing "4" speaks "4"; the user never hears "twelve euros forty" unless they swipe back up to the amount. A blind user cannot confirm what they will save without extra navigation.
   - Fix: after each key, post a debounced `AccessibilityNotification.Announcement(app.fmt(...))`. Label the decimal key "Decimal separator". Add `.accessibilityAddTraits(.updatesFrequently)` to the amount. Give the CTA a spoken amount: "Save €12.40".
   - Effort: S. Confidence: verified in code.

8. **Mistakes after saving are expensive, and the Undo window is six seconds**
   - Severity: S2 friction
   - Evidence: `UndoPolicy.window = 6` (`Undo.swift:12`; "six-second Undo" is in `DECISIONS.md:54`). The Undo bar is a plain `safeAreaInset` item in Home with no accessibility notification (`HomeView.swift:69`). `saveExpenseEdit` can change only title, category and amount (`AppModel.swift:4500-4520`, `appendExpenseRevision`); payer, split and date cannot change, and a changed amount reweights the old parts. The review page also cannot edit payer, amount or description; Back twice is the only way (`page()` header, `:284`).
   - Why it matters: if the payer or split is wrong and 6 seconds pass, the only fix is Void then re-enter everything. That raises the stakes of the entry flow and is the real reason the owner wants an explicit payer.
   - Fix: (a) make the Undo bar stay until the next navigation or about 12 seconds, whichever is longer (Challenges a decision: this delays delivery to flatmates by that long for held events); (b) announce "Expense saved. Undo available" to VoiceOver; (c) later, allow editing payer and split through a revision rather than Void.
   - Effort: S for (a)/(b), L for (c). Confidence: verified in code.

9. **Cancel and failure both throw the draft away**
   - Severity: S2 friction
   - Evidence: X is `Button(action: app.closeAdd)` on every page (`BudgetGroupExpenseFlow.swift:291`), with no confirmation. `beginAdd` clears everything (`AppModel.swift:3746-3766`). The first page's Back chevron also calls `closeAdd` (`:37`), so two controls do the same thing there. On any non-read-only, non-archived save failure, `persistenceFailed` -> `presentLocalDataFailure` sets `addPresented = false` and shows "That change couldn't be verified. Reload this pot." (`AppModel.swift:1042-1076`).
   - Why it matters: a stray tap on X after a 5-field exact split loses it. After a failed save the user is dumped on Home, with a banner that says "pot" (jargon), not knowing whether to re-enter the expense (risking a duplicate) or not.
   - Fix: if `addedAmountCents > 0 || !merchant.isEmpty`, X shows "Discard this expense? / Keep editing". Keep the draft in `AppModel` on failure and return to the review page with a plain message ("Couldn't save. Your entries are still here. Try again."). Remove the first-page Back chevron (X only). Use "household", not "pot".
   - Effort: S/M. Confidence: verified in code.

10. **Add and Save can be dead with no reason**
   - Severity: S2 friction
   - Evidence: the orb is `.disabled(!app.canWrite)` (`HomeView.swift:396`) and `VesselView`/`SharedOrbButtonStyle` do not read `isEnabled` (grep `isEnabled` in `Components.swift` finds nothing), so it likely looks fully active. `canWrite` includes a paused sync (sign-in required, update required, access removed) and a local data error (`AppModel.swift:847-853`). On the review page, Save is `.disabled` with a grey pill and no message when `canWrite` is false.
   - Why it matters: in a local-first app, a main action that silently does nothing reads as a crash. Sign-in-expired is a plausible state for a flatmate who has not opened the app for weeks.
   - Fix: keep the orb tappable. When `!canWrite`, open a small sheet with the reason and one action ("Sign in to keep adding expenses"). Reuse `syncPresentation.title/detail`. Show the same reason line above a disabled Save. (Separately question whether a sign-in pause should block local writes at all.)
   - Effort: S/M. Confidence: inferred.

11. **The "Who paid?" step is person-level, but the result is group-level, and the page no longer says so**
   - Severity: S2 friction
   - Evidence: `payerPeople` lists people (`AppModel.swift:136-141`); the row subtitle is the group name (`BudgetGroupExpenseFlow.swift:86`). Frame 24 has a callout, "Sam paid. You're writing it down. The expense belongs to Sam's shared budget. The history keeps both names." Code dropped it (`payer` page, `:74-99`). The radio circles never show a selection when you tap, because the tap navigates (`chosePayer` only paints on return). The recorder is not first or labelled "You": `personName` returns `displayName` (`AppModel.swift:139`) and the order is profile order. The review line reads "Today · Arseny paid · Added by you" when the payer is the recorder (`:109`). A solo group yields title "Sam" and subtitle "Sam".
   - Why it matters: "You" vs "Sam" in the same couple changes nothing in balances, only attribution, and nothing on screen says so. A third-person name next to "Added by you" reads oddly.
   - Fix: group rows under their budget header ("You + Sam" then You, Sam), recorder first and shown as "You". Restore a one-line explanation: "Who paid sets the history. The balance counts the whole group." Hide the radio circles (the row is a navigate-on-tap list). Review line: "Today · You paid", and add "· Added by Sam" only when the recorder differs.
   - Effort: S. Confidence: verified in code (ordering inferred).

12. **"Change date" is a 4-5 tap detour that also hides Category; Category barely does anything**
   - Severity: S2 friction
   - Evidence: "Change date" pushes a page (`BudgetGroupExpenseFlow.swift:62`) with a compact `DatePicker` and the free-text Category field (`:169-182`). The picker has no range, so future dates are allowed, and the displayed label omits the year (`HomeReceiptRow.dateLabel` uses `.day().month(.wide)`, `HomeView.swift:475`). Category drives exactly two magic strings, "internet" and "dining", for row icons (`HomeView.swift:462-463`); otherwise the generic receipt icon. An empty category is saved as the localized word "Uncategorized" (`AppModel.swift:4131-4133`). Design frame 23 had a "Note · optional" field here; code has Category instead, and `appendExpense` has no note parameter.
   - Why it matters: backdating ("paid yesterday") is common. Today it costs Change date, pill, day, dismiss, Keep. Category is undiscoverable behind a date label and almost never earns its keep.
   - Fix: on the entry screen show `Today ▾` as a chip row: Today, Yesterday, Pick date (one tap to backdate). Restrict to today or earlier, and show the year if it is not the current one. Remove Category from the add flow (or derive an icon from the description), and store nil, not a localized "Uncategorized". If the owner wants a note, add it as the design shows, but not behind "Change date".
   - Effort: S/M. Confidence: verified in code.

13. **No per-person equal split: a couple plus a solo flatmate cannot split groceries fairly without Exact** (Challenges a decision)
   - Severity: S2 friction
   - Evidence: "Equally" is equal per group (`BudgetGroupExpenseFlow.swift:146-147`; every group's share weight is 1). `PRODUCT.md` says shared bills are "commonly split 50/50 between two groups, rather than equally between every individual". The legacy flow had weights (couple = 2), now gone from the live one.
   - Why it matters: in a 3-person flat (couple + one person), a €60 grocery shop is €30/€30 by default but €40/€20 by head. The only way is Exact (13 touches). Rent between two groups is fine as is.
   - Fix: keep Equal per group as the default. Add "By people" as a secondary option in the split chip menu: weights = number of active members per group, still group-level balances, still exact-sum integer allocation, no within-couple debt. Trade-off: one more option to explain, but it removes the heaviest manual path for a very common household shape.
   - Effort: M. Confidence: inferred (product judgment).

14. **Amount display and keypad: no ghost cents, no typed-decimal feedback, cramped on small phones, hero only styles "€"**
   - Severity: S2 friction
   - Evidence: `ExpenseFlowAmount` renders one weight and colour for the whole string, including "€0.00" at rest (`BudgetGroupExpenseFlow.swift:355-359`), while frame 22 greys the untyped ".00". The text is `fmt(cents)`, so pressing "," after "12" still shows "€12.00" and the user sees no change. The special glyph styling applies only when `text.hasPrefix("€")` (`:356`); other currencies and suffix-symbol locales ("96,00 €") render the whole string at 69pt with `fixedSize(horizontal: false)` and no `lineLimit` or `minimumScaleFactor`, so long values can wrap by character at larger Dynamic Type. Layout arithmetic for iPhone 16 (852pt): about 818pt of content at default type, so it just fits. On a 812pt phone (12/13 mini) or an SE it overflows and the bottom keypad row sits under the pinned CTA, and at larger text it overflows on more devices (estimate, not measured). No key haptics and no long-press repeat on delete (`ExpenseFlowKeypad`, `:414-431`).
   - Why it matters: the amount is the one number that must feel solid. On small screens the user scrolls the keypad while the amount scrolls off.
   - Fix: pin the keypad to the bottom (flexible `Spacer`, keys sized to the space left) and let the top section compress: shrink the "What was it for?" heading to 22pt on this screen, drop the "Euro · EUR 🔒" chip (the € already says it; the lock looks tappable and is not). Use `displayAmount` so the typed decimal shows, and grey the untyped digits. Add `.lineLimit(1).minimumScaleFactor(0.5)` to the hero. Style the currency glyph for any prefix symbol. Add `.sensoryFeedback` or a soft impact per key and a repeating delete.
   - Effort: M. Confidence: inferred (layout), verified in code (styling).

15. **Copy and grammar defects in the flow**
   - Severity: S3 polish
   - Evidence: "Equal shares for \(count) budget groups—not per person." gives "1 budget groups" and leaks "budget group" (`BudgetGroupExpenseFlow.swift:147`). The row subtitle "\(count) people · one budget" gives "1 people", and the count includes archived members because it filters `memberProfiles` without checking state (`:233`). "Paid \(dateLabel.lowercased())" gives "Paid 3 september" (`:60`). "After saving, \(name) owe ..." is wrong for a single-person group: "Sam owe Leo" (`AppModel.swift:3940`; Home does the same, `HomeView.swift:114`). "Locked amounts" (see 6). The decimal key stays visible but greyed on zero-decimal currencies. The Save pill carries an arrow ("Save expense →"), which reads as "next" for a final action.
   - Why it matters: each is a small "this wasn't proofread" signal in the screen where trust matters most.
   - Fix: "Split evenly between the 2 groups, not per person." Use "1 person". Skip archived members. Do not lowercase dates. Pluralise owe/owes by member count of the group. Hide the decimal key for exponent 0. Drop the arrow on Save.
   - Effort: S. Confidence: verified in code.

16. **The remainder cent always goes to the last group**
   - Severity: S3 polish (Challenges a decision)
   - Evidence: `MinorUnitAllocator` floors every share and gives the leftover to the last unit in `orderedUnitIDs` (`Allocation.swift:55-56`, `WeightedAllocator` doc: "assigns all residual minor units to the final unit"). The order is `attachedKeys`, which follows `activeBudgetUnitIDs` (`AppModel.swift:3858`). €100.00 over 3 groups gives 33.33 / 33.33 / 33.34, and €100.01 gives 33.33 / 33.33 / 33.35. The last group always eats up to (n-1) extra cents. Nothing on review marks the extra cent.
   - Why it matters: it is exact-sum and deterministic, so trust holds. But the same group is always 1-2 cents worse off, and a flatmate seeing 33.34 with no note will ask why.
   - Fix: either note it on the row ("includes 1¢ rounding"), or give the residual to the payer's group (they are owed money anyway, so debtors never overpay). Keep the order stable and tested.
   - Effort: S (note) / M (policy change plus replay compatibility check). Confidence: verified in code.

17. **Two add flows and three keypads**
   - Severity: S3 polish
   - Evidence: `LegacyAddExpenseView` (`AddExpenseView.swift:12-72`), `SplitPreviewView`, `ExpensePeoplePicker`; `ExpenseFlowKeypad` (live) vs `AmountKeypadView` (legacy add, edit sheet `SheetViews.swift:683`, repayment `SheetViews.swift:955`). The legacy flow has things the live one lost: recent-title chips, shake plus warning haptic on invalid review, `Haptics.prepare()`.
   - Why it matters: two sources of truth drift (finding 4 and 14 are already drift). Editing an expense and adding one use differently styled keypads.
   - Fix: port suggestions and invalid-state feedback to the live flow, unify on one keypad component with the redesign styling, and plan a migration that retires the schema-1 path once the owner's own data is upgraded.
   - Effort: M/L. Confidence: verified in code.

Things that work and should be kept: the double-save guard (`guard !saveInProgress` in `perform`, `.disabled(!enabled || saveInProgress)`, `isPersisting` check in `saveExpense`, `path.last == .payer` guard on the payer tap, `interactiveDismissDisabled(saveInProgress)`, record ID generated before the task for idempotent replay); integer-only entry through `MoneyInput` (no float anywhere); the consequence strip; going straight back to Home with an Undo lane instead of a celebration screen (matches frame 34); local-first save that needs no network.

## Ground-up rethink

1. **One screen, sentence chips, Save carries the number.** The Add sheet is a single page: a description field with 3 history chips, the big amount, one sentence of two tappable tokens ("**You** paid · split **equally**"), a live consequence line ("You + Sam will owe Alex + Jo €36"), the keypad, and a primary button "Save €12.40". Defaults are the recorder and Equal per group, but both are on screen, so nothing is silent. Tapping "You" opens a short payer sheet (people grouped under their group). Tapping "equally" opens the split sheet: Equal per group, By people, One group only, Exact amounts. The review page disappears for the default case. The user does: orb, 4 digits, Save (6 taps, 1 screen). Exceptions pay for their own complexity in a sheet, which fits "make everyday entry quick; keep advanced splitting secondary".

2. **History-aware add.** The first thing the user sees under the description is what they usually add: "Rent · €1,200 · Sam paid · 50/50", "Groceries", "Internet". One tap on a chip fills description, amount, payer and split from the last matching record, focus lands on the amount for a quick edit, and Save is one tap away. Typing filters the chips. It is local string matching, not AI, and nothing is scheduled or recurring, so it stays inside the exclusions. Rent becomes 3 taps (orb, chip, Save). The existing `repeatExpense` becomes the backend for exact repeats.

3. **Exact split as "enter one number".** For two groups, the restaurant case is one decision: how much was theirs. Choosing Exact swaps the screen to "How much was Alex + Jo's part?" with the big keypad and a live "You + Sam: €60.00" under it (the other group auto-balances, which `rebalanceExactSplit` already does). For three or more groups, tap a group row, type on the same keypad, and see "Left to allocate €6.00" until it hits zero. No system keyboard, no select-all, no lock jargon. (d) drops to about 9 taps and the "€6 still needs a home" state from frame 58 becomes a live meter instead of a dead end.

4. **Save first, fix easily.** Replace "review everything before Save" with "Save is safe". Keep the six-second Undo but make it behave: it stays through the return to Home and until the next tap (about 12s minimum), and it is announced to VoiceOver. Add a revision path in the expense detail for payer and split (today only title, category and amount can change). Then the review page can go, because a wrong payer costs one edit, not a Void and re-entry. This challenges the six-second decision and the explicit-payer decision together, so it needs the owner's call.

## Quick wins

1. Stop masking the amount in the add flow when Hide amounts is on (finding 1): one `fmt` change plus a test.
2. Replace the 6-digit cap with a magnitude cap and give rejected keys a warning haptic plus shake (finding 2).
3. Put the recorder first and label it "You" in the payer list, and say "Who paid sets the history; the balance counts the whole group" (finding 11).
4. Restore the 3 recent-description chips from the legacy view in the live entry and drop the triple labelling (finding 4).
5. Exact split: tap the row to focus, select all on focus, visible field chip, and "Left to allocate €X" in place of "Locked amounts…" (findings 5 and 6).
