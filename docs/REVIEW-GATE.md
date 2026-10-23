# Review and verification

Review the requested change against the user's intent, relevant product contracts, and actual code. The user's current request can intentionally change earlier workflow policy; removing duplicated instructions is not itself a defect.

## Routine work

- Inspect the affected diff and paths. Check correctness, behavior, maintainability, and scope; substantiate findings with a concrete failure or contract conflict.
- Choose the smallest useful checks from `docs/DEVELOPMENT.md` and `scripts/README.md`. Documentation needs reference and whitespace checks; a small code fix needs affected tests; UI behavior needs the relevant rendered journey.
- Fix material findings within the task. Style preferences, speculative risks, and missing model labels do not create approval gates.
- Delegate independent investigation or review when useful. A task does not require named Builder/Reviewer/Chief handoffs or two reports by default.
- Use the selected runtime and reasoning settings. Report precise model/effort labels only when supplied by the runtime; historical filenames do not dictate new settings.

## Release candidates

Use [the verification map](CI.md) for the current Expo candidate, including the
explicit rendered-journey coverage gap. `./scripts/phase-gate.sh P5` verifies
legacy Swift compatibility and source identity on a clean, immutable candidate;
it does not exercise the Expo app. Do not edit a frozen checkout while its gate runs.

For material ledger, authentication, sync, privacy, or signing changes, use independent parallel review:

1. **Standards:** implementation, invariants, security, privacy, accessibility, and verification quality.
2. **Spec:** requested behavior, failure paths, and the relevant release requirements.

The primary agent reconciles findings against evidence. Resolve material issues before delivery, then verify the affected surfaces. Repeat the full matrix when executable candidate inputs change; documentation, receipt, or workflow-only changes need their own focused review and do not retroactively change the tested binary. Record both source identities when reusing evidence and verify the executable inputs are unchanged.

Save one concise candidate review in private storage outside this public
repository, with source commit/tree, relevant changes, checks and results,
findings, and remaining work. Do not put review receipts in tracked source,
issues or pull requests. Do not rewrite historical receipts or require a model
name in the filename. A source review, signed-package inspection, Apple processing
result, and installed-device result each prove their own stage.

## Completion

A passing local matrix or review allows the next authorized step. It does not start an unrelated release, authorize a new audience, or require a branch merge ceremony. Use `docs/RELEASE.md` for operations and `GOAL_BRIEF.md §2` for the full ship outcome.

Record progress at meaningful milestones or handoff, not after every small edit. If blocked, state the observed problem and smallest missing input, then continue work that does not depend on it. Retry or change approach based on evidence, without a fixed attempt limit.
