# Numa Shared

Native iPhone household-expense app: who paid, who benefited, and who owes whom. It records repayments made elsewhere and never moves money. Numa Pro is a separate product; its data, identifiers, backend, credentials, and release records stay separate.

## This repository is public

Keep private material out of files, commits, issues and pull requests: machine
paths, hostnames, credentials, private tracker links, real household data, tester
identities and App Store Connect group or tester IDs. Use synthetic data in tests
and examples. Release receipts, progress logs and review evidence stay in the
owner's private records; `npm run hygiene:test` checks tracked files.

## Working style

- Carry the user's requested outcome through implementation, appropriate verification, and handoff. Make reasonable implementation decisions and continue useful work when part of a task is waiting.
- Routine local edits, fixes, refactors, tests, documentation, and task-scoped commits need no extra confirmation. Honor authority already granted in the conversation; ask only when missing information or a consequential action outside that authority prevents progress.
- Use the user's selected model and reasoning settings, including GPT-6 Astra. Choose tools and delegate independent work when it saves time or improves the result. There is no repository model restriction, reasoning cap, fixed retry count, or mandatory role handoff.
- Prefer deleting unnecessary work to adding machinery. Verify in proportion to the change; once relevant checks pass, finish. Documentation-only changes need reference/diff checks, not an app build or release matrix.
- Follow the owner-approved risk-based autonomy policy in `GOAL_BRIEF.md §5`: complete authorized work through review, verification, scoped commit, push and approved deployment. Reuse valid evidence; change strategy after two equivalent failures. Stop only the affected action for missing authorization, unsafe conditions or genuine external blockers, and continue independent in-scope work. No timer or fixed test count applies; privacy, security and release gates remain mandatory.

## Product contracts

- Money uses integer minor units and ISO 4217 currency. Splits sum exactly; balances are reducer-derived and zero-sum.
- History is append-only; corrections and voids are visible events. Only an unsent event within its undo window may disappear. Event IDs make replay idempotent; the server validates and sequences rather than computing balances.
- Local data precedes authentication and reconciles without loss, duplication, reordering, or cross-account leakage. Authored-text erasure must survive replay and export.
- Color identifies people/groups, not financial direction. Preserve equivalent gesture/tap paths, accessibility, Reduce Motion and Reduce Transparency. Redesign follows the owner's approved visual direction, not superseded prototype prompts.

## Read as needed

- `PRODUCT.md`: product truth; `GOAL_BRIEF.md`: beta scope, decision gates and task-specific validation limits; `docs/SHIP-PLAN.md`: issue sequence. A normal task does not launch the whole beta mission.
- `CONTEXT.md`: identity/ledger vocabulary. Use `DESIGN.md` when the owner-approved direction has been recorded; generated concepts are not approval.
- `NumaSharedCore/`, `NumaSharedSync/`, `ios/NumaShared/`, `convex/`: ledger, sync, SwiftUI app, backend. Subsystem contracts are in `docs/`.
- `docs/DEVELOPMENT.md` and `scripts/README.md`: commands and toolchain details; `docs/REVIEW-GATE.md`: review depth; `docs/RELEASE.md`: release operations.
- `DECISIONS.md`: dated decisions. Read relevant recent entries. Release evidence, progress logs and review receipts are kept outside this public repository.

## Useful commands

Use the existing locked dependencies; run `npm ci` when installation is needed.

```bash
swift test --package-path NumaSharedCore
swift test --package-path NumaSharedSync
npm run backend:typecheck
npm run backend:test
npm run branding:test
```

Local Convex runs through `scripts/convex-local.sh` or `scripts/with-convex-local-e2e.sh`; these wrappers isolate it from cloud projects. Reuse compatible Simulators and DerivedData; the sync gate manages its own clones.

`./scripts/phase-gate.sh P5` is the full local release matrix. It requires a clean candidate descended from `main` and checks that its base/head/tree stay unchanged while running. Commit first or use an isolated candidate worktree; ordinary work can continue elsewhere.

For release work, apply existing authorization to the named operation and audience using `docs/RELEASE.md`. New production/data/credential changes, paid actions, or distribution beyond that scope need an owner decision. Final App Store submission and public release remain human actions. Record observed source, build, upload, distribution, and device results without treating one as proof of another.
