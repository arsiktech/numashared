# 01 Home screen and balance comprehension

Evidence labels: **verified in code** (read the Swift and traced the path), **inferred** (follows from SwiftUI/UIKit behaviour, needs a device check), **design only** (approved frame, no code involved). Nothing was run; there is no Simulator here.

## Verdict

Home is built around the right idea (a sentence, a big number, one action, a short feed), and for the one case in the approved frames (two couples, one debt) it reads well. It does not hold up for the shapes a real flat has. It never says "you", it hard-codes plural verbs ("Sam owe Leo"), it collapses three or more groups into "X owe across the household" with no names, and the empty and settled states show a giant amount beside an arrow that goes nowhere useful. The "why" arrow does not open the approved "whole picture" screen at all; it opens the generic Activity sheet with a filter chip and a net-arithmetic card. The bottom bar looks like three tabs but is one screen plus two modal sheets, and the household-name switcher is a hidden control that leads to a mostly disabled "Pots" sheet. The code also drifts from the approved empty, settled and offline frames without a recorded reason, and carries pixel-matching hacks that only apply at one Dynamic Type size.

## Findings

### 1. Home never says whether YOU owe or are owed
- Severity: S1 broken/trust
- Evidence: `HomeView.swift:110-120` builds the headline from `unitInfo(for:).name` only. `UnitInfo.isYou` is computed (`AppModel.swift:738, 773`) and never read by any view (grep: only definitions). The approved frames 09, 21, 38, 54 all say "You + Sam owe Alex + Jo". Setup lets the owner type a real name (`OnboardingViews.swift:591`), so a real Home reads "Arseny + Sam owe Alex + Jo".
- Why it matters: the first question on opening the app is "do I pay or get paid?"; today the user must find their own name in a sentence.
- Fix: render viewer-relative text at display time, never persisted: own group is "You" (solo) or "You + Sam" (couple, viewer first); sentence forms: "You owe Alex", "Alex owes you", "You + Sam owe Alex + Jo", "Alex + Jo owe you + Sam". One pure function `BalanceSentence.make(viewer:plan:balances:)` with unit tests for every shape in the appendix. Keep stored titles neutral (see 11).
- Effort: M. Confidence: verified in code.

### 2. Verb agreement is hard-coded and inconsistent
- Severity: S1 broken/trust (copy errors on the hero, every launch, for the most common household shape: single people)
- Evidence: `HomeView.swift:114` `"\(from.name) owe\n\(to.name)"`, `:117` `"\(name) owe\nacross the household"`, `:118` `"get back"`, `:119` `"\(name) are even."`. All plural. The "why" card does the opposite: `AppModel.swift:5124-5135` uses "gets back", "owes", "is even" for every group, so a couple reads "You + Sam owes €84". Chips use "owes" (`HomeView.swift:319`), fine as a fragment. `UnitInfo.isWoven` already tells couple from single.
- Why it matters: "Sam owe Leo" and "Alex get back from the household" look like bugs and undermine trust in the number beside them.
- Fix: one helper `verb(for unit, viewerIsUnit)` used by Home, the why card, `contestBalanceState` (`AppModel.swift:4248-4268`), and chips. Rule: "you" and couples take plural, a single named person takes "-s".
- Effort: S. Confidence: verified in code.

### 3. With 3+ groups, Home stops answering "who owes whom"
- Severity: S1 broken/trust
- Evidence: `HomeView.swift:116-119, 125`. When `plan.count != 1` the hero becomes "<You> owe\nacross the household" plus your net total, or "<You> are even.\nSee every group below." plus a 75pt "€0". Counterparties exist only in the 12pt chip subtitles, and only in the non-compact layout (`:338`). `openSettlePlan` then lists every plan step, not just yours (`SheetViews.swift:815`). The plan is a minimum-transfer plan (`SettlementPlanner.swift`), not pairwise, so the steps can name someone you never traded with, with no explanation.
- Why it matters: three flatmates is the normal case beyond couples; "across the household" has no names or amounts to act on, and "€0" hides that two others owe each other.
- Fix: for n>=3 show the plan as up to 3 lines inside the butter panel, your lines first ("You pay Leo €30", "Sam pays Leo €10"), each tappable to record that repayment; collapse the rest under "2 more". If you are even, replace the big "€0" with "You're even." and a single line "Sam owes Leo €30". In the repayment list put your steps first and label others "Between others".
- Effort: M. Confidence: verified in code (layout of the new lines is design work).

### 4. The "why" arrow does not open the designed "why" screen
- Severity: S1 broken/trust (core promise: "and why")
- Evidence: `HomeView.swift:173` `Button { app.tapOrb(whyUnit) }`; `AppModel.swift:4190-4193` `tapOrb` just sets `activityFilter` and `sheet = .activity`. The result is `ActivitySheet` (`SheetViews.swift:47-205`) titled "Activity", with search field, two filter menus, an ink filter chip, then a card from `filterExplain` (`AppModel.swift:5098-5153`): "Share of expenses −€x / Paid for the pot +€y / Settled so far ±€z / Balances cover the full pot history." There is no "Here's the whole picture" screen and no "What makes up €84" per-expense list (frame 10), no total line, and no large-type version (frame 59). The whole header including the card is outside the `ScrollView` (`SheetViews.swift:59-153`), so at accessibility sizes it can fill the sheet and leave no room for rows (inferred). The arrow itself has no visible text; the hint is VoiceOver-only (`HomeView.swift:189`).
- Why it matters: the user taps the arrow expecting an explanation and gets a search/filter tool plus three signed figures they must add up themselves; rows below show gross amounts (€96) not the user's effect (€48).
- Fix: build the approved screen. Contents: debtor/creditor bridge, amount, then "What makes up €84": one row per live record with your signed effect = (you paid ? amount : 0) − your share, repayments as rows, a total that equals the balance exactly. That is correct for any group count, unlike the frame's two-group shortcut. Scrolling page, not a detent sheet. Put a visible label on the trigger ("Why €84?" or "See what makes this up") instead of a bare arrow disc. Remove "pot" from copy.
- Effort: L. Confidence: verified in code.

### 5. Empty and all-square states keep the amount and the dead arrow, and drift from approved frames
- Severity: S2 friction
- Evidence: `HomeView.swift:173-190` has no `isEmpty`/`isAllEven` condition, so the dark arrow disc stays: on empty it opens an empty Activity filtered to you; on all-square it opens "X is even". Empty shows "Nothing shared yet" as the 75pt amount slot (`:122`, `:288`) with headline "Our everyday,\ntogether." (`:111`, not in `screens.js`, not localized). Frame 54 is "All square. Nice place to start." with a "Add your first expense" row and "Already owe each other money?" link; frame 55 is "All square. Go enjoy the day." with a check orb and no amount. Code: "All square.\nNo one owes anyone." (`:112`, second line repeats the first) with a 75pt "€0". The Add row copy never changes for empty. The empty-state "See all" and "No records yet. Your first shared expense starts the story." both show. Opening balances are reachable only from setup (`OnboardingViews.swift:576`, `AppModel.swift:3404`); no caller after setup, so the frame-54 link has no destination.
- Why it matters: the first screen a new household sees has one real job (add the first expense) and instead shows a slogan, a fake amount, a button that goes nowhere and three competing text lines.
- Fix: empty: hide amount and arrow; hero "Nothing owed yet." (or the approved copy), sub-line one sentence; Add row becomes "Add your first expense / A coffee, a bill, a dinner together."; hide "Latest" and "See all"; add the "Already owe each other money?" row that opens the opening-balance flow (also from Settings, per frame 77). All-square: drop the amount, keep one line ("All square. Go enjoy the day." is better than repeating "No one owes anyone"). On "All square" as a phrase: fine for a UK/EU audience (dates are en_GB), and it is clear; just do not say it before anything happened unless you keep frame 54's "Nice place to start".
- Colour note: frames 54/55 turn the whole panel citrus, the same hue as the "You + Sam" group identity. That breaks the contract "colour identifies groups, never state". Code stays butter. Keep butter, or use a tone outside the group palette.
- Effort: S-M. Confidence: verified in code + design only.

### 6. The balance amount has no fit strategy; it can wrap mid-number
- Severity: S2 friction (money must never break across lines)
- Evidence: `HomeView.swift:275-292`. The Euro-at-`.large` branch uses `ViewThatFits` but its fallback is `fixedSize(horizontal:false)` which wraps. All other cases (every non-euro currency, every other type size) use `Text(amount).font(display(75)).fixedSize(horizontal:false)`. The amount sits in an HStack with a 47pt disc and 12pt gap (`:176-183`), so it gets about 284pt of 343. `display(75, relativeTo: .largeTitle)` scales with Dynamic Type (`Theme.swift:134`). From frame 09 a digit is about 38pt at 75pt, so "€12,345.00" and any six-digit JPY/HUF balance already exceed 284pt at default size; at accessibility sizes even "€84.50" does. A long token breaks by character in SwiftUI `Text`.
- Why it matters: the single most important number on the screen can display as "€1,234." over ".50".
- Fix: `ViewThatFits` size ladder 75, 60, 48, 40 with `lineLimit(1)` and `minimumScaleFactor(0.5)` on the last rung, for all currencies; at accessibility sizes put the arrow disc below the amount, not beside it. Test strings: €84, €123.45, €1,234.50, €12,345.00, ¥123,456, 123 456 Ft, at default and AX5.
- Effort: S. Confidence: inferred (needs device).

### 7. Two Home compositions, keyed on one exact Dynamic Type size
- Severity: S2 friction
- Evidence: `compactPair = ledgerUnitIDs.count == 2 && typeSize == .large` (`HomeView.swift:108`). Under it: fixed heights 50.5, 28, 82.5, 43 (`:137, 166, 184, 211`), negative offsets from `referenceLeadingInset` (`:263, 283`), an inline chip row, and initials in circles. Any other size or any household with 3+ groups gets the `LazyVGrid` of plain colour circles with two-line labels (`:168`) that no frame shows. A user on Medium or XL text sees a different, unreviewed Home from the owner.
- Why it matters: the approved design only exists at one text size; the rest is accidental.
- Fix: design the non-compact layout once and make it the base (chips as a wrapping row of initials + name, direction text only where it helps); keep fixed heights out of it. Delete pixel-matching offsets once the base layout is right.
- Effort: M. Confidence: verified in code.

### 8. Long household and group names overflow the header
- Severity: S2 friction
- Evidence: `HomeView.swift:244` `NativeTextLabel(text: app.potName, size: 12 ...)`; `Components.swift:65-88` is a one-line UILabel with `.fixedSize()`, so it takes its full width and `adjustsFontSizeToFitWidth` never triggers. Names may be 128 characters (`AppModel.swift:3698`). The header row is title + Spacer + optional sync capsule + 44pt gear (`:132-153`); a long name pushes the gear off or overlaps it. Group names with "Alexandra + Jonathan" are handled: chips fall back to the wrapping grid (`:168`), the headline reflows (`:255-268`), no truncation. Single-line `NativeTextLabel` is also used for the compact chip names (`:335`) but they have the grid fallback.
- Fix: header title column `layoutPriority(0)`, name `lineLimit(2)` with truncation in the middle; use `WrappingTextLabel` for the household name. Cap household name at 40 characters in setup.
- Effort: S. Confidence: inferred.

### 9. The household-name switcher is hidden and mostly dead
- Severity: S2 friction
- Evidence: `HomeView.swift:133-144` makes "numa. / Our place" a plain button: no chevron, 12pt grey text, hint "Opens the pot switcher." It opens `PotSwitcherView`: title "Pots", "New pot", "Untitled pot", and when sync is on (the normal case for a shared household) the list shows one row, the button is 40% opacity and a note says "Sync keeps this pot active in this version." (`PotSwitcherView.swift:34-48`; `canManagePots` is false whenever sync is enabled, `AppModel.swift:3131`). The file comment cites "design frame 90 for v1.1 local multi-pot"; the approved interface-v2 has no switcher.
- Why it matters: a first-screen control that looks like a label, is named with jargon, and for synced households opens a disabled sheet.
- Fix: Challenges a decision (v1.1 multi-pot): remove the tap target from Home; make the title plain text. Move "Switch / New household" to Settings, shown only when more than one local household exists or sync is off. Rename "pot" to "household" in every UI string and VoiceOver hint (count in my area: `HomeView.swift:144`, `RootView.swift:126, 267, 285`, `SheetViews.swift:144`, `PotSwitcherView.swift:15, 35, 42, 61, 99`, `SyncViews.swift` hint strings).
- Effort: S. Confidence: verified in code.

### 10. The three-"tab" bar is not a tab bar, and People is duplicated
- Severity: S2 friction. Challenges a decision (IA and custom bar).
- Evidence: `HomeView.swift:502-523`. "Home" is always `selected: true` and only scrolls to top. "Activity" and "People" set `app.sheet = .activity` / `peoplePresented = true`; both are modal `.sheet`s (`RootView.swift:40-61`) that cover the bar, so the selected state never moves and the user gets an X/Done instead of a tab switch. In the frames (16, 40) they are real destinations with the bar visible and the tab highlighted. People also appears as Settings → "People & ownership" (`SettingsView.swift:14-20`), and notification controls exist in both People (`PeopleManagementView.swift:52`) and Settings (`SettingsView.swift:53-87`). Four routes lead to the same Activity sheet: tab, "See all", group chips (`HomeView.swift:323`), arrow. The bar is a custom capsule: `.regularMaterial` overlaid with a 0.95 opaque fill (`:515-518`), while DESIGN.md says "Navigation: system controls".
- Why it matters: controls that look like tabs but behave like sheets, two copies of the same settings, and ~90pt of permanent bottom space for a destination used a handful of times.
- Fix (pick one): (a) Real `TabView` with Home and Activity only; Liquid Glass bar for free, selection state, VoiceOver tab semantics; People goes to Settings and to the group chips. (b) No bar: Activity becomes the feed under the hero on Home (see Ground-up rethink 2). Either way delete the duplicate notifications block from one screen and name the destination once ("People").
- Effort: M (a), L (b). Confidence: verified in code.

### 11. "Repayment" has four names, and a stored title reads backwards for other viewers
- Severity: S2 friction (naming) and S1 for the title bug
- Evidence: Home button "Record a repayment" (`HomeView.swift:295`); sheet title the same (`SheetViews.swift:809, 997`); row subtitle "Settlement · Today · by Sam" (`Models.swift:369`); undo "Settlement €50 recorded" (`AppModel.swift:4932`); activity filter "Settlements"; CTA "Mark as paid" (`SheetViews.swift:968`); "Record another transfer" (`:836, 976`). Frames use "Repayment recorded / You + Sam → Alex + Jo" with a swap icon on citrus (frames 21, 55); code shows a generic receipt icon (`HomeView.swift:485`) and the title. The title is built at record time and synced: `"%1$@ paid %2$@"` with `receiverName == currentUnitID ? "your household" : name` (`AppModel.swift:4895-4909`). If Alex records that You + Sam paid Alex + Jo, the event title is "You + Sam paid your household". Sam sees that on Home and in the CSV, where "your household" means Sam's own household.
- Why it matters: the same action has four names, and a repayment record can read as if the payer paid themselves.
- Fix: one word, "repayment", everywhere (row subtitle "Repayment", undo "Repayment €50 recorded", filter "Repayments", CTA "Record repayment", "Record another repayment"). Never store a viewer-relative string: build the title from absolute group names only ("Sam + Arseny paid Alex + Jo"), and render "you" at display time from the structured from/to. On Home show title "Repayment recorded" with subtitle "You + Sam → Alex + Jo". Use the swap icon in Home and Activity. This changes new events only; old titles stay as written (append-only), so the row builder should prefer from/to over the stored title where both exist.
- Effort: S for copy, M for title change. Confidence: verified in code.

### 12. Home makes sync claims it cannot back, and disables Add without saying why
- Severity: S2 friction (trust)
- Evidence: footer `HomeView.swift:441-448` shows "Your household shares the same history." whenever `isSyncEnabled`, which is true for offline, syncing, paused and access-removed (`AppSyncRuntime.swift:94-97`). The design note for frame 56 says the app must not present stale acknowledgement as "everyone is up to date". Local mode shows "Saved on this iPhone. Connect when you're ready to share." as a non-tappable line. Offline status is an 11pt capsule in the header row (`HomeView.swift:146`, `SyncViews.swift:63-100`: "Offline / 1 record waiting · Retry") instead of frame 56's full-width lane "Saved on this iPhone · 1 pending · Details" with a desaturated panel. `canWrite` is false for any paused sync (`AppModel.swift:847-853`, `pauseDisposition == nil`); Add and Record a repayment then dim with no explanation (`HomeView.swift:305, 396`), which contradicts "offline, not out of action".
- Fix: footer text from `syncPresentation`: waiting records stay on this iPhone / synced / paused reason. Make "Connect" a tappable link. Build frame 56's lane. For paused states keep the Add row enabled and let the tap open a one-line sheet ("Sign in to add expenses" with the button) rather than a dead dim control. Decide with the sync owner whether local entry should really be blocked while paused.
- Effort: M. Confidence: verified in code.

### 13. Add is mid-screen and scrolls away at large text
- Severity: S2 friction
- Evidence: `HomeView.swift:55-62`. Orb row follows the butter panel (about 450pt tall at default size, `:219` top padding 75) inside one ScrollView. At accessibility sizes the panel alone exceeds the screen and the primary action is below the fold; the bar does not carry Add. Single control (orb + text is one `Button`, `:380-399`), so "orb and row both" is not a duplicate; the problem is position. Common action = 1 tap from top of Home, but 1 tap plus a scroll at AX sizes.
- Fix: pin Add in the bottom lane (above or inside the bar) at accessibility sizes; at default sizes it can stay where it is. If the bar goes (finding 10b), pin a 56pt orange capsule with the orb as leading glyph.
- Effort: S-M. Confidence: inferred.

### 14. No VoiceOver feedback for undo or balance change; Undo pops in without motion
- Severity: S2 friction (accessibility)
- Evidence: no `UIAccessibility.post` / announcement anywhere (grep). `UndoBar` appears in `HomeView.swift:68-72` with no transition or animation, and it changes the bottom safe-area inset; `SheetContainerView` animates the same bar (`SheetViews.swift:34-37`). After saving, nothing tells a VoiceOver user that the balance changed or that Undo exists for about six seconds. The balance number does not animate either.
- Fix: post an announcement with the new balance sentence and "Undo available" when `undoText` is set; same for repayment. Add `.transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))` and an `.animation` on `undoText`; add `.contentTransition(.numericText())` on the amount (purposeful motion: it shows the number changed).
- Effort: S. Confidence: verified in code.

### 15. If the exact planner gives up, Home has no repayment path
- Severity: S2 friction (edge, larger households)
- Evidence: `LedgerRepository.swift:1366-1384` maps `.unavailable` to `plan = []`. The planner has hard limits (`SettlementPlanning.swift:46-51`: 4,096 states, 32,768 branches); setup allows up to 64 people (`AppModel.swift:3030-3040`, `canCompleteSetup`). With `plan.isEmpty` Home hides "Record a repayment" (`HomeView.swift:192`), the hero falls to "X owe across the household", and the line under it says "Every shared moment is still in your history." (`:214`), which reads like a settled state.
- Fix: when balances are non-zero and the plan is empty, still show the repayment entry (manual path), and show the real balances; fall back to a deterministic greedy plan labelled "suggested".
- Effort: M. Confidence: inferred (needs a many-group fixture to trigger).

### 16. Cold launch shows the old orbit skeleton, then jumps to a butter panel
- Severity: S3 polish
- Evidence: `RootView.swift:219-269` `LoadingHomeSkeleton`: capsule + two circles header, three circles on a line, a bottom sheet block. That is the retired orbit layout; the real Home is a butter panel, orb row and tab bar.
- Fix: mirror Home: butter rounded panel with three static grey bars, a grey disc, an orange-free circle for the orb row, three row stubs. No shimmer.
- Effort: S. Confidence: verified in code.

### 17. Feed rows: inconsistent dates, odd copy, no balance effect
- Severity: S3 polish
- Evidence: expenses use a custom label "today / yesterday / 10 September" in en_GB (`HomeView.swift:469-478`); repayments use `when` "Today / Tue 10 Sep" in the device locale (`Models.swift:335-348`). Missing payer reads "Person not recorded paid · yesterday" (`HomeView.swift:466-467`). No year on old dates. `homePresentationDate` is `Date()` at render, so "today" can go stale past midnight. Rows show gross amount only, not what it did to your balance; non-dinner, non-internet rows share one generic receipt icon (`:482-486`). "Latest at home" has two meanings of "home" (the tab and the household); "See all" duplicates the Activity tab.
- Fix: one date helper used by Home and Activity (Today / Yesterday / "10 Sep", year when not current); "Payer unknown" row text; add a quiet right-hand second line "you owe €48" / "you're owed €48" per row (this is the glanceable "why", see Ground-up rethink 3); retitle "Recent" and drop "See all" if Activity is in the bar.
- Effort: S-M. Confidence: verified in code.

### 18. Hard-coded 75pt top padding under `.ignoresSafeArea(.container)`
- Severity: S3 polish
- Evidence: `HomeView.swift:82, 219`. The panel ignores the container safe area and pads 75pt from the top, tuned to a 59pt Dynamic Island inset. The RootView top banners ("You're no longer a member...", "Please update", local-data retry) are added with `safeAreaInset(edge: .top)` (`RootView.swift:80-111`); with Home ignoring the container region they likely sit on top of the wordmark and gear instead of pushing content down.
- Fix: use `.ignoresSafeArea(edges: .top)` only for the panel background and let the content respect `safeAreaPadding(.top)`; verify with each banner on device.
- Effort: S. Confidence: inferred.

### 19. Dead code from the orbit UI
- Severity: S3 polish
- Evidence: `FieldSpaceView.swift`, `ConstellationLayout.swift`, `FieldSpace.metal`, `VesselOrb.metal` have no references outside themselves (grep for `FieldSpaceView`, `ConstellationLayout`, `ShaderLibrary`, `vesselOrb`). Naming leaks into live code: `tapOrb` (`AppModel.swift:4190`), `fieldUnitIDs`, `fieldBalances`, `qaEightUnitField`, and the `.more` overflow cluster for more than eight groups (`Models.swift:61-87`) which routes to an unfiltered Activity and shows "More groups" as if it were a group.
- Why it matters: nothing animates idly on Home today (the orb is static, `Components.swift:341-380`; press scale 0.97 over 120/220ms, fine). Dead shaders still ship and invite regressions.
- Fix: delete the four files; rename `tapOrb` to `openActivity(for:)`; replace "More" with a plain "+N more" row that expands.
- Effort: S. Confidence: verified in code.

## Ground-up rethink

**1. Sentence-first, viewer-relative Home.** Home becomes one generated sentence plus its proof. Examples: "You owe Alex + Jo", €84, under it in 15pt: "Dinner €48 + Internet €36". Three groups: "You owe €40" and two lines: "Alex €30  >", "Jo €10  >", each a one-tap record-repayment. You are even but others are not: "You're even." and one line, "Sam owes Leo €30". The arrow disc is replaced by a labelled "Why?" that expands in place. The user can answer who, how much, and why without leaving the screen, for any household shape.

**2. One everyday screen, no bar.** Home is the only screen people use daily: hero, pinned orange "Add an expense" capsule at the bottom, and the full feed below the hero (infinite list, `.searchable` + a filter menu replace the Activity sheet). Household and invites live under the group chips (tap a chip: members, who is connected, invite) and in Settings, not in a bar. This removes the tab bar, the four routes to Activity, and People as a destination. It does depart from the approved frames, so it needs the owner's call.

**3. Why on the page, effect on every row.** Every record row (Home, Activity, why) gets a second right-hand line with its signed effect on your balance ("you owe €48", "you're owed €12", repayments "you paid back €50"). The effects of all live records sum exactly to the headline, so the "why" is the same list, filtered to "what still counts". This is true for any number of groups because effect = paid − share, and it needs no new ledger state.

**4. Calm status lane and honest states.** One full-width lane under the panel carries every non-happy sync state in plain words ("Saved on this iPhone · 1 waiting · Details", "Sign in to share new entries"), the panel desaturates only while offline, and Add never dims silently: if something blocks it, tapping it explains and offers the fix. The footer claims nothing the lane does not.

**5. Numbers that move for a reason.** After a save or repayment the amount counts to its new value (`numericText`), the new row slides in once and settles, and when the balance flips side the sentence cross-fades instead of snapping. Reduce Motion gets an instant change plus the VoiceOver announcement from finding 14. Nothing runs idle.

## Quick wins

1. Conjugate and personalise the headline (finding 1+2): one helper, "You owe Alex", "Sam owes Leo", fix "owes" for couples in the why card.
2. Empty and all-square: hide the amount and arrow, use the approved CTA copy, add "Already owe each other money?" (finding 5).
3. Rename everything "repayment" and stop storing "your household" in settlement titles (finding 11).
4. Make the balance amount non-wrapping with a size ladder, and give the header title a line limit (findings 6, 8).
5. Home footer follows sync state, Undo animates and announces, delete the Home pot-switcher tap target and the four dead orbit files (findings 12, 14, 9, 19).

## Appendix: what Home says today, by household shape (verified in code)

| Shape | Hero | Amount slot | Gaps |
|---|---|---|---|
| Two couples, one debt | "You + Sam owe\nAlex + Jo" (real names, not "You") | transfer amount | no "you" (1); plural right |
| Two singles, one debt | "Sam owe\nLeo" | transfer amount | wrong verb (2) |
| 3+ groups, one transfer left | "A owe\nB", even for a viewer not involved | transfer amount | other groups only as 12pt chip text |
| 3+ groups, several transfers, viewer owes | "<You> owe\nacross the household" | viewer's net | no counterparties (3) |
| 3+ groups, viewer even, others owe | "<You> are even.\nSee every group below." | "€0" at 75pt | the real debt is hidden (3) |
| Everyone even after activity | "All square.\nNo one owes anyone." | "€0" + arrow | redundant line, dead arrow (5) |
| Empty | "Our everyday,\ntogether." | "Nothing shared yet" + arrow | dead arrow, no first-expense CTA (5) |
| One group left (others departed, not a designed state) | as "all square" | "€0" | no invite nudge; chips show a single group |
| Planner unavailable | "<You> owe across the household" | viewer's net | no repayment button (15) |
