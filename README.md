# Cyprus Live Traffic

Hobby project: a live traffic layer (speed / travel time) over Cyprus's
Bluetooth travel-time paths, sourced from the public traffic4cyprus feed.
No routing/navigation — this is a "see the live traffic" layer, not a
Waze/Google Maps competitor.

Fully separate from the `traffic-control-room` repo — no shared code or
dependency between them, by design.

## Pieces

- **`poller/`** — polls the public feeds, joins path geometry with live
  speed/travel-time, writes `preview/latest.json`. No history is kept; each
  run overwrites the previous snapshot.
- **`preview/`** — the app itself for now: a PWA (installable, offline-capable
  via a service worker) built as a plain HTML/Leaflet page. Fetches
  `latest.json` from the same directory and renders colored polylines by
  speed, with a mobile-style bottom sheet on tap.
- **`.github/workflows/poll.yml`** — runs the poller and commits the updated
  `preview/latest.json`, triggered externally via cron-job.org hitting
  `workflow_dispatch` (not GitHub's native `schedule:` — see comment in the
  workflow file for why). This is what keeps the deployed Pages site's data
  fresh, same pattern as `preview/latest.json` being the deployment artifact.
- **`api/`** — not needed for v1; GitHub Pages serving `preview/latest.json`
  directly *is* the API.
- **`app/`** — (not yet built) a React Native version, once/if this outgrows
  a PWA — needs Node tooling this environment doesn't have.

## Deployment

GitHub Pages, serving from `main` / `/(root)`. The app lives at
`https://atsiakkaris.github.io/cyprus-live-traffic/preview/index.html`.

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
