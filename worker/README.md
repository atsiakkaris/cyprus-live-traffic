# Worker deployment (dashboard, no local tooling needed)

**Status: deployed and live** at
`https://cyprus-live-traffic.tsiakkaris-andreas.workers.dev`. This replaced
the earlier `latest.json`-via-GitHub-Pages approach — the Worker polls the
feeds on its own schedule and serves the result directly from KV, no git
commit, no Pages build, no CDN cache floor in the loop. Steps below kept for
reference / redeploying from scratch if ever needed.

## Steps

1. **Create a Cloudflare account** (free tier is enough) at
   [dash.cloudflare.com](https://dash.cloudflare.com) if you don't have one.

2. **Create a KV namespace**: Workers & Pages → KV → Create namespace.
   Name it whatever you like, e.g. `cyprus_traffic`.

3. **Create the Worker**: Workers & Pages → Create → Create Worker. Give it a
   name (e.g. `cyprus-live-traffic`), then open its editor (Quick Edit) and
   replace the default code with the contents of [`worker.js`](worker.js) in
   this folder.

4. **Bind the KV namespace**: Worker → Settings → Variables → KV Namespace
   Bindings → Add binding. Variable name must be exactly `TRAFFIC_KV`, bound
   to the namespace you created in step 2.

5. **Add two Cron Triggers**: Worker → Settings → Triggers → Cron Triggers →
   Add Cron Trigger.
   - `*/5 * * * *` (every 5 minutes) — live speed/travel-time plus Waze
     alerts/jams and official situations. Tighter than the old poll cadence
     since there's no CDN cache fighting it anymore, though the source feed
     itself won't update faster than every few minutes anyway.
   - `0 */6 * * *` (4x/day) — re-fetches and re-parses road geometry, which
     the 5-min tick instead reads from a cached copy in KV (see "Note on
     Workers' CPU time limit" below for why). Must match `GEOMETRY_CRON` in
     `worker.js` exactly.

   Confirmed firing correctly via Observability → filter to "Invocations" →
   look for `Trigger: cron`.

6. **Add the `REFRESH_KEY` secret**: Worker → Settings → Variables and
   Secrets → Add → type **Secret** → name `REFRESH_KEY` → any value you
   choose. `/refresh` 401s without it (see step 7) — it forces an extra
   upstream fetch and burns CPU time, so it's not left open to anyone with
   the URL.

7. **Deploy**, then visit
   `https://<worker-name>.<your-subdomain>.workers.dev/refresh?key=<your REFRESH_KEY>`
   once in a browser — this seeds KV immediately rather than waiting for the
   first Cron Trigger to fire.

8. **Verify**: `https://<worker-name>.<your-subdomain>.workers.dev/latest.json`
   should return the joined snapshot instantly (no deploy/cache lag).

9. ~~Once confirmed working, update `preview/index.html`'s `fetch('latest.json')`
   to point at that Worker URL instead of the local file, and retire the
   `poll.yml` GitHub Action + committed `preview/latest.json`.~~ **Done.**

## Note on Workers' CPU time limit

The free plan caps CPU time per request at ~10ms — this **is** a real
constraint, not just a theoretical one. Regex-parsing all 5 feeds
(geometry + live + Waze alerts + Waze jams + situations) every 5-min tick
eventually exceeded it, causing `scheduled()` to fail with `exceededCpu` on
every single invocation and freezing KV on stale data for hours before it
was noticed. The fix wasn't reducing feature scope — it was recognizing
that road geometry (the single heaviest parse, touching every one of ~430
roads) barely ever changes, so it didn't need re-parsing every 5 minutes at
all. Moving it to its own 4x/day cron (see step 5) and caching the result
in KV freed up enough budget for the 5-min tick to comfortably handle the
other 4 feeds. If `exceededCpu` errors show up again in Observability
Logs, that's the first place to look — either something got heavier again,
or it's time to consider the Workers Paid plan (raises the CPU cap to 30s).
