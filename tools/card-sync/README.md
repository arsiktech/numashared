# Card sync for ether.fi Cash

Adds spends on chosen ether.fi Cash cards to a shared Numa Shared household by themselves. Useful when you
gave someone in the household one of your cards: every spend on it is added as "you paid, for them".

ether.fi has no public API, so this script runs on your own computer. It opens ether.fi's transaction
history in a browser profile where you are logged in, keeps only final spends on the cards you chose and
sends those to Numa Shared. Your ether.fi login never leaves the computer. The key it uses can only add
card spends to that one household.

```
ether.fi (logged-in browser on your computer)
   │  card transactions the history page loads
   ▼
sync.mjs ── keeps final spends on the linked cards since "since"
   │  POST /card-sync/spends  (Bearer key)
   ▼
Numa Shared ── ignores other cards, skips spends it already has
   │
   ▼
household: "<you> paid  €12.30  Corner Shop  for <their group>"
```

## Set up

1. In the app: Settings → Card sync. Add each card's last four digits, whose it is and which group its
   spends are for, then tap **Link these cards**. Share the key to your computer. It is shown only once.
2. On the computer (Node 22 or later):

   ```sh
   cd tools/card-sync
   npm install
   npx playwright install chromium
   security add-generic-password -s numa-shared-card-sync -a numa -w   # paste the key when asked
   mkdir -p ~/.config/numa-card-sync
   ```

   Then write `~/.config/numa-card-sync/config.json`:

   ```json
   {
     "url": "https://<deployment>.convex.site/card-sync/spends",
     "cards": ["1234", "5678"],
     "currency": "EUR",
     "since": "2026-10-01T00:00:00Z"
   }
   ```

   `since` is the first moment to sync. Set it to just after the last spend you already recorded by
   hand, so nothing is counted twice. Off a Mac, put the key in `NUMA_SHARED_KEY` instead.
3. `npm run login` opens a window. Log in to ether.fi; it closes by itself once your transactions load.
4. `npm run inspect` reads the history and prints the fields of the newest transaction (values masked)
   and how many spends it would send per card. It sends nothing. If it says no transaction names a
   card, ether.fi changed its data and `etherfi.mjs` needs a look.
5. `npm run sync` sends the spends. Run it every hour, for example with launchd or cron.

## Exit codes

- `0` synced (or nothing new).
- `2` ether.fi logged you out: run `npm run login` again.
- `1` anything else; the message says what.

## What gets sent

Only spends on the linked cards, once they are final (pending and declined ones wait or are skipped,
refunds are skipped and listed so you can add them by hand). Each one carries its ether.fi id, the card's last four digits, the time, the
merchant, the amount and the merchant category. A charge in another currency is converted at that day's
ECB rate. Numa Shared adds each spend once, however often the script runs.

To stop, tap **Turn off card sync** in the app; the key stops working at once.
