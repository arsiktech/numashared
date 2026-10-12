# 07 Copy, vocabulary and accessibility semantics

Scope: every user-facing string in `ios/NumaShared/NumaShared/*.swift`, the String Catalog, `app-store/en-US/*.txt`, the push copy in `convex/lib/notificationMatrix.ts`, and the accessibility modifiers across all views. Evidence labels: **verified in code** (I read the lines), **inferred from code** (follows from the code, not run), **design frame only**. Nothing was built or run; I could not hear VoiceOver or see Dynamic Type render.

Method: I read all view files in full, extracted every string literal with scripts (counts below are string literals in view and model files, with the Debug harness, repository seed data and `#if DEBUG` blocks excluded, so treat them as approximate), and compared the copy with the approved frames in `design/interface-v2/screens.js` (text extracted per frame).

## Verdict

The screens people see first (Welcome, Create, Home, the add-expense flow) have a clear, warm voice that matches the approved frames. Everything behind them speaks a different language: the household is called a "pot" in 57 strings, a group is called five things, a repayment is called seven, and the People, deletion and contested-edit screens expose the ledger's internal glossary ("identity", "claim", "detach", "arithmetic", "immutable"). The hero sentence on Home is ungrammatical for single-person groups, and the owner's own wording rule ("one name per thing") is broken in most flows. Accessibility basics are solid (icons are hidden by default, selection traits are set, destructive actions are labelled), but there is no VoiceOver announcement anywhere, which makes the 6-second Undo effectively invisible to a VoiceOver user. The String Catalog is a stale snapshot and the branding test only scans one string API, so neither can enforce vocabulary today.

What already works and should not be touched: `HomeIcon` is `accessibilityHidden` by design (`HomeIcon.swift:16`), close/back/gear buttons have labels, split and payer rows set `.isSelected`, the setup progress bar has a spoken label, `Toggle`s describe the ON state, the QR code has a label, and the destructive confirmations spell out the consequence ("Sign out and lose 1 record").

## Findings

### 1. VoiceOver never hears the Undo, a save, an error or the amount being typed
- Severity: **S1 broken/trust**
- Evidence: a grep of all app sources finds zero uses of `AccessibilityNotification`, `UIAccessibility.post`, `@AccessibilityFocusState` or `.updatesFrequently`. `setUndo` only sets `undoText` (`AppModel.swift:4947-4955`); `UndoBar` simply appears in a bottom inset (`HomeView.swift:69-72`, `SheetViews.swift:30-39`, `Components.swift:669-689`) and disappears after the 6-second window. The typed amount is an `.accessibilityElement(children: .ignore)` with a static label (`BudgetGroupExpenseFlow.swift:353`) above a 12-key custom keypad (`:414-431`), so a VoiceOver user taps a digit and hears nothing about the new total.
- Why it matters: the product's safety net for a wrong entry (6-second Undo) is unreachable unless a VoiceOver user happens to swipe to the new element in time; this breaks the "VoiceOver" hard contract for the most common mistake.
- Fix: on `setUndo` post `AccessibilityNotification.Announcement("\(title) \(amount) saved. Undo is available for 6 seconds.")`; also add an `.accessibilityAction(named: "Undo")` on the Home scroll view and Activity list while `undoText != nil` so the action is on the rotor without hunting for the bar. Add `.accessibilityAddTraits(.updatesFrequently)` to the amount element and post a short announcement of the running total (debounced about 300 ms). Announce save failure and inline errors the same way (`Setup error:` labels exist, the announcement does not).
- Effort: S to M. Confidence: inferred from code (no runtime check possible here).

### 2. "Pot" is the second name for the household and leaks into most non-onboarding screens
- Severity: **S2 friction**
- Evidence: 57 string literals say "pot" (AppModel 15, InviteViews 14, PeopleManagementView 10, PotSwitcherView 5, SettingsView 4); 22 say "household" and 13 say "home". Onboarding says "Create our home", "Household name", "Latest at home" (`OnboardingViews.swift:116,168`, `HomeView.swift:412`); then Settings says "Mute this pot" (`SettingsView.swift:55`), People says "Leave pot", "Create pot invite" (`PeopleManagementView.swift:272,382`), the join sheet says "Join a pot", "Pot invitation" (`InviteViews.swift:227-229`), the error screen says "Your pot couldn't be opened" (`RootView.swift:126`), the Home household button hint says "Opens the pot switcher" (`HomeView.swift:144`). The public join page tells a new flatmate "Someone invited you to a shared pot" (`convex/lib/webContent.ts:216,232`) while the approved frames say "You've been invited to Our place" and "Leave home" (design frames 43/44/52, design frame only). `DECISIONS.md:199` shows the word comes from the retired orbit/planet concept; interface-v2 renamed it but only the onboarding strings were migrated.
- Why it matters: a flatmate who just typed "Casa Mar" as the household name is then asked to "Leave pot" and "Join a pot"; the word means nothing to them.
- Fix: use the household's own name wherever a sentence needs it ("Leave Casa Mar?", "Join Casa Mar", "Mute Casa Mar", "Casa Mar couldn't be opened"; the web page already does this for the heading). Where no name is available, the noun is "household". Keep "home" only for the tab label and the warm onboarding headlines. Rename the 57 literals, `webContent.ts` lines 216-250 and 273-293, and update UI tests that match on visible text. Accessibility identifiers (`create-pot`, `pot-switcher`) can stay.
- Effort: M (mechanical but wide). Confidence: verified in code.

### 3. Five names for the group, and "units" in the Activity feed
- Severity: **S2 friction**
- Evidence: "budget group" (9), "balance group" (5), "shared budget" (2), bare "budget" (13), bare "group" (34), "one balance" (4), "unit" (10). Same screen family, different nouns: setup says "Who shares a budget?" then "2 balance groups" then "Keep at least two balance groups separate" (`OnboardingViews.swift:541,568,582`); opening balances say "Your budget group starts" (`OpeningBalanceView.swift:189`); People says "Budget groups" and "Change budget group" (`PeopleManagementView.swift:198,216`); the payer row says "Shared budget" (`BudgetGroupExpenseFlow.swift:86`) and "2 people · one budget" (`:233`); the split note says "Equal shares for 2 budget groups" (`:147`); Detail says "Payer's budget group" (`SheetViews.swift:313`). The Activity row subtitle for an expense is "Sam paid · Mon, 11 Sep · split 2 units" (`Models.swift:383,390`) and then a second line repeats "Paid by Sam" (`Components.swift:491-496`). The design frames use "group" in the working screens ("From this group", "For one group", "Your group owes Alex + Jo") and "budget" only in setup.
- Why it matters: "balance group" and "unit" are the ledger's words, not a flatmate's; the Activity feed is the screen people open to check a figure.
- Fix: one noun, "group", never "budget group", "balance group" or "unit". Teach it once in setup ("A couple shares one balance, so they form one group") and elsewhere lead with the names ("Maya + Sam"). Rewrite the Activity subtitle to "Sam paid · 11 Sep · split between 2 groups" and drop the duplicate "Paid by" line. `Models.swift:383-392` also needs a proper plural, not two hand-written strings.
- Effort: M. Confidence: verified in code.

### 4. The repayment flow uses seven words, and three of them sound like the app moves money
- Severity: **S2 friction** (trust-adjacent: the core promise is "never moves money")
- Evidence: Home button "Record a repayment" (`HomeView.swift:295`); the list sheet says "X pays Y", "Record", "Record another transfer" (`SheetViews.swift:820,826,836`); the amount sheet title is "Record a repayment" / "Record a transfer" / "Reverse flagged settlement" (`:990-998`), the primary button is "Mark as paid" (`:968`), the secondary is "Not yet" (`:981`); the row badge is "Settled" and the kind is "Settlement" (`Models.swift:156,420`); the toast is "Settlement €50.00 recorded" (`AppModel.swift:4932`); the filter is "Settlements" (`Models.swift:176`); the help text says "payment" (`SheetViews.swift:951`). The approved frames say "Already paid some back?", "Record €50.00 repaid", "€50 written down", "Amount repaid" (design frames 35 to 39, design frame only). The App Store description says "payments", TestFlight copy says "settlements" (`app-store/en-US/description.txt`, `testflight-description.txt`, `what-to-test.txt`), the push says "A settlement in X involves your balance".
- Why it matters: "pays", "Mark as paid" and "transfer" read as actions the app performs; the screen then has to apologise with three disclaimers.
- Fix: noun "repayment", verb phrase "Record €50.00 repaid" (the button names the amount, as in frame 35). Replace "X pays Y" with "X repays Y", "Record another transfer" with "Record a different repayment", "Mark as paid" with "Record €50.00 repaid", "Not yet" with "Cancel", badge "Settled" with "Repayment", filter "Settlements" with "Repayments", toast with "€50.00 repayment recorded". Keep "settle" only as an App Store keyword.
- Effort: S to M. Confidence: verified in code; design drift from frames.

### 5. "Owe / owes" agreement is wrong for one group size on every screen
- Severity: **S2 friction**
- Evidence: the Home hero builds `"\(name) owe\n..."`, `"\(name) get back\n..."`, `"\(name) are even."` (`HomeView.swift:114-119`), plural only. The group chips build `"owes €x"` / `"gets back €x"` (`:318-319`), singular only. The review strip uses plural "owe" (`AppModel.swift:3940,3943`), the repayment preview uses plural "still owe / are owed / are even" (`:4831-4836`), the contested-edit and filter explainer use singular "owes / gets back / is even" (`:4247-4268`, `:5123-5135`). A group's name is the joined first names (`AppModel.swift:726`), so a single person gives "Sam owe Alex" in the hero and a couple gives "Maya + Sam owes €12" in the chip. The design notes say "Singles are not the secondary case" (design frame 07 notes), but the only fixtures are couples.
- Why it matters: the most-read sentence in the app is grammatically wrong for any household with a single person, and the chip beside it is wrong for couples.
- Fix: one function `phrase(group:, verb:)` that picks the verb by member count ("Sam owes Alex", "Maya + Sam owe Alex") and is the only place these sentences are built; use it from Home, chips, review strip, repayment preview, detail, filter explainer. Test with 1+1, 2+1, 2+2 groups. Use a localized plural variation for the verb so translation stays possible.
- Effort: M. Confidence: verified in code (logic), output inferred.

### 6. Names are spoken as "plus" and the viewer is never "You"
- Severity: **S2 friction**
- Evidence: `AppModel.swift:726` joins names with " + "; the Home sentence is given as the accessibility label unchanged (`HomeView.swift:272`), and so is each chip (`:346`). VoiceOver reads "+" as "plus", so a user hears "Maya plus Sam owe Alex plus Jo". `UnitInfo.isYou` is set (`AppModel.swift:738,773`) but nothing reads it, and `personName` returns the raw display name (`AppModel.swift:139-141`). The approved frames show "You + Sam owe Alex + Jo", "Your group owes Alex + Jo €48.00" (design frames 09, 10, 12, 28). Native shows "Maya + Sam owe Alex + Jo" even to Maya, who has to work out which side she is on.
- Why it matters: spoken output is awkward and the sentence does not say "you" even though the design promises it.
- Fix: build two renderings from one model: a visual string ("You + Sam") and a spoken string ("You and Sam"). Use "You" for the viewer's own member in group names (verb agreement then needs the plural rule from finding 5: "You + Sam owe", "You owe" for a single viewer). In the same pass fix "Paid by Maya" shown to Maya (say "Paid by you").
- Effort: M. Confidence: inferred from code for output; design frame for the intent.

### 7. Repayment titles are stored in the recorder's voice and say "your household"; English placeholders are stored as ledger data
- Severity: **S2 friction**
- Evidence: `markPaid` sets the receiver to the literal "your household" when the receiver is the recorder's own group and stores `"%1$@ paid %2$@"` as the settlement title (`AppModel.swift:4896-4909`); the title goes into the synced event payload (`LedgerRepository.swift:774-796`) and is shown verbatim as the row title (`HomeView.swift:492`, `SheetViews.swift:228`). Other members read "Alex + Jo paid your household" and "your household" means themselves. It also uses "household" for a couple's group, which finding 2 reserves for the whole home (`AppModel.swift:701-705` does the same for payers). Similar stored English: empty description saved as "Expense" and empty category as "Uncategorized" (`AppModel.swift:4130-4133`, so every no-category expense shows "Category: Uncategorized" in Detail), "Opening balances before Numa Shared" (`:3505,3548`), "Void attempt: %@" (`LedgerRepository.swift:1913-1922`).
- Why it matters: shared history reads wrongly for everyone except the person who typed it, and generated text in the ledger cannot be corrected or localized later.
- Fix: store the structured facts (from, to, amount) and derive the display title when rendering ("Alex + Jo repaid Maya + Sam"). For empty description/category store nothing and render "Expense" and no category line at display time.
- Effort: M. Confidence: verified in code.

### 8. Void and edit: wording drifts from the approved frames, and the void reason is mandatory
- Severity: **S2 friction**. **Challenges a decision.**
- Evidence: frames say "Void expense", "Remove its effect. Not its history.", "Reason · optional", primary "Record void", secondary "Keep expense" (design frame 15), and "Correct an expense", "Fix the detail. Keep the history.", "Save correction" (frame 14, design frame only). Native says "Void record", "Confirm void", "Why is this record wrong?" with the button disabled until text is typed (`SheetViews.swift:402,750,759-795`), and "Edit expense" / "Save edit" (`:390,649,691`). The list filter says "Corrections" but the button says "Edit". "Void" is also a bare badge (`Models.swift:415`). The mandatory reason is a documented contract ("Void confirmation requires user-entered nonblank reason text", `docs/CORE.md:108`; "blank void reasons remain invalid in every path", `DECISIONS.md:136`).
- Why it matters: the commonest reason to void is "I added it twice"; forcing a typed sentence on the escape hatch, framed as "why is this wrong?", feels like blame. Three words (void, edit, correction) for one family of actions.
- Fix: keep the contract (a non-blank reason) but remove the typing: pre-filled one-tap reasons ("Added twice", "Wrong amount", "Not a shared expense") plus free text; heading "Remove its effect. Not its history."; title "Void expense"; add the frame's "Keep expense" secondary action. Choose one word for changing an expense: I recommend "Edit" (pencil icon in frame 12, platform convention) and "Edited" in history, retiring "correction", "revision", "updated" and "Corrections" (rename the filter "Edits and voids"). That departs from frame 14's "Correct"; it needs an owner call.
- Effort: S to M. Confidence: verified in code.

### 9. People, deletion and contested-edit screens expose the ledger glossary
- Severity: **S2 friction**
- Evidence: `CONTEXT.md` lists "claim", "identity", "pending identity", "settlement unit", "member profile" as internal terms with "Avoid" lists; the UI uses them: "Detach wrong claim", "Detach claim", "The identity stays in the pot, but this account loses its claim" (`PeopleManagementView.swift:355,755,773`), "Choose an identity for this account", "Requested identity: %@", "Identity: %@" (`:494-510`), "Archive member" (`:358`), "Erase name", "The pending identity remains available" (`:362,779`), "People & ownership" (`SettingsView.swift:21`). The account-deletion dialog says "Shared arithmetic stays visible to other members under 'Former member'" and lists "relay email, push tokens" (`AppModel.swift:1581`). The notifications footer says "alerts you only when someone else changes your position or a contested record needs your choice. Pushes never include amounts" (`PeopleManagementView.swift:266`), which uses "alerts", "pushes" and "notifications" for one thing. Detail says "Settlements are immutable" (`SheetViews.swift:362`) and the header "Settlement [em dash] immutable" (`:229`). Contested edits: "Two edits need your choice / The later edit is applied for now" (`:469-471`).
- Why it matters: these are the highest-stakes screens (removing a person, deleting an account) and they use the least human words.
- Fix: see rewrites in Appendix B. Short version: "Unlink account" for detach, "Remove Sam from Casa Mar" for archive, "Who is this?" for identity, "Expenses and repayments you shared stay visible to the others. Your name becomes Former member." for arithmetic, "notifications" everywhere, and "A repayment can't be edited. If it's wrong, record a correction. The original stays in Activity." for immutable.
- Effort: S to M. Confidence: verified in code.

### 10. The primary action's accessible name does not contain its visible name, plus smaller label problems
- Severity: **S2 friction** (Voice Control on the main action); the rest S3
- Evidence: Home's add row shows "Add an expense" but is labelled "Add expense" (`HomeView.swift:387,397`). Voice Control users who say "Tap Add an expense" will not match (label-in-name rule). Other items, all verified in code:
  - Hints that start with "Double-tap to" (`SyncViews.swift:155-159`, `OpeningBalanceView.swift:180`); VoiceOver already says that, and hints should describe the result.
  - A hint that is not a hint: "Sync status for Casa Mar." (`SyncViews.swift:161`).
  - Activity unit-filter chip is a Button with a name and an X and no label or hint (`SheetViews.swift:119-132`); the two filter Menus announce only their current value ("All records", "All time"), not that they filter (`:101,112`).
  - Person menu in setup is labelled "Group options for Sam" but contains Edit name, Share a balance, Remove person (`OnboardingViews.swift:639`); the join-request menu is labelled "Selected identity: Sam" (`PeopleManagementView.swift:521`) with no hint that it opens a choice.
  - Settings dismiss is an X icon labelled "Done" (`SettingsView.swift:249-253`); the opening-balance screen has two controls that both skip (X "Close" and "Skip", `OpeningBalanceView.swift:39-48`).
  - Decimal key is labelled "." (`BudgetGroupExpenseFlow.swift:427`, `Components.swift:648`), read as "dot" or "period"; say "decimal point".
  - Hidden amounts render "€•••" (`NumaSharedCore/.../MoneyFormatting.swift:61`), probably read as "bullet bullet bullet" (inferred); label "Amount hidden". The empty-amount glyph "—" (`HomeView.swift:428`, `SheetViews.swift:170,229`) gets the same treatment ("No amount").
  - Share +/- buttons have no label (`AddExpenseView.swift:451,459`, legacy path); at best VoiceOver says "Add" and "Remove" for every row.
  - Decorative images not hidden: result symbols in the join sheet (`InviteViews.swift:192`), row icons in People (`PeopleManagementView.swift:433,486`), the initials fallback "A·M" (`:593-597`, would be read "A middle dot M"), the search glass (`SheetViews.swift:69`).
  - The Activity tab label announces "Activity, 5 records" counting only non-voided records (`HomeView.swift:511`, `AppModel.swift:626`) while the list also shows voided rows.
- Fix: label the add row exactly "Add an expense"; rewrite hints as results ("Keeps Casa Mar synced with Sign in with Apple"); give the filter chip `accessibilityLabel("Filtered to Sam")` + hint "Clears the filter"; prefix filter menus with "Filter by kind: All records"; hide the decorative images; add the spoken replacements above.
- Effort: S. Confidence: verified in code, except spoken output of SF Symbols and "•••" (inferred).

### 11. Dynamic Type: fixed-width money fields, single-line UIKit labels, and text below the app's own 11 pt floor
- Severity: **S2 friction**
- Evidence:
  - Fixed-width amount fields: `OpeningBalanceView.swift:152` (`.frame(width: 112)`), `BudgetGroupExpenseFlow.swift:125` (`maxWidth: 130`), `AddExpenseView.swift:492` (`width: 92`); at accessibility sizes "1,234.56" in a scaled font will clip or scroll inside the field.
  - `NativeTextLabel` is a one-line UILabel with `adjustsFontSizeToFitWidth`, `minimumScaleFactor 0.7` and `.fixedSize()` (`Components.swift:65-123`); it carries the household name under the wordmark (`HomeView.swift:244`) and the tab labels (`:538`). A long household name ("The Smiths' flat on Elm Street") has no wrapping or truncation path and will push the sync chip and gear (inferred).
  - The Home hero amount is `Text(amount).font(display(75))` with no scale-down (`HomeView.swift:288-289`), so at AX sizes a 5-digit amount wraps in the middle of the number. (`ActivityRowView` documents wrapping as a deliberate choice, `Components.swift:504-509`; for the hero a scale-down is safer than a split number.)
  - Text below the project's own `Metrics.minOrdinaryText = 11`: state labels at 9.5 pt and 8.5 pt mono in the revision history and contest cards ("Needs choice", "Applied for now", "Current", "Other version", `SheetViews.swift:519,609,613`), all-caps "ALLOCATION" and "REVISION HISTORY" at 9.5 pt (`:342,589`). `UIFontMetrics` scales from the smallest text style, so at default size these stay under 11 pt. They carry state, not decoration.
  - Home's "Money changes hands outside Numa Shared." is the core trust line and is 11 pt in the secondary colour (`HomeView.swift:204-206`; matches the frame, but it scales poorly). The tab labels are 10 pt.
  - Fixed heights on Home (`HomeView.swift:137,166,211,284`) are gated on `typeSize == .large`, so they are fine.
- Why it matters: money fields and the state of a contested edit are exactly where clipping or tiny text hurts most.
- Fix: replace fixed widths with `minWidth` + `.fixedSize(horizontal: true)` or move the amount under the name at `isAccessibilitySize` (the pattern already used elsewhere); make `NativeTextLabel` wrap at accessibility sizes (`numberOfLines = 0` when `traitCollection.preferredContentSizeCategory.isAccessibilityCategory`); `lineLimit(1)` + `minimumScaleFactor(0.5)` on the hero amount only; raise the state labels to `.caption2` (11 pt) sentence case ("Needs your choice").
- Effort: M. Confidence: inferred from code (not rendered).

### 12. Duplicate and contradictory lines on the same screen
- Severity: **S3 polish**
- Evidence:
  - Repayment amount screen, amount empty: the preview says "Enter what actually changed hands." (`AppModel.swift:4811`) and the line below says "Enter the amount already paid." (`SheetViews.swift:933`). Amount entered: the preview ends with "Only record money already sent elsewhere." (`AppModel.swift:4839`) and the screen's own note repeats it as "Record this only after the payment was made outside the app." (`SheetViews.swift:951`). The core promise has four phrasings in the app: "outside Numa Shared" (Home, `HomeView.swift:204`; sheet 1, `SheetViews.swift:813`), "outside the app" (`:951`), "sent elsewhere" (`AppModel.swift:4839`), "changed hands" (three places).
  - Entry screen asks the description question three times: heading "What was it for?", label "Description · optional", placeholder "What was it?" (`BudgetGroupExpenseFlow.swift:40-43`).
  - The payer step has four phrasings: CTA "Who paid?", nav title "Paid by", heading "Whose money paid for it?", intro "Choose the person who actually paid the €96 bill" (`:38,75-77`). "Whose money paid for it?" is the frame's wording (design frame 24) but it is the only place "money" is the subject, and "bill" for a restaurant dinner is the only use of "bill" in the flow.
  - Search placeholder promises a note that no screen lets you enter: "Search merchant, person, or note" (`SheetViews.swift:72`); the flow has Description and Category only, and "merchant" is a code word (`app.merchant`).
  - Empty-state spelling of the same fallback: "Person not recorded" (`HomeView.swift:466`, `SheetViews.swift:310,531`) vs "person not recorded" (`Components.swift:492`), plus "Unknown member", "Former member", "Former group", "Shared group", "No group" (`AppModel.swift:140,735,755`, `PeopleManagementView.swift:195`).
  - Notification controls (mute toggle, permission, footer) appear in both Settings and People (`SettingsView.swift:53-88`, `PeopleManagementView.swift:236-268`).
- Fix: keep one instruction per screen: "Enter the amount that was paid." and one disclaimer, in one phrase ("Record this only after the money has actually changed hands. Numa Shared never moves it." as in frame 35); entry heading only, label "Description (optional)", placeholder "Dinner, rent, groceries"; payer step: heading "Who paid?" (matches the CTA and the Home subtitle), no "bill"; search "Search expenses and people"; two fallbacks only ("Former member", "Former group").
- Effort: S. Confidence: verified in code.

### 13. Dates: three formats for one date, a hard-coded British locale, and a lowercase-month bug
- Severity: **S3 polish**
- Evidence: Home rows use `en_GB` regardless of device locale and give "3 October" with no year, "today", "yesterday" in lowercase (`HomeView.swift:469-478`); Activity and Detail use the device locale, "Today" capitalised and "Mon, 3 Oct" (`Models.swift:336-352`); revision history uses "3 Oct, 7:30 pm" (`Models.swift:225-233`). The expense flow shows "Paid \(dateLabel.lowercased())" (`BudgetGroupExpenseFlow.swift:60`), where `dateLabel` is the en_GB label with its first letter capitalised, so a back-dated expense reads "Paid 3 october" (verified by reading the code path). A US-locale phone sees "3 October" on Home and "Mon, Oct 3" in Activity.
- Fix: one relative-date formatter (today, yesterday, then "3 Oct" and "3 Oct 2025" when the year differs), device locale, used by every surface; do not lowercase a formatted date.
- Effort: S. Confidence: verified in code.

### 14. Em dashes (owner rule: none in generated copy)
- Severity: **S3 polish**
- Evidence: 13 Swift strings and 1 App Store field (full list in Appendix B). Two are dead (`amountEntryHint`, `AppModel.swift:933-940`, has no callers) and two are in the legacy add path (`AddExpenseView.swift:293,319`). Note that the approved frame for setup has "groups—not four people" (design frame 06), so removing it departs from frame text but follows the owner's rule. The standalone "—" placeholder for "no amount" is a glyph, not prose; keep or replace with words.
- Fix: replace with a period or comma (rewrites in Appendix B). Add a lint test that fails on U+2014 in `String(localized:)`, `Text("…")` and `app-store/` files.
- Effort: S. Confidence: verified in code.

### 15. The String Catalog cannot enforce anything, and the branding test has a hole
- Severity: **S3 polish** (no runtime impact in an English-only release)
- Evidence: `Localizable.xcstrings` has 233 keys, every value empty, no comments. 32 keys (14%) match no source string and carry retired vocabulary: "Create a pot", "Drag the sphere onto Sam or Maya", "See every balance at a glance. Add an expense by moving one object to the people who shared it.", "double entry", "Who lives here?" (list in Appendix C). Conversely about 270 live strings in `Text`, `Button`, `String(localized:)` and accessibility modifiers have no key. Large parts of the most important screens never reach the catalog because they are typed as `String`: 72 of 108 literals in `OnboardingViews.swift`, 26 of 45 in `BudgetGroupExpenseFlow.swift`, 20 of 38 in `HomeView.swift` (headline, amount line, chip direction, subtitles); `Text(cond ? "a" : "b")` is also a `String` overload and is not localized (`HomeView.swift:214`, inferred). Hand-made plurals ("1 record waiting", "split 1 unit"). `scripts/tests/branding-contract-test.mjs:21` only scans `String(localized: "…")`, so the standalone "Numa" in "Numa does not convert currencies" (`OnboardingViews.swift:198`) passes, against the rule that the name is exactly "Numa Shared". Three strings use a straight apostrophe where the other 77 use curly (`HomeView.swift:214,347,444`).
- Fix: do not chase localization now; chase vocabulary. Add one test that scans every string literal in the app target against a banned-word list (pot, unit, settle*, "budget group", "balance group", "Numa " not followed by Shared, U+2014) and fails. Delete the 32 stale keys. Make the flow components take `LocalizedStringResource`.
- Effort: M. Confidence: verified in code (counts from my extraction scripts, approximate).

### 16. Headings, and states carried by tone alone
- Severity: **S3 polish**
- Evidence: `.isHeader` appears in 9 places (Welcome, setup headings, expense-flow headings, join sheet header, error screens) and nowhere on Home ("Latest at home", the hero sentence), Activity, Detail (record title), Settings-style sheets ("Record a repayment", "Void record", "Edit expense", "Pots", "Keep Casa Mar synced"), or the expense-flow page title (`BudgetGroupExpenseFlow.swift:289`). The Headings rotor is empty on the screens used most. Colour/tone alone: the selected tab is a fill of `#E8E7DD` on a `#FAF9F4` bar, contrast 1.18:1, same font weight (`HomeView.swift:546`, computed by me; the `.isSelected` trait covers VoiceOver); setup progress is 4 pt bars distinguished only by tone (`OnboardingViews.swift:378`, has a spoken label); the Internet row icon uses the lilac group colour as a category colour and the category icon is chosen by substring-matching "internet" or "dining" (`HomeView.swift:462-463,489`), which clashes with "colour identifies groups". Disabled primary buttons drop to 45% opacity with no reason shown (for example "Who paid?" until an amount exists, `BudgetGroupExpenseFlow.swift:38`).
- Fix: add `.accessibilityAddTraits(.isHeader)` to screen titles and section titles; give the selected tab a second cue (heavier weight or filled icon); use a neutral colour for category icons and drive the icon from a category list, not substrings; show a one-line reason under a disabled primary ("Enter an amount first").
- Effort: S. Confidence: verified in code; contrast computed.

### 17. "Export CSV" promises a spreadsheet and delivers an event log
- Severity: **S2 friction**
- Evidence: Settings says "Export CSV" and "N events in this export" (`SettingsView.swift:112-125`); the App Store text says "export the full record as CSV"; frame 50 promises "Expenses, splits and actual payers / Recorded repayments and opening balances / The household's derived balances". The file's columns include `event_kind`, `server_sequence`, `applied_order` and a canonical `event_json` blob, and `docs/CSV.md` says to reconcile by decoding the JSON and running the reducer. Derived balances and plain date/description/amount/payer columns do not exist (`LedgerCSVExport.swift:15-33`).
- Why it matters: this product replaces a household spreadsheet; a flatmate who opens the file finds JSON.
- Fix: until a readable export exists, say what it is: "Export full history (technical file)" with "Includes every event, with exact amounts, for backup or audit." Better: add a second, readable CSV (date, description, payer, group shares, repayments, running balance per group).
- Effort: S for copy, M for a readable file. Confidence: inferred from `docs/CSV.md` and exporter columns.

### 18. Push, TestFlight and store copy repeat the internal words
- Severity: **S3 polish**
- Evidence: push bodies: "New expense in Casa Mar affects your balance", "A record in Casa Mar was edited and affects your balance", "... was voided and affects your balance", "A settlement in Casa Mar involves your balance", "A record in Casa Mar needs your choice" (`convex/lib/notificationMatrix.ts:12-33`). TestFlight: "add expenses, split them exactly, see balances, and record settlements", "check that a push opens the correct pot" (`app-store/en-US/testflight-description.txt`, `what-to-test.txt`). Store description bullet: "Search, edit, void, restore, and repeat expenses with visible history" and "Invite household members"; it never says that couples can share one balance, which is the product's one distinctive idea. Promo text has an em dash.
- Fix: pushes (still amount-free): "New expense in Casa Mar. Your balance changed." / "An expense in Casa Mar was edited. Your balance changed." / "An expense in Casa Mar was voided. Your balance changed." / "A repayment was recorded in Casa Mar. Your balance changed." / "Two edits in Casa Mar need your choice." Store: add a bullet "Couples can share one balance"; "payments" to "repayments"; drop "void, restore, repeat" from the marketing list or explain them ("fix mistakes without erasing history"). Promo: "One calm, shared record of household expenses. No money moves."
- Effort: S. Confidence: verified in code and files.

## Appendix A. Vocabulary table

Counts are approximate string-literal hits across view and model files (regex, case-insensitive). "Use" is the single recommended word.

| Concept | Words used today (count) | Examples (file:line) | Use |
|---|---|---|---|
| The shared place | pot (57), household (22), home (13), place (2), "shared pot" (3) | "Leave pot" `PeopleManagementView.swift:272`; "Join a pot" `InviteViews.swift:227`; "Create our home" `OnboardingViews.swift:116`; "Household name" `:168`; "Latest at home" `HomeView.swift:412`; "Confirming your place in this pot" `InviteViews.swift:242`; "Mute this pot" `SettingsView.swift:55` | The household's own name ("Leave Casa Mar"); noun "household"; "home" only for the tab and warm headlines |
| Person or couple that owns a balance | budget group (9), balance group (5), shared budget (2), budget (13), group (34), unit (10), "one balance" (4) | `OnboardingViews.swift:541,568,582`; `OpeningBalanceView.swift:189`; `PeopleManagementView.swift:198`; `BudgetGroupExpenseFlow.swift:86,233`; `Models.swift:383` | "group"; lead with names; teach once in setup |
| Who owes whom | owe/owes (15), gets back (6), even (8), "All square" (1), balance (41), debt (2), position (1) | `HomeView.swift:114-119,318`; `PeopleManagementView.swift:266` ("position") | "owes/owe" by group size, "gets back", "even" for a group, "All square" only for the household headline; "balance" noun; never "position" or "debt" |
| Paying someone back | repayment/repaid (5), settle/settlement/settled (16), transfer (10), "Mark as paid" (1), "pays" (1), payment (2), reversal (15), "changed hands" (1) | `HomeView.swift:295`; `SheetViews.swift:820,836,968,995`; `Models.swift:156,420`; `AppModel.swift:4932` | "repayment" / "Record €50.00 repaid"; "reversal" becomes "correction" |
| The thing someone bought | expense (29), bill (6), purchase (1), charge (2), record (64) | "Void record" `SheetViews.swift:402`; "No matching records" `SheetViews.swift:158`; "paid the €96 bill" `BudgetGroupExpenseFlow.swift:77`; "Everyone records purchases" `OnboardingViews.swift:523`; "Save personal charge" `AddExpenseView.swift:361` | "expense" (and "repayment" for repayments); "record" only as a verb; mixed lists say "activity" |
| Removing an expense | void (11), delete (19, mostly account), remove (5), restore (8), erase (4), archive (6), detach (4), revoke (3) | `SheetViews.swift:402,414`; `PeopleManagementView.swift:355-362` | "Void" for expenses, "Restore" to undo; "Remove" for people; "Delete" only for account and data; retire archive, detach, erase |
| Changing an expense | edit (17), correction (6), revision (1), update (7), flag (9), repeat (2), "attempt" (7) | "Edit expense" `SheetViews.swift:390`; "Corrections" `Models.swift:178`; "Flag as incorrect" `SheetViews.swift:444`; "Void attempt" `Models.swift:403` | "Edit" / "Edited" (owner call, see finding 8); "Flag as incorrect" becomes "Report a mistake"; no "attempt" in user text |
| People and roles | member (25), person/people (44), owner (12), identity (11), account (14), claim (4), pending (4), friends (2), flatmate/housemate (0) | `PeopleManagementView.swift:355,494-510,606-610`; `SyncViews.swift:178` | "person/people"; "owner" for the one role; never identity, claim, account (except Apple sign-in), "friends" |
| Invites | invite (43), invitation (10), link (6), code (20), request (8), "withdrawn"/"Revoke" | `InviteViews.swift:229,264`; `PeopleManagementView.swift:382,390,453` | "invite" (noun and verb), "join request", "Revoke" in both places |
| The list of events | Activity (6), history (19), records (25), "shared history" (3) | `HomeView.swift:510,422,443`; `SheetViews.swift:62,158` | "Activity" for the screen, "history" for the idea, never "records" for the list |
| Staying in step | sync (28), connect (2), sign in (12), "Enable sync", "Keep X synced", "Continue with Apple" | `HomeView.swift:444`; `SettingsView.swift`; `SyncViews.swift:176` | "sync" for the feature, "Sign in with Apple" for the button; drop "connect" |
| Alerts | notifications (7), alerts (3), pushes (1) | `PeopleManagementView.swift:266`; `SettingsView.swift:82` | "notifications" |
| Missing person or group | "Person not recorded", "person not recorded", "Unknown member", "Former member", "Former group", "Shared group", "Shared budget", "No group", "Untitled pot", "Uncategorized" | `HomeView.swift:466`; `Components.swift:492`; `AppModel.swift:140,735,755`; `PeopleManagementView.swift:195` | "Former member", "Former group" only |
| Postponing or leaving a step | "Not now" (sync), "Not yet" (repay), "Skip" (opening), "Cancel", "Keep these details", "Done" | `SyncViews.swift:207`; `SheetViews.swift:981`; `OpeningBalanceView.swift:44` | "Not now" to postpone, "Cancel" to abandon, "Done" to finish, "Continue" to advance |

## Appendix B. Copy defects with rewrites

Rewrites contain no em dashes. Group names are shown as "Maya + Sam".

### Em dashes (14)

| Location | Before | After |
|---|---|---|
| `Models.swift:447` | Couldn't be added [em dash] you're no longer a member | This can't be shared because you're no longer in this household. It stays on this iPhone. |
| `Models.swift:449` | Couldn't be added [em dash] this pot reached its safe record capacity. Copy the details and contact support. | Casa Mar is full and can't take more entries. Copy the details to send us. |
| `Models.swift:451` | Couldn't be added [em dash] copy the details and contact support. | This couldn't be shared. It's still saved on this iPhone. Copy the details to send us. |
| `SheetViews.swift:229` | %@ [em dash] immutable | Repayment (can't be edited) |
| `SheetViews.swift:247-248` | Voided [em dash] balances restored. The record stays visible. | Voided. Balances are back to how they were. The expense stays in Activity. |
| `SheetViews.swift:362` | Settlements are immutable [em dash] flag it if something is wrong; it stays visible while you sort it out. | A repayment can't be edited. If it's wrong, report a mistake and record a correction. The original stays in Activity. |
| `BudgetGroupExpenseFlow.swift:147` | Equal shares for 2 budget groups[em dash]not per person. | Split equally between 2 groups, not per person. |
| `OnboardingViews.swift:573` | A 50/50 bill is split between these two groups[em dash]not 4 people. | A 50/50 bill is split between these two groups, not 4 people. |
| `AddExpenseView.swift:293,319` (legacy) | Dinner [em dash] €96.00 / Personal charge [em dash] Sam owes Maya the full amount. | Dinner, €96.00 / Sam owes Maya the full amount. |
| `AppModel.swift:935,938` (dead) | %@ [em dash] whole units only. | Delete (unused). |
| `app-store/en-US/promotional-text.txt` | ...household expenses[em dash]without moving money. | One calm, shared record of household expenses. No money moves. |

### Jargon

| Location | Before | After |
|---|---|---|
| `AppModel.swift:1581` | Shared arithmetic stays visible to other members under "Former member." | Expenses and repayments you shared stay visible to the others. Your name becomes "Former member". |
| `PeopleManagementView.swift:266` | Numa Shared alerts you only when someone else changes your position or a contested record needs your choice. Pushes never include amounts. | We notify you when someone else's change affects what you owe, or when two edits need your choice. Notifications never show amounts. |
| `PeopleManagementView.swift:355,745,755,773` | Detach wrong claim / Detach Sam? / The identity stays in the pot, but this account loses its claim. | Unlink account / Unlink Sam's account? / Sam stays in Casa Mar and keeps their expenses. This account no longer controls them. |
| `PeopleManagementView.swift:358,746,775` | Archive member / Archive Sam? / Past records stay visible. This member loses access to the pot. | Remove Sam from Casa Mar / Remove Sam? / Their past expenses stay in Activity. They can no longer open Casa Mar. |
| `PeopleManagementView.swift:494,495,510` | Choose an identity for this account. / Requested identity: Sam / Identity: Sam | Who is this? / Wants to join as Sam / Joining as Sam |
| `SheetViews.swift:469-471` | Two edits need your choice. The later edit is applied for now. Compare both versions and choose what this record should say. | Two people edited this expense. Pick the version to keep. Until then, the later one counts. |
| `SheetViews.swift:342,589` | ALLOCATION / REVISION HISTORY | Who it was for / Earlier versions |
| `SheetViews.swift:536-539,712` | Balance impact / Balances stay the same. | What changes / Nobody's balance changes. |
| `OpeningBalanceView.swift:59` | Add only what was already owed before this pot. Your budget group amount is calculated so the pot stays exactly balanced. | Add only what was already owed before you started here. We work out your side so everything adds up. |
| `OpeningBalanceView.swift:189,230,232` | Your budget group starts / Sam owed your budget group | Maya + Sam start by owing / Sam was owed by Maya + Sam |
| `AppModel.swift:3087` | This household has reached its group identity limit. | This household can't take more people or groups. |
| `Models.swift:383,390` | Sam paid · 11 Sep · split 2 unit(s) | Sam paid · 11 Sep · split between 2 groups |
| `SettingsView.swift:125,155` | 12 events in this export / The file contains exact amounts even when Hide amounts is on. Deleted authored text stays redacted. | 12 rows in this file / The file shows exact amounts even when Hide amounts is on. Text you erased stays erased. |
| `RootView.swift:83` | You're no longer a member. This frozen copy stays available to review and export. | You've left Casa Mar. You can still read and export the history, but you can't add to it. |

### Vague or robotic

| Location | Before | After |
|---|---|---|
| `SyncViews.swift:178`, `InviteViews.swift:139` | This keeps your pots synced and tells friends it's you. | Sign in with Apple to share Casa Mar with the people you invite. Your expenses stay on this iPhone either way. |
| `SyncViews.swift:215` | Canceling leaves every record on this iPhone. | You can sign in later. Your expenses stay on this iPhone. |
| `RootView.swift:93` | Please update | Update Numa Shared to keep syncing. (with a link to the App Store) |
| `HomeView.swift:214` | Every shared moment is still in your history. | Everything you've added is in Activity. |
| `HomeView.swift:422` | No records yet. Your first shared expense starts the story. | No expenses yet. Add the first one. |
| `AppModel.swift:4811` + `SheetViews.swift:933` | Enter what actually changed hands. / Enter the amount already paid. | Enter the amount that was paid. (once) |
| `AppModel.swift:4838` | Overpayment reverses who owes whom. | That's more than Maya + Sam owe, so Alex + Jo would owe back the difference. |
| `AppModel.swift:4932` | Settlement €50.00 recorded | €50.00 repayment recorded |
| `SheetViews.swift:72` | Search merchant, person, or note | Search expenses and people |
| `SheetViews.swift:760` | Why is this record wrong? | Reason (for example: added twice) |
| `OnboardingViews.swift:198` | Numa does not convert currencies. | Numa Shared does not convert currencies. |
| `notificationMatrix.ts:12-33` | A record in Casa Mar was edited and affects your balance | An expense in Casa Mar was edited. Your balance changed. |

### Inconsistent tone

| Location | Observation |
|---|---|
| Home, Welcome, empty state (warm) vs repayment, void, People (clinical) | Frames 35, 15, 14 are warm and short ("Already paid some back?", "Remove its effect. Not its history."); the native screens behind them are not. |
| `HomeView.swift:111` | Empty-state headline "Our everyday, together." says nothing about the state; frame 54 says "All square. Nice place to start." |
| `SettingsView.swift:155`, `SheetViews.swift:362` | The two longest disclosures in the app use the most technical words. |
| Toolbar | "Done" is top-leading in People (`PeopleManagementView.swift:98`) and top-trailing in Settings (`SettingsView.swift:247`). |

## Appendix C. Strings that bypass or drift from the catalog

1. **Typed as `String`, so they cannot reach the catalog:** all onboarding headings, intros, footnotes, buttons and explanations (`OnboardingViews.swift:160-258,449-575,692-755`: 72 of 108 literals); the add-expense flow's page titles, button labels, intros, row subtitles and explanations (`BudgetGroupExpenseFlow.swift:9,37-40,75-77,86,102,108,119,146-147,170-180,231-233`: 26 of 45); Home's headline, amount line, chip direction, subtitles (`HomeView.swift:111-122,214,317-319,466-467,494`); `PrimaryPillButton(title:)` in `AddExpenseView.swift:53`, `SheetViews.swift:691,788`; `SplitChoice` raw values rendered with `Text(choice.rawValue)` (`BudgetGroupExpenseFlow.swift:9,205`).
2. **Built with interpolation in AppModel, never localized:** review strip "After saving, ..." (`AppModel.swift:3937-3943`), repayment preview in budget-group mode "After this, X still owe Y ...", "Overpayment reverses who owes whom.", "Only record money already sent elsewhere." (`:4831-4840`; the older unit path just above is localized, the path new households use is not), fallback names "Former member", "Unknown member", "Former group", "Choose person" (`:140,735,3861`), "Starting balance" (`:5138`; elsewhere the same concept is "Opening balance"), "This household has reached its group identity limit." (`:3087`).
3. **Stored in the ledger as English text:** "Expense", "Uncategorized" (`AppModel.swift:4130-4133`), "Opening balances before Numa Shared" (`:3505,3548`), settlement titles "X paid your household" (`:4896-4909`), "Void attempt: %@" (`LedgerRepository.swift:1913`). See finding 7.
4. **Names and locale hard-coded in production code:** `localName(app.ownerDisplayName, fallback: "Arseny")` (`PeopleManagementView.swift:161`, a user without a display name sees the author's name in the legacy people list); default units "Arseny + Maya", "Sam", "Leo" (`Models.swift:104-106`); date format forced to `en_GB` (`HomeView.swift:475`); currency names forced to the "en" locale (`OnboardingViews.swift:315`, `BudgetGroupExpenseFlow.swift:187`).
5. **In the catalog but not in source (32 keys):** `%@ would be shared with %@`, `Add a person to create two balance groups.`, `Add person`, `Confirmed for this pot [em dash] never changed automatically`, `Suggested from this iPhone [em dash] tap to confirm`, `Create a pot`, `Create your pot`, `Drag the sphere onto Sam or Maya`, `Drag people together if they should share one balance.`, `Enter a name for each person.`, `Enter a pot name and your name.`, `EUR €`, `Into %@`, `Invites can wait. You can share them from People after setup.`, `Keep everyone separate`, `One shared balance`, `See every balance at a glance. Add an expense by moving one object to the people who shared it.`, `Start locally. Sign in only when you invite someone or enable sync.`, `Names are enough [em dash] they can join later and claim their history.`, `Pending [em dash] invite anytime`, `Pot name`, `Who lives here?`, `YOU`, `Your name in this pot`, `Amount (EUR minor units): %lld`, `Everyone in this pot sees this same synced history.`, `Couldn't sync`, `Only on this iPhone until you enable sync.`, `This history stays available on this iPhone.`, `Waiting records stay on this iPhone until sync finishes.`, `double entry`, `Some failed records are only on this iPhone.`
6. **Present in source, absent from the catalog:** about 270 literals, for example all of Settings (`SettingsView.swift:92,115-116,147,167`), People, the pot switcher, Activity filters, the repayment sheets and the whole add flow.

## Appendix D. Accessibility checklist result

| Check | Result |
|---|---|
| Icon-only buttons without a label | Share +/- in the legacy split view (`AddExpenseView.swift:451,459`); the unit-filter chip (`SheetViews.swift:119`). Everything else (gear, back, close, ellipsis, refresh, QR, lock toggle) is labelled. |
| Labels that differ from visible text | Add row (`HomeView.swift:397`), Settings "Done" on an X (`SettingsView.swift:253`), "Group options for" on a person menu (`OnboardingViews.swift:639`). |
| Images not hidden | `InviteViews.swift:192`, `PeopleManagementView.swift:433,486,593`, `SheetViews.swift:69` (inferred: SF Symbols without a label can still be read from their name). |
| Headings | Missing on Home, Activity, Detail, repayment/void/edit sheets, pot switcher, sync sheet. |
| Announcements and focus | None in the app (finding 1). |
| Colour or tone alone | Selected tab 1.18:1 fill; setup progress; Internet icon uses a group hue; disabled CTA gives no reason. Selection in pickers and rows is fine (shape plus trait). |
| Hints | Two "Double-tap to" hints; one hint that restates status; good hints on payer, balance, Support link. |
| Dynamic Type | Risks in finding 11; Home fixed heights are gated to `.large` and are safe; most rows reflow with `ViewThatFits` or `AnyLayout`. |
| Text under 11 pt | `SheetViews.swift:342,519,589,609,613`; tab labels at 10 pt. |
| Voice Control names | Add row mismatch; "Delete digit" and digits are fine. |
| VoiceOver reading of names and money | "+" read as "plus"; "€•••" and "—" unclear. |

## Voice proposal for Numa Shared

One voice: a friendly flatmate who is good with numbers. Warm on Home and onboarding, plain on money, calm on anything destructive.

1. **One name per thing, the one a flatmate would say.** The household is called by its name. A repayment is a repayment.
   Before: `Leave pot` / `Join a pot` / `Mark as paid` / `Record another transfer`
   After: `Leave Casa Mar` / `Join Casa Mar` / `Record €50.00 repaid` / `Record a different repayment`
2. **Say the result with names and numbers, not the model.** Replace nouns like "balance impact", "allocation", "position" with a sentence about who owes whom.
   Before: `Balance impact` then `Maya + Sam owes €12.00 → Maya + Sam owes €48.00`
   After: `After this, Maya + Sam owe Alex €48.00.`
3. **Buttons name the outcome, with the amount when there is one.**
   Before: `Mark as paid` / `Save edit` / `Confirm void` / `Keep these details`
   After: `Record €50.00 repaid` / `Save changes` / `Void expense` / `Save details`
4. **Say what stays, then what changes, then what to do.** Every consequence line works in that order, and never ends on "contact support" without saying the data is safe.
   Before: `Couldn't be added [em dash] copy the details and contact support.`
   After: `This couldn't be shared. It's still saved on this iPhone. Copy the details to send us.`
   Before: `Past records stay visible. This member loses access to the pot.`
   After: `Their past expenses stay in Activity. They can no longer open Casa Mar.`
5. **Warm where it is safe, plain where it is money.** Humor and rhythm live on Home, onboarding and empty states; never on a number, an error or a destructive button.
   Keep: `All square. No one owes anyone.` / `Good company. Clear money.` / `Who paid? Who was it for?`
   Change: `No records yet. Your first shared expense starts the story.` becomes `No expenses yet. Add the first one.`; `Every shared moment is still in your history.` becomes `Everything you've added is in Activity.`

Mechanics, as a footer rule: no em dashes (use a period or a comma), sentence case everywhere (retire all-caps mono labels), curly apostrophes everywhere, accessibility hints describe the result and never start with "Double-tap to", "tap" for gestures, one instruction per screen.

## Ground-up rethink

1. **One sentence builder for every "who owes whom" line.** A small value type `BalanceSentence(from: Group, to: Group, amount:)` produces the visual string ("You + Sam owe Alex + Jo €84"), the spoken string ("You and Sam owe Alex and Jo, 84 euros"), the short chip ("owes €10"), the push-safe string (no amount), and the verb agreement for 1 or 2 people. Home hero, chips, review strip, repayment preview, detail, filter explainer and tests all call it. The user sees the same sentence everywhere, correct for singles and couples, spoken properly, and speaking in "you" as the frames show. This also gives a place to put the banned-word lint.
2. **A spoken confirmation layer.** Every save, undo, void and repayment posts a short announcement ("Dinner €42.00 saved. Undo for 6 seconds") and exposes Undo as a rotor action on the Home and Activity containers; the 6-second bar stays for sighted users. Add a haptic-plus-announcement pair to the amount keypad so each digit confirms the running total. A VoiceOver user gets the same safety net as everyone else.
3. **Fix a repayment like you fix an expense.** Today a wrong repayment needs "Flag as incorrect", then "Record reversal" (with "linked reversals" and "Fully reversed by linked records"), then recording the right one again. Offer "Fix repayment" with the same edit sheet as an expense (change amount, who repaid whom) and write the flag, reversal and new repayment as one visible "Corrected" event under the hood. The history stays append-only; the user learns one verb. This **challenges** the "settlements are immutable" decision (`SheetViews.swift:362`) in the UI layer only; the ledger contract is unchanged.
4. **Teach "group" by example, not by name.** In setup, show the live label ("Maya + Sam") on a tinted card with one line, "A couple shares one balance", and never print "budget group", "balance group" or "unit" anywhere. After setup the word "group" appears only in the split choices ("For one group") and the People list. A new flatmate meets the idea once, in context, and never has to learn a glossary.

## Quick wins

1. Replace the 57 "pot" strings with the household name or "household", and `convex/lib/webContent.ts` lines 216-293 (finding 2).
2. One `owe/owes` helper used by Home hero, chips, review strip and preview, with an "and" spoken variant (findings 5, 6).
3. Post a VoiceOver announcement when Undo appears and add `.updatesFrequently` to the amount element (finding 1).
4. Label the Home add row "Add an expense", add `.isHeader` to screen titles, and rename "Mark as paid" to "Record €X repaid" and "Record another transfer" to "Record a different repayment" (findings 4, 10, 16).
5. Remove the 13 em dashes in Swift and the one in `promotional-text.txt`, and add a lint test that bans U+2014, "pot", "unit" and standalone "Numa" in user strings (findings 14, 15).
