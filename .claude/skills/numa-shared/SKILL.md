---
name: numa-shared
description: Working knowledge for Numa Shared, the native SwiftUI iPhone household expense ledger (ios/NumaShared, NumaSharedCore and NumaSharedSync Swift packages, Convex backend in convex/). Covers repo map, test and gate commands, product and brand naming rules, owner-gated release steps, the internal TestFlight ship order, and how to answer "is TestFlight current" from Apple instead of notes. Use when changing the app, ledger core, sync layer or Convex backend, running the phase gate, preparing or checking a TestFlight build, or editing user-facing product copy.
---

# Numa Shared

AGENTS.md owns the product contracts (integer money, append-only ledger, reducer-derived balances, color never encodes direction), working style and the command list. Do not restate them; read AGENTS.md first, then PRODUCT.md (product truth), CONTEXT.md (identity vocabulary: account, member profile, pending identity, settlement unit, claim), DESIGN.md (approved visual system) and DECISIONS.md (dated owner decisions) as the task needs. GOAL_BRIEF.md has beta scope, exclusions and owner decision gates. Release evidence and progress logs are kept outside this public repository; a dated snapshot is never live Apple or production truth.

Other in-repo skills for this repo: `write-swift` (Swift 6, concurrency), `convex-expert`, `convex-reviewer`, `convex-deploy-guard` (use the last before anything that touches a Convex deployment).

## Map

- `ios/NumaShared/NumaShared.xcodeproj`, scheme `NumaShared` (plus `NumaSharedReleaseScreenshots`), bundle `tech.arsik.numashared`, team `794UJ787LZ`. Swift 6 with complete strict concurrency; the app target uses MainActor default isolation, the Core and Sync packages do not. Deployment floor is iOS 26.0 (see `docs/DEVELOPMENT.md`).
  - App sources in `ios/NumaShared/NumaShared/`: `AppModel.swift`, `Models.swift`, `HomeView.swift`, `AddExpenseView.swift`, `BudgetGroupExpenseFlow.swift`, `Components.swift` (shared component system, extend it), `Theme.swift`, `AppSyncRuntime.swift`, `NumaSession.swift`, `PotRegistry.swift`, `InviteRouting.swift`, `LedgerRepository.swift`, `LedgerCSVExport.swift`, `PushNotifications.swift`, `PrivacyPreferences.swift`, `SettingsView.swift`, `E2EHarness.swift` (Debug only).
  - Tests: `ios/NumaShared/NumaSharedTests/` (unit), `ios/NumaShared/NumaSharedUITests/` (`GoldenPathUITests` plus `+Welcome`, `+HomeFidelity`, `+ExpenseFidelity`, `+Settlements`, `+Performance`, `ActivityDetailJourneyUITests`, `JourneyNavigationUITests`, `SettingsJourneyUITests`), host-run `ios/NumaShared/Tests/LedgerTests.swift`.
- `NumaSharedCore/` pure Foundation-only ledger: money, allocation, events, reducer, undo, wire format V1 (`docs/CORE.md`).
- `NumaSharedSync/` GRDB/SQLite persistence, outbox, `SyncCoordinator`, Convex transport (`docs/PERSISTENCE.md`).
- `convex/` backend: `schema.ts`, `events.ts`, `pots.ts`, `members.ts`, `identity*.ts`, `notifications.ts`, `lib/*`, tests `*.test.ts` run by `convex-test` under vitest. The server validates and sequences events; it never computes balances. `convex/_generated/` is tracked: refresh only through the asserted anonymous-local lifecycle used by `sync-test.sh`.
- `convex/lib/webContent.ts` and `convex/web.ts` serve the public site on the Convex HTTP-actions host (marketing, `/join/*`, `/privacy`, `/support`, AASA, `/app-config`; see `docs/WEB.md`). `web-marketing/` is not the production origin.
- `contracts/event-terminal-codes.json` is the sorted terminal-code list that must equal both the backend emission surface and the Swift allowlist (`scripts/tests/event-terminal-contract-test.sh`).
- `scripts/` holds every gate and release tool (`scripts/README.md`); `docs/RELEASE.md` is the release runbook; `docs/REVIEW-GATE.md` sets review depth; `reviews/` holds candidate review artifacts.
- Numa Shared is not Numa Pro. Never share bundle ids, schemas, Convex projects, App Store records, credentials or release evidence between them. Plain `npx convex dev` is forbidden (it can select a cloud project); there is deliberately no package script for it.

## Commands

From the repo root (run `npm ci` once; locked dependencies):

```bash
swift test --package-path NumaSharedCore
swift test --package-path NumaSharedSync
npm run backend:typecheck
npm run backend:test
npm run branding:test          # naming/copy contract, run after any user-facing copy change
```

Local Convex only through `./scripts/convex-local.sh` or `./scripts/with-convex-local-e2e.sh` (isolated anonymous instance, pinned CLI). Two-simulator sync gate: `./scripts/sync-test.sh` (`NUMA_PHASE=P3 ./scripts/sync-test.sh` for the multi-account extension). Release-boundary scan: `./scripts/p1-release-check.sh` (fails if any Debug-only QA, seed or local-auth marker is in a Release bundle).

Native work: reuse a compatible Simulator and incremental DerivedData; do not reset a booted Simulator and never `shutdown all`. The full UI gate runs on iPhone 17 Pro Max, iOS 27.0; P5 also runs the expense, balance, repayment, history and Welcome/Create journeys on iPhone 17 Pro, iOS 26.2. A missing runtime blocks the gate; do not substitute another OS. Focused runs use `xcodebuild test -project ios/NumaShared/NumaShared.xcodeproj -scheme NumaShared -destination 'platform=iOS Simulator,id=<UDID>' -only-testing:<target>/<class>`. Verify by `xcodebuild test` and `xcrun simctl` only; never drive the operator's mouse or keyboard.

`./scripts/phase-gate.sh P5` is the full local release matrix. It needs a clean candidate descended from `main`, prints base/head/tree, and fails if any of them change mid-run. Commit first or use a separate worktree; do not edit that checkout while it runs. Run it only for a release candidate; routine work uses the smallest relevant check (docs-only changes need reference and whitespace checks, not a build).

Convex "use node" local actions failed under a newer default Node on the owner's Mac (symptom `DeploymentNotConfiguredForNodeActions`); the recorded fix was to put a Node 22 install first on `PATH` for the gate only (Homebrew `node@22`) without relinking the default Node. This is from the owner's workflow and is not stated in the repo docs; if you see that error, check Node version first.

## Rules specific to this repo

- Never skip, weaken, `XCTSkip`, comment out or narrow a test to pass a gate. Change approach after two equivalent failures; stop only the blocked action and continue independent work.
- Do not add dependencies beyond what GOAL_BRIEF.md allows (GRDB, Convex client/CLI). Do not add features on its exclusion list (bank accounts, FX, subscriptions, widgets, analytics, recurring items, etc.).
- Accessibility is part of done: VoiceOver labels on new interactive elements, Dynamic Type reflow, Reduce Motion and Reduce Transparency variants, 44 pt targets, a tap equivalent for every drag gesture. New UI extends `Components.swift`; strings go through the String Catalog.
- Keep household balances, sheet contents and account identifiers out of docs, commit messages, chat and review artifacts. Use synthetic data (the Casa Mar seed is Debug only).
- Secrets live outside the repo, on the owner's machine only. Never print, commit or copy values; source env files without echoing. Never commit `*.p8`, `SECRETS.env`, `.env.*`; stage explicit paths, not `git add -A`.

## Product name and branding

- The user-facing name is exactly "Numa Shared": not "Numa Shared App", not standalone "Numa" (that is the other product).
- For a naming or branding pass, inventory first: native display name, UI strings and accessibility labels, the live website, `convex/lib/webContent.ts` and any store-copy files under `app-store/` and `docs/`. Preserve technical identifiers, URLs, append-only receipts and review files, Simulator names, package paths, explicit Numa Pro boundary references and the exact `Numa Shared App Store 2026-07-20` provisioning-profile name. Do not globally rewrite them. Reuse the existing visual identity.
- Acceptance: `npm run branding:test`; backend typecheck and tests when web copy changed; the native UI journeys containing the changed strings; compiled name via `/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' <built-app>/Info.plist` (a source plist edit proves nothing; it also does not prove SpringBoard rendering); read the result bundle with `xcrun xcresulttool get test-results summary --path <x>.xcresult`, export attachments, and look at the changed text for wrapping and clipping. A blank or failed capture is unverified. Bind review approval to the tracked diff hash and the hashes of new untracked files (`git diff` omits untracked tests).
- Local branding edits do not update a distributed TestFlight binary. Live site copy that already matches means no Convex deploy is needed; fetch the live origin before calling the site stale.

## Release and distribution

Release operations follow `docs/RELEASE.md`. The owner's step-by-step ship and TestFlight-status notes are kept outside this public repository.

Authority, in short (AGENTS.md and `docs/RELEASE.md` are authoritative): authorization already given in the conversation covers the named operation and audience. These need an explicit owner decision: production Convex change, App Store Connect writes beyond the authorized scope, any tester invite or public link, Beta App Review, credential changes, paid actions, real household data. Final Submit for Review and public release are human-only. "Put the current version on TestFlight so I can check it" authorizes an internal-only ship: freeze, gate, archive, upload, and assign the new build to the existing internal group `Numa Shared Internal`. It does not authorize a public link, Beta App Review, App Store draft writes or a production Convex deploy.

Keep these as separate facts and never let one imply another: source reviewed, local matrix green, signed archive inspected, upload accepted, Apple processing VALID, group assignment, tester INSTALLED, physical-device smoke. Tester state INSTALLED means some assigned build is on a device, not which build. A source review or old receipt proves nothing about a later tree.

For a nontechnical status question lead with the plain verdict (yes/no, which build, what is waiting); skip hashes and group ids unless asked.

## Pitfalls

- Answering TestFlight currency from `SHIP_REPORT.md`, PROGRESS or notes: Apple can hold a later VALID build than any committed note. Read Apple (see the status reference).
- Treating any dirty `git status` as "TestFlight is behind". Only native iOS files that differ from the uploaded IPA or source snapshot are missing from the phone; uncommitted web or docs changes do not make the phone stale.
- Reusing a spent build number. The next `CURRENT_PROJECT_VERSION` must exceed the combined floor of processed builds and build uploads (`scripts/asc-readonly.mjs` prints `ASC_BUILD_FLOOR`; `release-preflight.sh` enforces it). Do not take it from `HEAD` or a dirty pbxproj that still holds the spent number. After processing, the uploaded build itself becomes part of the floor.
- `GET /v1/builds/{id}/betaGroups` is forbidden by Apple (403). List builds from the beta group instead.
- Piping a live Node ASC reader into an early-exiting `grep -q` or `rg -q` raises EPIPE and hides a successful match under `pipefail`. Buffer the whole response, then parse.
- `scripts/archive-release.sh` exits if the output directory already exists; use a new directory per attempt. Inspect the exported IPA (`scripts/inspect-release.sh`), not the app inside the `.xcarchive`: the archive app is development-signed.
- Release URLs are fixed to the production Convex cloud and site hosts in `docs/RELEASE.md`; preflight rejects any other origin, redirect or custom domain. A split origin needs a new owner decision.
- Reconcile privacy drafts with actual collection and Apple's current taxonomy, not document recency: recording debts without moving money can still collect Other Financial Info; Crash Data is not Product Interaction. Inspect the App Store draft's release mode before first public submission (manual release is the safe default; changing it needs authorized draft scope).

