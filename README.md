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
  the Workers Free plan (see `worker/README.md`). Each 5-min tick also nudges
  a running estimate of every path's own free-flow speed (95th percentile,
  held in its own KV key) — exposed once a path has ~24h of samples, so the
  app can colour a road relative to its *own* normal instead of one global
  scale. Everything gets joined into one JSON snapshot in Workers KV.
  Refuses to overwrite/serve a snapshot that comes back suspiciously empty
  (e.g. from a broken upstream feed) — keeps the last known-good data (and
  the free-flow estimates) live instead of silently blanking or corrupting
  them. The `fetch` handler serves that snapshot directly at `/latest.json`
  — no build, no deploy, no CDN cache lag between a poll and the app seeing
  it. A manual `/refresh` (forces an immediate full refresh) is gated behind
  a secret key, since it costs extra CPU/upstream load. Live at
  `https://cyprus-live-traffic.tsiakkaris-andreas.workers.dev`.
- **`preview/`** — the app itself for now: a PWA (installable, offline-capable
  via a service worker) built as a plain HTML/Leaflet page. Fetches
  `latest.json` from the Worker and renders colored polylines by speed —
  relative to each road's own learned free-flow speed once the Worker has
  enough history for it, falling back to a general fast/moderate/slow scale
  otherwise (light/dark basemap follows system theme by default, with a
  manual override toggle and a colorblind-safe palette toggle), plus
  toggleable, clustered layers for road closures, hazards/accidents,
  crowdsourced jams, and official road works — each with a mobile-style
  bottom sheet (swipe-to-dismiss) on tap, showing which feed it came from.
  Multi-point Waze road closures are reconstructed into a connected line
  (barrier icons at the two ends) instead of showing each waypoint as its
  own dot. A share button encodes the current map position, zoom, and active
  filters into a link. Manual zoom +/- buttons sit above the locate button.
  Shows a live "data last updated" indicator so staleness is never silent.
  Basemap tiles are CARTO's, which started requiring a free API key in
  2026-08 — see `CARTO_API_KEY` in `preview/index.html`.
- **`poller/`** — the original Python poller. No longer the production data
  path (the Worker replaced it), and **roads only**: it predates the Waze
  alert/jam and official-situation feeds, so the snapshot it writes has no
  `alerts`, `road_closures`, `jams` or `situations`. The app handles those
  being absent, so it still runs — every event filter just reports nothing
  to show. Useful for working on the road/speed layer without the deployed
  Worker; use `/refresh` on the Worker instead if you need event data.
  Writes `preview/latest.json` (gitignored).

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

Previously known issue: the live feed's `measurement_timestamp` lagged well
behind real time (stuck ~5 days stale as of 2026-08-26). Resolved upstream
as of 2026-08-28 — `common_measurement_timestamp` now tracks within a few
minutes of `generated_at`. The app still surfaces a "Data outdated since
..." note whenever this recurs, separate from the Worker's own
poll-freshness indicator, so staleness in the upstream feed itself is never
silently hidden behind a healthy-looking poll.

## Running the poller

```bash
python poller/fetch_live.py
```

Writes `preview/latest.json`.
