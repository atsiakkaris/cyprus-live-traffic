# Cyprus Live Traffic

Hobby project: a live traffic layer (speed / travel time) over Cyprus's
Bluetooth travel-time paths, sourced from the public traffic4cyprus feed.
No routing/navigation — this is a "see the live traffic" layer, not a
Waze/Google Maps competitor.

Fully separate from the `traffic-control-room` repo — no shared code or
dependency between them, by design.

## Pieces

- **`worker/`** — a Cloudflare Worker that's the real backend: a Cron Trigger
  polls the public feeds every 10 min, joins path geometry with live
  speed/travel-time, and stores one JSON snapshot in Workers KV. The `fetch`
  handler serves that snapshot directly at `/latest.json` — no build, no
  deploy, no CDN cache lag between a poll and the app seeing it (this
  replaced an earlier GitHub Pages + committed-JSON approach that turned out
  to add several minutes of unavoidable latency — see `worker/README.md`).
  Live at `https://cyprus-live-traffic.tsiakkaris-andreas.workers.dev`.
- **`preview/`** — the app itself for now: a PWA (installable, offline-capable
  via a service worker) built as a plain HTML/Leaflet page. Fetches
  `latest.json` from the Worker and renders colored polylines by speed, with
  a mobile-style bottom sheet on tap.
- **`poller/`** — the original Python poller. No longer the production data
  path (the Worker replaced it), but still useful for local testing/dev
  without needing the deployed Worker — writes `preview/latest.json`
  (gitignored) for the app to fall back to locally.
- **`api/`** — not needed; the Worker's `/latest.json` route *is* the API.
- **`app/`** — (not yet built) a React Native version, once/if this outgrows
  a PWA — needs Node tooling this environment doesn't have.

## Deployment

- **App:** GitHub Pages, serving from `main` / `/(root)`. Lives at
  `https://atsiakkaris.github.io/cyprus-live-traffic/preview/index.html`.
- **Data:** Cloudflare Worker (see `worker/README.md` for setup) — deployed
  via the Cloudflare dashboard, no local Node/wrangler needed.

## Data source

- Geometry: `PredefinedLocationPublication`
- Live speed/travel-time: `PredefinedLocationDataPublication`
- Both under `https://www.traffic4cyprus.org.cy/swarco3/api/Data/`, joined by
  path `id`.

Known issue (as of 2026-08-06): the live feed's `measurement_timestamp` is
currently frozen at `2026-07-28T05:41:00Z` across all paths — see notes in
the `traffic-control-room` project. Building ahead on the assumption this
gets fixed upstream.

## Running the poller

```bash
python poller/fetch_live.py
```

Writes `preview/latest.json`.
