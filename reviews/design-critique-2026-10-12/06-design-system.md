# 06 Design system as implemented: tokens, colour, type, components, motion, haptics, materials, dark mode

Evidence labels: **verified in code** (read the Swift), **computed** (WCAG math on token hexes, computed with a local script), **design frame only** (PNG of the approved board), **inferred** (reasoned from code, not seen running). Nothing here was run on a device or Simulator. Contrast numbers come from token values, not rendered pixels.

## Verdict

The approved direction is genuinely distinctive: butter Home, lime/lilac/sky group identities, a terracotta orb, a chunky grotesque (Bricolage) that speaks in sentences. That identity is intact on about six screens (Welcome, Setup, Home, the Add flow, and three sheet titles). Everywhere else the app is stock iOS `List` screens, system fonts and one-off button recipes, so "a design system that really stands out" is true of a handful of screens and not of the product. The system is also drifting underneath: `Theme.swift` declares tokens the code ignores (spacing scale used 0 times, 8 of 19 palette fields dead, 8 corner radii in use against 4 declared tokens), three UI generations coexist (July orbit/aurora leftovers, a legacy add flow, the September board), and four token names lie about their colour (`indigo` is olive green, `teal` is lime, `amber` is sky blue). The orb, which PRODUCT.md calls "the signature interaction", is a well-made static gradient with a 0.97 press; nothing about its behaviour is yet unmistakable. Contrast is mostly sound in light mode and fine for text in dark mode, with one real dark-mode failure (destructive red) and a dark Home panel that has lost the butter.

## Findings

### 1. Distinctive on ~6 screens, stock iOS on ~12 (S2)
- **Evidence:** `SettingsView.swift:13` and `PeopleManagementView.swift:18` are plain `List { Section }` with inline nav titles and SF Symbols. Board frames `45-settings` and `40-people` show an identity header with a Bricolage "You", two-line rows with thin rules, and full-width lime/lilac group blocks; `budgetGroupsSection` (`PeopleManagementView.swift:190`) is text rows with no group colour at all. `NumaFont.display` (Bricolage) appears only in Home, the Add flow, Onboarding and three sheet titles (grep: 25 calls in 5 files). Activity (`SheetViews.swift:62`), Edit, Void, Opening balance (`OpeningBalanceView.swift:57`), Invite, Sync, Privacy, Pot switcher use `.title.bold()` or `NumaFont.system(21, .bold)`. Board `47-opening` and `16-activity` have Bricolage headings ("Picking up where you left off.", "Our running tab.").
- **Why it matters:** the moment a user opens Settings or Activity the app turns into any other app; the brand is a Home-screen skin, not a system.
- **Fix:** build four screen-level primitives and apply them everywhere: `NumaScreen` (25pt inset, chip-circle back/close, Bricolage 37 title + 15pt secondary intro), `NumaRow` (46pt leading disc or none, 16 semibold title, 13 secondary, trailing value/chevron, hairline), `NumaGroupBlock` (identity fill, name, member discs), `NumaNotice` (the board's `explain` block: icon + bold title + body on a chip). Rebuild Settings, People, Activity, Opening balance, Invite, Sync, Privacy on them. Keep `List` only where system behaviour is wanted, and restyle with `listRowBackground`/`listRowSeparatorTint`.
- **Effort:** L. **Confidence:** verified in code + design frame.

### 2. The token layer is mostly decoration; the real system is literals (S2)
- **Evidence (counts, verified in code):**
  - `Metrics.space1…6` used **0** times; there are **294** `.padding(` calls and **163** numeric `.frame(` literals. Horizontal page inset appears as 25 (×13), 24, 23, 22 (×7), 20, 18, 17, 16 (×12): Home is 25, sheets are 22 (`SheetViews.swift:187/462/700/797/987`), Settle plan is 24 (`:845`), Legacy add is 24. DESIGN.md says 25.
  - `Metrics.radiusS/L/pill` and the three drag radii: 0 uses. `radiusM` 1, `sheetRadius` 1. 12 of 16 `Metrics` constants are dead.
  - `Pal.Palette` has 19 stored fields; 8 have zero readers (`attn`, `glass`, `glassBorder`, `scrim`, `undoDivider`, `vesselBg`, `vesselBorder`, `vesselShadow`) and 3 have one (`kpBg`, `keyBg`, `discFill`). In light, `ink3 == ink2` (both `0x62655D`, `Theme.swift:39-40`), and `kpBg == discFill == bg`, `keyBg == surface`.
  - `Color(hex:)` outside `Theme.swift`: **29** (OnboardingViews 8, Components 7, HomeView 4, FieldSpaceView 10 which is dead). 13 `palette.isDark ? x : Color(hex:)` branches (HomeView 6, OnboardingViews 5, plus 2 Apple button styles).
  - `.font(.system(size:…))`: **24** (SheetViews 10, AddExpenseView 5). `cornerRadius:` literals: **44** across 9 files, worst `SheetViews.swift` (17).
- **Why it matters:** two people can follow "the design system" and produce different screens; drift is guaranteed to continue.
- **Fix:** delete dead tokens; make `Pal`/`Metrics`/`NumaType`/`NumaMotion` the only vocabulary (see Ground-up rethink 4); add a 20-line grep check to the existing gate (`scripts/`): fail on `Color(hex:` outside `Theme.swift`, `.font(.system(size:` and `cornerRadius: [0-9]`. Effort S for the lint, M for the migration. **Confidence:** verified in code.

### 3. Token names lie, and one colour has three names (S3)
- **Evidence (`Theme.swift:84-91`, computed hue):** `indigo = 0x52672B` is dark olive green (hue 81°); `teal = 0xD8EF7F` is lime/citrus (72°); `amber = 0xBBD8EA` is pale sky blue (203°); `purple = 0xCAB8ED` is lilac (260°, acceptable). The same lime is `--lime` in `studio.css`, `group-citrus` in DESIGN.md and `teal`/`tealInk` in Swift. `wovenRing` is therefore an olive-to-lilac gradient (`:93-98`). The old names are leftovers from the July indigo/mint palette (the app icon still shows it, finding 12).
- **Why it matters:** the next developer reads `Pal.teal` and assumes a cool colour; `amber` for "a warning" would paint sky blue.
- **Fix:** rename once, project-wide: `identity.lime/lilac/sky/peach` with `…Ink`; drop `indigo` (use a named `ringOlive` or delete the ring); add the same names to DESIGN.md frontmatter and `studio.css`. Effort S. **Confidence:** verified in code.

### 4. Only 3 identity hues for up to N groups; setup shows 4, Home shows 3 (S2)
- **Evidence:** group colour is `colors[index % colors.count]` over `[teal, purple, amber]` (`AppModel.swift:734-738`); the non-group path hashes to the same 3 (`:761-766`). The limit is 64 units. Onboarding preview uses a different 4-colour list including a hard-coded peach `0xF5B995` (`OnboardingViews.swift:647`). A flat with two couples and two singles has 4 groups: the 4th group is peach in setup, then lime on Home, the same lime as group 1. Computed contrast between the identity fills is 1.17 to 1.43:1 (lime vs sky 1.17), so they separate by hue only.
- **Why it matters:** the contract is "colour identifies people/groups"; at 4+ groups it does not, and the colour changes between setup and the app.
- **Fix:** one ordered set of 8 identity hues (add peach `F5B995`, mint, rose, apricot) each with an ink and a dark-mode check; assign by registry order, never wrap before 8; show initials in the disc everywhere (`SharedIdentityMark` currently draws a blank circle, `Components.swift:312-327`). Effort M. **Confidence:** verified in code.

### 5. Category discs reuse identity hues (S2) , Challenges a decision
- **Evidence:** Home rows paint the Internet icon disc `Pal.purple` (lilac) and Dinner `0xF9D2BF` (`HomeView.swift:489`); the board does the same (`09-home`, `16-activity`, `55-settled` uses lime for "Repayment"). Lilac is also the "Alex + Jo" group colour in the same frame. Activity rows (`ActivityRowView`, `Components.swift:471`) show the payer's group mark instead, so one record has two anatomies.
- **Why it matters:** lilac teaches two meanings on one screen; the contract says colour is for people/groups.
- **Trade-off:** the category colours make the board playful; keeping them costs the clean "colour = who". Fix: category discs neutral (`chip`) or from a separate warm set that never overlaps the identity set (peach, butter-light), and the payer shown as a small group-coloured dot. One row anatomy for Home and Activity. Effort S. **Confidence:** verified in code + design frame.

### 6. Money has no component; the signature amount works only for `€` at default text size (S2)
- **Evidence:** the same amount is set in 8 treatments: Bricolage 75 (Home), Bricolage 69 (Add/review), `.largeTitle.weight(.semibold)` (Settle amount `SheetViews.swift:896`, Legacy add `AddExpenseView.swift:29`), SF Rounded 36 (Edit `:670`), SF Rounded 13.5 and 17 (allocations, contest cards), system 12.5 secondary (detail header `:229`), system 17 (rows). Board `12-detail` makes the amount the hero (Bricolage 69); native detail demotes it to "€96.00 · Expense" at 12.5pt. The raised small `€` + large digits treatment is gated on `amount.hasPrefix("€")` (`BudgetGroupExpenseFlow.swift:356`, `HomeView.swift:277`, and Home also requires `typeSize == .large`). GBP and USD are first-class in the picker (`OnboardingViews.swift` currency list) and a device region such as DE or FR formats `84 €` with the symbol after the digits; those households get a plainer amount. At any Dynamic Type step other than default, Home falls back to full-size `€`.
- **Why it matters:** the amount is the product. It should look identical wherever it appears and survive every currency and text size.
- **Fix:** `MoneyText(minor:, role:)` with roles `hero(75)`, `large(69)`, `row(17 semibold)`, `inline(13)`; build it from `Decimal.FormatStyle.Currency(...).attributed` so the currency run is raised/smaller and the fraction run can be `ink2` (the board's `96.` + grey `00` on `22-expense`) in any currency and locale. Effort M. **Confidence:** verified in code.

### 7. Four typefaces, ~50 font specs, no scale; Bricolage use is uneven (S2)
- **Evidence:** families: Bricolage (13 sizes: 11, 16, 17, 22, 23, 28, 30, 33, 37, 45, 53, 69, 75), SF (`NumaFont.system` 12 sizes incl. 12.5, 13.5; 210 semantic text-style calls), SF Rounded (7 sizes incl. 14.5, 13.5; avatar initials at `size*0.34`), SF Mono (8.5, 9.5). Mono 8.5/9.5 caps ("ALLOCATION", "REVISION HISTORY", "Needs choice", `SheetViews.swift:342,519,589,609,613`) sit under the declared `Metrics.minOrdinaryText = 11`. Five `Text` sites use non-scaling `.font(.system(size:))`: `AddExpenseView.swift:344,415,456`, `SheetViews.swift:1036,1071`. The Home wordmark is `NativeTextLabel(text: "numa", … weight: .bold)` (`HomeView.swift:232`), which is SF Bold, not Bricolage; the Welcome wordmark is Bricolage 45 (`OnboardingViews.swift:17`); board `09-home` shows Bricolage. Avatar initials are rendered four ways: SF Rounded (`AvatarView`), Bricolage 11 (`HomeIdentityPair`), Bricolage 17 (`ExpenseFlowAvatars`), Bricolage fixed 16 (`OnboardingViews.swift:643`). DESIGN.md says "system text carries … amount entry, receipts"; the approved board and the shipped Add flow set amount entry in Bricolage 69.
- Text itself is forked three ways (SwiftUI `Text`, UIKit `NativeTextLabel`/`WrappingTextLabel` in ~17 places added to appease the accessibility audit, and `NumaFont.system` baking a `UIFont` that needs `let _ = dynamicTypeSize` in three views).
- **Fix:** a 10-role scale, Apple text styles underneath so Dynamic Type is native: `amountHero 75/amountLarge 69` (Bricolage), `title 37`, `titleSheet 28`, `section 22` (Bricolage), `rowTitle 17 semibold`, `body 17`, `secondary 15`, `meta 13`, `caption 12` (floor 12; delete 8.5/9.5/9/10/11 text). Drop SF Rounded and SF Mono. Initials: Bricolage everywhere via one `InitialsDisc`. Wordmark: Bricolage on Home. Fix DESIGN.md Typography to match the board. Effort M. **Confidence:** verified in code.

### 8. ~14 button recipes, 5 primary CTAs, and the busiest controls have no press feedback (S2)
- **Evidence:**
  - Primary ink pill: `PrimaryPillButton` (54 default, 3 callers pass 52, `.headline`, no arrow, `Components.swift:557`), `SetupPrimary` (56, callout semibold, arrow), the Add-flow CTA inline in `page()` (56, system 16 semibold, arrow, `.buttonStyle(.plain)`, `BudgetGroupExpenseFlow.swift:306-314`), Welcome inline (56, `.white` text in light instead of `palette.bg`, `OnboardingViews.swift:123`), RootView recovery/update (50). Sign in with Apple is 54. The board's CTA is 56.
  - Secondary: chip pill (50), ink 1.5pt outline (×5 hand-written in `SheetViews.swift:376-452`), destructive outline (×2), hairline-outline pills (filters, payer menu, category), plain text buttons, system `.bordered` (`SheetViews.swift:923`). `SecondaryPillButton` exists and is never called.
  - Icon buttons: chip circle 44 (back/close, 8 hand-built sites), toolbar `xmark.circle.fill` (`SettingsView.swift:249`), `chevron.left` 13pt in a circle (`SheetViews.swift:869`).
  - Disabled: `.opacity(0.45)` on `PrimaryPillButton` (5 callers) vs chip fill + `ink2` label in `SetupPrimary`/Add flow.
  - Press feedback: 28 `.buttonStyle(.plain)` vs 42 `PressableButtonStyle`. The Add-flow CTA, every keypad key (`BudgetGroupExpenseFlow.swift:426`), payer rows and beneficiary rows are `.plain`. SwiftUI's plain style gives at most a system dim, no scale: inferred. The board's CSS has a global `button:active{scale:.96}`.
- **Why it matters:** the keypad and "Who paid?" are the most-tapped controls in the app and are the least tactile.
- **Fix:** one `NumaButtonStyle(kind: .primary/.secondary/.quiet/.destructive)` at 56pt (min 44 at AX), one `NumaIconButton`, one disabled idiom (chip fill, `ink2` label), all with the press spec in finding 9. Effort M. **Confidence:** verified in code.

### 9. Motion and haptics have no tokens; the orb is not yet physical (S2)
- **Evidence:**
  - Specs in use (12 sites): spring(0.15,1.0) press ×42 call sites; orb easeOut 0.12 press / 0.22 release; spring(0.3,0.8) ×2 (avatar select, undo bar); spring(0.35,1.0); spring(0.4,1.0) (`AppModel.swift:993`); easeOut 0.2/0.22; linear 0.3 shake; linear 0.28 hold arc. Two spring personalities (damping 1.0 vs 0.8). No use of `.smooth/.snappy/.bouncy`.
  - DESIGN.md says "about 120ms press, 220ms release, interruptible". Only `SharedOrbButtonStyle` matches (`Components.swift:335`). Everything else is a 150ms-ish spring.
  - Orb press: scale 0.97 **and** `opacity(0.82)` (`:333-334`). Dimming to 82% washes the orange toward paper instead of compressing a solid object.
  - `Haptics.activated()` fires in the Button action, i.e. on touch-up, concurrent with the cover animating (`HomeView.swift:382`). `Haptics.holdFired()` and `HoldProgressArc` have no callers. `Haptics.locked()` (rigid) fires once, in Setup when grouping a couple (`AppModel.swift:3092`). Vocabulary: 14 `saved`, 34 `warned`, 1 `locked`, 1 `activated`; nothing on selection (split mode, payer, beneficiary), none on keypad.
  - Orb → Add continuity is gone: `RootView.swift:34` is a plain `fullScreenCover`; grep for `matchedTransitionSource`/`navigationTransition` = 0 (the July build had `.navigationTransition(.zoom)`, DECISIONS.md). `contentTransition(.numericText)` = 0 uses (also removed). After save the cover just dismisses with a success haptic and the Undo bar (`AppModel.swift:4159-4163`); the board's save frames (`31-saved`, "Written down. Sorted out.") and `55-settled` ("All square. Go enjoy the day.") are not implemented (grep: 0 hits).
  - Reduce Motion is handled for press, orb, undo, scroll, shake; `AvatarView`'s selection spring/scale has no check (`Components.swift:300-304`, trivial).
- **Fix:** `NumaMotion`: `press` = 120ms easeOut to scale 0.96 (no opacity change), `release` = spring(response 0.22, damping 0.7), `settle` = spring(0.4, 1.0), `reveal` = easeOut 0.22; Reduce Motion = opacity-only. Orb haptic on touch-down via `configuration.isPressed` edge. `UISelectionFeedbackGenerator` for discrete choices only; no keypad haptic. Restore `.navigationTransition(.zoom)` from the orb. Roll balance digits with `.contentTransition(.numericText())`. Effort M. **Confidence:** verified in code.

### 10. The two Metal shaders do not earn their cost because nothing runs them; neither does a lot of other superseded code (S2)
- **Evidence:** `VesselOrb.metal` (107 lines): no caller (`vesselOrb` appears only in its own file). `FieldSpace.metal` (101) + `FieldSpaceView.swift` (55): `FieldSpaceView` is never instantiated. Both compile into the target (the project is a folder-synchronized group; only `Info.plist` is excluded, `project.pbxproj:34-60`). `VesselView` (`Components.swift:341`) is pure `RadialGradient` + two inner shadows + a highlight ellipse, and carries 9 dead parameters (`ringUnits`, `beadUnits`, `rotation`, `isEngaged`, `pulseDate`, `stillsShimmer`, `contentFont`, `beadFont`, `unitInfos`). Also dead: `HoldProgressArc` (`:34`), `NativeCapsuleButton` (`:143`, 85 lines), `SecondaryPillButton`, `Haptics.holdFired`, the `Metrics` drag radii, 8 palette fields, the aurora hues `8B97E8/A98FE0/4A57B8/6B4FB0` (July indigo art direction). `LoadingHomeSkeleton` (`RootView.swift:219-258`, the first thing painted on every cold launch) is still the July "three discs on an even line" layout, in grey chips on paper, followed by the butter Home. `LegacyAddExpenseView` (`AddExpenseView.swift:12`) is a second add flow with system-font amounts, white keypad keys (`KeyButtonStyle`, radius 10) and a different segmented control.
- **Verdict on shaders:** zero runtime cost today, zero benefit, ~210 lines of maintenance and a toolchain dependency (Metal toolchain download is recorded in DECISIONS.md). The glass-nebula orb and aurora field contradict DESIGN.md ("authored native geometry… no CSS glass", "offscreen effects do no continuous GPU work") and the butter palette. Delete both and `FieldSpaceView`. If a shader signature is wanted, write one ~30-line press-driven `orbPress` (specular slides and body squashes with the press value; no timeline, no idle cost).
- **Effort:** S (delete) / M (new shader). **Confidence:** verified in code.

### 11. Dark mode keeps the pastel identities but drops the butter and has three real defects (S2)
- **Good (inferred from tokens):** the dark family is derived from the ink hue (`bg 1C211E`, `surface 282F29`, `chip 343C33`, all hue ~140°) and the lime/lilac/sky fills stay full-brightness (12.9, 9.0, 11.0:1 against the dark bg), so group identity reads strongly. The orb is unchanged and reads 4.4:1 on the dark bg.
- **Defects:**
  1. `home` dark is `0x3E3E28` (`Theme.swift:30`): hue 60°, sat 0.35, value 0.24, a khaki. Butter is hue 48°. It is only 1.5:1 from the canvas, so Home's panel is a dull slab, not a yellow object.
  2. `Pal.destructive = 0xBE3A4A` is not adapted (`:91`) and is used as text and stroke on the sheet surface (`SheetViews.swift:403,407,445,449`): **2.55:1** on dark `surface`, 3.03:1 on dark `bg` (fails even large-text 3:1). In light it is 5.39:1.
  3. `AccentColor.colorset` is a single `#101316` with no dark appearance. `.tint(palette.ink)` covers SwiftUI controls (`RootView.swift:78`), but alerts, confirmation dialogs and other UIKit-hosted chrome take the window accent (inferred; verify on device). `Toggle`s are `.tint(palette.ink)` (`SettingsView.swift:61,98`): in dark the on-track is `F8F6F0` and the thumb is white, **1.08:1** (inferred, system thumb is white).
  - Also: hard-coded light-only neutrals with an `isDark` branch in 5 places (`OnboardingViews.swift:46,358,420,519`, `HomeView.swift:237,546`), `Pal.light.identityInk` forced in `ExpenseFlowAvatars` (fine for pastel fills, but undocumented), and the board has **no dark frames** (README says so), so dark is unspecified, not designed.
- **Fix:** dark Home panel `#4A3F1A` (hue 46°; paper ink on it 9.6:1, butter-coloured numerals on it 7.8:1) and set the dark headline/amount in butter `F4DE8A` so the identity moves from the surface to the ink; `Pal.destructive` dark `#F0868F` or similar (≥4.5:1 on `282F29`); add a dark `AccentColor` (`F8F6F0`); replace `Toggle` + `.tint(ink)` with a small `NumaToggleStyle` (ink track and paper thumb in light, inverted in dark) because SwiftUI cannot recolour the system thumb; draw 6 dark frames (Home, Add, Review, Activity, Settings, Welcome) before more code. Effort M. **Confidence:** computed + inferred.

### 12. App icon, launch frame and accent still belong to the July brand (S2)
- **Evidence:** `Assets.xcassets/AppIcon.appiconset/AppIcon.png` (viewed): near-black field, a white disc, an indigo and a mint satellite. The September system is butter/orange/lime/lilac; the marketing site (`web-marketing/styles.css`) already uses the new palette. The dark variant is the same July art (tinted variant not viewed). Launch screen is `UILaunchScreen_Generation = YES` with no colour (`project.pbxproj:465,500`): system white/black, then the grey skeleton (finding 10), then butter. AccentColor is `#101316` (finding 11).
- **Why it matters:** the icon and the first 400ms are the first and most-seen brand surface; they currently show a different product.
- **Fix:** icon = two overlapping discs (lime + lilac, the app's couple/pair mark) with a small orange orb at the overlap on butter, plus dark/tinted variants; launch colour asset = butter (light) / `4A3F1A` (dark); replace the skeleton with a butter panel + chip placeholders. Effort M (icon art) / S (launch + skeleton). **Confidence:** verified (image + project settings).

### 13. Home's panel never changes with state; the board's lime state collides with identity (S2) , Challenges a decision
- **Evidence:** `palette.home` is the only panel fill (`HomeView.swift:221`; grep shows `palette.home` is never swapped). Board `54-empty` and `55-settled` flood Home lime with a green "all square" sphere, `56-offline` pale butter `EFE3B3`. Native empty/settled show the same butter panel; settled renders "All square.\nNo one owes anyone." and a 75pt `€0` (`HomeView.swift:112,123`).
- **Challenge:** lime is also the identity colour of "You + Sam" in the same board. A lime panel means "settled" and "your group's colour". Fix: signal the state with something outside the identity set (paper-bright panel with an ink check sphere, or butter with the orb replaced by a settled sphere), or make the identity set exclude the state colour. Settled should read as a distinct moment, not a recolour. Effort M. **Confidence:** verified in code + design frame.

### 14. Shapes and surfaces drift: 8 radii, no continuous corners, 5 near-identical neutrals (S3)
- **Evidence:** radii in use: 2, 10, 12 (×7), **14 (×16)**, 15, 16 (×5), 18 (×6), 24 (×2), plus 30 (Home panel). `Metrics` offers 12/16/20/34. None of the 44 `RoundedRectangle`s passes `style: .continuous` (grep: 0); SwiftUI's default is circular arcs, unlike hardware, sheets and system controls. Nesting is not concentric: the 3-way split control is a `RoundedRectangle(cornerRadius: 24)` around 44pt capsules with 4pt padding (`BudgetGroupExpenseFlow.swift:199`) = a 52pt-high container whose concentric radius is 26; the Undo bar has the same 24-on-52 mismatch (`Components.swift:687`; the board toast is 15). Neutrals: `chip EEEBE2` plus hard-coded `EEECE4`, `EEEADF`, `EBE8DD`, `E8E7DD` (`OnboardingViews.swift:358,420,519`, `HomeView.swift:546`); the CSS has ~8 more (`#EAE7DB`, `#EAE7DD`, `#ECE9DF`, `#e6e4db`…). Hairline and chip as control boundaries are 1.27:1 and 1.10:1 on paper (computed), fine for dividers, weak as the only edge of the payer/category fields in the legacy flow.
- **Fix:** three radii `field 12`, `card 16`, `panel 30` plus `Capsule`, all `.continuous`; use iOS 26 `ConcentricRectangle` for nested chips; two neutrals (`chip`, `chipStrong`) plus the butter-adjacent `notice`; give outlined controls a `palette.ink2` 1pt edge or a fill, not `hair`. Effort S. **Confidence:** verified in code.

### 15. Contrast: sound for text, with exceptions (S3)
See the table in Appendix B. Highlights, all **computed**: `ink2` on paper 5.49, on surface 5.93, on chip 4.98; `homeSecondary` on butter 5.23 (plain `ink2` would be 4.43, so the special token is justified); all identity inks 7.9 to 11.4:1; dark `ink2` on bg/surface/chip 9.6/8.1/6.7. Exceptions: destructive on dark (finding 11); `ink2` on lilac 3.28 and sky 3.99 (latent: only safe if the People group blocks from board `40-people` use `identityInk`, as the CSS does); white on orange 3.68 (unused, and the orb uses `orangeInk`, 3.2 on the flat orange and 4.7 at the centre where the "+" sits); the `numa.` dot `8B702E` on butter 3.52 (passes as large text). `IdentityColorContrastTests.swift` asserts the identity pairs for teal and amber only (no lilac/purple pair, no dark identity, no destructive); extend it with those four.
- **Effort:** S. **Confidence:** computed.

### 16. The tab bar is a CSS-glass imitation under an opaque overlay, and it is not a tab bar (S3) , Challenges a decision
- **Evidence:** `Capsule().fill(.regularMaterial)` with a 95%-opaque fill on top (`HomeView.swift:516-517`) means the material is invisible. `selected: true` is hard-coded on Home (`:509`); Activity and People open sheets. The app targets iOS 26 and uses `glassEffect` nowhere (grep: 0), while every system sheet, menu and toolbar around it renders in Liquid Glass. DESIGN.md: "Native iOS material belongs to navigation; do not reproduce CSS glass effects throughout the app." This bar is the one reproduction.
- **Trade-off:** the board shows a floating pale capsule; real Liquid Glass would shift per background and may reduce the "paper" feel. Fix: either `glassEffect(.regular.interactive(), in: .capsule)` inside a `GlassEffectContainer` (with the existing opaque path for Reduce Transparency), or drop the material call and make it an honest opaque surface. Effort S. **Confidence:** verified in code.

### 17. Pixel-conformance machinery bakes one CSS frame at one text size into the code (S3) , Challenges a decision
- **Evidence:** `referenceLeadingInset` + a `ViewThatFits` that branches on `typeSize == .large` in 6 places (HomeView ×2, Add flow ×2, Onboarding ×2), fractional constants `35.635, 38.85, 52.47, 75.9, 82.5, 50.5, 75.3, 51.5, 48.3`, `.padding(.top, 75)` for the Dynamic Island (`HomeView.swift:219`, = 59 + 16; safe-area-agnostic), and each heading is written twice (a pinned line box and a natural fallback). It follows the owner's "pixel-by-pixel conformance" instruction in DESIGN.md.
- **Trade-off:** fidelity to one frame at one size vs. a base that nobody can change without breaking the lock. Fix: conform at the **token and role** level (inset 25, type roles, 56pt CTA, 1.08 leading) and verify with screenshots; replace the pinned line boxes with one `NumaDisplay` view using iOS 26 line-height control (`AttributedString.LineHeight .multiple(factor: 1.08)`; verify it is in the SDK in use) or `.lineSpacing`; derive the Home top inset from `safeAreaInsets.top`. Effort M. **Confidence:** verified in code.

### 18. Two icon families for the same glyphs (S3)
- **Evidence:** `HomeIcon` is a coherent 18-glyph, 1.7pt round-cap set lifted from the board (25 uses). 57 other sites use SF Symbols. Back/close exist as `HomeIcon(.back/.close)` (Add flow, Setup), `chevron.left`/`xmark` (sheets), `xmark.circle.fill` (Settings, Activity search); people/lock/arrow/search likewise.
- **Fix:** decide: `HomeIcon` for anything the board draws (including Settings rows, board `45`), SF Symbols only for system-owned controls; add the missing glyphs (receipt, bell, cloud, share, doc) in the same stroke. Effort M. **Confidence:** verified in code.

## Ground-up rethink

### The ONE signature idea (three candidates)

What the system has today that is ownable: butter, a chunky grotesque that writes sentences, the pair-of-overlapping-discs for couples, and one glossy orange sphere. What is missing is one *repeated* device a stranger would recognise in a screenshot or a 3-second screen recording.

**A. "Pebbles on a table" (the Duolingo-3D-button analogue).** Make the shared-table metaphor literal: every tappable is a physical object resting on paper. The orb is the glossy one; ink CTAs are matte ink pebbles with a 1.5pt darker lip and a tight contact shadow; group chips and avatars are matte coloured pebbles; keypad keys stay flat for speed. Press = scale 0.96 + lip collapses 2pt + shadow tightens (120ms easeOut), release = 220ms spring with a tiny overshoot, soft haptic on touch-down for primary pebbles only. The orb stops being the single 3D thing in a flat app and becomes the loudest member of a family. Shows in static screenshots on every screen. Cost M. Risk: can read as a Duolingo clone or as skeuomorphic; mitigate with tonal shading (no hard black edge), Reduce Motion = static lip, Reduce Transparency = no shadow.

**B. "The pour" (the Things-checkbox analogue): one continuous object from tap to ledger.** Tap the orb: it compresses (120ms), the Add screen zooms out of it (`navigationTransition(.zoom)`, restored), the `+` becomes the currency glyph, typed digits roll in with `numericText`. Save: the sheet closes, the Home balance digits roll to the new number, the orb gives one gleam and a `.success` haptic; if the balance reaches zero the orb settles into its check state. Under 600ms, never blocks entry or save, Reduce Motion = crossfade + haptic. This is the most repeated reward in the product and it is the PRODUCT.md promise ("the tactile sphere is the signature interaction") made real. Cost M. Invisible in App Store stills.

**C. "Scoped colour" (the Arc-spaces analogue).** Colour says whose page you are on: butter = the household, a group hue = that group, orange = act, ink = utility. Tapping a group chip floods the Home panel with that group's hue (circular reveal from the chip, 300ms); group history, group balance and group blocks wear the same hue; the Add flow tints the payer row. With the identity set grown to 8 (finding 4) and a state colour outside it (finding 13), it also fixes dark mode: in dark the hues become the ink on dark panels. Cost L. Risk: more colour pairs to test; must never imply debt direction (it only names a group).

**Recommendation:** A as the system-level signature (the only one visible in static screenshots, the cheapest way to make the orb belong, and the literal "shared table"), with B as its first and best use. C is the right second step once the identity set is fixed.

### Other bolder ideas

1. **A `Numa*` kit instead of 14 button recipes and 6 screen layouts.** `NumaScreen`, `NumaRow`, `NumaGroupBlock`, `NumaNotice`, `NumaButtonStyle`, `NumaIconButton`, `MoneyText`, `InitialsDisc`, `NumaMotion`, `NumaType`. Every existing screen is re-expressed in them; a build-time grep check forbids `Color(hex:`, `.font(.system(size:`, `cornerRadius: n` outside the kit. What the user sees: Settings, People, Activity and Opening balance suddenly look like Home's siblings, and amounts look the same everywhere.
2. **Dark as a designed night table.** Butter moves from surface to ink: dark Home panel `#4A3F1A`, headline and amount in butter, group chips unchanged, orb unchanged. Draw it on the board first. The user sees a warm lamp-lit table, not a recoloured light theme.
3. **Amounts as typography, not text.** `MoneyText` raises the currency, greys the fraction while entering, rolls digits on change, and uses tabular numerals in every list. Entering `96` shows `€96.` + grey `00` growing into black as the user types cents.
4. **The pair mark as the brand glyph.** Two overlapping discs (lime, lilac) with the orange orb at the intersection: app icon, empty states, loading, the Home chip pair and the Welcome art are all that one shape. It says the product in one glyph: two budgets, one shared thing.
5. **State through shape, not hue, on Home.** Settled replaces the orb with a settled sphere and the amount line with "All square." in the same butter panel; offline slides in the existing butter notice. Keeps colour for people/groups only.

## Quick wins

1. Delete `VesselOrb.metal`, `FieldSpace.metal`, `FieldSpaceView.swift`, `HoldProgressArc`, `NativeCapsuleButton`, `SecondaryPillButton`, 8 dead palette fields, 12 dead `Metrics` constants and the 9 dead `VesselView` parameters (~400 lines, no behaviour change).
2. Replace `.buttonStyle(.plain)` on the Add-flow CTA, keypad keys and payer/beneficiary rows with the press style; remove the orb's `opacity(0.82)`; fire the orb haptic on touch-down (`Components.swift:333`, `HomeView.swift:382`, `BudgetGroupExpenseFlow.swift:314,426`).
3. Fix colour truth in one pass: rename `indigo/teal/amber`, adapt `Pal.destructive` for dark (≥4.5:1 on `282F29`), add a dark `AccentColor`, set the dark Home panel to `#4A3F1A`, and extend `IdentityColorContrastTests` with lilac, dark identity and destructive.
4. Put the Home wordmark in Bricolage (`HomeView.swift:232`), raise the mono 8.5/9.5 text to 12 and move the 5 non-scaling `Text(.system(size:))` sites to scaled styles.
5. Launch and brand: butter launch-screen colour, replace the July skeleton with a butter panel, and commission the new icon (finding 12).

## Appendix A: counts and worst offenders (verified in code, `ios/NumaShared/NumaShared`)

| Metric | Count | Worst offenders |
|---|---|---|
| `Color(hex:` outside `Theme.swift` | 29 (19 excluding dead `FieldSpaceView`) | FieldSpaceView 10, OnboardingViews 8, Components 7, HomeView 4 |
| `Color(hex:` in `Theme.swift` | 43 | n/a |
| `palette.isDark ? … : Color(hex:)` branches | 13 | HomeView 6, OnboardingViews 5 |
| `.font(.system(size:` | 24 (5 are non-scaling `Text`) | SheetViews 10, AddExpenseView 5 |
| `NumaFont.system` / `.rounded` / `.mono` / `.display` calls | 53 / 9 / 6 / 25 | SheetViews 33 `NumaFont.*` calls |
| Semantic text-style `.font` calls | 210 | n/a |
| Distinct Bricolage sizes | 13 | n/a |
| `cornerRadius:` literals | 44 (8 values) | SheetViews 17, AddExpenseView 5, OpeningBalanceView 5 |
| `.continuous` corners | 0 | n/a |
| `.padding(` calls / using `Metrics.space*` | 294 / 0 | SheetViews 68, OnboardingViews 55, BudgetGroupExpenseFlow 27 |
| Numeric `.frame(` literals | 163 | n/a |
| Horizontal inset values | 15 distinct (25 ×13, 16 ×12, 20 ×8, 22 ×7, 24 ×6…) | n/a |
| `withAnimation`/`.animation(` sites | 12 (≈11 distinct duration/curve pairs) | Components 5 |
| `.buttonStyle(.plain)` / `PressableButtonStyle` | 28 / 42 | n/a |
| Haptic call sites | 14 saved, 34 warned, 1 locked, 1 activated | AppModel |
| SF Symbol sites vs `HomeIcon` | 57 vs 25 | SheetViews 14, PeopleManagementView 13 |
| Dead components | `HoldProgressArc`, `NativeCapsuleButton`, `SecondaryPillButton`, `FieldSpaceView`, 2 shaders, `ShakeEffect` (legacy-only) | Components.swift |

## Appendix B: contrast (computed WCAG 2.x, token hexes, sRGB)

| Pair | Ratio |
|---|---|
| ink `252B27` on paper `F8F6F0` / surface / chip | 13.37 / 14.45 / 12.12 |
| ink2 `62655D` on paper / surface / chip | 5.49 / 5.93 / 4.98 |
| ink2 on butter `F4DE8A` (not used) | 4.43 |
| homeSecondary `655832` on butter | 5.23 |
| onboarding secondary `5B5237` on butter | 5.79 |
| `numa.` dot `8B702E` on butter | 3.52 (large text) |
| ink on Repay capsule (white 56% over butter) | 12.66 |
| identityInk on lime / lilac / sky / peach | 11.40 / 7.97 / 9.72 / 8.43 |
| tealInk / purpleInk / amberInk on own fills | 9.25 / 7.98 / 7.88 |
| ink2 on lime / lilac / sky (latent) | 4.68 / 3.28 / 3.99 |
| white on orange `E9522D` | 3.68 |
| orangeInk `572B20` on orange flat / orb centre | 3.22 / 4.67 |
| orange vs paper / vs butter (graphic) | 3.40 / 2.74 |
| lime vs lilac / lime vs sky / lilac vs sky | 1.43 / 1.17 / 1.22 |
| hair `DEDCD1` / chip as edge on paper | 1.27 / 1.10 |
| destructive `BE3A4A` on paper / surface / chip (light) | 4.99 / 5.39 / 4.52 |
| dark: ink on bg / surface / chip | 15.11 / 12.71 / 10.56 |
| dark: ink2 on bg / surface / chip | 9.59 / 8.07 / 6.70 |
| dark: ink3 on bg / chip | 7.60 / 5.31 |
| dark: ink / homeSecondary on dark Home `3E3E28` | 10.10 / 6.41 |
| dark: lime / lilac / sky vs bg | 12.89 / 9.02 / 10.99 |
| dark: **destructive on surface / on bg** | **2.55 / 3.03** |
| dark: orange vs bg | 4.44 |
| dark Home `3E3E28` vs bg (surface separation) | 1.50 |
| proposed dark Home `4A3F1A`: paper ink / butter text on it | 9.63 / 7.76 |
| Toggle white thumb vs dark tint `F8F6F0` | 1.08 |

## Appendix C: token honesty

| Swift token | Hex | What it actually is | Also called |
|---|---|---|---|
| `Pal.indigo` | `52672B` | dark olive green | none (only feeds `wovenRing`) |
| `Pal.teal` / `tealInk` | `D8EF7F` / `303C1E` | lime / citrus | `--lime`, `group-citrus` |
| `Pal.amber` / `amberInk` | `BBD8EA` / `243B47` | pale sky blue | `--sky`, `sky` |
| `Pal.purple` / `purpleInk` | `CAB8ED` / `302440` | lilac | `--lilac`, `group-lilac` |
| `Pal.orange` | `E9522D` | vermilion / terracotta | `orb` |
| `Pal.destructive` | `BE3A4A` | rose red, not the board's `A02D1D` | `.form-error` |
| `Palette.identityInk` | `252B27` | the ink itself, constant | duplicates `tealInk` role |
| `Palette.ink3` (light) | `62655D` | identical to `ink2` | n/a |

## What I could not check
Rendered appearance on any device, Liquid Glass behaviour of system chrome around the custom bar, UIKit alert tinting with the single-appearance AccentColor, whether `AttributedString.LineHeight` exists in the exact SDK in use, and the dark-mode look of Home (no board frame, no screenshot).
