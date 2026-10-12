# Interface v2 — proposal handoff

September 12, 2026. Owner requested a full, screen-by-screen replacement after rejecting the previous cheap/generic design. **Owner selection remains pending.** This record is not approval of the visual direction or evidence of a native app release.

## Delivered scope

60 code-native iPhone design frames in `index.html`, styled by `studio.css` and authored in `screens.js`. Seven flow/state sections, full-screen/focused browsing, a Figma-style overview, contextual notes and connected fixture outcomes. Licensed self-hosted display font; all names and amounts are synthetic. No new framework or package installation. No paid image generation. No production app or backend source change.

Local exports accompany the source:
- `outputs/design/interface-v2/01-welcome.png` through `60-system.png`: 60 individual high-resolution browser captures, suitable as flat reference images in Figma.
- `outputs/design/interface-v2/frames.json`: capture manifest.
- `output/pdf/numa-shared-interface-v2.pdf`: 60-page, bookmarked image-based review book. These are screenshots, not editable Figma layers or searchable app text.
- `outputs/design/numa-shared-interface-v2.zip`: source and individual PNG package.

## Checks and evidence

- JavaScript syntax, 60 unique screen IDs, 239 resolved static prototype routes, five saved-outcome scenarios and absence of application network-write APIs passed.
- All 60 browser frames rendered at the actual 1728 × 947 desktop viewport with no horizontal overflow. Independent rendered inspection covered Home, Welcome, grouping, review, repayment, larger text and the overview.
- Browser PNG dimensions and nonblank checks: 60 captures, 1570 × 3408 pixels each. No surviving studio-notification contamination in the frame set.
- Narrow studio layout checked at 430 × 932: document width 430, centered phone bounds approximately x=51.7…378.3, no horizontal page overflow. Temporary viewport override reset.
- The PDF has 60 pages, no JavaScript and no form fields. Home and repayment PDF pages rendered and visually inspected; the corrected repayment export contains no studio notification over its action.
- Plain browser PDF export failed when the extension connection dropped. Recovered using a fresh task-owned tab; built the review PDF from the already-exported browser frames instead. No further browser-print retry loop.
- A long PNG export invocation timed out after 56 completed exports. Resumed only the remaining four, preserving completed work. Initial script global-name collision was fixed with a closure; final files can be loaded without global `top` collisions.

## Independent review and resolution

Reviewer: `/root/interface_review`, GPT-6 Astra / xhigh. One initial material review and focused fix-list follow-ups; no repeated full audit.

| Finding | Resolution |
| --- | --- |
| Saved exact/paid-for-other flows returned to the original €84 Home | Explicit synthetic scenes preserve €48 and reversed €12 outcomes through Home, explanation, history and the new Sam-paid expense. Inspector notes now match. Starting a separate financial flow is explicitly labeled as returning to the original €84 example. |
| Whole overview inherited link underlines | Decoration removed only on the board frame wrapper. |
| Setup groups showed locked imagery before history | Setup uses people imagery; locks remain for post-history household groups. |

Final reviewer disposition: **SHIP — original three-item fix list resolved.** The last inspector-text residual was checked from source only. This clears proposal handoff at that scope, not owner selection or production readiness.

## Deliberate boundaries

- The board uses fixed, named synthetic scenarios, not a fully functional ledger/input application.
- Light-mode and larger-text designs are shown; actual native dark mode, accessibility, haptics, GPU behavior, offline/auth correctness and device journeys remain implementation/validation work.
- No bank transfers, account linking, invitations, exports of financial data, erasure, departure, deployment, TestFlight operations or live-data mutations were performed.
- No SwiftUI implementation of the replacement direction starts until the owner selects the visual direction.
