# Cyprus Live Traffic

Hobby project: a live traffic layer (speed / travel time) over Cyprus's
Bluetooth travel-time paths, sourced from the public traffic4cyprus feed.
No routing/navigation — this is a "see the live traffic" layer, not a
Waze/Google Maps competitor.

Fully separate from the `traffic-control-room` repo — no shared code or
dependency between them, by design.

## Pieces

- **`worker/`** — a Cloudflare Worker that's the real backend: a Cron Trigger
  fires every 5 min to pull live speed/travel-time plus Waze alerts/jams and
  official road-works situations; a second, much slower Cron Trigger
  (4x/day) re-fetches and re-parses road geometry, which is otherwise served
  from a cached copy in KV — geometry barely ever changes, and re-parsing it
  on every 5-min tick was the main cost behind a real CPU-budget failure on
  the Workers Free plan (see `worker/README.md`). Everything gets joined
  into one JSON snapshot in Workers KV. Refuses to overwrite/serve a
  snapshot that comes back suspiciously empty (e.g. from a broken upstream
  feed) — keeps the last known-good data live instead of silently blanking
  the app. The `fetch` handler serves that snapshot directly at
  `/latest.json` — no build, no deploy, no CDN cache lag between a poll and
  the app seeing it. A manual `/refresh` (forces an immediate full refresh)
  is gated behind a secret key, since it costs extra CPU/upstream load.
  Live at `https://cyprus-live-traffic.tsiakkaris-andreas.workers.dev`.
- **`preview/`** — the app itself for now: a PWA (installable, offline-capable
  via a service worker) built as a plain HTML/Leaflet page. Fetches
  `latest.json` from the Worker and renders colored polylines by speed
  (light/dark basemap follows system theme by default, with a manual
  override toggle and a colorblind-safe palette toggle), plus toggleable,
  clustered layers for road closures, hazards/accidents, crowdsourced jams,
  and official road works — each with a mobile-style bottom sheet
  (swipe-to-dismiss) on tap, showing which feed it came from. Multi-point
  Waze road closures are reconstructed into a connected line (barrier icons
  at the two ends) instead of showing each waypoint as its own dot. Manual
  zoom +/- buttons sit above the locate button. Shows a live "data last
  updated" indicator so staleness is never silent.
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

Known issue (as of 2026-08-26): the live feed's `measurement_timestamp`
still lags well behind real time — currently stuck around
`2026-08-21T10:01:00Z`, about 5 days stale — rather than being frozen at one
exact value forever as first observed; see notes in the
`traffic-control-room` project. Building ahead on the assumption this gets
fixed upstream. The app surfaces this directly via a "Data outdated since
..." note, separate from the Worker's own poll-freshness indicator, so
staleness in the upstream feed itself is never silently hidden behind a
healthy-looking poll.

## Running the poller

```bash
python poller/fetch_live.py
```

Writes `preview/latest.json`.
