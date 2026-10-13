# Numa Shared app (Expo)

One TypeScript codebase for iPhone, Android and the web, replacing the SwiftUI app in `ios/`. The design follows the approved direction "Color is who": a color always means a group of people, orange means add, and the history reads as a conversation.

## Run

```bash
cd app
npm install          # .npmrc sets legacy-peer-deps
npx expo start       # i: iOS simulator, a: Android, w: web
npm test             # ledger core tests (vitest)
npm run typecheck
```

## Layout

| Path | What |
|---|---|
| `src/core/` | Pure ledger core: integer money, exact-sum allocation, events, reducer, explanations, exact minimum settlement plan, undo policy. No React. Ported from `NumaSharedCore` and tested against its vectors. |
| `src/store/` | Local-first household store. Every change is a validated, appended event. Persists on the device. |
| `src/ui/` | Tokens and components: orb, bands, ticket, keypad, split bar, undo lane, sheets that grow from the orb. |
| `src/features/` | Screen building blocks (home bands, history thread, record detail, add flow, settings). |
| `src/sheets/` | Sheets opened over any screen (add, repay, detail, balance plan, void, flag, households, sign out). |
| `src/app/` | Routes (Expo Router). Phones get the stacked layout; the web gets three panes at desk width. |

## Product contracts kept

- Money is integer minor units. Splits sum exactly. Balances are derived from events and always zero-sum.
- History is append-only. Edits keep the old version, voids keep the record. Only an unsent event inside its 8-second undo window can disappear.
- Groups are fixed once money is recorded, so past balances never change silently.

## Build variants

`APP_VARIANT=preview` builds "Numa Shared Preview" (`tech.arsik.numashared.preview`), so a test build never replaces the app people already use. See `eas.json`.

## Not in this version yet

- Sync and sign-in. Data stays on the device. The next step is a sync adapter for the existing Convex backend (`convex/`), which also needs two backend contract additions: an optional `note` on expenses and repayments (stored like the other erasable text fields), and an optional payment method on repayments.
- Push notifications (arrive with sync).
