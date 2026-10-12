# Numa Shared — full interface proposal, v2

**Status: owner approved on September 12, 2026 (“I love it!”).** `../../DESIGN.md` records the selected native visual system. This replaces the rejected three-screen violet concept. No production SwiftUI code, backend, real household data, account access or release configuration was changed.

## Open and explore

Open `index.html` through a local server. Current preview: <http://127.0.0.1:8769/#home>.

```sh
python3 -m http.server 8769 --bind 127.0.0.1 --directory design/interface-v2
```

- **60 individually authored iPhone frames**, with a layer-style screen navigator.
- **All screens** is the Figma-style overview; select a frame to inspect it.
- **Previous / Next**, or the keyboard arrows, move screen by screen.
- **Focus view** removes the side panels. The phone automatically fits the viewport.
- App controls connect the principal design flows. Secondary controls that have no implementation announce that they are appearance previews.
- The inspector explains each screen's purpose, motion and financial/privacy constraints.
- Text fields and numeric keyboards preview filled states. This is not a financial application or a general-purpose input prototype.
- Save outcomes preserve the selected scenario through Home, balance explanation, history and new-expense detail. Starting another financial flow explicitly returns to the original €84 example. Selecting a frame in the sidebar or overview resets to that frame's named fixture.

This is an editable **HTML/CSS/JavaScript design canvas**, not a `.fig` document or an actual Figma workspace. It uses no build framework, npm installation, network application API or paid image-generation call. The live server binds only to loopback.

## Direction: the shared table

**Thesis:** a warm, physical little object for the everyday “I'll get this” moments—not a personal-finance dashboard.

**Own world:** butter-yellow Home, warm neutral working surfaces, ink typography, citrus and lilac budget identities, a terracotta sphere. Bricolage Grotesque provides expressive headings; system typography carries controls, rows and supporting information. Thin rules carry the receipt structure; groups—not generic feature cards—earn colored containers.

**First screen:** full named debt direction, a large exact amount, one tap into its explanation, a separately named repayment action. Below it, a tactile orb starts expense entry and recent household history provides context.

**Cross-screen rule:** expression belongs to Home, onboarding and the orb. Arithmetic, error recovery and consequential data actions become quieter and more explicit. Nothing depends on color or gestures alone.

**Implementation boundary:** the owner selected this warm light-mode world. Native
dark mode, real Dynamic Type and runtime accessibility remain implementation and
validation requirements; the design board does not supply that evidence.

## Screen map

| Area | Screens and states |
| --- | --- |
| Start together | Welcome; name/currency; currency list; people; add person; paired budgets; singleton alternative; final confirmation |
| Everyday | Home; why this balance; updated Home; expense and bill details; correction; void; full history; expense/repayment filters; correction/void records; post-repayment Home |
| Add an expense | Description/amount; date/note; actual payer; equal/exact/one-group allocation; all three reviews and saved states; unsent Undo |
| Record repayments | Partial repayment; overpayment warning; partial/overpaid/full completion |
| Your household | People/budgets; connect; invite selection; invite preview; receiving invitation; settings; motion; opening balance and review; privacy; export; erasure; departure |
| Important states | Invite unavailable; empty Home; settled Home; offline Home; pending-sync recovery; incomplete allocation; larger text |
| Design system | Palette, material, type, interaction intent |

## Synthetic accounting fixtures

None of these names, descriptions or amounts were copied from the private Google Sheet.

**Base:** Alex paid dinner €96 and Jo paid internet €72, each split equally between You + Sam and Alex + Jo. Therefore You + Sam owe Alex + Jo **€48 + €36 = €84**.

The flows below are **independent alternatives**, not a cumulative series:

| Action from the base fixture | Result |
| --- | --- |
| Sam pays new €96 dinner; €48 per group | You + Sam owe Alex + Jo €36 |
| Sam pays new €96 dinner; own share €60, other share €36 | You + Sam owe Alex + Jo €48 |
| Sam pays €96 entirely for Alex + Jo | Alex + Jo owe You + Sam €12 |
| You + Sam record €50 repaid | You + Sam owe Alex + Jo €34 |
| You + Sam record €100 repaid | Alex + Jo owe You + Sam €16 |
| You + Sam record €84 repaid | No outstanding debt |
| Original dinner corrected €96 → €90, equal shares | You + Sam owe Alex + Jo €81 |
| Original dinner voided | You + Sam owe Alex + Jo €36 |
| Separate opening balance €84 added to existing €84 | You + Sam owe Alex + Jo €168 |

## Implementation handoff — not implemented here

- Native SwiftUI, iOS 26+, English. Retain existing ledger/sync contracts and reader/schema versioning.
- Currency is explicitly confirmed and fixed. Integer minor units; exact-sum allocations; no FX.
- Actual payer, recorder and financial owner are separate. A person can belong to one singleton/couple budget; budgets are configured before any financial history.
- Corrections and voids are visible events. Only unsent events inside their actual undo window may disappear.
- Orb: the entire labeled row is tappable; about 120 ms press compression, about 220 ms release/open, one activation haptic. No mandatory long press, dragging to repay or autonomous looping. Respect Reduce Motion and Reduce Transparency.
- Navigation uses native iOS material APIs rather than a CSS imitation. Content stays on opaque readable surfaces; larger text reflows instead of shrinking. Native VoiceOver, real Dynamic Type, physical haptics and dark-mode checks remain required.
- Undo occupies a reserved lane above navigation; it must not overlap Add expense or Record repayment.
- Local pending work stays usable and is not falsely labeled shared. Retry retains event identity and order. Account boundaries, invite claims, replay/export erasure and server validation remain the backend's contracts.
- Invitations are design previews only. No invite creation or distribution beyond the existing owner-only private-beta authority.

Apple references consulted: [Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass), and [Apple Design Awards](https://developer.apple.com/design/awards/). These inform the separation of navigation/material from content, system accessibility behavior, and purposeful interaction. They do not certify this proposal or make it an award-winning design.

## Assets and provenance

- All UI, icons and sphere are authored geometry/code, not generated raster images.
- Bricolage Grotesque 700 is self-hosted from Google's official Fonts distribution. SIL Open Font License is included in `assets/OFL.txt`.
- No GPT Image model was used for these precise interface frames. The earlier Brave-generated raster board is rejected and not embedded or treated as approval.

## Delivery boundary

Design canvas completion is separate from visual selection, native implementation, release validation, commit integration, deployment, TestFlight upload/processing, tester access and physical installation. The canvas supplies the approved visual reference, not native or release proof.
