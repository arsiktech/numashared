# Numa Shared

Current implementation: the Expo app in [`app/`](app/README.md) is the current
client. The SwiftUI app in `ios/` is legacy compatibility code; its UI gates do
not verify Expo. See the [verification map](docs/CI.md).

> This public repository is a snapshot of Numa Shared's private development
> repository, published without its history. Release evidence, progress logs,
> review receipts and internal planning links are not included. Development
> continues here in public.

Native iPhone app for household expenses: who paid, who benefited, and who owes
whom. It records repayments made elsewhere and **never moves money**.

- Website: <https://adept-camel-457.convex.site>
- Status: private TestFlight beta (iOS 26 and later). Not yet on the App Store.
- Numa Pro, the personal-capital app, is a separate product with its own
  repository and backend.

## How it fits together

| Path | What it is |
| --- | --- |
| `app/` | Current Expo client for iPhone, Android and web ([app/README.md](app/README.md)) |
| `NumaSharedCore/` | Foundation-only ledger: integer money, allocation, append-only events, reducer, wire format ([docs/CORE.md](docs/CORE.md)) |
| `NumaSharedSync/` | GRDB/SQLite persistence, offline outbox, sync coordinator, Convex transport ([docs/PERSISTENCE.md](docs/PERSISTENCE.md)) |
| `ios/NumaShared/` | Legacy SwiftUI app, unit tests and UI journeys |
| `convex/` | Convex backend: validates and sequences events, identity, invites, push, web pages ([docs/IDENTITY.md](docs/IDENTITY.md), [docs/WEB.md](docs/WEB.md)) |
| `web-home/` | Source of the website home page, built into `convex/lib/homePage.generated.ts` |
| `web-marketing/` | Earlier static marketing pages (not the production origin) |
| `contracts/` | Cross-language contracts checked by tests |
| `scripts/` | Local gates, release tooling and their contract tests ([scripts/README.md](scripts/README.md)) |
| `design/`, `DESIGN.md` | Approved interface direction and design system |
| `app-store/` | Store copy and screenshots |
| `docs/` | Subsystem contracts, privacy, push, CSV, account deletion, release runbook |

Product truth lives in [PRODUCT.md](PRODUCT.md), vocabulary in
[CONTEXT.md](CONTEXT.md), beta scope and exclusions in [GOAL_BRIEF.md](GOAL_BRIEF.md),
and dated decisions in [DECISIONS.md](DECISIONS.md). The contracts below and
the subsystem docs apply across both clients. Execution guidance stays private.

## Product contracts

- Money is integer minor units with an ISO 4217 currency. Splits sum exactly;
  balances are reducer-derived and zero-sum.
- History is append-only. Corrections and voids are visible events; replay is
  idempotent. Only an unsent event inside its undo window may disappear. The
  server validates and sequences events; clients derive balances.
- Local data comes before sign-in and reconciles without loss, duplication or
  reordering or cross-account leakage. Authored-text erasure survives replay
  and export.
- Color identifies people and groups, never financial direction.
  Equivalent tap/gesture paths, accessibility, Reduce Motion and Reduce
  Transparency remain product requirements.

## Run the checks

Use Node 22 and the locked dependencies, plus Xcode 27 for native work.

```bash
npm ci
# Install the current app's dependencies too: backend integration tests import it.
npm ci --prefix app
npm run typecheck --prefix app
npm test --prefix app
npm run native:check --prefix app
npm run backend:typecheck
npm run backend:test
npm run branding:test
npm run hygiene:test
swift test --package-path NumaSharedCore
swift test --package-path NumaSharedSync
```

Run local Convex only through `scripts/convex-local.sh` or
`scripts/with-convex-local-e2e.sh`; they isolate it from cloud deployments. The
legacy Swift compatibility matrix is `./scripts/phase-gate.sh P5`, not an Expo
release gate. There is no committed rendered current-app journey check; CI's
sync integration uses simulated clients, not rendered screens. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/CI.md](docs/CI.md).

## Contributing and security

Issues and suggestions are welcome. Please do not include real household data,
balances or personal details in issues or pull requests. Report security problems
privately through the support address on the website, not in a public issue.

## License

Copyright © 2026 arsiktech. All rights reserved. The source is published so people
can read it and follow development; no license to copy, modify or redistribute it
is granted. Third-party components keep their own licenses, for example the
bundled fonts under OFL.
