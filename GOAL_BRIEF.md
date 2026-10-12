# Numa Shared private-beta brief

Updated September 12, 2026 from the owner interview. `PRODUCT.md` owns product
truth; `AGENTS.md` owns execution defaults; the selected existing Notion Work item owns current
implementation scope. This supersedes the old public-beta mission, not its
financial, privacy, accessibility or release safeguards.

## 1. Outcome and plan

A polished, free, English native iPhone beta for **iOS 26 and later**. People enter
purchases; one-person or couple budget groups own balances. Show who owes whom,
how much and why, and record repayments made elsewhere. Never move money.

The owner explicitly wants **fun, colorful and social**, not a serious, muted
finance aesthetic. Premium means exceptional native craft and interaction.

Issues ARS-111 through ARS-118 in the owner's private planning workspace hold
detailed acceptance and dependencies. Preserve useful existing code, not
obsolete prototype instructions. The October 1 assumption-audit repairs do not
establish full redesign acceptance or authorize production changes or distribution.

## 2. Definition of done

For the full beta, a ship report identifies source and evidence for:

1. The agreed group setup, equal/exact/paid-for-another expenses, group balances,
   explainable history and external repayment journey.
2. The owner-selected orb-led world implemented natively, with equivalent tap
   paths, accessible layouts and purposeful, interruptible motion.
3. Preserved local-first entry, SIWA/invites, offline recovery, corrections,
   export, erasure and account isolation.
4. Risk-appropriate independent review and the required full P5 matrix on a clean
   immutable candidate descended from `main`, including genuine iOS 26 proof and
   the established higher-runtime release coverage.
5. The named authorized Numa Shared deployment and synthetic production smoke,
   inspected signed artifact, matching uploaded/processed build and private access.
6. Intended-tester acceptance, installation and cold launch of that exact build
   on a physical iPhone, with applicable auth/sync/offline/privacy smoke.
7. Scoped commits pushed and one concise report linking proof and limitations.

Each issue is complete against its own acceptance. Source, local verification,
deployment, artifact, upload, Apple processing, access and installation are
separate milestones. Historical receipts prove no later candidate. Public
TestFlight, general App Store-draft work and submission are not this beta;
public release and final App Store submission remain human actions.

## 3. Preserved scope and exclusions

Reuse Swift 6 / SwiftUI, Foundation-only Core, GRDB/SQLite and dedicated Convex.
Accounts remain people; accounting units remain debt counterparties. Preserve
integer-money/replay invariants and existing data without bulk identity replacement.

Keep existing SIWA, person-specific invites/claims and ownership, offline outbox,
opening balances, expense repeat/edit/void/restore, repayment correction,
activity/detail, privacy, CSV, account deletion, amount-free English pushes,
minimum-version protection and support/settings. A redesign does not silently
remove these safeguards or require rebuilding working features.

Do not add bank accounts/transfers, bank integrations, subscriptions, spending
limits, AI bookkeeping, FX, recurring services/reminders, analytics infrastructure,
widgets, App Intents, Notification Service Extensions, PDF statements, new refund
kinds, Contacts access or a custom release domain. One currency is explicitly
confirmed per household and fixed; English UI still formats money by locale.
Separate debts inside a couple are out of scope.

## 4. Owner decision gates

- **Lifecycle, confirmed:** initial coupling before financial activity, then
  fixed groups. Defer merging/splitting financially active groups. Departure and
  erasure do not redistribute old debt; existing active singleton ledgers stay
  unchanged. The owner confirmed this rule on September 12.
- **Visual, confirmed:** the owner approved the complete 60-frame interface-v2
  shared-table direction with “I love it!” on September 12. `DESIGN.md` records
  the selected world. The rejected three-screen raster and earlier restrained
  directions are superseded. The approved canvas is not a native build.
- **Delivery audience, confirmed:** the owner receives this private beta; do not
  include other testers by assuming the existing Internal group is owner-only.
  Resolve the owner's existing TestFlight identity and verify the Numa Shared
  target before delivery. Release docs provide operations, not new data,
  credential, spend or wider-audience authority.

Continue independent scoped work while a dependent decision waits.

## 5. Cost and verification

### Owner-approved autonomy policy — September 12, 2026

The owner's latest instruction supersedes both the former numeric caps and the
90-minute issue window. Earlier counts and deadlines remain historical evidence,
not active stop conditions. No new paid action or wider distribution is implied.

- Complete authorized in-scope work autonomously through implementation, review,
  verification, scoped commit, push and deployment to the approved target. Keep
  one active builder per scoped issue.
- Select verification by risk, with one owner per check and a cumulative evidence
  ledger. Reuse evidence only after comparing affected source, dependencies and
  configuration. Change strategy after two equivalent failures; do not repeat
  ineffective attempts or weaken a check to manufacture success.
- Diagnose related findings together, correct coherently and review the stable
  full diff. Keep independent review for material money/auth/privacy/sync/signing
  changes. Render affected UI journeys and accessibility states; static source
  or design screenshots are not device evidence.
- Stop only the affected action for missing authorization, unsafe conditions or
  genuine external blockers. Continue independent authorized work. Do not request
  routine permission to continue. Preserve unrelated work and agreed scope.
- Existing named release authority applies. New spending, destructive/data or
  credential changes, expanded audiences and unresolved owner-only choices still
  require a decision. Never weaken privacy, security or release gates.

Run the required full `./scripts/phase-gate.sh P5` on the final clean immutable
candidate. Reuse valid checks and repeat only invalidated evidence or unresolved
failures, including the mandatory full matrix when executable inputs change as
required by `docs/REVIEW-GATE.md`. No extra owner confirmation is needed for a
required rerun. Reuse compatible dependencies, Simulators and DerivedData. No
unrequested image-variation loop or new concept approval round.

## 6. References and baseline

Durable contracts: `docs/CORE.md`, `docs/IDENTITY.md`, `docs/PERSISTENCE.md`,
`docs/CSV.md`, `docs/ACCOUNT-DELETION.md`, `docs/PRIVACY.md`, `docs/PUSH.md`.
Review/release safeguards: `docs/REVIEW-GATE.md`, `docs/RELEASE.md`.

Planning baseline: `dfa11eb561b7b84d1b99df92c3845e57df7bd690`, branch `v1-ship`;
P0–P4 baseline `4d3a46150030644002f8e36948892c8969d1325a`. The planning baseline declared
1.0 (8) and iOS 27; ARS-112 lowered the floor to iOS 26 in `6cbae7f`. Neither
source configuration nor compatibility checks are refreshed delivery evidence.
