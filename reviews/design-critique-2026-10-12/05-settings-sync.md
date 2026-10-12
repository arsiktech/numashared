# 05. Settings, privacy and data, households, sync status, offline and errors

Scope read: `SettingsView`, `PrivacyViews`, `PrivacyPreferences`, `SyncViews`, `SyncPotSelection`, `PotSwitcherView`, `PotRegistry`, `PushNotifications`, `SupportInfo`, plus the status, error and sync-state code in `AppModel`, `AppSyncRuntime`, `Models`, `RootView`, `HomeView`, `InviteViews`, `PeopleManagementView`, `LedgerCSVExport`. Design frames viewed: 45, 46, 49, 50, 51, 52, 53, 56, 57, 59. Nothing was built or run (no Xcode here). Every finding says whether it is "verified in code", "inferred from code" or "design only". "Inferred" means I traced the logic but a device run should confirm before anyone acts on it.

All paths below are under `ios/NumaShared/NumaShared/` unless stated.

## Verdict

The "just works" layer is engineered carefully (idempotent retry, account isolation, export fencing, recovery states), but almost none of that care reaches the screen. Settings is a flat list of ten controls across six sections with no identity, no currency and no sync status. Sync is a log-style header chip that says "Offline" and "records waiting" and flickers after every saved expense. The paused and error states the code classifies in detail have no screen that explains them. Three destructive paths understate their consequences: sign out wipes every local household, leaving a household strands you in a frozen copy with no way forward, and the delete-account and leave warnings are dialogs rather than review screens. Multi-household exists only as a hidden, local-only switcher that stops working once a household is shared. The approved frames 45, 49 to 52, 56 and 57 point the right way (frame 57, "Saved here. Not shared yet.", is the best copy in this area), but native implements almost none of them, and frames 46 and 50 to 52 carry prototype-only copy that must not ship.

## Findings

### 1. Sign out and Delete account erase every local household, but warn only about the active one
- Severity: S1 broken/trust
- Evidence: `AppModel.swift:1731-1760` (`eraseAllLocalAccountState` loops `ephemeralPotStores`, `repository`, `newPotReturn`, then `PotRegistry.removeAccountStores(named: localPots.map(\.databaseName))`). The warning counts `unsyncedEventCount`, which is per active household (`AppModel.swift:963`, `NumaSharedSync/.../LedgerStore.swift:505-511`). Sign-out message, `AppModel.swift:1434-1453`: "Synced records stay in the shared pot. This iPhone's local cache will be cleared." Delete-account message lists server households only (`AppModel.swift:1575-1625`).
- Why it matters: someone who made a second household locally (the switcher only works with sync off), then enabled sync on another one, loses the never-shared household when they tap Sign out, and nothing told them it existed.
- Fix: before either dialog opens, list every household on this iPhone that has never been shared ("Beach house: 14 expenses, only on this iPhone, will be deleted"). Add an "Export first" button to both dialogs. Rename the row to say what it does: "Sign out and clear this iPhone".
- Challenges a decision: wiping local data on sign out serves the account-isolation contract. Keying the local store per account and hiding it on sign out (wipe only on delete, or on an explicit "Remove all data from this iPhone") keeps isolation without turning Sign out into a reset. See rethink 5.
- Effort: S for the disclosure, L for the keyed-store alternative. Confidence: verified in code.

### 2. After you leave (or are removed) there is no way forward except wiping the frozen copy
- Severity: S1
- Evidence: banner `RootView.swift:83` "You're no longer a member. This frozen copy stays available to review and export." `canManagePots` requires `!isSyncEnabled` (`AppModel.swift:3131-3136`), and a paused sync still counts as enabled (`AppSyncRuntime.swift:94-97`). So New pot and switching stay disabled. The "Enable sync" row is hidden when sync is on (`SettingsView.swift:33`). "I have an invite" exists only on the Welcome screen (`OnboardingViews.swift:131`), which an existing install never sees again. `canWrite` is false when archived (`AppModel.swift:847-853`).
- Why it matters: the person who left a flat (or was removed) cannot start a new household or enter an invite code. The only exit is Sign out, which deletes the frozen copy, and its dialog says "Synced records stay in the shared pot", which is not true for someone who no longer has access.
- Fix: make the frozen banner actionable with three plain choices: "Export history", "Start a new household", "Remove this copy". Allow household creation when the current member is archived. Use archived-specific sign-out copy: "You've left Our place. Signing out removes this copy from your iPhone. Export it first if you want to keep it."
- Effort: M. Confidence: inferred from code (trace is short; confirm on a device).

### 3. Joining a second household while signed in strands the first and renames its registry slot
- Severity: S1 (rare today, severe when it happens; the owner is the only beta user)
- Evidence: `activateRemotePot` swaps the active identity inside the same store (`LedgerRepository.swift:448-495`). `apply(snapshot)` then sets `potName` to the new household (`AppModel.swift:983`) and `refreshActivePotDescriptor` writes that name and currency over the existing registry entry (`AppModel.swift:1000`, `3347-3370`). The switcher lists only `app.localPots` (`PotSwitcherView.swift:27`) and is disabled while synced. The only route back to household A is tapping a push notification from A (`AppSyncRuntime.swift:769-795`). The join sheet promises only "Your existing records remain on this iPhone." (`InviteViews.swift:66`). Frame 53 promises "Your existing home is safe."
- Why it matters: a person who moves flats, or shares a flat plus a trip, joins the second household and the first one vanishes from the UI with no explanation or way back.
- Fix: list households from the server (`listPots`) as well as local ones, and let the switcher activate them. Until then, block a join when already in a household with a clear message ("You're in Our place. Leave it first, or ask for a separate app account"), rather than silently replacing it. Also: a push tap for another household swaps the active household silently and does not close Add, Settings or the switcher (`AppModel.swift:1243-1264` only closes People and Join). Close everything and show a one-line "Switched to Beach house" banner.
- Effort: L. Confidence: inferred from code.

### 4. A failed save closes the Add sheet and says "Reload this pot"
- Severity: S1
- Evidence: `AppModel.swift:1042-1054` (`presentLocalDataFailure` sets `addPresented = false` and `sheet = .none`; message "That change couldn't be verified. Reload this pot."). Banner at `RootView.swift:161-218`. The blocking variant (`RootView.swift:115-160`): title "Your pot couldn't be opened", body "Your records haven't been changed. Retry to load the verified copy on this iPhone.", only a Retry button.
- Why it matters: the person pressed Save, the sheet vanishes, and the banner does not say whether the expense was saved. On the blocking screen, if Retry keeps failing there is no support link, no export, nothing.
- Fix: non-blocking: "That didn't save. Your other entries are fine." with a Try again button, and keep the draft open (I did not verify whether the draft survives; check). Blocking: "Numa couldn't open Our place on this iPhone. Nothing was deleted." with Try again and "Contact support" (pre-filled mail with a diagnostic line).
- Effort: S for copy and support link, M for draft preservation. Confidence: verified for the copy and dismissal; draft survival not verified.

### 5. Any sync pause silently disables Add and Record a repayment
- Severity: S1 (breaks the local-first promise at the exact moment a session expires)
- Evidence: `canWrite` includes `syncPresentation.pauseDisposition == nil` (`AppModel.swift:847-853`). Add row `.disabled(!app.canWrite)` at `HomeView.swift:396`, repayment at `HomeView.swift:305`. A pause includes "Sign in required" (expired refresh token) and the generic terminal "Sync paused" (`AppSyncRuntime.swift:40-80`, `126-160`). The disabled row shows no reason. Design note on frame 56: "Keep the useful balance and entry action available."
- Why it matters: after a token expires, the app's main button goes grey with no explanation, even though entries could be saved locally and queued safely.
- Fix: keep local writes on for sign-in-required and generic terminal pauses (events queue, replay is idempotent). Block only for access removed, update required and account mismatch, and in those cases replace the Add row's subtitle ("Who paid? Who was it for?") with the reason and one action ("Update Numa Shared", "Sign in again").
- Effort: M. Confidence: inferred from code (confirm intent with the owner; account mismatch must stay blocked).

### 6. The sync chip talks like a log, says "Offline" for server trouble, and flashes after every save
- Severity: S2 friction
- Evidence: titles and details `AppSyncRuntime.swift:40-95` ("Connecting", "Offline", "Syncing", "Synced", "N records waiting"). Header placement `HomeView.swift:146`. Pending count includes `held` events (`LedgerStore.swift:1211-1221`), the undo window is 6 seconds (`NumaSharedCore/Sources/NumaSharedCore/Undo.swift:12`), and "Synced" shows for 2 seconds (`SyncViews.swift:28-37`). `syncPresentation` converts synced-with-pending to syncing (`AppModel.swift:857-863`). Any retryable error becomes `.offline` (`AppSyncRuntime.swift:1468-1475`). Retry gives no feedback (`AppModel.swift:2477-2480`). Frame 56 is a banner under the hero, shown only when something is pending: "Saved on this iPhone · 1 pending · Details".
- Why it matters: every saved expense, while online, shows a "Syncing / 1 record waiting" chip for at least 6 seconds, then "Synced" for 2, right where the Undo lane appears. Airplane mode shows a permanent "Offline · Retry" chip even with nothing to sync. A server outage is labelled "Offline", which is untrue.
- Fix: show nothing when healthy, nothing while an event is only held for undo, nothing for the first 10 seconds of pending. After that, or when offline with pending work, show the frame 56 banner: "Saved on this iPhone · 1 not shared yet · Details". Offline with nothing pending shows nothing. Server trouble uses the same banner; the detail screen says "Can't reach Numa right now". Retry shows a spinner and a result.
- Effort: S for count and flash, M for the banner and detail screen. Confidence: verified in code.

### 7. Paused and error states have no screen; the human error strings are computed but never shown
- Severity: S2
- Evidence: `syncErrorMessage` is rendered in exactly one place, the sign-in sheet (`SyncViews.swift:198`). The capsule has no action for update required, sync setup issue and access changed (`AppSyncRuntime.swift:104-117`), so it is a non-tappable label; generic "Sync paused" only offers Retry. `userFacingSyncError` default branch (`AppModel.swift:2902-2927`) returns "This record couldn't be added. It remains on this iPhone; copy its details and contact support." for paused states, and the Apple sign-in sheet displays that text when the server rejects a sign-in (`AppModel.swift:2400-2406`). Any non-paused login failure says "Your records are safe here. Retry when you're online." A rejected record (`Models.swift:446-453`, `SheetViews.swift:258-292`) offers only Copy details and Share details; no "Try again", no "Remove". The "Please update" banner (`RootView.swift:93`) has no reason and no link. No native screen exists for frame 57.
- Why it matters: "Sync paused" with no reason or next step is a dead end, and the one string that does appear on a sign-in failure talks about a record that was never involved.
- Fix: build the frame 57 screen (Settings row "Sharing" and the banner's Details both open it). One title, one plain cause, one action per state:
  - Waiting for connection: "Saved here. Not shared yet." / "1 change is waiting for a connection. It goes through on its own. Don't add it again." / Try again.
  - Server unreachable: "Can't reach Numa right now." / "Your expenses are safe on this iPhone. We'll keep trying."
  - Sign in required: "Sign in again to keep sharing." / Sign in with Apple. Note: "You can keep adding expenses meanwhile."
  - Update required: "Update Numa Shared to keep sharing." / Open the App Store.
  - Access removed: "You're no longer in Our place." / Export history.
  - Rejected expense: "Numa couldn't add Dinner together." plus the reason in words / Add it again, Delete it, Send details to support.
- Effort: M. Confidence: verified in code.

### 8. You cannot tell whether the household has your expense, and two lines overclaim
- Severity: S2
- Evidence: per-record state exists (`Models.swift:259-265`, `440-455`) but "synced" renders nothing. Home rows show only the failed state (`HomeView.swift:494`). Activity shows "Waiting to sync" only when sync is on (`SheetViews.swift:172`). Activity footer "Synced with everyone in this pot." (`AppModel.swift:904`) means only that this phone's events were acknowledged and it is caught up. Home footer "Your household shares the same history." (`HomeView.swift:441-445`) is static and stays visible offline. Expense detail has no sharing line.
- Why it matters: the most common worry ("did Alex get my dinner?") has no honest answer, and the app says "everyone" when it only knows about its own phone.
- Fix: use a two-step vocabulary everywhere: "Only on this iPhone" then "Shared". Home rows get a small cluster of state only while not yet shared (not for every row). Expense detail gets one line: "Shared with Alex + Jo, 14:02" or "Only on this iPhone so far". Footers: "Up to date" and "Waiting for a connection". Do not add read receipts (they are a privacy cost between flatmates and not in the contracts). The push notification is the flatmate's cue.
- Effort: S for copy, M for the per-row state. Confidence: verified in code.

### 9. Notifications: no primer, the owner is rarely asked, denied is a dead end, the section is dead before sync, and it exists twice
- Severity: S2
- Evidence: the only automatic system prompts come from `requestPushAuthorization(afterAcceptedMembership: true)` on a joiner's claim (`AppModel.swift:2463`) and on an owner approving a join request (`AppModel.swift:1858-1866`, `2088`). Per-member invites go straight to "joined" for the joiner, so the household creator, who most needs "Alex added dinner", is never prompted unless they dig into Settings after enabling sync. The iOS dialog fires over the "Pot joined" screen with no primer, and iOS shows it once. No code opens iOS Settings (`openSettingsURLString` appears nowhere); denied state is a label (`PeopleManagementView.swift:670`). Before sync the section shows a greyed "Mute this pot" in the off position plus "Enable sync before changing this pot's notifications." (`SettingsView.swift:53-70`). The control exists twice (`SettingsView.swift:53-88`, `PeopleManagementView.swift:233-258`) with two different footers; the People footer says "changes your position or a contested record needs your choice" (`PeopleManagementView.swift:255`). "Mute" on means quiet.
- Why it matters: a one-shot system prompt is spent with no explanation, the person it matters most to may never see it, and a user who taps "Don't Allow" has no path back.
- Fix:
  - Ask at the first moment of value, with an in-app primer before the system prompt: "Want a nudge when Alex adds something? Turn on / Not now". Show it to the joiner on the "You're in" screen, and to the owner the first time someone joins. "Not now" must not spend the iOS prompt.
  - One Settings row, "Notifications: On / Off / Muted for Our place", shown only when the household has two or more people. Toggle wording: "Notify me about Our place" (on means alerts).
  - Denied state gets a button: "Open iPhone Settings".
  - Remove the duplicate from the People sheet.
  - Footer: "Alerts never include amounts. You get one when someone adds or changes an expense that affects you."
- Effort: M. Confidence: verified in code (prompt timing for per-member invites inferred from `.joined` vs `.pendingApproval` handling).

### 10. Settings is a junk drawer: ten controls in six sections, no identity, no currency, no sync status
- Severity: S2
- Evidence: `SettingsView.swift:14-244`. Sections: People and Enable sync; Notifications (toggle, permission, retry, error, two footers); Privacy (one toggle); Export (button, count, error, warning, second share button, disclosure); About (support, licenses, version); Account (Sign out, Delete account, two error lines). Frame 45 has six calm rows under an identity header ("You / You + Sam · Our place"), a Currency row ("Fixed for this household, EUR") and a trust footer ("No bank connections. No money transfers."). Native has none of those three. Once sync is enabled the "Enable sync" row disappears and nothing in Settings shows sync status, which Apple account is signed in, or what is waiting.
- Why it matters: people cannot answer "who am I here", "which currency", "is it shared" from Settings, but they do see Delete account next to Contact support.
- Fix: seven top-level rows under an identity card.
  ```
  [avatar] You + Sam
           Our place · EUR (fixed)
  People & invitations          >
  Sharing                Up to date >   (Apple account, Sign out live here)
  Notifications              On >       (only with 2+ people)
  Hide amounts                  [toggle]
  Export & your data            >       (Export, Leave, Delete account)
  Help & about                  >       (Contact support, licenses, version)
  Numa Shared · Private beta. No bank connections. No money transfers.
  ```
  Sign out moves under Sharing. Delete account moves under Export & your data. Remove the Notifications and About sections from the top level.
- Effort: M. Confidence: verified in code; frame 45 is design only.

### 11. The household switcher is hidden, dead when it matters, and written in developer words
- Severity: S2
- Evidence: entry is the "numa." wordmark plus name (`HomeView.swift:133-146`), no chevron, VoiceOver hint "Opens the pot switcher." Sheet title "Pots", a bare count, row subtitle is the currency code, "Untitled pot" fallback (`PotSwitcherView.swift:15`, `61`, `76`). With sync on: footer "Sync keeps this pot active in this version." and New pot at 40 percent opacity (`PotSwitcherView.swift:34-51`). No rename, delete or archive anywhere (the file's own comment lists them as follow-ups, `PotSwitcherView.swift:3-6`). New pot runs the full create, people, opening-balance onboarding (`AppModel.swift:3169-3195`). Frames 45 to 59 have no switcher at all.
- Why it matters: it works only for households that are not shared, which is the case nobody needs it for. A typo in the household name is permanent, and a mis-tapped New pot leaves a permanent empty household.
- Fix: now, remove the tap target (make the wordmark plain text) and add "Rename household" under People & invitations. Later, one Households sheet (see rethink 3) with a chevron on the title only when there are two or more.
- Effort: S now, L for the real feature. Confidence: verified in code.

### 12. "Export CSV" produces an audit log, not a household history
- Severity: S2
- Evidence: `LedgerCSVExport.swift:17-35` columns: `format_version, pot_name, pot_configuration_json, event_id, event_kind, event_schema_version, server_sequence, local_ordinal, applied_order, delivery_state, event_origin, attempt_count, terminal_reason, occurred_at_utc, saved_at_utc, originating_time_zone, event_json`. There is no amount, payer or description column; they are inside `event_json`. UI says "42 events in this export" (`SettingsView.swift:125`) and "Deleted authored text stays redacted" (`SettingsView.swift:155`). Frame 50 promises "Expenses, splits and actual payers; recorded repayments and opening balances; visible corrections and voids; derived balances". PRODUCT.md: replace the household spreadsheet.
- Why it matters: someone who opens the file in Numbers to check last year's rent sees JSON.
- Fix: default export "Household history": Date, What, Type (expense, repayment, opening balance), Paid by, Paid by (group), Amount, Currency, Shared between, Status (active, corrected, voided), Recorded by, Saved at. Keep the current file as "Full record for backup (advanced)". Show the frame 50 manifest before the share sheet ("Export household history" button, not "Export CSV"). Footnote: "Contains exact amounts, even with Hide amounts on. Names and notes people erased stay erased." Minor: a flatmate's incoming change while the share sheet is up discards the file and closes the sheet (`SettingsView.swift:341-346`, `AppModel.swift:954-956`); acceptable, but say "History changed. Export again."
- Effort: M. Confidence: verified in code.

### 13. Delete account and Leave are dialogs with understated or confusing consequences
- Severity: S2
- Evidence: Delete account is a `confirmationDialog` whose message is one paragraph plus one paragraph per household (`SettingsView.swift:299-322`, `AppModel.swift:1575-1625`). No export offered. It sits one row below Sign out, both red, same weight (`SettingsView.swift:195-225`). Leave is not in Settings; it is at the bottom of the People sheet (`PeopleManagementView.swift:268-283`) and warns "Your current balance is −€84.00. Leaving does not settle it." (`AppModel.swift:688-699`): a signed number, no counterparty, no group, and in a couple it is the group's balance, not "yours". Frame 52 has it right: "The group keeps its balance… Owed to Alex + Jo €84.00". Nothing says whether you can rejoin.
- Why it matters: the contracts say never to express debt as a bare number, and the deletion dialog can truncate once a person has several households.
- Fix: full-screen review for each, as in frames 51 and 52, with an "Export first" row on both. Leave copy: "You + Sam owe Alex + Jo €84.00. Leaving does not change that, and Sam keeps the group's balance. Your history stays on this iPhone, frozen. You can come back only if someone invites you again." (confirm the rejoin rule with the backend before shipping that last sentence). Delete copy per household as rows: "Our place: stays with Alex + Jo as 'Former member'" / "Beach house: deleted, you're the only member." Keep a system dialog only as the last step, with "Delete my account" as the destructive button.
- Effort: M. Confidence: verified in code.

### 14. Opening Settings offline shows an error
- Severity: S2
- Evidence: `openSettings` always refreshes notification state (`AppModel.swift:1270-1274`). `refreshSettingsNotificationState` calls the server for the mute flag and on failure sets "Notification settings couldn't be loaded. Try again." (`AppModel.swift:1287-1306`). `SettingsView.swift:73-81` shows the error plus a Retry button.
- Why it matters: offline is normal use. Opening Settings on a train shows an error row.
- Fix: cache the last known mute state per household, fetch silently, and show an error only after the person taps the toggle. Sign out and Delete account also fail offline with "Sign out couldn't finish. Try again." (`AppModel.swift:1486`); say "You need a connection to sign out."
- Effort: S. Confidence: verified in code.

### 15. Developer language is all over the "just works" layer
- Severity: S2
- Evidence: "pot" is in 34 of the 233 catalog keys (`Localizable.xcstrings`); the design says household, home or the household's own name. Others:
  - Settings hint "Manage people, invitations, and the pot owner." (`SettingsView.swift:31`), "Keep this pot synced with Sign in with Apple." (48), "Mute this pot" (55). Switcher: "Pots", "New pot", "Untitled pot". People: "Leave pot". Join: "Join a pot", "Pot joined", "Open pot". Errors: "Your pot couldn't be opened", "Loading your pot".
  - "N records waiting" (`AppSyncRuntime.swift:90-91`), "events in this export" (`SettingsView.swift:125`), "contested record", "your position" (`PeopleManagementView.swift:255`), "authored text", "redacted" (`SettingsView.swift:155`), "verified copy" and "Reload this pot" (`AppModel.swift:1047-1048`), "in this version" (`PotSwitcherView.swift:36`), "split 2 units" (`Models.swift:383-390`).
  - "People & ownership" (`SettingsView.swift:21`). Frame 57 itself says "The same event will retry" and "If the server rejects a change"; do not copy those.
- Why it matters: the product says "fun, social, no jargon", and these strings are what people read when something goes wrong.
- Fix, replace:
  - pot becomes household, or the household's name ("Notifications for Our place").
  - records waiting becomes "not shared yet" ("1 not shared yet").
  - events in this export becomes "entries".
  - contested record becomes "two edits clash".
  - your position becomes "affects you".
  - authored text becomes "names and notes you wrote".
  - redacted becomes "erased".
  - People & ownership becomes "People & invitations".
  - verified copy and Reload this pot becomes "Nothing was lost. Try again."
  - split 2 units becomes "split between 2 groups".
  Pick one noun ("household") and use it in Settings, Join and errors.
- Effort: S to M (string sweep, one pass). Confidence: verified in code.

### 16. Challenges a decision: frames 46 and 49 to 52
- Severity: S2 (design decision; costs nothing to fix before building)
- Evidence: frame 46 "Appearance & motion": three of four rows are read-only echoes of iOS settings ("Reduce Motion: System", "Reduce Transparency: System" with an info icon) that look tappable and are not, plus a "Preview orb press" demo. Native correctly omits it. Frames 49 to 52 split three flows (Export, Erase my personal text, Leave) and keep Delete account elsewhere. Native has no hub; "Erase my personal text" does not exist for yourself, only the owner's "Erase name" for a pending member (`AppModel.swift:1916`). Delete account already erases authored text (`AppModel.swift:1581`). Frames 50 to 52 contain prototype copy: "Preview export action", "Preview final confirmation", "Preview leaving confirmation", "This design preview will not erase anything", "A final confirmation is required in the actual app."
- Why it matters: building frame 46 adds a dead screen to Settings. "Authored text" is a concept most people do not hold; having it as a top-level choice invites a mis-tap with a permanent effect.
- Fix: do not build 46; if a light/dark override is ever wanted, make it one three-way row (System, Light, Dark) inside Help & about. Replace the privacy hub with one "Export & your data" screen ordered by reversibility: Export a copy (reversible), Leave this household (history stays, return by invite), Delete my account and personal text (permanent). Fold "erase my name and notes" into Leave as a switch ("Also erase my name and notes from shared history"). Do not ship any "Preview" label.
- Effort: S (decision). Confidence: design only for the frames, verified in code for native.

### 17. Polish bundle
- Severity: S3 polish (item f is S2)
- a. Settings to People dismisses Settings (`SettingsView.swift:18`, `AppModel.swift:1279-1285`); closing People lands on Home, not Settings. The row has no chevron (it is a Button, while "Open-source licenses" is a NavigationLink with one) and uses a UIKit label where neighbours use SwiftUI `Label`, so one list renders two ways. Push People inside the Settings stack.
- b. Close control is an `xmark.circle.fill` placed as `.confirmationAction` but labelled "Done" (`SettingsView.swift:246-255`). Frame 45 uses a back chevron and a bottom "Done".
- c. Currency is never stated in Settings. Add the frame 45 lock row. Add the trust footer: "Numa Shared · Private beta. No bank connections. No money transfers."
- d. "Anonymous diagnostic ID" in the support email is `UUID()` minted on every render (`SupportInfo.swift:26`, `SettingsView.swift:164`). It ties to nothing. Remove it, or use the failed-record ID.
- e. Bricolage's OFL license is bundled (`Resources/Bricolage-OFL.txt`) but not listed in `OpenSourceLicensesView` (`SettingsView.swift:403-433`).
- f. (S2) The quiet "cloud" chip (`SyncViews.swift:45-60`) is unreachable: `HomeView.swift:146` hides the capsule when local. The Home footer "Saved on this iPhone. Connect when you're ready to share." (`HomeView.swift:441-446`) is plain text, so a solo user has no tap path from Home to sharing. Make that line a button: "Share with your housemates".
- g. "Sync now" in the sign-out dialog (`SettingsView.swift:277`, `AppModel.swift:1456-1459`) closes the dialog and runs silently. Nothing says when it is safe to sign out. Reopen the dialog with the result.
- h. Hide amounts takes three taps (Settings, toggle, Done) every time. Consider an eye button in the Home header, since people hide amounts right before showing someone their screen.
- Effort: S each. Confidence: verified in code.

## Ground-up rethink

1. **Saved, then Shared: one quiet truth about the network.** Remove every network word from the app ("Offline", "Syncing", "Connecting", "records waiting"). An expense is either "Only on this iPhone" or "Shared". Home says nothing when everything is shared. If something has been unshared for more than 10 seconds, a calm banner under the hero says "Saved on this iPhone · 1 not shared yet · Details" and the hero amount gets a small qualifier, "includes 1 expense not shared yet", because your balance includes local events your flatmate's phone does not have yet, and that gap is exactly what starts a "my app says 84, yours says 36" argument. Details opens the frame 57 screen, which states what is safe, what is pending, and the single next action. Expense detail ends with "Shared with Alex + Jo, 14:02". Nothing is ever red, nothing flashes, nothing blocks Add.

2. **Settings as "You and Our place".** The top of Settings is the identity card (avatar, "You + Sam", "Our place · EUR, fixed"). Below it are seven rows, each a destination, not a control. The two scary things, Sign out and Delete account, are two screens deep and each starts with a plain review ("Here is what stays, here is what goes") and an Export first button. A person who opens Settings to hide amounts sees a toggle, not a legal page. Everything that needs a decision uses sentences with names ("You + Sam owe Alex + Jo €84.00. Leaving does not change that").

3. **A real "Households" sheet.** Tapping the household name (with a chevron, shown only when you belong to more than one) opens a list built from the server and the device. Each row shows group chips, a balance sentence ("You owe Alex + Jo €84"), last activity and notification state. Footer actions are "Join with a code" and "Start another household". This is where the typed invite code lives after onboarding, where rename and archive live, and where a push for another household says "Opened Beach house" instead of swapping silently. A person who never needs it never sees it.

4. **An export people can open.** "Export household history" shows a one-screen preview of what the file contains, then hands over a spreadsheet with a row per expense, repayment and correction (date, what, who paid, amount, who it was for, status). A second, optional "Full record for backup" file keeps the technical log for people who want it. Add a "Share where we stand" text (one line, the balance sentence and date) for the group chat; it moves no money, and it is what flatmates currently screenshot.

5. **Sign out that never deletes.** Keep each account's data on the device under that account's key. Sign out locks it (the app returns to Welcome and the data is unreadable by any other account), and signing back in is instant with no re-download. Only an explicit "Remove all data from this iPhone" wipes, and it lists every household it will remove and offers Export first. This keeps the account-isolation contract and removes the most surprising destructive button in the app.

## Quick wins

1. Add an "Open iPhone Settings" button to the denied-notifications state, and hide the whole Notifications section until sync is on and the household has two or more people (`SettingsView.swift:53-88`, `PeopleManagementView.swift:649-690`).
2. Stop counting undo-window `held` events as "waiting" and drop the 2-second "Synced" flash; reword the offline chip to "Saved on this iPhone · 1 not shared yet" (`LedgerStore.swift:1211-1221`, `SyncViews.swift:28-37`, `AppSyncRuntime.swift:40-95`).
3. Make Sign out and Delete account name every local household they will erase, and add an "Export first" button (`AppModel.swift:1434-1453`, `1575-1625`, `1731-1760`).
4. Cache the mute flag and stop showing "Notification settings couldn't be loaded" when Settings opens offline (`AppModel.swift:1270-1306`, `SettingsView.swift:73-81`).
5. Replace "pot" with household or the household's name in every string, and make the "numa." wordmark a plain label until there are two or more households (`HomeView.swift:133-146`, `PotSwitcherView.swift`, the 34 catalog keys).
