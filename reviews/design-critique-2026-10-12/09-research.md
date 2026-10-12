# 09 Competitive and creative research

Researcher: subagent 09. Date of research: 2026-10-12. No repo file was edited.

## Verdict

The shared-expense category is weak in three places: monetisation friction (Splitwise's free-tier daily cap and ads), distrust of the numbers (silent edits, lost trips, sync that drops entries), and trip-shaped thinking (nobody models a couple as one unit, nobody explains the arithmetic). Numa Shared's approved direction already answers all three on paper: group-owned balances, a "why" screen, append-only history, no ads or caps, local-first saves. Where it is behind is speed. The native add flow needs 4 non-digit taps (orb, "Who paid?", payer row, "Save expense") against an estimated 2 to 3 for rivals, and it forces a payer pick even though the model already defaults one. The only other native iOS 26 peer, Spliit 2.0 (released 3 Sept 2026), is converging on the same craft cues (save haptic, money typeface, friendly empty states), so "native and pretty" will not stay a moat. The best creative upside is one tactile vocabulary (haptics, optional sound), one continuity rule ("fly, don't teleport"), and one ritual moment (the household going all square), with novelty kept on Home and the orb and out of the arithmetic screens.

## Evidence limits (read first)

- **Reddit was not reachable.** The search tool blocks reddit.com and old.reddit.com, so there are no Reddit links. Complaint themes come from Trustpilot, App Store and Play reviews, a Hacker News thread, and press. Trustpilot's Splitwise page says the company has not invited reviews, so it skews negative. App Store pages showed only a small sample of reviews each.
- **Tap counts are estimates.** I could not run any rival app. Competitor counts are built from documented flows (help pages, store text, guides) and counted as taps after the app is open, excluding keystrokes. Numa's count is "verified in code" for the native flow and "design frame only" for the canvas.
- **Vendor and competitor sources are flagged** (Kittysplit, SplitterUp, SPLIIT Pro, Coupl, Dolio, HippoSplit). Their claims about rivals are marked as such.
- **Some design-company claims are second-hand** (marked "third-party" or "search summary only") where the primary page could not be fetched.
- I did not use Bevel. I found no sourced design detail for it beyond a long onboarding teardown, so I left it out rather than invent.

---

## 1. Competitor comparison

Numa row first, for reference. "Est." means estimated from documented flow, not measured.

| App | Taps to add an equal-split expense | How the balance is shown | How "settle up" works | Groups and couples | Top complaints (evidence) |
|---|---|---|---|---|---|
| **Numa Shared** (native code and canvas) | Native: **4** non-digit taps (orb, "Who paid?", tap payer row, "Save expense") plus digits. Canvas: 5 (adds a separate split step, frames 24, 25, 28). Verified in code (`BudgetGroupExpenseFlow.swift`) and design frames | One sentence plus one huge number ("You + Sam owe Alex + Jo €84"), "why" screen lists contributing expenses (frames 09, 10) | Records a repayment made elsewhere. Single-debt case skips the plan screen and pre-fills the exact debt (`AppModel.swift` ~4630), so about 2 taps. "Money changes hands outside Numa." | Budget group = one person or a couple; the group, not the person, owns the balance. 50/50 between groups by default ("Not €24 per person", frame 25) | Not shipped. Own risks: forced payer step, keypad without feedback, draft lost on close (findings below) |
| **Splitwise** | Est. 3 plus typing: open group, "+", description and amount, optional payer/split row, save [SW5]. Free tier adds a daily cap and, per one reviewer, a 10-second countdown [SW1] | Home shows three figures: you owe, you are owed, overall net [SW3]. Group page lists who owes what | "Settle up" records a payment made outside, or pays via Venmo/PayPal/Splitwise Pay in supported countries. Deleting a cash record restores the balance; deleting a Venmo/PayPal record does not cancel the transfer [SW4]. "Simplify debts" reduces payment count [SW6] | Individuals in groups. Split types include "share" [SW2]; no native couple unit found in any source (couples use shares as a workaround, inferred). Placeholder friends cannot see the group until they register (Dolio, competitor, citing Splitwise KB) | Daily cap of about 2 to 4 entries, ads, paywall; no draft when you leave the app mid-expense; in-app payment problems; expenses editable or deletable by members without warning; "don't trust the balance reconciliations", exported to a spreadsheet [SW1][SW2]. Trustpilot 2.0 from 72 reviews; App Store 4.0 from 29K |
| **Tricount (bunq)** | Est. 3 plus typing: open tricount, "+", title and amount; you are proposed as payer each time [TR1]; save | Two totals at the bottom: "My Total" and "Expenses total"; reimbursements excluded [TR1] | App proposes transfers that minimise payment count; in-app payment requests; bunq payment import [TR1][TR2]. A reviewer asks for partial "Mark as paid" [TR2] | One shared "tricount" joined by link; you identify yourself on first join [TR1]. No couple concept found | Update wiped a trip's data (Oct 2024 review; developer said it was never uploaded); no CSV or overview ("a dealbreaker", Aug 2025); no search; no recurring; default participants [TR2]. Sync drops or reshuffles entries (Play review) [TR3]. Premium export, custom splits and web version removed after the bunq takeover [TR4]. App Store 4.9 from 7.4K |
| **Settle Up** | Est. 3 plus typing. A reviewer: "Settle up by far has the fastest expense adding framework" [SU1] | Who-owes-who overview; non-installers can view balances via a browser link [SU1] | Settlement algorithm minimises transfers; reminders and notifications [SU1] | Members with weights; a reviewer gives a couple weight 2 and singles weight 1 [SU1]. Closest rival to a couple model, but it is a number the user must remember | Ads in the free tier; "looks a little dated"; fixes for crashes and empty screens after login; privacy label says identifiers may track users across apps [SU1]. App Store 4.8 from 1.8K |
| **Splid** | Est. 2 to 3 plus typing: orange "+", amount, who paid, how to split [SP3] | "Who owes how much to whom"; reviewer: "you could see at a glance who paid for what" [SP1][SP2] | Shows the easiest way to settle (fewest payments); PDF/Excel summaries [SP1] | Names only, no accounts; offline groups, optional sync; split among only some members [SP1][SP2] | Ads ("I hate ads"), a paid tier for more features, missing options such as dates and dual-currency display; one old report of an entry limit [SP2]. App Store 4.9 from 4.1K |
| **Spliit** (web, MIT; native iOS 2.0 since 3 Sept 2026) | Est. 3 to 4 plus typing: open group, add expense, title, amount, paid by, paid for, save | Web: group balances. iOS: leads with your own balance once you pick who you are; totals tab [SL1][SL2] | Group balances and "create reimbursement expense" [SL1] | Shareable group, no account. iOS app needs iOS 26, EN/FR only, no recurring, CSV export or saved split defaults yet [SL2] | HN 2022: rounding off by one cent, a 500 error on large amounts, wanted "select all" for paid-for [SL3] |
| **Kittysplit** | Not verified | "Who owes whom, fewest transactions" (vendor) [KS1] | Same | One link; anyone with it can add; names only; free to 9 people, about €3 one-off per Kitty (vendor) [KS1] | No independent reviews found |
| **Honeydue** (couples, bank-linked) | n/a: imports bank transactions, then you split | Shared dashboard, per-account visibility (all / balances only / hidden) [HD1] | No settle flow described | Two partners, linked accounts | Bank sync (Plaid) failures and lag, slow support, ads with no removal [HD1]. Reviewer site, not user reviews |
| **Venmo Groups** | Not verified: "any member can add an expense" [VG1][VG2] | Not described in sources | Settle "in a few taps" (moves money) [VG1] | Ongoing groups under Me > Groups; every member needs Venmo (inferred) | No independent complaint source found. Weakest evidence row |
| **Apple Cash Split Bill** (iOS, US only) | About 6 to 7 documented steps: Messages "+", Apple Cash, Split Bill, scan or pick, Request, choose people, Send [AC1] | Wallet "Requests" shows who has paid; requests last up to 30 days or until "Mark as Complete" [AC1] | Recipient taps "Pay [Name]" and confirms with Face ID | Ad hoc per conversation | Not a ledger; US only; receipt scan needs Apple Intelligence [AC1] |
| **Tab** (bring10) | One-off dinners: photo of receipt, friends claim items in the app | Per-person items, tax/tip proportional | Venmo (2017 review) | Per bill | Not a household tool. 4.22 from 1.1K (aggregator) [TB1] |

Newcomers worth knowing (all vendor-sourced, treat claims as unverified): **SplitterUp** (launched 2026; claims households, "a couple can be treated as one unit", retroactive re-split, QR live bills; 23 App Store ratings) and **SPLIIT Pro** (native app with receipt scanning) are marketing pages of the makers. **Coupl** takes a shared-wallet route for couples (nothing to settle) and argues Splitwise is built for groups, not couples. **Medici** and **Divvy.club** are small open-source or Show HN projects; Medici's author cites Splitwise's daily cap as the reason it exists [HN 44612306].

### Sources for the table

- [SW1] Trustpilot, Splitwise: https://www.trustpilot.com/review/splitwise.com
- [SW2] App Store listing and reviews: https://apps.apple.com/us/app/splitwise/id458023433 and https://apps.apple.com/us/app/splitwise/id458023433?see-all=reviews
- [SW3] Pratt design critique (2023): https://ixd.prattsi.org/2023/02/design-critique-splitwise-ios-app-2/
- [SW4] Splitwise KB on undoing a settle up: https://kb.splitwise.com/balances-and-expenses/i-accidentally-settled-up-how-can-i-undo-this
- [SW5] TapSmart flow guide: https://www.tapsmart.com/tips-and-tricks/shared-bills-splitwise
- [SW6] HippoSplit review (comparison site, secondary): https://hipposplit.com/blog/splitwise-review/
- [TR1] Tricount FAQ: https://help.tricount.com/articles/tricount-faqs
- [TR2] Tricount App Store: https://apps.apple.com/us/app/tricount-split-settle-bills/id349866256 and `?see-all=reviews`
- [TR3] Play listing (sync complaint, from search summary): https://play.google.com/store/apps/details?id=com.tribab.tricount.android&hl=en_GB
- [TR4] bunq community FAQ on dropped Premium features (search summary only): https://together.bunq.com/d/59049-tricount-faqs
- [SU1] Settle Up App Store: https://apps.apple.com/us/app/settle-up-group-expenses/id737534985
- [SP1] Splid App Store: https://apps.apple.com/us/app/splid-split-group-bills/id991473495
- [SP2] Splid reviews: https://apps.apple.com/us/app/splid-split-group-bills/id991473495?see-all=reviews&platform=iphone
- [SP3] WhistleOut review: https://www.whistleout.com/CellPhones/Apps/splid-app-for-splitting-group-expenses
- [SL1] Spliit repo: https://github.com/spliit-app/spliit
- [SL2] Spliit iOS 2.0 post: https://spliit.app/blog/spliit-for-iphone-has-been-rewritten-from-scratch
- [SL3] Show HN thread: https://news.ycombinator.com/item?id=31863691
- [KS1] Kittysplit (vendor page): https://www.kittysplit.com/en/splitwise-alternative
- [HD1] Honeydue review: https://www.fincomparelab.com/reviews/honeydue-review/
- [VG1] https://www.fox26houston.com/news/venmo-groups-splitwise-alternative-bill-calculator  [VG2] https://www.paymentsjournal.com/venmo-launches-venmo-groups-to-split-common-expenses
- [AC1] Apple Support, Split the bill with Apple Cash: https://support.apple.com/en-gb/127565
- [TB1] https://appgoblin.info/apps/595068606
- Vendor pages: SplitterUp https://splitterup.app/blog/best-expense-splitting-apps, SPLIIT Pro https://spliit.pro/blog/best-splitwise-alternative-2026/, Coupl https://coupl.money/blog/coupl-vs-splitwise-couples-india, Dolio (competitor, source-checked list) https://dolio.org/compare/splitwise-alternatives, Medici https://news.ycombinator.com/item?id=44612306

### What the table says

1. The most repeated complaint across sources is money friction on the free tier (Splitwise cap and ads), then trust in the numbers (silent edits, lost data, sync). Neither is a design-system problem; both are Numa's existing strengths if they are kept visible.
2. No rival gives a couple a first-class identity. Splitwise and Settle Up make the user simulate it with shares or weights. Numa's "50% each, because you share two budgets. Not €24 per person." (frame 25) is unique copy in this category.
3. "Fewest payments" and "simplify debts" are standard in rivals. Numa's core already has a fewest-transfer planner (`Models.swift:499`, `LedgerTests.swift:46`), which matters once a household has 3 or 4 groups.
4. Rivals that remove sign-up (Splid, Kittysplit, Spliit) sell it as their main benefit. Numa's SIWA and invites are an owner decision, but pending identities (CONTEXT.md) let one person run the house from day one. Splitwise placeholders cannot see the group.

---

## 2. Findings: ideas worth stealing or adapting for Numa Shared

Each finding names the source app, what it does, what Numa has today, and how it would look in Numa within the contracts (no banks, FX, recurring, widgets/App Intents, analytics, Contacts; tap equivalent for every gesture; Reduce Motion, Reduce Transparency, VoiceOver).

### 1. Default the payer and put Save on the entry screen
- **Severity:** S2. **Challenges a decision** (the explicit payer step; the owner wants actual payer vs recorder made explicit, which the receipt can still do).
- **Source:** Tricount proposes the person you identified as yourself as payer each time [TR1]. A Settle Up reviewer calls its flow "the fastest expense adding framework" [SU1]. Splitwise puts payer and split behind one optional row [SW5].
- **Evidence in Numa:** `BudgetGroupExpenseFlow.swift:14` `@State private var chosePayer = false`; line 103 Save is `enabled: chosePayer && ...`; the payer page (frame 24-payer) is a full screen. Yet `AppModel.swift:3753-3754` (`beginAdd`) already sets `expensePayer = currentUnitID` and `expensePayerMemberID = currentMemberID`. A default exists in the model and the UI throws it away. Canvas flow adds a further split page (22, 24, 25, 28).
- **Why it matters:** The most common action costs one to two more taps and two more screens than any rival, and the app is judged on that action.
- **Fix:** Entry screen becomes the whole expense: description, big amount, keypad, and one sentence row under the amount, "You paid · Equally between You + Sam and Alex + Jo", with two tappable chips. Tapping "You paid" opens the existing payer list as a bottom sheet (the "Sam paid. You're writing it down." explainer from frame 24 moves into that sheet and onto the receipt). Tapping "Equally" opens Exact amounts / For one group (frames 26, 27). Save sits in the bottom pill. Common case = orb, digits, Save. The review receipt (frame 28) remains available as a one-tap "Review" disclosure, and always appears on the Expense detail afterwards. A recorded-for-someone-else case still reads "Sam paid · Added by you".
- **Effort:** M. **Confidence:** verified in code (flow and defaults); competitor taps are estimates.

### 2. Show the consequence live, while the amount is typed
- **Severity:** S3.
- **Source:** Apple Cash Split Bill adjusts each person's share live as items change [AC1]. Family animates the digits and commas as the user types an amount, to add delight on a frequent screen without distracting [benji.org/family-values: https://benji.org/family-values].
- **Evidence in Numa:** The "After saving, You + Sam owe Alex + Jo €36." line exists only on the review step (frame 28; `AppModel.swift:3937-3940`) and the "Your group gets €48 back" box on frame 25.
- **Why it matters:** The reassurance that the entry does what the user expects arrives after the work is done, and a typo in "96" vs "69" only shows up at review.
- **Fix:** Under the keypad's amount, a quiet one-line preview that updates per digit: "Then: You + Sam owe Alex + Jo €36" (monospaced digits, rolling numeric transition, cross-fade under Reduce Motion). It uses the default payer and split from finding 1 and flips to "Then: all square" when relevant. Hidden from VoiceOver as a live region; announce only on the Save button label ("Save €96.00. You + Sam will owe €36").
- **Effort:** S to M. **Confidence:** design only.

### 3. Description chips from the household's own history
- **Severity:** S2.
- **Source:** Tricount's site describes starting the add flow by choosing an expense type (tickets, food, fuel, shopping) [https://tricount.com/en-us, via search summary]. Spliit's own iOS post lists "saved split defaults" as still missing [SL2]. A Tricount reviewer asks for default participants preselected [TR2].
- **Evidence in Numa:** The entry screen has a free-text "Description · optional" field (`BudgetGroupExpenseFlow.swift:42-43`) and no suggestion. A `category` exists in the model (`AppModel.swift:3751`, saved as "Uncategorized") but the flow never sets it.
- **Why it matters:** Flats repeat themselves (internet, groceries, dinner). Typing "Internet" each time is the slowest part of the flow after the digits.
- **Fix:** One row of up to 4 chips above the keypad: the household's most recent distinct descriptions, e.g. "Groceries · Internet · Dinner together". Tapping a chip fills the description and, as a suggestion shown in the sentence row, the payer and split last used with that description (always visible, always editable). This is local autocomplete from the ledger, not AI bookkeeping, and creates nothing by itself, so it stays clear of the recurring-expense exclusion. Orb, chip, digits, Save.
- **Effort:** M. **Confidence:** inferred.

### 4. Make the keypad feel physical (haptic and optional sound ladder)
- **Severity:** S3.
- **Source:** Not Boring's apps play one of about a dozen slightly different click sounds per tap, "No button ever sounds exactly the same" [RevenueCat interview: https://www.revenuecat.com/blog/growth/andy-allen-not-boring-software-launched-podcast-2026]. Duolingo treats haptics as a composed element blended with sound (third-party, LinkedIn "Inside Design Studio" post, via search summary). Spliit 2.0 adds a haptic buzz confirming an expense was saved [SL2].
- **Evidence in Numa:** `ExpenseFlowKeypad` (`BudgetGroupExpenseFlow.swift:414-431`) uses `.buttonStyle(.plain)` and calls `action(key)` with no haptic and no press state. The `Haptics` enum (`Components.swift:235-249`) has `activated`, `holdFired`, `locked`, `saved`, `warned` and nothing for keys. No sound code exists (grep for AVAudio finds none). `holdFired()` has no caller and `locked()` has one (`AppModel.swift:3092`), both leftovers of the earlier orbit interaction.
- **Why it matters:** The digits are tapped several times per expense and give no feedback, while the orb, tapped once, gets a haptic.
- **Fix:** (a) Light rigid impact at low intensity per digit, via `.sensoryFeedback`, plus a pressed state (a soft disc behind the numeral, 100 ms). (b) A small haptic vocabulary: key tick, orb press (soft), saved (success, exists), settled (two-beat pattern, see finding 8), warning. (c) Optional: a short "glass tick" sound set for save and settle only, off when the ringer switch is off (do not copy Not Boring's play-through-silent behaviour), with a Settings toggle. Remove `holdFired()` and re-check `locked()`.
- **Effort:** S (haptics), M (sound). **Confidence:** verified in code.

### 5. Fly, don't teleport: one amount and one button across the steps
- **Severity:** S3 (only if the multi-step flow survives finding 1).
- **Source:** Family (wallet) states "We fly instead of teleport", keeps persistent elements consistent across screens, and morphs button labels rather than swapping them ("Continue" becomes "Confirm" by animating shared letters) [https://benji.org/family-values]. Things pops a tapped task into a card while the rest of the list fades [MacStories review: https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/].
- **Evidence in Numa:** Each step of the flow is a `NavigationStack` push that re-renders its own `ExpenseFlowAmount` (`BudgetGroupExpenseFlow.swift:57, 113`). Frames 22, 24, 28 show the amount at different sizes and positions with no stated continuity.
- **Why it matters:** The big typographic amount is the product's hero object; letting it travel makes the flow read as one act and costs no time.
- **Fix:** `matchedGeometryEffect` on the amount from keypad (22) to receipt (28) and on to the saved screen (31); the bottom pill's label morphs "Who paid? →" to "Save expense →". 220 ms spring, interruptible, cross-fade only under Reduce Motion. Never delays Save.
- **Effort:** M. **Confidence:** design only.

### 6. Do not lose the draft
- **Severity:** S2.
- **Source:** A Splitwise App Store reviewer: switching to another app mid-expense closes the expense and there is no way to save a draft [SW2].
- **Evidence in Numa:** `beginAdd` zeroes amount, description and splits every time (`AppModel.swift:3746-3766`); `closeAdd` (X button, `BudgetGroupExpenseFlow.swift:291`) dismisses with no confirmation. State is in memory only, so an app kill also loses it.
- **Why it matters:** Typing a 40-character description and amount, then hitting X by accident or taking a call, loses the work. It is the kind of small surprise that makes an app feel flimsy.
- **Fix:** Keep the draft until it is saved or explicitly discarded. Closing with a non-empty draft shows a two-button confirm ("Keep draft" / "Discard"), and Home shows a quiet row "Unfinished: Dinner together · €96.00 · Continue" in place of nothing. Persist locally so it survives relaunch. Nothing enters the ledger until Save (append-only contract intact).
- **Effort:** M. **Confidence:** verified in code.

### 7. Make "all square" the one celebration, and make it unmistakable
- **Severity:** S3.
- **Source:** Family's "Delight-Impact Curve": delight matters most in rarely used moments, and "mastering delight is mastering selective emphasis" (confetti after a wallet backup, a ripple on the QR screen) [https://benji.org/family-values]. (Not Boring) Habits turns "routine into ritual" with a checkbox that explodes with custom sound and haptics [Apple, Behind the Design: https://developer.apple.com/news/?id=9ab1g4r3]. Duolingo started its Rive animation work on reward moments such as a chest shaking and gems jumping out [Rive: https://rive.app/blog/creative-technologists-duolingo-s-solution-to-the-designer-to-developer-handoff].
- **Evidence in Numa:** The settled state is already designed (frame 55-settled: "All square. Go enjoy the day.") and the Home copy exists (`HomeView.swift:112`). `Components.swift:339-340` says the Add orb stays orange in every financial state. `VesselOrb.metal` contains a one-shot "gleam band" meant to sweep after a record persists (`VesselOrb.metal:47, 98-100`), but no Swift file references `vesselOrb` and `VesselView.pulseDate` is never passed (grep), so the hook is unwired.
- **Why it matters:** Reaching zero is the only moment in a household ledger that feels like a win, and it is also the rarest. Saving every expense with fanfare would be noise; this one deserves it.
- **Fix:** When a repayment brings the balance to exactly zero, play one sequence: panel colour change over about 500 ms, the orb's gleam sweeps once, a two-beat success haptic, and (if enabled) one soft sound. Never on ordinary saves. Reduce Motion: instant colour change, haptic only. Wire the existing shader or replace it with a SwiftUI gradient sweep; do not ship an unreferenced `.metal` file.
- **Effort:** S to M. **Confidence:** verified in code (hook unused); design only for the sequence.

### 8. Give Home real states, and stop colliding with group colours
- **Severity:** S3.
- **Source:** Flighty, Apple Design Award for Interaction in 2023 [https://www.apple.com/newsroom/2023/06/apple-announces-winners-of-the-2023-apple-design-awards/], is analysed by a third party as having 15 context-aware states by trip phase, each showing different content [https://blakecrosley.com/guides/design/flighty] (third-party analysis, not Flighty documentation).
- **Evidence in Numa:** Frames 09 (owing), 54 (empty), 55 (settled), 56 (offline, "Saved on this iPhone · 1 pending") show the idea but the transitions and rules are unspecified. In 54-empty the citrus panel carries the "You + Sam" avatar row, and the citrus "Y" disc vanishes into the citrus background (design frame only). DESIGN.md says citrus and lilac identify budget groups.
- **Why it matters:** A flatmate in the lilac group sees the whole panel in someone else's colour when the house is square, and the "You + Sam" group loses its disc on the same screen.
- **Fix:** Write a state table for Home (empty, owe, owed, all square, unsynced, sync error, a flatmate not joined) with one headline, one hero object and one primary action each. Reserve one non-group, non-direction colour for state-level surfaces such as all-square (a distinct green or a paper tone with the settled orb), so group hues only ever mean people. Animate between states with the same spring as finding 5.
- **Effort:** M. **Confidence:** design only.

### 9. Direction-aware repayment verbs
- **Severity:** S3.
- **Source:** Apple Cash splits the verbs: "Request" and "Pay [Name]", with "Mark as Complete" for the requester [AC1]. Splitwise's guide says "Once someone has paid you, tap Settle up and confirm" [SW5], one neutral button for both sides.
- **Evidence in Numa:** The Home chip always says "Record a repayment" (`HomeView.swift:295`), whether you owe or are owed. Frame 35's "From this group / To this group" handles both, but the entry label does not tell the creditor which of the two they are doing.
- **Why it matters:** A creditor who got paid in cash should read "Alex + Jo paid us back" and not decode who the "repayment" is from.
- **Fix:** When you owe: "I paid them back". When you are owed: "They paid us back". Same event, same sheet, only the pre-filled from/to and heading differ. Keep "Record a repayment" as the accessibility label.
- **Effort:** S. **Confidence:** inferred.

### 10. "Say it in Messages" from the receipt and the balance
- **Severity:** S3.
- **Source:** Apple Cash and Venmo put the request where the conversation already is (Messages) [AC1]. Splid sends PDF summaries by text or WhatsApp [SP1]. Partiful lets hosts share to any channel without requiring guests to have the app [Pratt critique: https://ixd.prattsi.org/2025/02/design-critique-partiful/].
- **Evidence in Numa:** Pushes are amount-free by design. Sharing exists only for invite links (`PeopleManagementView.swift:410`), support text (`SheetViews.swift:281`) and CSV export (`SettingsView.swift:391`); no share action on the balance or saved screens (verified by grep).
- **Why it matters:** The owner wants an app people recommend to friends. A flatmate who has not joined yet needs a sentence from a human, not a push.
- **Fix:** A `ShareLink` with plain text: "Numa says we still owe you €36 for September. Nothing to pay in the app, it just keeps the count." on the balance screen and on the saved screen, with the invite link when the person is pending. User-initiated, no Contacts access, no money moved, no reminders feature. PDF statements remain excluded.
- **Effort:** S. **Confidence:** verified in code for the gap; the benefit is inferred.

### 11. Keep novelty on Home and the orb; keep arithmetic conventional
- **Severity:** S3 (a rule, not a feature).
- **Source:** Arc's maker later reframed the browser around simplicity; press described Arc's problem as "complexity, novelty, and incremental approach" that "made it a tough sell for the mainstream" [The Register: https://www.theregister.com/2025/05/27/arc_browser_development_ends/]. (Not Boring) Habits: "We didn't have to rethink how a button or a popover works", while the checkbox is theatrical [Apple: https://developer.apple.com/news/?id=9ab1g4r3].
- **Evidence in Numa:** DESIGN.md already says "Expression belongs to Home, onboarding and the tactile add orb. Arithmetic, recovery and consequential actions are quieter." This confirms it.
- **Why it matters:** The risk is drift: once the orb and Home are delightful, every screen asks for flourish.
- **Fix:** Add a one-line review gate to DESIGN.md: any new animation or sound must name which of three moments it serves (add, saved, settled). Everything else stays system-standard.
- **Effort:** S. **Confidence:** inferred.

---

## 3. What would make Numa clearly the best-feeling app for 2 to 4 flatmates

Ordered by weight. Each tied to evidence above.

1. **Be the fastest to log.** Target: orb, digits, Save, with payer and split defaulted and editable in place, plus description chips. That beats every rival's estimated 3 taps and turns "I'll get this" into five seconds. Today's native flow is 4 non-digit taps (finding 1).
2. **Be the app whose numbers nobody doubts.** The loudest trust complaints are about silent edits, expenses members can delete without warning, balances people re-check in a spreadsheet, and a trip lost to an update (Splitwise Trustpilot, Tricount App Store). Numa's append-only history, visible corrections, "What makes up €84" and "Saved on this iPhone. It will appear for your household after sync." (frame 31) answer all of it. Say so in the product: one line in onboarding and Settings, "Nothing disappears: corrections stay visible."
3. **Treat a couple as one household member.** No rival has a native couple unit. Splitwise and Settle Up require shares or weights the user must reason about. Numa should show the group, not the people, in every sentence, and keep the "50% each, not €24 per person" explanation in the product.
4. **Stay free of friction.** Splitwise's daily cap and ads are the single most repeated complaint. When pricing comes ("Pricing follows household feedback", PRODUCT.md), the research suggests one payer per household rather than per person (Kittysplit's one-off per group, Settle Up's group premium, versus Splitwise's per-user Pro) and no cap on entries. Input for later, not a recommendation to build now.
5. **One ritual and one tactile language.** Rivals are quiet utilities. A single "all square" moment, a consistent haptic and optional sound set, and a travelling amount make Numa memorable without touching the arithmetic (findings 4, 5, 7).
6. **Make flatmate number two painless.** One person can set up and record for everyone through pending identities; Splitwise placeholders cannot see the group. Lead the onboarding copy with that, and add the "Say it in Messages" sentence (finding 10) for people who have not joined.
7. **Do not chase features.** FX, receipts, recurring, bank sync are where rivals compete (and where Honeydue's bank sync, Tricount's sync and Splitwise's paywall hurt). The contracts exclude them; the research says that is the right place to be thin.
8. **Match Spliit 2.0 on craft cues now.** It already ships a save haptic, a money typeface, initials-and-colour people, category glyphs and friendly empty states, in SwiftUI for iOS 26, free and open source [SL2]. Numa's edge must be the household model, the trust story and the orb.

Honest gaps against rivals, to accept on purpose: no web or link view for people without the app (Settle Up and Kittysplit have it; this follows from SIWA and invites), no photo attachment on expenses (Tricount, Settle Up Premium), no per-expense currency (excluded).

---

## 4. Signature design-system ideas from distinctive apps

| Idea | Source | What it is there | Translation for Numa Shared |
|---|---|---|---|
| **Material rule: one glossy object** | Airbnb 2025: tiny 3D objects that react on tap (the house opens its door and lights a porch lamp, the bell rattles, per Bloomberg via search summary; Airbnb describes a "dimensional and beautifully animated interface") [https://news.airbnb.com/airbnb-2025-summer-release/] | Everything else is flat, one set of objects has volume and moves once | Paper, ink and thin rules for money; the orb is the only glossy, volumetric thing. It appears as the same sphere in three states: add (orange plus), saved (one gleam), all square (green check, frame 55). Gloss means "this writes to the ledger". Keep it to those three |
| **Shape grammar** | Duolingo: bespoke rounded type (Feather Bold, https://creativebloq.com/news/feather-bold) and a friendly shape language (card and button radii and a chunky button edge, from a third-party reverse-engineered summary, not an official spec: https://opendesigner.io/design-systems/duolingo) | Rounded everything, one recognisable "button feel" | Circles are people and states, pills are actions, hairline rules are money rows. Never box a money row. Already implied by DESIGN.md ("colored containers are earned by identity"); write it down as three rules |
| **Motion personality: "fly, don't teleport"** | Family: tab switches slide toward the tapped tab, shared elements persist, labels morph, trays stack at different heights [https://benji.org/family-values] | One continuity rule explains every transition | One spring for everything (fast, one overshoot only on the orb), interruptible, 120 ms press and 220 ms release already in DESIGN.md. Amount and CTA travel (finding 5). Reduce Motion: cross-fade |
| **Haptic score** | Duolingo (haptics composed with sound, third-party post); Not Boring (layered sound and haptics, "explosion" feel in Habits) [https://developer.apple.com/news/?id=9ab1g4r3] | Haptics are authored, not sprinkled | Five patterns: key tick, orb press, saved, all square (two beats), warning. Document them in DESIGN.md next to the 120/220 ms numbers |
| **Sound, sparingly** | Not Boring: about a dozen click variants so no two taps match [RevenueCat] | Texture through variation | Two sounds only, save and all square, a few pitch variants each, silent switch respected. Do not copy Not Boring's play-through-mute (an accessibility and etiquette risk) |
| **Delight-Impact Curve** | Family [https://benji.org/family-values] | Spend delight where use is rare | Rank Numa's moments by frequency: keypad (daily, quiet), save (daily, one haptic), repay (weekly, medium), all square (rare, full) |
| **State-adaptive hero** | Flighty (third-party analysis of 15 states) [https://blakecrosley.com/guides/design/flighty] | The main surface changes content with context | Home states table (finding 8). Same hero object, different headline and action |
| **Voice** | Numa already has it: "Written down. Sorted out.", "All square. Go enjoy the day.", "A home for the little 'I'll get this' moments." | Duolingo and Partiful have strong voices; Spliit leans on "friendly empty-state text" [SL2] | Make the verb set explicit: "written down" (record), "all square" (settled), "our place" (household), never "settlement", "pot", "unit". One page in DESIGN.md |
| **Calm native data screens** | Copilot Money (2024 Apple Design Award finalist): "all the data is kept locally, so the app is really responsive", "a native app makes a difference the moment you start interacting with it" [https://developer.apple.com/articles/copilot-money] | Fast local reads, restrained look | Numa is local-first already (`LedgerRepository`); keep every read local and every save instant ("Saved on this iPhone") |

---

## 5. Do not copy (conflicts with Numa's contracts or looks wrong for this product)

- **Long press to trigger the delight.** (Not Boring) Habits requires a longer-than-expected press, found through "thousands of iterations" [Apple]. DESIGN.md forbids a mandatory long press and hidden drag, and every gesture needs a tap equivalent.
- **Drag the Add control into a list slot** (Things' Magic Plus: drop it on Inbox, on a day in Upcoming, or between tasks [MacStories]). Delightful, but "hidden drag" and "drag-to-pay" are excluded in DESIGN.md. A tap path would make it redundant.
- **Daily caps, countdown timers before saving, ads between entries** (Splitwise free tier [SW1]).
- **Item-by-item receipt claiming, AI receipt scanning, currency conversion** (Tab, Apple Cash, SplitterUp, Spliit on-device scan). Out of release scope.
- **Bank-linked transaction feeds** (Honeydue). Its top complaint is sync failures [HD1], and banks are excluded.
- **Reminders and automatic payment nudges** (Settle Up [SU1]). Recurring reminders are excluded.
- **Tracking-style identifiers** (Settle Up's and Tricount's privacy labels list identifiers used to track users) [SU1][TR2]. Numa has no analytics; keep the privacy label clean as a selling point.

---

## Ground-up rethink

**A. The expense is one live receipt, not a four-step wizard.** The user taps the orb and sees one screen: a typographic receipt that fills in as they type. Top: description with history chips. Middle: the big amount and keypad. Under the amount: "You paid · Equally between You + Sam and Alex + Jo", each part a chip that opens a small sheet. Under that, one grey line that updates per digit: "Then: You + Sam owe Alex + Jo €36". Save is the bottom pill. The existing receipt layout (frame 28) becomes what the saved expense looks like in detail, not a required stop. Every rival is about 3 taps; this makes the real work (digits) the only effort.

**B. The orb is a character with exactly three moods.** Orange plus when it invites an expense, a single gleam when a record is saved, a green check sphere when the household is all square. It travels: tap the orb and it grows into the amount screen's background disc; on save it settles back into the Home row; on all square it turns green and the panel changes colour. One haptic score and an optional two-sound set go with it. The rest of the app stays Apple-standard and quiet. This gives Numa what Airbnb's icons, Duolingo's owl and Not Boring's checkbox give those products, a single recognisable thing that reacts, without a full-app mascot system.

**C. A household voice and a short phrasebook.** Treat copy as part of the design system: "written down", "all square", "our place", "who paid / who was it for", always with the group names, never with the units, pots or settlements of CONTEXT.md. Add one page to DESIGN.md and review every string against it. This is already the strongest differentiator in the frames, and it is not yet a rule.

**D. Start alone, invite by sentence.** One person sets up the house, adds the flatmates as pending identities, logs the first week, and shares a plain-language message with each person ("Numa says we owe you €36"). The rival pitch is "no account"; Numa's pitch is "you do not need anyone to join before it works", with the join step arriving when the flatmate is curious. This stays inside SIWA and person-specific invites.

---

## Quick wins (highest value per effort)

1. Pre-select the payer (`chosePayer` starts true, payer chip on the review step) and add Save to the review without the payer page: removes 1 to 2 taps. (Finding 1, M, or S if only the pre-selection is done.)
2. Add key haptics and a pressed state to `ExpenseFlowKeypad`; remove the unused `holdFired()` haptic. (Finding 4, S.)
3. Keep the add draft until Save or an explicit discard, with a confirm on X. (Finding 6, M.)
4. Make "I paid them back" / "They paid us back" the Home chip label by direction. (Finding 9, S.)
5. Wire or remove the unused orb gleam, and use it once when the balance reaches zero, with a two-beat success haptic. (Finding 7, S to M.)
