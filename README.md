# Cyprus Live Traffic

Hobby project: a live traffic layer (speed / travel time) over Cyprus's
Bluetooth travel-time paths, sourced from the public traffic4cyprus feed.
No routing/navigation — this is a "see the live traffic" layer, not a
Waze/Google Maps competitor.

Fully separate from the `traffic-control-room` repo — no shared code or
dependency between them, by design.

## Pieces

- **`poller/`** — polls the public feeds every N minutes, joins path geometry
  with live speed/travel-time, writes a single `latest.json` snapshot. No
  history is kept; each run overwrites the previous snapshot.
- **`preview/`** — a plain HTML/Leaflet page for visually checking the data
  (colored polylines by speed) without needing any app tooling installed.
- **`api/`** — (not yet built) will just be static hosting for `latest.json`
  in production — no server/database needed for v1.
- **`app/`** — (not yet built) React Native app that fetches `latest.json`
  and renders the live layer on a map.

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

Writes `poller/latest.json`.
