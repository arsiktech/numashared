# 04 First run: welcome, household setup, people, invites, joining, opening balance

Evidence labels used below: **verified in code** (I read the lines), **inferred** (follows from the code but I could not see the runtime result), **design only** (canvas frame). Nothing here was run: there is no Simulator in this container. Tap counts are counted from the source, not timed on a device.

Source read: `OnboardingViews.swift`, `InviteViews.swift`, `InviteRouting.swift`, `PeopleManagementView.swift`, `OpeningBalanceView.swift`, `ConstellationLayout.swift`, `FieldSpaceView.swift`, `RootView.swift`, plus the onboarding, invite, join and opening-balance parts of `AppModel.swift`, `AppSyncRuntime.swift`, `SyncPotSelection.swift`, `SyncViews.swift`, `HomeView.swift` (first-run state only), `OnboardingFrictionTests.swift`, and frames 01-08, 40-45, 47-48, 53, 54.

## Verdict

The first screens (Welcome, name and currency, people) are well made and the local-first order is right: no account up front, Sign in with Apple only when someone is invited. The weak part is everything after "Create our home". The path to a shared household is long and technical: about 6 taps and 3 text fields to reach Home for two flatmates, 14 taps and 5 fields for two couples, then roughly 12 more taps across two phones and two Apple sign-ins before the other flatmate sees an expense. Three trust problems sit in the unseen corners: the opening balance can only be entered inside the setup flow (frames 45 and 54 promise it later), invite and join screens still use the word "pot" that nothing explains, and tapping an invite while already holding a household has no guard at all. The couple/"budget group" concept is forced on every household and then locked for good by the first expense, including a test expense. Roughly half the screens in my area (People, connect, join, invite error, opening balance) are structurally different from the approved frames, not just off by pixels.

## Time to first value (counted from code, estimate not timed)

Two single flatmates, best case. Install to first expense saved:

| # | Screen | Taps | Typing |
|---|---|---|---|
| 1 | Welcome | "Create our home" | none |
| 2 | Name and currency (keyboard opens on its own) | "Confirm EUR & continue" | household name |
| 3 | Who's at home (owner field focused) | "Add a person" | your name |
| 4 | Add a person (full-screen cover) | "Save person" | their name |
| 5 | Who's at home again | "Continue with 2 people" | none |
| 6 | One last look | "Create our home" | none |
| 7 | Home (empty) | tap the orb row | none |
| 8 | Add expense | about 2-3 more (belongs to the add-expense report) | description, amount |

Result: 6 screens, 6 taps and 3 typed fields before Home, about 10 taps in total to a saved expense. Two couples (You + Sam, Alex + Jo): 2 more Add-person round trips (+4 taps) and 2 pairings through a pencil menu (+4 taps), so 14 taps and 5 typed fields before Home, about 18 to the first saved expense.

The other flatmate sees it (owner side, then joiner):
- Owner: People tab (1) → "Invite" on Sam's row (2) → People sheet closes, "Keep Our place synced" sheet opens → Continue with Apple (3) + Apple sheet + Face ID (+ a Share/Hide My Email step, see finding 14) → People sheet re-opens with the invite → Share invite (4) → share sheet: Messages, contact, Send (5-7). About 8 taps, 1 Face ID, 4 modal transitions.
- Joiner, app already installed: tap link (1) → Continue with Apple + Face ID (2-3) → "Open pot" (4) → Home. If the app is not installed, the web page sends them to the App Store and tells them to tap the link again.
- In total about 22 taps (two singles) to 30 (two couples) and two Apple sign-ins from first launch to "Sam sees the dinner". Install time on Sam's phone dominates; the design should not make the owner wait for it (see Ground-up rethink 2).

## Findings

### 1. Opening balance can only be entered once, inside setup
- **Severity:** S1 broken/trust
- **Evidence:** `OnboardingViews.swift:576` is the only entry: a small `.footnote` text button "Set opening balances" in the middle of the last setup step, above the real primary button. It calls `AppModel.continueToOpeningBalance` (`AppModel.swift:3404`), which persists the household first and then shows `OpeningBalanceView` as a root screen (`RootView.swift:28`). The only other route to `.openingBalance` is `persistSetup(then:)`. `HomeView.swift` and `SettingsView.swift` contain no opening-balance entry. Frame 54-empty has the row "Already owe each other money?" and frame 45-settings has "Opening balance / Bring an existing balance". Neither exists in the native app. If the app is killed on that screen, `apply(snapshot)` sets `.home` on relaunch (`AppModel.swift:989`) and the screen is gone.
- **Why it matters:** "We already owe each other €X from the spreadsheet" is the main first-run scenario for a household migrating off a sheet, and today a user who taps Skip, or just taps the big button, can never record it.
- **Fix:** Add a quiet row on empty Home ("Already owe each other money?" with an arrow, as in frame 54) and a Settings row. Present it as a sheet, not a root screen. In setup, replace the footnote button with a real choice on the last step: a second, equal-weight secondary button "We already owe each other". Because it is additive on a live ledger, add the review step from frame 48 ("A starting point. Not a payment.", current balance + opening amount = resulting debt) whenever the household already has records. The ledger already supports appending later (`appendOpeningBalance`), so this is UI only.
- **Effort:** M. **Confidence:** verified in code.

### 2. One thing, six names: pot / home / household / place / budget / balance group
- **Severity:** S1 broken/trust (inconsistent naming, jargon in the very first invite screen)
- **Evidence:** Onboarding says "Create our home", "household", "place". The invite and join flow, People, Settings, errors and the web invite page say "pot": `InviteViews.swift:227` "Join a pot", `:229` "Pot invitation", `:82` "Pot joined", `:87` "Open pot", `:154` "Join this pot", `:59` "No pot history is opened until…", `PeopleManagementView.swift:239/272/382/749` "Mute this pot", "Leave pot", "Create pot invite", `RootView.swift:126/267` "Your pot couldn't be opened", `SyncViews.swift:178` "tells friends it's you" next to "your pots", `AppModel.swift:3385` "Confirm the pot currency.", `HomeView.swift:144` "Opens the pot switcher.", `convex/lib/webContent.ts:216` "Someone invited you to a shared pot". 34 of 233 string keys in `Localizable.xcstrings` contain "pot", and 5 of those keys (for example "Create your pot") are no longer used anywhere. For the unit people live in, the setup screens use "budget", "shared budget", "balance group", "group", "Share a balance with" and "Keep balances separate" (`OnboardingViews.swift:541-573`, `PeopleManagementView.swift:198-221`). Frames use "home" and "household" only.
- **Why it matters:** Sam's first screen in Numa is "Join a pot", a word no one has explained, and a person who learned "balance group" in setup meets "budget group" in People.
- **Fix:** One word per concept, in all user-facing strings, notifications and the web page: the thing is a **home** (noun) / "household" in formal spots. Join sheet: "Join Our place", "You're invited to Our place", "Welcome to Our place". People: "Mute this home", "Leave home", "Invite link". Keep "pot" in code and docs only. For people-groups use one phrase, not three (see finding 6). Then grep the xcstrings and the Convex web copy for `\bpots?\b`.
- **Challenges a decision:** the word "budget" (frames 06, 07, 08, 40) suggests spending limits, which are excluded from this release. "Together" / "couple" / "shares money" would not. See finding 6 for the proposed wording.
- **Effort:** S for strings, M including the web page and tests that assert strings. **Confidence:** verified in code.

### 3. Tapping an invite while already in a household has no guard
- **Severity:** S1 broken/trust
- **Evidence:** `AppModel.handleOpenURL` (`AppModel.swift:2165`) sets `joinPresented = true` regardless of `screen` or whether a local household with records exists. The preview (`InviteViews.swift:125-166`) shows only the invited home's name and "Join this pot". Claiming calls `activateRemotePot`, which switches the active home (`LedgerRepository.swift:448`). The test `testInviteLoginDefersLocalPromotionUntilClaimAndThenAdoptsClaimedPot` asserts `promote == 0` after a claim, so the local household is deliberately not uploaded. While sync is enabled the home switcher is disabled (`AppModel.swift:3131`, `canManagePots` is false). The only copy about local data is "Your existing records remain on this iPhone." (`InviteViews.swift:66`). Frame 53 states the intent: "No dead end and no accidental account switch", "Your existing home is safe".
- **Why it matters:** Sam installs, tries the app alone, adds a few expenses, then taps the link from Alex. From the code, his own household will probably vanish from the UI while the screen says nothing about it. I could not verify the on-screen result, only the logic.
- **Fix:** In `handleOpenURL` and again in the preview state, check whether the active local household has any events. If it has none (a fresh Welcome or an empty setup), join silently. If it has any, show one interstitial before the Apple button: "You already have 'Sam's place' with 12 expenses on this iPhone. Joining Our place will replace it on this screen. [Join Our place] [Keep mine]". The first choice should offer Export first. Copy: "Your records stay safe" must not be claimed unless they are reachable.
- **Effort:** M. **Confidence:** inferred (flow traced through code and one unit test; no runtime).

### 4. A test expense permanently locks who is a couple, and the choice is made through a pencil menu
- **Severity:** S1 broken/trust
- **Evidence:** `PeopleManagementView.swift:218-220`: "Groups are fixed after the first expense, opening balance or repayment, even if voided." `AppModel.canEditBudgetGroups` requires `hasFinancialHistory == false` (`AppModel.swift:132`). The only warning at setup time is a card on the last step, "Once you add money, groups stay put" (`OnboardingViews.swift:575`). Pairing is done through the pencil icon menu "Share a balance with Sam" or a hidden drag and drop (`OnboardingViews.swift:609-613`, `:615-640`). Default is everyone separate. Nothing at the moment of the first expense mentions the lock. Escape hatch today: Privacy → erase.
- **Why it matters:** The most common first action is a throwaway "coffee €3" to see how it works. If groups were left as default or set wrongly, that one tap fixes them for the life of the household.
- **Fix:** (a) At the first-ever "Save" in a household, show one confirmation sheet: "After this, who shares money is fixed. You + Sam | Alex | Jo. [Looks right] [Change groups]". (b) Make pairing a visible, plain-language control at the moment of adding a person (finding 6). (c) Offer "Start over" for a household with one member and no sync (reset without Privacy → erase).
- **Challenges a decision** (lifecycle rule confirmed Sept 12): consider letting an owner regroup while they are the only active member and nothing has synced, since nobody else's balance can be affected. The reducer cost looks high, so (a) and (c) are the cheap safety net.
- **Effort:** S for (a), M for (b) and (c). **Confidence:** verified in code.

### 5. Setup takes 4 screens and a full-screen cover per person
- **Severity:** S2 friction
- **Evidence:** Welcome → Create (`OnboardingViews.swift:151`) → People (`:424`) → per person a `fullScreenCover` name editor (`:485-498`, `:699`) → Ready step inside the same view (`:529`) → Home. `SetupProgress` draws 3 bars (`:377`), frames 02, 06 and 08 draw 4. Household name and owner name start empty by design (`OnboardingFrictionTests.testFreshDefaultsDoNotInventHouseholdOrOwnerIdentity`), while frame 02 shows "Our place" prefilled. Currency is confirmed on the Create screen (`:209-213`) and is editable again on the last step (`:537`), so it is handled twice. Nothing typed survives a kill before "Create our home" (setup fields live in memory, `AppModel.swift:97-105`).
- **Why it matters:** For two flatmates this is 6 taps and 3 text fields before they have seen their own Home. Each added housemate costs a screen change and a tap, and the user thinks about "creating a home" before getting any value.
- **Fix:** One "Who's at home?" screen: your name on top, housemates as inline rows (return key adds the next one, like Reminders), no cover per person. Prefill household name with "Our place" as a selected suggestion (accepting it is still a visible user action). Move currency off its own step: show `€ Euro · change` on the last screen and make the primary button the explicit confirmation, "Create Our place in EUR". Net: Welcome → Who's home → Home, 3 taps for singles. Persist the draft so a kill does not lose it.
- **Challenges a decision:** the "no invented default" test and the separate currency step; the confirmation contract (explicit, fixed) stays intact because the final button names the currency.
- **Effort:** M. **Confidence:** verified in code and frames.

### 6. Every household has to learn "budget groups", and the two-flatmate case reads wrong
- **Severity:** S2 friction
- **Evidence:** The last step always asks "Who shares a budget?" and prints "2 balance groups" (`OnboardingViews.swift:541-568`). For two single flatmates `:573` prints "A 50/50 bill is split between these two groups—not 2 people." (the groups are the 2 people), and `:532` prints "Two people. Two shared budgets." People step shows no mention of couples until the next step. With everyone paired into one group the only hint is a footnote "Keep at least two balance groups separate." while the primary button is simply disabled (`:582`, `app.canCompleteSetup`). Frames 06 and 07 had a dedicated "Shared budgets" step and a clear "Separate, or together?" editor with check rows; the native version has neither.
- **Why it matters:** The simplest household pays a concept tax it does not need, and the couple case relies on an unlabelled pencil.
- **Fix:** Ask nothing when there are exactly two people (two single groups are forced). With three or more, show names as chips under one question, "Does anyone share money with someone else?" and let people tap two chips to join them ("Sam and I share money"). Show the result as the group name ("You + Sam") and a single line "Bills split 50/50 between You + Sam and Alex + Jo." Avoid "budget" and "balance group" in the UI; if a noun is needed use "group" as Home chips already do. Replace the disabled button with a plain sentence that says what to change.
- **Challenges a decision:** naming in frames 06-08 and 40. The problem is the word "budget" (implies limits) and four near-synonyms.
- **Effort:** M. **Confidence:** verified in code.

### 7. Shared value sits behind about 8 taps and the empty Home never mentions inviting
- **Severity:** S2 friction
- **Evidence:** Empty Home: headline "Our everyday, together.", amount slot "Nothing shared yet", "Start here, on this iPhone. Invite people when you're ready." (`HomeView.swift:111,122,214`), plus the footer "Saved on this iPhone. Connect when you're ready to share." (`:444`). Neither is a button. The path is People tab → plain-text "Invite" in a list row (`PeopleManagementView.swift:330-336`) → People sheet dismisses (`AppModel.swift:1948-1955`, `peoplePresented = false`) → sheet "Keep Our place synced" (`SyncViews.swift:176`) → Apple → People sheet re-presents (`AppModel.swift:2394`) → "Share invite" at the top of a long list. Frame 40 shows the colored group cards with one "Connect & invite" row, frame 41 explains why.
- **Why it matters:** The product is social; the owner can easily use it alone for a week because nothing in Home asks them to invite.
- **Fix:** Add a first-run row under the orb on empty Home: "Invite Sam" (one row per pending person, avatar + name + "Send their spot"), until all are claimed. One tap starts Sign in with Apple, then opens the system share sheet directly with message text ("Sam, your spot in Our place is ready" + link). Keep the QR and code as a secondary "Show QR" for people in the same room. Remove the sheet-to-sheet hop by presenting Apple sign-in in place.
- **Effort:** M. **Confidence:** verified in code.

### 8. Joiner's first screen is generic, hides who they are joining as, and pushes a notification prompt over the confirmation
- **Severity:** S2 friction
- **Evidence:** `JoinPotView` is a half-height sheet over Welcome, in system styling (`.title2.bold()`, `PrimaryPillButton`, SF symbols `person.2`), not the Bricolage full-screen of frame 44 ("Come on in, Sam.", group card, "Joining as Sam", currency, "This isn't me"). The preview only has the home name (`InvitePreview` has no member field, `InviteRouting.swift:197-204`; decision 2026-07-15 keeps previews generic). It reads "Invite to Our place / This invitation claims the place prepared for you." After the claim the user gets "Pot joined / Open pot" (`InviteViews.swift:79-89`), one extra tap that adds nothing. `AppModel.swift:2461-2463` sets `.joined` and then awaits `requestPushAuthorization`, so the iOS notification permission alert appears on top of that interstitial before the user has seen the household. On Home there is no "You are Sam in You + Sam" moment.
- **Why it matters:** A per-person invite is an identity claim. The person should see which identity before tapping, and see themselves in the home right after.
- **Fix:** Full-screen branded invite screen. Let the POST preview response (already rate-limited and token-gated) return the pending member's first name and group label; the holder of the link can claim that identity anyway, so this adds little exposure. Single CTA "Continue with Apple" (sign-in and claim stay one tap), plus "This isn't me". On success go straight to Home with a one-time banner "You're Sam, in You + Sam. Alex + Jo are your housemates." Ask for notifications after that banner is dismissed, with a one-line reason first.
- **Challenges a decision:** the generic-preview rule for the POST response. If the owner keeps it, at least add the post-claim welcome and drop the "Open pot" step.
- **Effort:** M (L with the backend field). **Confidence:** verified in code and frame 44.

### 9. The pot-link and approval path is a dead end for the joiner and an extra concept for the owner
- **Severity:** S2 friction
- **Evidence:** `inviteControlsSection` offers "Create pot invite" to every owner (`PeopleManagementView.swift:379-394`), producing a link where anyone can request access and the owner must pick an identity in "Join requests" (`:479-548`). The joiner ends at "Waiting for approval" with a Done button (`InviteViews.swift:68-78`) and returns to Welcome (`screen` stays `.welcome`). `claimInvite` publishes `.local` and stops polling in that case (`AppSyncRuntime.swift:456-458`); the only foreground hook in the app refreshes app configuration, not membership (`RootView.swift:71-73`). So they probably learn about approval only after a relaunch (inferred). Frames show per-person invites only.
- **Why it matters:** A second invite type in the first week makes "who do I send this to" ambiguous, and the waiting side looks like nothing happened.
- **Fix:** Remove "Create pot invite" from the default People screen (move behind a "More ways to invite" row or drop for this release). If it stays, give the waiting person a persistent state ("Waiting for Alex to approve" with the home name) and refresh membership on foreground.
- **Challenges a decision:** `GOAL_BRIEF` §3 keeps person-specific invites; it does not require the open link.
- **Effort:** S to hide, M to do properly. **Confidence:** inferred for the waiting state, verified for the rest.

### 10. A returning user on a new phone has no way in from Welcome
- **Severity:** S2 friction
- **Evidence:** `WelcomeView.actions` has two buttons only (`OnboardingViews.swift:112-148`). The refresh token is stored `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (`NumaSession.swift:314`), so a new device does not restore it. The route is: create a throwaway home (4 screens), then Settings → sign in, then `SyncPotSelection` adopts the remote home because the local one is empty.
- **Why it matters:** Reinstall and upgrade are normal; making people invent a fake household to get back to a real one is the opposite of "it just works".
- **Fix:** Add "Sign in" as a text button under "I have an invite" on Welcome (Apple button, then `loginForInvite`-style flow without promotion). If the account has a home, go to Home. If not, say so and offer Create.
- **Effort:** M. **Confidence:** inferred.

### 11. Opening balance form is a different, harder design than frames 47 and 48
- **Severity:** S2 friction
- **Evidence:** Frame 47: bridge "You + Sam → Alex + Jo", one large amount, "This adds to your current balance". Native (`OpeningBalanceView.swift`): one row per other group with a 112pt amount field and a direction capsule "Alex + Jo owed your budget group ⇄" (`:229-232`; past tense "owed" is ambiguous about whether it is still owed), a preview that reads "Your budget group starts" / "owes €84.00" (`:189-193`, ungrammatical when read together), and an intro "Your budget group amount is calculated so the pot stays exactly balanced" (`:59`). Close (X) and Skip both call `skipOpeningBalance` (`:38-48`). Semantically each amount is a net position against the whole home, with the owner's group as the plug (`AppModel.swift:3598-3613`), which is not what "Alex owed me €50" means once there are three or more groups. No review step.
- **Why it matters:** This is where a spreadsheet migrator types their real number; a wrong direction or sign is easy to make and only the tiny preview line shows it.
- **Fix:** One sentence builder: "[Alex + Jo ⌄] owe [You + Sam] €____" with a swap button, the same word order as Home ("owe"). Add "Add another" for 3+ groups and show the computed net result below. Drop the "pot stays balanced" line, keep one line: "This isn't a purchase or a payment." Remove the duplicate X. Add the frame 48 review before recording when the home already has records.
- **Effort:** M. **Confidence:** verified in code.

### 12. People is a long conditional settings list with a dead-end sentence, not the calm page of frame 40
- **Severity:** S2 friction
- **Evidence:** `PeopleManagementView` is a `List` sheet with up to a dozen conditional sections: sync notice, issued invite, progress, join requests, roster, budget groups (listing every person again with their group), notifications, leave, pot invite, managed invites, refresh, errors (`:18-90`). When not synced, the first line is plain text "Enable sync to invite people and manage roles." with no button (`:19-25`); "sync" never appears in the frames. "Invite" is an unstyled text button (`:330-336`). Frame 40 is "Our people." with the lime and lilac group cards, a lock icon and one row "Connect & invite".
- **Why it matters:** People is the screen the owner is told to use for the product's core social step, and it reads like an admin console.
- **Fix:** Rebuild per frame 40: group cards on top; "Invite" as a visible pill on each pending person; "Connect to invite" as the button under the notice; move notifications, leave and managed invites to a quieter "Manage access" row. Replace "sync" with "connect" / "share".
- **Effort:** M. **Confidence:** verified in code and frame 40.

### 13. Welcome sells the mood in 1 second and the function in about 4
- **Severity:** S2 friction
- **Evidence:** `WelcomeView` headline "Good company. Clear money." at 53pt; the only functional sentence is the grey 17pt subhead "Keep the shared bills simple. Get back to living together." (`OnboardingViews.swift:25`). The only product hint above the buttons is the pair of chips "You + Sam" / "Alex + Jo" around the orb. Nothing says "split with housemates" or "who owes whom". Frame 01 is faithfully implemented.
- **Why it matters:** A stranger from a friend's recommendation should know in 3 seconds that this is for flatmates splitting costs.
- **Fix:** Keep the headline and layout. Change only the subhead to one concrete sentence: "Split rent, bills and dinners with your housemates. Always know who owes whom." Keep "No bank connection. No money moved." Optionally show a faint "Alex + Jo owe You + Sam" under the chips as the product proof.
- **Challenges a decision:** copy approved on Sept 12; cheap to test.
- **Effort:** S. **Confidence:** design only for the 3-second judgement, verified in code for the copy.

### 14. The Apple sign-in sheet does not say why, and asks for an email nobody uses
- **Severity:** S3 polish
- **Evidence:** An owner who taps "Invite Sam" sees "Keep Our place synced / This keeps your pots synced and tells friends it's you." (`SyncViews.swift:176-178`) with a "Not now" button. Nothing mentions Sam or the invite, and the invite intent disappears visually because the People sheet has been dismissed first. Frame 41 says "Connect your account to invite Sam, Alex and Jo to this household", "Your local work comes with you" and "Keep using on this iPhone". `prepareAppleAuthorization` requests `.email` (`AppModel.swift:2311`); the backend stores only an optional `relayEmail` (`convex/authSessions.ts:48`) and the app never uses it, as far as I found.
- **Why it matters:** Local-first is the right moment for sign-in, but the user should know what it is for, and Apple's extra "Share My Email / Hide My Email" step is one more decision for nothing.
- **Fix:** Context copy when there is a pending invite: "Sign in with Apple to invite Sam. Everything you've added so far comes along." Drop the `.email` scope unless the backend needs it for Apple notifications.
- **Effort:** S. **Confidence:** verified in code for scope and copy; inferred that nothing else needs the email.

### 15. Leftover code and screens from the orb/constellation and multi-pot designs
- **Severity:** S3 polish
- **Evidence:**
  - `ConstellationLayout.swift` (114 lines), `FieldSpaceView.swift` (55) and `FieldSpace.metal` (101) are referenced nowhere, including tests (grep for `ConstellationLayout`, `FieldSpaceView`, `fieldSpace` finds only the definitions). So are the global functions `dist(_:_:)` and `springReturnVelocity(...)`, which also pollute the module namespace.
  - `RootView.swift:243-252` `LoadingHomeSkeleton` still draws the old dashed even line with three orbs, and shows on every cold start (including first launch, where Welcome in butter follows) between a blank generated launch screen (`INFOPLIST_KEY_UILaunchScreen_Generation = YES`) and Welcome.
  - `HomeView.swift` still carries `qaEightUnitField`, `FieldFrameRateMonitor`, `fieldUnitIDs` and the "More groups" chip for the eight-orb field.
  - Tapping the household name on Home opens the "Pots" switcher with "New pot" (`HomeView.swift:133`, `PotSwitcherView.swift`), which no approved frame shows.
  - Legacy three-slot path (`.am/.sam/.leo`): `OpeningBalanceView` `samText/leoText`, `PeopleManagementView.localPersonRow`, and `PeopleManagementView.swift:161` with the owner's own first name hard-coded as the display fallback (`fallback: "Arseny"`) in a public repository.
  - Group colors: `Pal.teal` is lime and `Pal.amber` is sky blue (`Theme.swift:85-90`); setup uses four colors (`OnboardingViews.swift:647`, a peach as the fourth) but Home uses three (`AppModel.swift:734`, `% colors.count`), so a fourth group is peach in setup and lime afterwards.
- **Why it matters:** Dead code and stale strings make later changes riskier, and the skeleton and switcher are visible leftovers of a design the owner replaced.
- **Fix:** Delete the three constellation files and the two globals. Replace the skeleton with a plain butter/paper fill (or skip it when the registry says no household exists). Remove the pot switcher entry point from Home until multi-home is a real feature. Drop the legacy slot path if no schema-1 data exists in the owner's own install (owner decision). Rename `Pal.teal/amber` to their actual hues. Use the same group palette in setup and Home.
- **Effort:** S (delete) to M (legacy path). **Confidence:** verified in code.

### 16. Invite error and join entry: small gaps next to the right idea
- **Severity:** S3 polish
- **Evidence:** `InviteViews.swift:209-221`: all dead-end states show "Ask for a new link or enter another code." with a primary button "Enter another code". For `.rateLimited` ("Too many checks right now") the advice should be "Wait a minute and try again". Frame 53 adds the reassurance "Your existing home is safe" and a "Return to my home" button; native has neither, so a user already in a home gets a prompt to type another code. The code field uses `.textContentType(.oneTimeCode)` (`:102`) for a six-character alphanumeric code and has no paste control. `ShareLink(item: invite.url)` (`PeopleManagementView.swift:410`) shares a bare URL with no message.
- **Why it matters:** The failure state is where trust is won or lost, and the Welcome button "I have an invite" lands on a field that expects the user to type.
- **Fix:** Per-status copy (expired: "Ask Alex for a new one"; used: "This one was already used"; rate limited: "Try again in a minute"), primary button "Done", and a line "Nothing on your account changed." Add a SwiftUI `PasteButton` that accepts a link or a code. Give `ShareLink` a `message` and `subject`, for example "Sam, your spot in Our place is ready."
- **Effort:** S. **Confidence:** verified in code.

### 17. Frame-by-frame conformance for this area (design only vs. verified in code)
- **Severity:** S2 friction (owner requires pixel conformance)
- **Evidence and status:**

| Frame | Status in native |
|---|---|
| 01 welcome | Matches (copy, chips, orb, buttons). |
| 02 create | Close; no prefilled "Our place"; 3 progress bars instead of 4. |
| 03 currency | Select-and-dismiss on tap; no "Use EUR" button; fine functionally. |
| 04, 05 people, add person | Close; per-person cover matches 05. |
| 06, 07 shared budgets, edit groups | Missing as screens; folded into the last step, edited via pencil menu or drag. |
| 08 ready | Close; adds a competing "Set opening balances" text button. |
| 40 people | Different structure (long conditional list sheet). |
| 41 connect | Different: generic "Keep … synced" sheet. |
| 42, 43 choose person, invite preview | Different: row buttons plus "Invite ready" QR/code section, which is a good addition. |
| 44 receiving invite | Different: half sheet, "pot" wording, no identity. |
| 47, 48 opening, review | Different form; no review step; not reachable after setup. |
| 53 invite error | Partly: more specific causes, no reassurance and no "Return". |
| 54 empty Home, 45 Settings | Missing "Already owe each other money?" and "Opening balance". |

- **Why it matters:** `DESIGN.md` says the canvas is a visual specification and drift was already observed once.
- **Fix:** Use findings 1, 2, 5, 6, 8, 11, 12 and 16 as the work list to close the gaps; treat the table as the checklist when re-comparing captures.
- **Effort:** (see individual findings). **Confidence:** design frames viewed, native verified in code only.

## Ground-up rethink

**1. One screen to a home ("Who's home?").** After Welcome the user sees a single screen: their name at the top, a list where each housemate is a row they type into, and the return key adds the next row. If there are three or more people, a small line appears under the list: "Does anyone share money? Tap two names." Currency and household name are not asked about up front; the last line of the screen reads "Our place · € Euro (fixed once created)" and the primary button says "Create Our place in EUR", which is the explicit confirmation of the currency. Two flatmates reach Home in 3 taps; a household with a couple needs one extra tap and never reads the phrase "budget group".

**2. Invite first, expense while they install.** Right after creating the home, empty Home shows two equal rows: "Add your first expense" with the orb, and "Invite Sam" with Sam's avatar. Tapping Invite runs Sign in with Apple and opens the system share sheet directly with a person-specific message. The owner then logs the first expense on their own phone while Sam is installing. When Sam claims the invite, the owner's Home shows a short "Sam joined" moment, and Sam's first screen is "Come on in, Sam", then a Home that already contains the first expense. This turns the 3-5 minute install wait into useful time and makes "the other flatmate sees it" an event the owner can watch.

**3. Couples in plain words.** When a person is added and there are already other people, a segmented control appears on their row: "Flatmate" or "Shares money with [name]". Once chosen, the row shows the group label ("You + Sam") and the two avatars link visually. Nothing named "budget group" or "balance group" is shown. The first expense then opens with the one-time confirmation from finding 4, "Who shares money is fixed after this", so the lock has a visible commit moment instead of a footnote.

**4. "From the spreadsheet" as a sentence.** On empty Home and in Settings a quiet row says "Already owe each other money?". It opens a sheet with one sentence the user fills in: "[Alex + Jo] owe [You + Sam] [€ 84.00]", a swap button and a single line "This isn't a purchase or a payment." For a home with existing records, the review from frame 48 shows current balance, amount to add and the resulting debt before recording. No pairwise bookkeeping UI for the common two-group case.

**5. Returning and double-home safety.** Welcome gets a quiet "Sign in" next to "I have an invite" for people on a new phone. Any invite link tapped while the device holds a household with records first shows what will happen to it ("You have Sam's place with 12 expenses. Join Our place [Replace on this screen] [Keep mine]"). Both paths end in the same Home, and neither can lose records silently.

## Quick wins

1. Replace every user-facing "pot" with "home" (Join sheet first, then People, Settings, errors, web invite page); delete the 5 stale xcstrings keys.
2. Add "Already owe each other money?" to empty Home and "Opening balance" to Settings, opening the existing form as a sheet.
3. Skip the groups explanation for exactly two people and fix the "split between these two groups, not 2 people" copy (`OnboardingViews.swift:573`).
4. Show a one-time "who shares money is fixed after this" confirmation before the first-ever saved expense.
5. Guard `handleOpenURL`: if the local household has records, show a replace-or-keep choice before the Apple button; otherwise join silently and drop the "Pot joined / Open pot" step.
