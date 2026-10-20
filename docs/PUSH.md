# Push delivery

Numa Shared uses alert pushes only for the exhaustive matrix in `GOAL_BRIEF.md §6`. The server composes the English, pot-named body; clients never supply notification text or amounts.

## Delivery path

1. A successful `events:appendEvents` transaction records each new event and, only for an eligible kind, atomically adds its id to the pot's `pendingPushes` row (`convex/pushQueue.ts`). The first queued event schedules `pushQueue:flushPendingPush`.
2. An exact idempotent replay returns the original sequence and queues nothing.
3. The flush waits until the pot has been quiet for 30 seconds, or at most 10 minutes from the first queued event while events keep arriving, then clears the row and schedules `apns:deliverBatchPush`. The sync client uploads one event per call, so without this a bulk upload sent one push per event.
4. `notifications:batchPushPlan` resolves each queued event at its stored sequence (in pages of 100) and `composeBatchMessages` gives each person at most two messages: the event's own body when one event affects them, otherwise `<n> updates in <pot> affect your balance`, plus a separate `needs your choice` request when a record became contested. Each event reads only its own record history and the membership events up to its sequence, never the whole pot.
5. Per event, the plan applies actor exclusion and per-pot mutes, and returns registered devices. A newly contested branch routes the choice message to the current heads' authors; ordinary expense/edit/void/settlement messages route through units whose record contribution actually changed. Restore is silent because the goal's notification matrix is exhaustive and does not include it.
6. The Node action reuses an ES256 provider JWT for less than 50 minutes, opens one HTTP/2 session per APNs environment in the batch, and sends the required topic/push-type/priority/expiration headers.
7. A timestamped APNs `410 Unregistered` removes a token only if no newer registration exists. Other APNs rejections do not mutate token state.

The custom payload is deliberately small:

```json
{
  "aps": {
    "alert": { "title": "Numa Shared", "body": "<server-composed amount-free text>" },
    "sound": "default"
  },
  "route": "pot",
  "potId": "<pot UUID>"
}
```

The iPhone notification delegate validates `route` and the UUIDv7 `potId`, asks the authenticated runtime to rediscover that exact authorized pot, activates its persisted identity, syncs it, and then opens Home. Unknown, malformed, and unauthorized pot identifiers fail closed.

## iPhone lifecycle

- The app checks existing notification authorization only after an authenticated pot is available. It never presents the system prompt at launch.
- The first accepted membership in a multi-member synced pot is the contextual prompt point. People also provides an explicit **Allow notifications** action and the only per-pot setting, **Mute this pot**.
- An already-authorized app registers with APNs once per launch. The lowercase device token, APNs environment, and current IANA time zone are then registered through the serialized authenticated client. The same token moving to another account is re-pointed server-side.
- App-delegate callbacks queue tokens and notification routes until `AppModel` is connected. Registration failures expose generic retry copy and never log the token or Apple error details.
- The checked-in development entitlement enables sandbox registration. Distribution signing supplies the production APNs environment; physical delivery is verified in the release smoke.

## Secret contract

The action requires exactly these environment values on the selected Convex deployment:

- `APNS_KEY_ID`
- `APPLE_TEAM_ID`
- `APNS_PRIVATE_KEY_PKCS8_PEM`

The last value comes from the owner-local `APNS_KEY_PATH`. It is never committed or printed. Cloud-secret changes use the intended deployment and the authorization boundary in `docs/RELEASE.md`.

Local unit tests generate an ephemeral EC key and never contact Apple. They prove JWT claims/signature/cache rotation, sandbox/production hosts, HTTP/2 request headers and payload, response classification, actor/mute/contest routing, replay-safe scheduling, and race-safe 410 cleanup. They do not establish physical delivery.

## Local verification

```bash
npm run backend:typecheck
npm run backend:test -- --run
./scripts/convex-local.sh dev --start '/usr/bin/true'
```

Use only `scripts/convex-local.sh` for the persistent anonymous-local deployment. Plain `convex dev` is forbidden. Primary protocol references: [Apple provider-token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [sending requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), and [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions).
