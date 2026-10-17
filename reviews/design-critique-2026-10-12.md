# Design critique, 12 October 2026

Source reviewed: `main` at `b508cf7`. Scope: the native SwiftUI app in `ios/NumaShared/NumaShared` and the approved 60-frame board in `design/interface-v2/`. Nothing in the app, backend or release configuration was changed by this review.

## Verdict

The approved shared-table look is good, but the app under it is not finished. Nine focused reviews logged 158 findings. The style holds on about six screens (Welcome, setup, Home, Add); the rest is stock iOS built from one-off values. The serious problems are not visual: sign-out can erase households the user was never warned about, Add hides the amount being typed when Hide amounts is on, a slightly late Undo reports a local-data failure, and VoiceOver never hears a save.

Recommended order: fix the trust problems, cut Add expense from three screens to one sheet, settle one vocabulary, build a small component foundation, then apply one design direction.

## Owner decisions needed

1. **Direction.** Four directions were mocked up (A Table, tightened; B Color is who; C The running tab; D Marbles). Recommendation: D, which turns the orb into the material of the whole app. Runner-up: B. The mockup canvas was shared with the owner privately.
2. **One-sheet Add.** Removes the separate "Who paid?" and Review screens shown on the approved board. Payer and split become editable words in one sentence ("You paid €12.40 for Groceries, split equally"), and the result is shown live above Save.
3. **Product calls.** Drop the three-item bar and move People into Settings. Keep void reasons required (`docs/CORE.md`) but offer one-tap reasons, or make them optional. Lengthen Undo to about 10 seconds for voids and repayments. Make Sign out lock local data instead of deleting it.

## Fix first: trust and data

"Checked" means the code was re-read for this summary. "Reported" means a reviewer found it in code and it was not re-read. "Inferred" needs a Simulator or device run.

| # | Problem | Where | Status | Fix | Size |
|---|---|---|---|---|---|
| 1 | Sign out and Delete account erase every local household; the warning counts unsynced records of the active one only. | `AppModel.swift:1434`, `:1731` | Checked | Name every household that will be erased; offer "Export first". Later, lock instead of delete. | M |
| 2 | With Hide amounts on, Add shows a masked amount while typing. | `AppModel.swift:910`, `BudgetGroupExpenseFlow.swift:57,113` | Checked | Entry and review use the unmasked value. | S |
| 3 | Undo tapped after its window shows a local-data failure. | `AppModel.swift:5015-5017` | Checked | "Already shared. Void it from Activity." Clear Undo on household switch. | S |
| 4 | Repayment titles are stored as a recorder-relative sentence ("X paid your household"), read backwards for others, go stale, and become redacted rows. | `AppModel.swift:4896-4909` | Checked | Store a constant, render from payer and receiver; keep legacy titles readable. | M |
| 5 | Home never says "you"; verbs are hard-coded plural ("Sam owe Leo"). | `HomeView.swift:110-119` | Checked | One balance-sentence helper for Home, chips, review and VoiceOver. | S |
| 6 | Three or more groups: Home says "X owe across the household" with no names. | `HomeView.swift:116-118` | Checked | Your position by name, then the plan to get everyone square. | M |
| 7 | No VoiceOver announcements anywhere (save, Undo, errors, typed amount). | whole app | Checked | Announce; Undo as a rotor action; amount updates frequently. | S |
| 8 | Opening balance can only be entered inside setup. | `OnboardingViews.swift:576` | Checked | "Already owe each other money?" on empty Home and in Settings. | S |
| 9 | Six whole digits max with no feedback; rent in VND or IDR cannot be entered. | `NumaSharedCore/.../MoneyInput.swift:39` | Checked | Cap by magnitude per currency; warning haptic. | S |
| 10 | Corrections and voids fold into one row; the "Corrections" filter matches attempt kinds. | `Models.swift:189`, `LedgerRepository.swift:1554` | Reported | Edited and Voided badges, struck old amount; filter matches them. | M |
| 11 | Any sync pause, including an expired sign-in, silently disables Add and Record repayment. | `canWrite` gating | Reported | Keep local writes; show the reason and fix on the control. | M |
| 12 | A failed save closes Add, discards the draft and says "Reload this pot". | `AppModel.swift:1042-1076` | Reported | Keep sheet and draft; say whether it saved; Retry. | M |
| 13 | An invite opened while a household exists has no guard and can strand it. | `handleOpenURL` | Inferred | Keep-or-switch choice before Sign in with Apple. | M |
| 14 | The first expense permanently fixes couples with no warning. | setup pairing | Reported | One-time confirmation before the first saved expense. | S |
| 15 | Seven independent presentation flags; links and pushes can open over Add or switch household under a draft. | `AppModel` sheet flags | Inferred | One `Modal` state plus a route queue; the draft lives with its sheet. | L |

## Speed

| Task | Today | Proposed |
|---|---|---|
| You paid €12.40 for groceries, split equally | 8 taps, 3 screens | 6 taps, 1 sheet (7 with a description chip) |
| Sam paid rent €1,240, 50/50 | 8 taps plus typing | 3 taps with a suggestion from the household's history |
| Restaurant, exact 60 / 36 | 13 touches incl. long-press and Select All | 8 taps |
| Partial repayment, €30 of €84 | 5 taps (typing 5, 0 after the prefill gives €8450) | 3 taps |
| Void an expense | 4 taps plus a typed reason | 3 taps |
| Fix a wrong repayment | about 9 taps, 3 events | 4 taps, same linked events |
| Install to first saved expense, two flatmates | about 10 taps, 3 fields | about 6 taps |

## One word per thing

| Concept | Today | Use |
|---|---|---|
| The shared place | pot (57), household (22), home (13) | The household's name; "household" as the noun |
| Person or couple with one balance | budget group, balance group, shared budget, budget, group, unit | "group" |
| Paying back | repayment, settle, settlement, transfer, Mark as paid, reversal | "repayment"; buttons carry the amount ("Record €84.00 repaid") |
| Something bought | expense, record, bill, purchase, charge | "expense" |
| People | member, identity, account, claim, friends | "person / people", "owner" |

## Design system findings (all counts re-checked)

- `Metrics.space*` is used 0 times against 294 `.padding(` calls; 29 `Color(hex:)` calls outside `Theme.swift`; 25 fixed `.system(size:)` fonts.
- Token names do not match values: `indigo` is `#52672B`, `teal` is `#D8EF7F`, `amber` is `#BBD8EA`.
- Three identity colors cycled with `% 3`, so a fourth group repeats the first.
- Dark Home panel `#3E3E28` is 1.5:1 against `#1C211E`; `Pal.destructive` is 2.55:1 on `#282F29`; white on `#E9522D` is 3.68:1.
- `VesselOrb.metal`, `FieldSpace.metal`, `FieldSpaceView.swift` and `ConstellationLayout.swift` have no callers.

Proposed foundation: role-named tokens, six tested group identities, a `MoneyText` component for every amount, one button family, rows and sheets, motion and haptic tokens, and a designed dark mode.

## Area reports

Unedited reviewer output with file and line evidence. Each finding is labelled verified in code, inferred or design only by its reviewer.

- [Home and balance](design-critique-2026-10-12/01-home.md)
- [Adding an expense](design-critique-2026-10-12/02-add-expense.md)
- [Repayments, history and corrections](design-critique-2026-10-12/03-repay-history.md)
- [First run, invites and people](design-critique-2026-10-12/04-onboarding.md)
- [Settings, sync and errors](design-critique-2026-10-12/05-settings-sync.md)
- [Design system](design-critique-2026-10-12/06-design-system.md)
- [Copy and accessibility](design-critique-2026-10-12/07-copy-a11y.md)
- [UI state bugs](design-critique-2026-10-12/08-state-bugs.md)
- [Competitors and ideas](design-critique-2026-10-12/09-research.md)

## Limits

- The native app was not built or run; the review environment had no Xcode or Simulator. Inferred items need a Simulator or device pass.
- Competitor tap counts are estimates from documented flows.
- Mockups use the board's synthetic fixture (You + Sam, Alex + Jo, €84). No household data, credentials or release records were read.
