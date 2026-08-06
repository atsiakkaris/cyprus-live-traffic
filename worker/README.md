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

5. **Add the Cron Trigger**: Worker → Settings → Triggers → Cron Triggers →
   Add Cron Trigger. Currently set to `*/5 * * * *` (every 5 minutes) —
   tighter than the old poll cadence since there's no CDN cache fighting it
   anymore, though the source feed itself won't update faster than every
   few minutes anyway. Confirmed firing correctly via Observability → filter
   to "Invocations" → look for `Trigger: cron`.

6. **Deploy**, then visit `https://<worker-name>.<your-subdomain>.workers.dev/refresh`
   once in a browser — this seeds KV immediately rather than waiting for the
   first Cron Trigger to fire.

7. **Verify**: `https://<worker-name>.<your-subdomain>.workers.dev/latest.json`
   should return the joined snapshot instantly (no deploy/cache lag).

8. ~~Once confirmed working, update `preview/index.html`'s `fetch('latest.json')`
   to point at that Worker URL instead of the local file, and retire the
   `poll.yml` GitHub Action + committed `preview/latest.json`.~~ **Done.**

## Note on Workers' CPU time limit

The free plan caps CPU time per request (historically ~10ms). A Python
prototype of the same parsing logic took ~24ms — turned out to be a non-issue
in practice: `/refresh` returns successfully in the real Workers runtime
(V8's regex engine is evidently fast enough), confirmed against production
traffic (431 paths, 419 with live data, matching the old Python poller's
output exactly).
