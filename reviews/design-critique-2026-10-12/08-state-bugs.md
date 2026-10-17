# 08 · "Weird things" and "just works": UI state, presentation and interaction bugs

Scope read: `AppModel.swift` (all published UI state, save/undo/dismiss paths, deep link and push handling), `RootView.swift`, `HomeView.swift`, `AddExpenseView.swift`, `BudgetGroupExpenseFlow.swift`, `SheetViews.swift`, `Components.swift`, `InviteRouting.swift`, `InviteViews.swift`, `SettingsView.swift`, `OnboardingViews.swift`, `OpeningBalanceView.swift`, `PrivacyViews.swift`, `SyncViews.swift`, `PotSwitcherView.swift`, plus the sync poll loop in `AppSyncRuntime.swift` where it drives UI state. Design frames compared: `22-expense`, `34-undo`, `56-offline`.

Evidence labels: **verified in code** = I traced the path in the source and it does what I say. **inferred** = follows from the code plus known SwiftUI/UIKit behaviour, but could not be run here (no Xcode). Inferred items each carry a 30-second device check.

## Verdict

The money path is well defended: every mutation sets a synchronous `isPersisting` guard before its `Task`, so a fast double tap on Save, Mark as paid, Void, Repeat or Undo cannot write twice (verified). `beginAdd()` resets the whole draft, and the Add cover is rebuilt on every presentation, so reopening Add never shows an old draft or error (verified). The weak spots are all around the money path, in the places where state is owned in more than one place. Seven independent presentation flags live on one view and nothing arbitrates between them. Failures all funnel into one "local data failure" mode that wipes the draft and locks writing. The undo toast has no accessibility story and one wrong error path. A 2-second sync poll re-applies the entire snapshot, animated, even when nothing changed. The two bugs I would fix before anything else are `Hide amounts` blanking the amount you are typing in Add, and the "Undo too late" tap that reports data corruption and locks the app read-only.

## Findings

### S1: broken or trust-breaking

**1. "Hide amounts" masks the number you are typing in Add**
- Severity: S1
- Evidence: `BudgetGroupExpenseFlow.swift:57` renders the entry amount with `app.fmt(app.addedAmountCents, forceCents: true)`. `AppModel.swift:910-917` passes `hidden: hideAmounts`, so the output is the mask from `MoneyFormatter.hiddenString` ("€•••"). Same on the review page (`:113`), the payer intro (`:77`) and the VoiceOver label (`ExpenseFlowAmount`, "Total amount, €•••"). The legacy view, the edit sheet and the repayment sheet use `displayAmount`, which is not masked.
- Repro: Settings → Hide amounts on → Add an expense → tap 1, 2, 0. The big amount stays "€•••". Nothing confirms what you entered before you commit it to a shared ledger.
- Why it matters: blind money entry on the primary flow; the privacy setting silently breaks the product's main job.
- Fix: entry and review pages use `app.displayAmount(...)` (never masked). Keep the mask for at-rest surfaces (Home, Activity, undo toast). If masking the review page is wanted, make it "hold to reveal", not a silent mask. The settings footer already says "Amounts appear as … only on this iPhone"; add "Not while you type."
- Effort: S. Confidence: verified in code.

**2. Undo tapped just too late reports a data problem and locks the app read-only**
- Severity: S1
- Evidence: `AppModel.swift:5009-5028`. If `undoHeldEvent` returns `nil` (the 6 s hold lapsed, `UndoPolicy.window = 6` in `NumaSharedCore/Undo.swift:12`), the code runs `clearUndo(); persistenceFailed()`. `persistenceFailed` with no error takes the `needsRecovery` branch (`:1056-1076`), which calls `presentLocalDataFailure(blocking: false)`: it sets `localDataErrorMessage` ("That change couldn't be verified. Reload this pot."), closes Add and the sheet, and makes `canWrite` false (`:847-853`), so Add and Record a repayment stop working until Retry.
- Repros:
  - Save an expense, tap Undo as the toast expires, or return from the background after 7 s and tap the still-visible toast.
  - Save an expense, open the pot switcher, switch pot within 6 s: `undoText`/`undoEventID` survive (`switchPot` 3138, `beginNewPot` 3169 never call `clearUndo`), Undo then runs against the new repository and returns `nil`. Same banner.
- Why it matters: a benign race looks like ledger corruption and takes away the app's main button.
- Fix: treat `nil` as an expected outcome. `clearUndo()` and show a one-line toast "Already shared with your household. Void it from Activity." (a visible correction fits the append-only contract). Never route it through `persistenceFailed`. Call `clearUndo()` in `switchPot`, `beginNewPot`, `cancelNewPot` and `finishLocalAccountRemoval` (already there).
- Effort: S. Confidence: verified in code.

**3. A failed save wipes the draft, closes everything and gives a cryptic message; the read-only variant leaves Save greyed with no reason**
- Severity: S1
- Evidence: `AppModel.swift:1042-1054`: any error from `appendExpense` goes `persistenceFailed` → `presentLocalDataFailure`, which sets `addPresented = false`, `sheet = .none` and shows "That change couldn't be verified. Reload this pot." The copy does not say whether the expense was saved. For `.readOnlyReduction` / `.archivedPot` (`:1060-1066`) Add stays open, `isPersisting` resets, `canWrite` flips false, and the Save button (`BudgetGroupExpenseFlow.swift:103`, `enabled: … app.canWrite …`) just greys out. The only explanation is the root banner, which the full-screen Add cover hides.
- Why it matters: the user loses a typed expense and cannot tell if it exists; in the read-only case Save silently dies mid-flow.
- Fix: on save failure keep Add open with the draft, show an inline "Not saved. Nothing was lost on this iPhone. Try again" with Try again (re-append with the same `recordID`; event IDs make replay idempotent). Only escalate to the read-only recovery screen if a reload also fails. For read-only, show the reason inline in the flow ("This version can no longer record. Update to continue."). Rewrite the banner: "Your last change may not have saved. Check Activity, then Reload."
- Effort: M. Confidence: verified in code (path), cannot trigger the error here.

**4. Top banners likely sit on top of the Home header, hiding Settings (and Export) for the frozen member**
- Severity: S1 (inferred; check on device)
- Evidence: `RootView.swift:80-111` adds the frozen / "Please update" / local-data banners with `.safeAreaInset(edge: .top)`. `HomeView.swift:82` applies `.ignoresSafeArea(.container)` and `:219` hard-codes `.padding(.top, 75)` for the header row, so Home draws from y = 0 and ignores the inset. Banner roughly y 59–115 (2 lines of subheadline plus 16 pt padding) vs header buttons at y 75–119: the gear and pot switcher are covered. The frozen copy says "This frozen copy stays available to review and export", and export lives behind that gear.
- Repro: archive the current member (or use `--qa-forced-update`-style states) → Home → the gear is under the black banner.
- Why it matters: the person who most needs Export (they just left the pot) cannot reach it.
- Fix: do not ignore the container safe area for layout. Keep `.ignoresSafeArea` only on the yellow background (`.background(palette.home.ignoresSafeArea(edges: .top))`) and replace the 75 pt constant with the real top inset. Alternatively render these banners inside Home's scroll content, under the header.
- Effort: S. Confidence: inferred from layout code; I am about 80% sure `ignoresSafeArea` also swallows ancestor `safeAreaInset`s.

**5. Seven independent presentation flags on one view, with nothing arbitrating**
- Severity: S1 (inferred SwiftUI behaviour; the code's own workarounds point at it)
- Evidence: `RootView.swift:34-69` stacks `fullScreenCover(addPresented)` plus six `.sheet`s (`sheet != .none`, `syncSetupPresented`, `joinPresented`, `peoplePresented`, `potSwitcherPresented`, `settingsPresented`) on one view. Callers flip flags without checking the others:
  - `handleOpenURL` (`AppModel.swift:2165-2175`) sets `joinPresented = true` unconditionally, ignoring Add, onboarding, `isBootstrapping`, and whatever sheet is up. `RootView.swift:70` discards the result, so a link that fails to parse, or arrives while `joinIsBusy`, shows nothing.
  - `openPendingNotificationPotIfPossible` (`:1243-1266`) closes only People and Join, then `activateRemotePot` swaps the active pot (`AppSyncRuntime.swift:769-791`). Add, Activity, Settings, Switcher and Sync sheets stay open.
  - Settings → "Enable sync" calls `beginSyncSetup` (`SettingsView.swift:34`), setting `syncSetupPresented` while `settingsPresented` is still true. `openPeopleFromSettings` (`:1279-1285`) and `performAppleLogin` (`:2393`) already work around this with `Task.yield()`; `beginInvite` (`:1951-1954`) does `peoplePresented = false; beginSyncSetup()` with no yield. The authors have hit this class of bug three times.
- Repros:
  - Open Add, type 12, tap an invite link in Messages. `joinPresented` flips while the cover is up. SwiftUI shows one presentation per presenter, so the sheet is queued or lost; it can pop up later over unrelated UI. When the claim finishes, `activateRemotePot` replaces the active pot under the open draft.
  - Multi-pot user, Add open, tap a push for the other pot: `apply` runs but `expensePayerMemberID`/`attached` still belong to the old pot, so the flow shows "Choose person" (`AppModel.swift:3861`) and Save is dead.
  - Cold-launch via an invite link while the skeleton shows: `joinPresented` opens at once, but `performInviteLoginAndClaim` needs `syncRuntime` (not configured yet) and says "Invites aren't available right now" for a problem that clears in a second.
- Why it matters: this is the growth loop (invite link → join) and it collides with every other state; failures are silent or land in the wrong pot.
- Fix: one `@Published var modal: Modal?` (`enum Modal { add, activity, detail, settle, settings, people, join, sync, switcher }`) driving one `.sheet(item:)` plus the cover. Add a small `enqueue(_ intent)` that runs a deep link or push route only when `modal == nil && !isBootstrapping`, otherwise stores it, and shows a banner "Invite link ready: Open it" (confirm before discarding a non-empty Add draft). Replace every `Task.yield()` hand-off with the single item binding, which makes dismiss-then-present atomic. Give `handleOpenURL` a visible failure ("That link isn't an invite").
- Effort: M. Confidence: inferred for the SwiftUI presentation behaviour; verified that the flags are independent and the callers do not coordinate.

### S2: friction

**6. The primary buttons look live and do nothing when `canWrite` is false**
- Evidence: `HomeView.swift:396` (`.disabled(!app.canWrite)` on the Add vessel) and `:305` (Record a repayment). `SharedOrbButtonStyle` (`Components.swift:329-337`) ignores `isEnabled`. `canWrite` (`AppModel.swift:847-853`) is false for: update required, archived pot, frozen member, any sync pause (sign-in expired, access removed, config invalid), any local-data error. The tap is swallowed with no haptic and no reason.
- Repro: let a Sign in with Apple session expire; open the app; tap the big orange Add button. Nothing happens. Only the small header capsule hints why.
- Fix: do not disable. Keep the button tappable and, when `!canWrite`, turn the subtitle "Who paid? Who was it for?" into the reason ("Sign in to keep adding. Your 2 entries are safe.") and route the tap to the fix (sync sheet, update page, reload). Dim the vessel to 0.5 only if you also keep that reason line.
- Effort: S. Confidence: verified in code (disabled with a style that never dims). Whether the plain-styled Repayment pill dims is inferred.

**7. The undo toast is invisible to VoiceOver, and 6 seconds is short for anyone using assistive tech**
- Evidence: no `AccessibilityNotification`/`UIAccessibility.post` anywhere in the app (grep is empty). `UndoBar` (`Components.swift:669-689`) appears and clears with no announcement; `Haptics.saved()` is the only save confirmation for non-sighted users. `UndoPolicy.window = 6`.
- Why it matters: PRODUCT says VoiceOver is a contract; a VO user cannot find and activate a control that exists for 6 seconds without being told it exists. Same for the saved confirmation, error banners and "Copy details".
- Fix: post `AccessibilityNotification.Announcement("\(text). Undo is available for 6 seconds. Later you can void it from Activity.")` in `setUndo`, and on failures. For VoiceOver / Switch Control / AssistiveTouch running, use a longer hold (e.g. 12 s). Challenges a decision: the 6 s window is a sync-delay trade-off, but accessibility users pay for it, and Void in Activity is the visible fallback so the window need not be the only path.
- Effort: S (announcements), M (longer hold for AT, touches `UndoPolicy`). Confidence: verified in code.

**8. The sync poll re-applies the whole snapshot every 2 seconds, with a spring animation, and keeps killing prepared CSV exports**
- Evidence: poll interval 2 s (`AppSyncRuntime.swift:246`, loop `:1089-1109`). Each `runSync` ends with `publish(... snapshot: snapshot ...)` (`:1204-1210`); `refreshSnapshot()` always calls `advanceRevision()` (`LedgerRepository.swift:252-257`, `:1299`). `onUpdate` (`AppModel.swift:2876-2880`) calls `apply(snapshot)` with the default `animated: true` (`:993-996`, spring). `apply` treats any higher revision as a change and calls `discardPreparedCSVExport()` (`:951-956`). The CSV fence `appliedRevision == exportRevision` (`:1367-1369`) can therefore trip with "History changed while preparing this file. Prepare the export again." although nothing changed.
- Repros:
  - Sync on, offline: Settings → Export CSV → the offline "Share saved history" button and warning appear, then vanish at the next poll tick (back-off 1 to 30 s).
  - Sync on, Export CSV for a large ledger: roughly one in N attempts hits the false "History changed" error, N depending on write time vs the 2 s tick.
  - Every tick re-publishes ~15 `@Published` fields with a spring transaction, so every observing view re-evaluates and anything layout-dependent can twitch.
- Fix: make `apply` idempotent: compare a cheap fingerprint (last authoritative sequence + local event count + member roster version) and return early when equal. Do not bump `revision` in `refreshSnapshot` when nothing changed. Poll updates call `apply(animated: false)`; keep the spring only for user-initiated mutations. Fence the CSV on content fingerprint, not a counter.
- Effort: M. Confidence: verified in code for each link; end-to-end behaviour not run.

**9. Activity: scroll position is lost on every record open, and search/filters never reset**
- Evidence: `SheetContainerView` (`SheetViews.swift:15-23`) swaps views by `switch app.sheet`, so `ActivitySheet` (and its `ScrollView`, `:153`, with no position state) is destroyed when a record opens (`openDetail` `AppModel.swift:4194`) and rebuilt, scrolled to top, on the way back (`leaveDetail`). `activitySearchQuery`, `activityKindFilter`, `activityPeriodFilter` (`:329-331`) live in the model and `closeSheet()` (`:4182`) resets only `activityFilter`. `finishLocalAccountRemoval` does not reset them either.
- Repro: Activity → search "pizza" → scroll → open a record → back: back at the top, query still set. Close Activity, reopen tomorrow: still filtered; after account deletion and a new household, the first Activity open is pre-filtered.
- Fix: host Activity and Detail in a `NavigationStack` inside the sheet so Activity stays mounted (position kept, native back swipe). Reset query/kind/period when the sheet closes and when the pot changes; show an "N filters on · Clear" chip while any is active.
- Effort: M. Confidence: verified in code.

**10. The record detail sheet can become an empty dead-end with no close button**
- Evidence: `RecordDetailSheet.record` (`SheetViews.swift:212`) is `app.records.first { $0.id == app.detailID }`; everything including the close button sits inside `if let r = record` (`:225-243`), else a bare `Spacer` (`:455-457`).
- Repro: save an expense, tap its Latest-at-home row within 6 s (the detail sheet carries its own undo bar, `:31-35`), tap Undo. The record is deleted; the sheet is now a grabber and blank space. Same if sync erases the record while it is open.
- Fix: in `undoNow` success and in `apply`, if `sheet == .detail` and the record is gone, `leaveDetail()`. In the view, render a "This record is no longer here" state with a Close button.
- Effort: S. Confidence: verified in code.

**11. Long pot or group names push the Home header off the screen**
- Evidence: `NativeTextLabel` (`Components.swift:65-141`) sets `adjustsFontSizeToFitWidth = true`, `minimumScaleFactor = 0.7`, `numberOfLines = 1`, then the SwiftUI wrapper applies `.fixedSize()` (`:87`), which proposes the label's unconstrained width, so shrink-to-fit never triggers. `HomeView.swift:244` uses it for the pot name; setup allows up to 128 UTF-16 units (`AppModel.swift:3695-3700`). Header row = title button + Spacer(8) + sync capsule + 44 pt gear.
- Repro: name the household "The Smiths and flatmates, 14 Elm Street" (40 chars, ~260 pt at 12 pt) with sync on (capsule ~110 pt): the row needs ~420 pt of 343, so the gear is pushed off the trailing edge. At AX sizes the same happens with shorter names.
- Fix: for single-line labels use SwiftUI `Text(...).lineLimit(1).truncationMode(.tail)` with `minimumScaleFactor(0.7)` and no `.fixedSize()`, or give the UIKit label a `sizeThatFits` that honours the proposal (as `UIKitWrappingLabel` already does). Soft-limit the pot name field to ~32 characters in setup, keep 128 on the wire.
- Effort: S. Confidence: inferred (layout from code; 128-char limit verified).

**12. Large amounts wrap mid-number in the Add and Home heroes**
- Evidence: `MoneyInput.applying(... maximumWholeDigits: 6)` (`NumaSharedCore/MoneyInput.swift:40`) allows 999,999.99. `ExpenseFlowAmount` (`BudgetGroupExpenseFlow.swift:342-360`) draws at 69 pt, and its fallback branch is `fixedSize(horizontal: false)` with no `lineLimit` or `minimumScaleFactor`; Home's `balanceAmount` (`HomeView.swift:275-292`) does the same at 75 pt next to a 47 pt arrow button (about 284 pt of width).
- Estimate: at 75 pt a balance such as €1,250.40 needs about 305 pt; it wraps from roughly €1,000 up on a 393 pt phone, and earlier at non-default text sizes (the `.large`-only ideal-width branch is skipped).
- Fix: `.lineLimit(1).minimumScaleFactor(0.45)` on both amounts (scale, never wrap a number); at AX sizes allow two lines only if the break is between the currency symbol and the digits.
- Effort: S. Confidence: inferred; verify with €1,250.40 and €123,456.78.

**13. Setup errors render below the fold; the opening-balance error never clears**
- Evidence: `setupErrorMessage` is drawn at the end of the scroll content (`OnboardingViews.swift:199-202`, `:467-470`) while the CTA is pinned in `safeAreaInset`. On the "One last look" step the content is longer than a phone screen. `openingBalanceErrorMessage` is set on the budget-group path (`AppModel.swift:3512`, a non-localized literal, no haptic) and cleared only on the legacy path (`:3543`, `:3577`), so it survives until app restart and reappears on the next pot's opening-balance screen.
- Repro: make `completeBudgetGroupSetup` fail; tap "Create our home": button returns to "Create our home", nothing visible changes, error sits under the fold. Fail an opening-balance save once, fix the amount, retry: the old error text stays visible while saving.
- Fix: render errors inside the pinned bottom inset directly above the CTA (and post an accessibility announcement). Clear `openingBalanceErrorMessage` at the start of `saveBudgetGroupOpeningBalance` and when amounts change; add `Haptics.warned()` and `String(localized:)`.
- Effort: S. Confidence: verified in code.

**14. Fast double taps can push duplicate pages; some flows have no re-entry guard**
- Evidence: `BudgetGroupExpenseFlow.swift:39` ("Who paid?") does `path.append(.payer)` and `:62` ("Change date") does `path.append(.details)` with no guard, while the payer rows guard with `path.last == .payer` (`:80`), which shows the authors have hit this. `beginAdd` has no `guard !addPresented`, so a double tap on the vessel fires `Haptics.activated()` twice and resets the draft twice. `claimResolvedInvite` (`AppModel.swift:2188`) has no `guard !joinIsBusy`; the `.claiming` phase is only set inside the `Task`.
- Repro: double-tap "Who paid?": the payer page stacks twice and Back returns to another payer page.
- Fix: `guard path.last == nil`/`path.last != .payer` before appending (or derive navigation from one enum state), `guard !addPresented` in `beginAdd`, `guard !joinIsBusy` plus a synchronous phase flip in `claimResolvedInvite`.
- Effort: S. Confidence: inferred (SwiftUI double-push) / verified (missing guards).

**15. Activity rows flip to a different layout when the title is long**
- Evidence: `ActivityRowView.body` (`Components.swift:521-543`) wraps the two-column row in `ViewThatFits(in: .horizontal)`. `UIKitWrappingLabel.sizeThatFits` (`:448-452`) reports the full single-line width when the proposal is nil, so any row whose title + detail + amount exceed ~340 pt falls through to `stackedContent` (avatar, title, badge, detail, amount stacked).
- Repro: Activity with "Groceries", "Rent", "Groceries at the farmers market, Saturday": the first two have trailing amounts, the third becomes a five-line block. Home's `HomeReceiptRow` does not do this, so the two lists disagree.
- Fix: keep the HStack at every non-AX size and let the title wrap to two lines (`layoutPriority(1)` on the amount); use the stacked layout only at accessibility sizes (already a separate branch, `:523`).
- Effort: S. Confidence: inferred.

**16. The Void sheet is not scrollable; the Settle sheet's CTA is buried in a scroll view**
- Evidence: `VoidRecordSheet` (`SheetViews.swift:746-799`) is a bare `VStack` with a `Spacer` and the CTA at the bottom; it lists `app.voidBalanceImpacts` (one row per affected group) and has no `ScrollView`. At AX sizes, or with the keyboard up and several groups, the CTA and the field are clipped. `SettleAmountSheet` (`:856-988`) puts "Mark as paid" at the end of a `ScrollView` (title, parties, amount, hints, impact box, keypad, CTA), unlike the Add flow, which pins it.
- Fix: wrap Void in a `ScrollView`, pin "Confirm void" and "Mark as paid" with `safeAreaInset(edge: .bottom)` as `BudgetGroupExpenseFlow.page` already does.
- Effort: S. Confidence: inferred.

**17. Add accepts any date, including the future or 1970**
- Evidence: `DatePicker("Date paid", selection: $app.expenseDate, displayedComponents: .date)` has no `in:` range (`BudgetGroupExpenseFlow.swift:172`). A future date is excluded from Activity's "This week/month/year" filters (`AppModel.swift:5066-5069`, `occurredAt <= now`) and sorts ahead of today's records.
- Fix: `in: ...Date()` (optionally a one-year floor). Related polish: the "Paid" line prints "Paid 10 september" because `dateLabel.lowercased()` also lowercases the month (`:60`); lowercase only "Today"/"Yesterday".
- Effort: S. Confidence: verified in code.

### S3: polish

**18. No in-flight state on Save; `isPersisting` is not published**
- Evidence: `private var isPersisting` (`AppModel.swift:211`, not `@Published`) backs `isRecordMutationInFlight` (`:707`), used by `.disabled(...)` and `interactiveDismissDisabled(...)` in `ExpenseEditSheet` (`SheetViews.swift:702, 705`), `SettleAmountSheet` (`:856, 858`) and the Add flow. When a save starts, nothing publishes, so those controls do not update until something else changes. `VoidRecordSheet` has no `interactiveDismissDisabled`, and completions set `sheet = .activity` / `.detail` unconditionally (`:4426`, `:4521`, `:4565`), which reopens a sheet the user already swiped away if the write was slow.
- Fix: `@Published private(set) var isSaving`; show a spinner in the CTA and disable the sheet; make completions navigate only if the user is still on the originating screen.
- Effort: S. Confidence: verified in code.

**19. Motion and haptic plumbing is patchy**
- Evidence: `app.reduceMotion` is only set from `HomeView.onAppear/onChange` (`HomeView.swift:99-100`), so `apply()` springs during onboarding ignore Reduce Motion (`AppModel.swift:993`). `AvatarView` spring (`Components.swift:304`) and the legacy allocation spring (`AddExpenseView.swift:396`) are ungated. `Haptics.prepare()` runs only on Home appear and the legacy Add view; generators go cold after a few seconds, so the first `Haptics.saved()` of a session can lag. The Home undo bar appears and disappears with no transition (`HomeView.swift:69-72`), while the sheet version animates (`SheetViews.swift:34-37`), so the Home scroll area jumps by the bar's height. `SheetContainerView`'s empty bottom inset still reserves ~16 pt in every sheet.
- Fix: read `\.accessibilityReduceMotion` where animations are made (or `UIAccessibility.isReduceMotionEnabled` in `apply`), `Haptics.prepare()` when the review page appears, add the same `.transition/.animation` to the Home undo lane, and only add the inset when `undoText != nil`.
- Effort: S. Confidence: verified in code.

**20. The app-switcher privacy shield shows on every `.inactive`**
- Evidence: `AppSwitcherPrivacyModifier` (`PrivacyViews.swift:3-15`) overlays a branded blank screen whenever `scenePhase != .active`, on the root and on every sheet. `.inactive` also happens for Control Center, the notification shade, an incoming-call banner, the push-permission alert and the Sign in with Apple sheet. `RootView.swift:71-73` also refetches app configuration on every return to `.active`.
- Repro: pull down Notification Center mid-expense: the whole UI blanks for a moment.
- Fix (Challenges a decision: privacy vs flicker): keep the shield but fade it in over ~120 ms and show it immediately only on `.background`; for `.inactive`, delay ~250 ms (system sheets return before then). Debounce the configuration refresh to once per foreground.
- Effort: S. Confidence: inferred.

**21. Add and Opening Balance discard silently; two buttons do the same thing**
- Evidence: on the Add entry page the "Back" and the "×" both call `app.closeAdd` (`BudgetGroupExpenseFlow.swift:37, 284-294`); `closeAdd` has no confirmation even with an amount and description typed. Opening Balance's "×" and "Skip" both call `skipOpeningBalance` (`OpeningBalanceView.swift:39-45`), dropping typed amounts; `SettleAmountSheet` has a chevron and "Not yet" for the same `backToPlan` (`SheetViews.swift:868, 980`).
- Fix: on the first page keep one control (×); if amount > 0 or a description exists, confirm "Discard this expense?" or keep a draft for 15 minutes (see Rethink 1). Drop the duplicate controls.
- Effort: S. Confidence: verified in code.

**22. Small accessibility and copy defects (batch)**
- `ExpenseFlowKeypad` labels the decimal key "." (`BudgetGroupExpenseFlow.swift:427`): label it "Decimal point". The entry page's "Back" (`:287`, `.accessibilityLabel("Back")`) cancels the whole flow.
- "Copy details" (`SheetViews.swift:269-271`) writes to the pasteboard with no confirmation.
- Settings' close is an `xmark.circle.fill` labelled "Done" (`SettingsView.swift:248-253`).
- Home tab labels are 10 pt (`HomeView.swift:538-542`) while `Metrics.minOrdinaryText` is 11.
- Detail rows show raw IDs and blank values (`kv("Target record", r.targetRecordID ...)` `:300`; `kv("Category", r.category ?? "")` `:335`).
- Home's "tab bar" is permanently "Home selected" while Activity and People open as sheets.
- Effort: S. Confidence: verified in code.

**23. Held-expiry timers are fire-and-forget, with an unbounded 1 s retry**
- Evidence: `scheduleHeldExpiry` (`AppModel.swift:4957-5000`) starts an uncancellable `Task` per save. On an error the loop sets `delay = 1` and retries forever (`:4995-4997`). After sign-out, account deletion or a pot switch the task keeps polling the old repository; `preparedStore()` (`LedgerRepository.swift:1099-1117`) can reopen the SQLite path.
- Fix: keep `[EventID: Task]`, cancel on `retireSyncRuntime`, pot switch and erase; cap retries (e.g. 5, then give up and let the next foreground sweep expire it).
- Effort: S. Confidence: verified in code.

**24. Dead code and dead state from the superseded orbit UI**
- Evidence: unused: `NativeCapsuleButton` (`Components.swift:143-227`), `FieldSpaceView.swift`, `ConstellationLayout.swift`, both `.metal` files, `HoldProgressArc`, `KeyButtonStyle`, and 8 `@Published` fields (`addDragPoint`, `addHalo`, `homeDragPoint`, `homeHalo`, `liftUnit`, `liftPoint`, `liftLocked`, `homeLockedAll`, `AppModel.swift:314-325`). `LegacyAddExpenseView` and the 3-unit `.am/.sam/.leo` fixtures serve only schema-1 pots, which new pots never create (`readerSchemaVersion: budgetGroupSchemaVersion` everywhere).
- Why it matters: `AppModel` publishes 117 properties; every one that changes re-runs every view that reads `app`, including Home behind the Add cover on each keystroke.
- Fix: delete; then split `AppModel` (see Rethink 1).
- Effort: M. Confidence: verified (grep for usage).

**Checked, no bug found:**
- Double-submit on Save / Void / Repeat / Mark as paid / Undo (synchronous `isPersisting`).
- Stale draft or stale error on reopening Add.
- `#if DEBUG` gating: only E2E and QA hooks plus the APNs sandbox/production switch; one Debug-only `accessibilityValue` on the Create button (`OnboardingViews.swift:128-130`) makes the UI-test accessibility tree differ slightly from Release.
- Force unwraps: the only `preconditionFailure`s are in identity mapping for non-core units (`Models.swift:721, 769, 778`); I could not reach them from a UI path.
- `scenePhase` timers: `SyncStatusCapsuleView.task(id:)` is stable.

## Ground-up rethink

**1. One presentation owner and a draft that lives and dies with its screen.** Replace the 7 flags + `SheetKind` with `Modal` as a single state, and make Add own an `AddDraft` struct created when the cover opens (`@State` in the cover), not 15 fields on `AppModel`. The user would see: an invite link or push tap while Add is open raises a small banner "Invite to Casa Mar. Open after this expense?", never a silent pot swap or a queued sheet; a stray tap on × asks "Discard this expense?" and offers "Save draft", which reappears as a "Draft: Pizza €12" row above Latest-at-home. Side benefit: the model stops re-rendering Home on every keystroke, and "reopen shows the old draft" becomes impossible by construction. Move to `@Observable` and split `AppModel` into ledger read model, sync session, presentation and drafts.

**2. Undo that always works, for everyone.** A root-level overlay bar (not per-screen) that shows "Pizza €12.00 saved · Undo" with a thin 6 s countdown line, survives sheets, Add and pot switches, is announced to VoiceOver, and when the window closes morphs into "Void" (a visible correction event, per the append-only contract) for 10 more seconds. Tapping Undo too late reads "Already shared. Void instead?", never a data-error banner. The user never loses the safety net because a sheet was in the way.

**3. A calm sync.** Sync only emits when content changed; the UI shows one quiet "Updated" tick and only user actions animate. Poll updates never discard exports. The user would notice that nothing twitches every 2 seconds, Export works, and the header capsule only speaks when state actually changes.

**4. Blocked states as cards, not dead buttons.** When writing is blocked (signed out, update needed, frozen member, reload needed), the Add vessel stays tappable and becomes a one-line explanation with the fix ("Sign in to keep recording"); the frozen member gets a header chip "Frozen copy · Export" that sits in the header row, not in a banner above it. The user always knows why the main button is quiet, and what to tap.

**5. Two-tap default Add.** `beginAdd` already knows the payer (`expensePayerMemberID = currentMemberID`) but `chosePayer` (a `@State` duplicate of model state, `BudgetGroupExpenseFlow.swift:14`) forces a full "Whose money paid for it?" page. Open on the review screen with "You paid · All groups, equally" prefilled and each fact tappable to change; amount → Save becomes two taps. This removes a screen, a source-of-truth duplicate, and the double-push class of bug.

## Quick wins

1. Entry and review use `displayAmount`, not `fmt` (Hide amounts no longer blanks typing): `BudgetGroupExpenseFlow.swift:57,77,113`.
2. `undoNow()` with `nil` → "Already shared. Void it from Activity." and never `persistenceFailed()`; clear undo on pot switch (`AppModel.swift:5015-5019`, `:3138`, `:3169`).
3. `AccessibilityNotification.Announcement` in `setUndo` and on every error banner; label the decimal key "Decimal point".
4. `apply(animated: false)` for poll updates plus an early return when the snapshot fingerprint is unchanged (stops the 2 s re-render, the export wipe and the false "History changed").
5. Guards: `path.last` check before appending pages, `guard !addPresented` in `beginAdd`, `guard !joinIsBusy` in `claimResolvedInvite`; `DatePicker(in: ...Date())`; reset Activity filters in `closeSheet()`.
