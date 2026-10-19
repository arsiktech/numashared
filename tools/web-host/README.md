# shared.numaworth.com

A Cloudflare Worker that puts Numa Shared under its own address:

| Path | What happens |
|---|---|
| `/app/…` | The web app (an Expo web export of `app/`, served as a single-page app). |
| `/`, `/assets/…`, `/privacy`, `/support`, `/join/<token>`, `/.well-known/apple-app-site-association` | Fetched from the backend and served here, so the address stays branded. |
| anything else, any POST | `307` to the backend, so its rate limits see each person's own IP. |

The web app calls the backend directly. The backend answers it with CORS headers only for origins
listed in `NUMA_SHARED_WEB_ORIGINS`.

## Deploy

```sh
npm install
GOOGLE_WEB_CLIENT_ID=<web OAuth client id> npm run build   # exports app/ under /app into dist/
CLOUDFLARE_API_TOKEN=… npm run deploy
```

The token needs Workers Scripts edit and Workers Routes edit on the `numaworth.com` zone. The
hostname must not be attached to another Pages project or Worker.

## One-time settings elsewhere

- Backend (Convex) environment:
  - `NUMA_SHARED_WEB_ORIGINS=https://shared.numaworth.com`
  - `NUMA_SHARED_WEB_APP_URL=https://shared.numaworth.com/app`
  - `NUMA_SHARED_TESTFLIGHT_URL=https://testflight.apple.com/join/…` while in beta
- Google Cloud: add `https://shared.numaworth.com` to the web client's Authorized JavaScript origins,
  or Google sign-in on the web is refused.

`npm run dev` serves it locally at http://localhost:8787 (the web app still talks to the live
backend, which refuses `localhost` as an origin).
