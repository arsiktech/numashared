# Continuous integration

`.github/workflows/ci.yml` runs on GitHub-hosted runners for every pull request and
push to `main`:

- **backend** (Ubuntu, Node 22): `npm ci`, `backend:typecheck`, `backend:test`,
  `branding:test`, `build:home:check` and `hygiene:test`.
- **swift-packages** (macOS): `swift test` for `NumaSharedCore` and `NumaSharedSync`.

Never add a self-hosted runner: this repository is public, so pull requests from
forks would run code on it.

The iOS app and UI suites, the two-simulator sync gate and the full release matrix
(`./scripts/phase-gate.sh P5`) still run locally. They need Xcode, iOS Simulators
and an isolated local Convex backend; see `docs/DEVELOPMENT.md` and
`scripts/README.md`.
