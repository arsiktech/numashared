# Numa Shared

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

Flatmates sharing ongoing household costs. A budget group is one to six people
who pay as one (a single person, a couple, a family). People enter purchases;
their group owns the balance. Separate debts within a group are outside the
first release.

## Product Purpose

Show exactly which budget group owes another group, how much, and why. Replace
the household spreadsheet's expense and repayment workflow, not the bank.

## Operating Context

- Shared bills such as rent, internet, electricity, and water are commonly split
  50/50 between two groups, rather than equally between every individual.
- A group may pay for a purchase that benefits only another group.
- Restaurant purchases can allocate the amount actually owed by each group.
- People record repayments made elsewhere; Numa Shared never moves money.

## Capabilities and Constraints

- One expense flow records who paid and who benefited. Shared and personal
  expenses are split presets, not separate ledger systems.
- Payments, allocated shares, and recorded repayments determine group balances.
- Configure budget groups before financial activity. Once expenses are recorded, defer
  merging or splitting their budget groups. Departure and account erasure do not
  redistribute existing debts; historical group ownership stays intact.
- One currency is explicitly confirmed per household and then fixed. Foreign
  entry and conversion are outside this beta; money remains locale-formatted.
- Preserve exact integer-money accounting, visible corrections, idempotent
  replay, offline safety, account isolation, and existing data.
- Native SwiftUI, supporting iOS 26 and later; use the existing ledger/sync
  implementation where suitable. English is the only first-release language.
- First release: polished, free private beta delivered to the owner only. Pricing
  follows household feedback; no wider tester access is authorized here.
- No pooled-money account, bank connection, spending-limit planner, or subscription
  system in this release.
- The owner approved the 60-frame `design/interface-v2/` shared-table direction
  on September 12 with “I love it!”; `DESIGN.md` is the selected visual system.
  The rejected three-screen raster and earlier restrained concepts are superseded.
  Approval is of the design, not evidence of native implementation or delivery.

## Brand Commitments

The name is Numa Shared. A tactile sphere/orb is the signature interaction.
The owner explicitly wants a **fun, colorful, social** app: amazing to use and
something people want to recommend to friends. Premium means exceptional craft,
not a serious, muted financial aesthetic. Use vibrant group identities and
playful, purposeful interaction while making debt direction and amounts clear.
The initial restrained concept directions are superseded by this clarification;
they are not approved designs.

## Product Principles

1. Make the balance and its explanation obvious.
2. Make everyday entry quick; keep advanced splitting secondary.
3. Preserve trust through visible history and explicit repayment recording.
4. Give every gesture an equally capable tap path.
5. Validate recurring household usefulness before adding monetization or automation.

## Accessibility & Inclusion

Support VoiceOver, Dynamic Type, Reduce Motion, and Reduce Transparency. Identity
must remain understandable without color. Motion should explain and respond,
never delay financial entry or conceal an action.

## Evidence on Hand

Confirmed in the owner's September 12, 2026 interview. The linked household
spreadsheet was inspected read-only as workflow guidance; its personal financial
rows are not fixtures and must not be copied into Git or Linear. Existing app
code and historical design documents are implementation references. The explicit
interface-v2 approval selects the direction; existing receipts do not verify the
redesigned app.
