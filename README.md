# Cyprus Live Traffic

Hobby project: a live traffic layer (speed / travel time) over Cyprus's
Bluetooth travel-time paths, sourced from the public traffic4cyprus feed.
No routing/navigation — this is a "see the live traffic" layer, not a
Waze/Google Maps competitor.

Fully separate from the `traffic-control-room` repo — no shared code or
dependency between them, by design.

## Pieces

- **`worker/`** — a Cloudflare Worker that's the real backend: a Cron Trigger
  polls the public feeds every 5 min, joins path geometry with live
  speed/travel-time, pulls in Waze alerts/jams and official road-works
  situations, and stores one JSON snapshot in Workers KV. Refuses to
  overwrite/serve a snapshot that comes back suspiciously empty (e.g. from a
  broken upstream feed) — keeps the last known-good data live instead of
  silently blanking the app. The `fetch` handler serves that snapshot
  directly at `/latest.json` — no build, no deploy, no CDN cache lag between
  a poll and the app seeing it (this replaced an earlier GitHub Pages +
  committed-JSON approach that turned out to add several minutes of
  unavoidable latency — see `worker/README.md`).
  Live at `https://cyprus-live-traffic.tsiakkaris-andreas.workers.dev`.
- **`preview/`** — the app itself for now: a PWA (installable, offline-capable
  via a service worker) built as a plain HTML/Leaflet page. Fetches
  `latest.json` from the Worker and renders colored polylines by speed
  (light/dark basemap follows system theme, with a colorblind-safe palette
  toggle), plus toggleable, clustered layers for road closures/hazards,
  crowdsourced jams, and official road works — each with a mobile-style
  bottom sheet (swipe-to-dismiss) on tap. Shows a live "data last updated"
  indicator so staleness is never silent.
- **`poller/`** — the original Python poller. No longer the production data
  path (the Worker replaced it), but still useful for local testing/dev
  without needing the deployed Worker — writes `preview/latest.json`
  (gitignored) for the app to fall back to locally.

## Deployment

- **App:** GitHub Pages, serving from `main` / `/(root)`. Lives at
  `https://atsiakkaris.github.io/cyprus-live-traffic/preview/index.html`.
- **Data:** Cloudflare Worker (see `worker/README.md` for setup) — git-connected
  via Cloudflare Workers Builds, so pushing to `main` auto-deploys `worker.js`
  and `wrangler.toml`. No local Node/wrangler needed for day-to-day changes.

## Data source

- Geometry: `PredefinedLocationPublication`
- Live speed/travel-time: `PredefinedLocationDataPublication`
- Official road-works/obstructions/lane-management: `SituationPublication`
- All three under `https://www.traffic4cyprus.org.cy/swarco3/api/Data/`,
  geometry and live speed/travel-time joined by path `id`.
- Waze crowdsourced alerts (closures, hazards, jam reports) and jam-level
  line segments: `waze_alerts` and `waze_traffic`, both under
  `https://fixcyprus.cy/gnosis/open/api/nap/datasets/`.

Known issue (as of 2026-08-06): the live feed's `measurement_timestamp` is
currently frozen at `2026-07-28T05:41:00Z` across all paths — see notes in
the `traffic-control-room` project. Building ahead on the assumption this
gets fixed upstream.

## Running the poller

```bash
python poller/fetch_live.py
```

Writes `preview/latest.json`.
