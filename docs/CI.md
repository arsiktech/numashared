# Continuous integration

`.github/workflows/ci.yml` runs on GitHub-hosted runners for every pull request and
push to `main`:

- **app** (Ubuntu, Node 22, `app/`): `npm ci`, `npm run typecheck`, `npm test`
  and `npm run native:check`. The last check compares the committed Expo iOS
  project with regenerated native configuration; it does not launch the app.
- **backend** (Ubuntu, Node 22): installs locked dependencies at the root and
  in `app/`, then runs `backend:typecheck`, `backend:test`, `branding:test`,
  `build:home:check`, `hygiene:test` and `card-sync:test`. `backend:test` includes
  `convex/clientSync.test.ts`, which exercises the Expo sync engine against
  backend functions with simulated clients. It is not a rendered UI journey.
- **swift-packages** (macOS): `swift test` for `NumaSharedCore` and `NumaSharedSync`.

Never add a self-hosted runner: this repository is public, so pull requests from
forks would run code on it.

## Android

Android uses Expo prebuild-on-demand, not a committed native project. See
[Android release](ANDROID.md) for local signing, isolated emulator QA and the
remaining Google Cloud, Firebase and Play Console setup.

## Verification by implementation

The Expo app in [`app/`](../app/README.md) is current. The app and backend jobs
above are its committed automated gate. No committed rendered Expo web or native
journey harness is present, and CI does not launch that client. A release still
needs rendered evidence for the affected current-app journeys. Neither unit
tests, native configuration consistency nor simulated sync closes that gap.

`./scripts/phase-gate.sh P5` is the legacy Swift compatibility matrix. It targets
`ios/NumaShared/NumaShared.xcodeproj`, not `app/ios/`. Its SwiftUI UI suites and
two-simulator sync gate remain local and need Xcode, the pinned iOS runtimes and
an isolated local Convex backend. See [development](DEVELOPMENT.md) and
[script contracts](../scripts/README.md). Keep these checks for legacy/wire
compatibility; do not present them as Expo release verification.
