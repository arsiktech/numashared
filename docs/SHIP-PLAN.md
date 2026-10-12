# Numa Shared private-beta work sequence

Updated September 12, 2026. `GOAL_BRIEF.md §2` defines the outcome; detailed
acceptance lives in the owner's private planning workspace. This table remains
the dated beta sequence. Tasks are not delivery proof.

| Issue | Smallest complete outcome | Prerequisite |
| --- | --- | --- |
| ARS-111 | Lock contract; retire obsolete master prompts | Owner interview |
| ARS-112 | Native iOS 26+ support and minimum-runtime proof | ARS-111 |
| ARS-113 | Stable group ownership and safe replay | ARS-111; lifecycle answer |
| ARS-114 | Authorized, topology-aware backend operations | ARS-113 |
| ARS-115 | Lossless offline/promotion/account integration | ARS-114 |
| ARS-116 | Complete group-first expense/repayment journey | ARS-115 |
| ARS-117 | Approved playful orb-led Home and native motion | ARS-112, ARS-116; visual choice |
| ARS-118 | Reviewed, verified private-beta delivery | ARS-117; delivery authority |

Finish each issue's review and scoped commit before its successor. Compatibility
can proceed while lifecycle/visual decisions wait; do not implement those pending
choices or add adjacent features.

Execution follows the owner's risk-based autonomy policy in `GOAL_BRIEF.md §5`,
superseding both numeric caps and timed issue windows. Keep cumulative evidence,
reuse valid checks and change strategy after two equivalent failures. The full
release gate remains mandatory. Visual selection is complete: implement the
approved interface-v2 world recorded in `DESIGN.md`.

## Final candidate and delivery

- [ ] Resolve acceptance and material Standards/Spec findings.
- [ ] Run one full P5 on a clean immutable candidate descended from `main`, with
  iOS 26 proof and established higher-runtime coverage.
- [ ] Refresh build floor, configuration names, signing and dependency closure;
  inspect the signed archive/IPA and record source/hashes.
- [ ] Verify the named production operation and private audience. Existing docs
  name **Numa Shared Internal**; refresh identity/scope before assignment. Do not
  expand access by default.
- [ ] Perform only authorized deployment and synthetic production smoke.
- [ ] Upload the inspected version/build; separately verify processing and access.
- [ ] Observe tester acceptance/install/cold launch and applicable physical auth,
  multi-user sync, offline, privacy, push/deep-link journeys.
- [ ] Push scoped source and update one ship report linking evidence and limits.

Use `docs/RELEASE.md` and `docs/REVIEW-GATE.md` for safeguards and operations.
Public TestFlight, general App Store-draft work and submission are not this beta.
ARS-20/ARS-27 and older receipts concern earlier work, not this candidate.
