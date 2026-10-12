---
name: Numa Shared — The shared table
description: A warm, physical companion for everyday shared expenses.
colors:
  paper: "#F8F6F0"
  ink: "#252B27"
  secondary: "#62655D"
  home: "#F4DE8A"
  group-citrus: "#D8EF7F"
  group-lilac: "#CAB8ED"
  orb: "#E9522D"
  sky: "#BBD8EA"
typography:
  display:
    fontFamily: "Bricolage Grotesque"
    fontWeight: 700
  body:
    fontFamily: "iOS system"
spacing:
  content-inset: "25pt"
  minimum-tap-target: "44pt"
---

# Design System: Numa Shared

## Overview

**Owner approved September 12, 2026: “I love it!”** The selected reference is the
complete 60-frame `design/interface-v2/` canvas, not the rejected violet raster.
This file records approved design intent; native implementation and runtime proof
are separate. The owner subsequently observed substantial Simulator drift and
required pixel-by-pixel conformance. The canvas is a visual specification, not
merely inspiration. Match synthetic data, locale, viewport and normal text size;
compare native/reference captures and pixel-difference overlays screen by screen.
Document OS chrome/font rasterization differences without masking app layout,
spacing, type, icon, material or navigation defects. Accessible/dark adaptations
have separate evidence and must not excuse ordinary-layout drift. Track every
one of the 60 reference states; a shared palette or Home-only pass is incomplete. The canvas is editable HTML/CSS/JS, not an actual Figma document.

Fun, colorful and social, with grown-up clarity. A warm shared table for “I'll get
this” moments, not a serious finance dashboard, generic card wall or cartoon.
Expression belongs to Home, onboarding and the tactile add orb. Arithmetic,
recovery and consequential actions are quieter, exact and trustworthy.

## Colors

Light-mode tokens above match the approved canvas. Butter is Home's continuous
safe-area/top surface; paper supports working content. Citrus and lilac identify
budget groups, never debt direction. Keep names and financial direction explicit
without color. Orange belongs to the add orb, not debt warnings or every CTA.
Native dark appearance must preserve that identity with readable adapted surfaces;
never invert whole rendered screens or claim the light board verifies dark mode.

## Typography

Licensed Bricolage Grotesque 700 gives headings and the balance their character;
use the bundled font and preserve its SIL OFL. System text carries controls,
amount entry, receipts and supporting content. Exact amounts must remain readable.
Use native Dynamic Type and reflow, not fixed-height clipping, compressed names or
shrinking away accessibility. Body text and full group names outrank decoration.

## Layout

Home flows from household/Settings to named group identities, debtor/creditor
sentence and dominant exact amount with a why disclosure. Record a repayment is
separately labeled; explain that money changes hands outside Numa. Below the
butter panel: physical orb and fully tappable “Add an expense” row, then quiet
recent activity. Native navigation remains familiar and adaptive.

Use approximately 25pt working insets and at least 44pt targets. Colored group
containers are earned by identity; ordinary content uses spacing and thin rules.
Multi-group balances, settled/empty states, hidden amounts and offline recovery
must remain truthful. Undo uses a reserved safe-area lane above navigation,
never an overlay obscuring the orb, repayment or another primary action.

## Elevation & Depth

The orb is authored native geometry/material with physical shading, not a bitmap
of UI. Keep content on opaque readable surfaces. Native iOS material belongs to
navigation; do not reproduce CSS glass effects throughout the app. Reduce
Transparency and Low Power retain legibility with lower-cost rendering.

## Components

- **Add orb/row:** native accessible button, full labeled tap equivalent. About
  120ms press compression and 220ms release/open, interruptible. One activation
  haptic; no idle loop, mandatory long press, hidden drag or drag-to-pay.
- **Balance/why:** full financial group ownership, exact currency, clear debtor
  and creditor. Never turn couple members into separate financial counterparties.
- **Reviews:** typographic receipts, actual payer vs recorder vs group allocation
  made explicit; correction/void/overpayment consequence explained before commit.
- **Motion:** responds to user input, never blocks entry or saving. Reduce Motion
  keeps quiet pressed feedback. Offscreen effects do no continuous GPU work.
- **Navigation:** system controls and safe areas, explicit dismiss/cancel paths;
  do not replace functional screens with decorative dead ends.

## Do's and Don'ts

Do preserve integer-money, append-only history, local-first identity, privacy and
all existing recovery/export/deletion flows. Do test real SwiftUI journeys,
Dynamic Type, VoiceOver semantics, reduced settings and dark mode. The board's
synthetic fixtures are independent examples, never real Sheet rows or a ledger.

Don't add charts, banks, AI bookkeeping, new services, subscriptions or within-
couple debts. Don't equate design approval, a screenshot, build success, upload,
Apple processing or physical installation: each requires its own evidence.
