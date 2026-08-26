/**
 *
 * Routes:
 *   GET /latest.json  — serves the cached snapshot from KV (fast path)
 *   GET /refresh       — forces a fresh fetch+parse+store, then returns it
 *                         (useful to seed KV once right after deploying,
 *                         before the first Cron Trigger fires)
 */

const BASE = "https://www.traffic4cyprus.org.cy/swarco3/api/Data";
const GEOMETRY_URL = `${BASE}/PredefinedLocationPublication`;
const LIVE_URL = `${BASE}/PredefinedLocationDataPublication`;
const SITUATION_URL = `${BASE}/SituationPublication`;

const FIXCYPRUS_BASE = "https://fixcyprus.cy/gnosis/open/api/nap/datasets";
const WAZE_ALERTS_URL = `${FIXCYPRUS_BASE}/waze_alerts/`;
const WAZE_TRAFFIC_URL = `${FIXCYPRUS_BASE}/waze_traffic/`;

const BLOCK_RE = /<q1:predefinedLocationReference[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/q1:predefinedLocationReference>/g;
const NAME_RE = /<value lang="en-US">([^<]*)<\/value>/;
const POSLIST_RE = /<q1:posList>([\s\S]*?)<\/q1:posList>/;
const COORDS_RE = /<gml:coordinates[^>]*>([\s\S]*?)<\/gml:coordinates>/;
const SPEED_RE = /<obs_speed[^>]*>([^<]*)<\/obs_speed>/;
const TTIME_RE = /<obs_t_time[^>]*>([^<]*)<\/obs_t_time>/;
const TS_RE = /<measurement_timestamp[^>]*>([^<]*)<\/measurement_timestamp>/;

// Waze feeds (waze_alerts, waze_traffic) share this DATEX II shape: repeated
// <traffic:trafficElement> blocks, each with a free-form set of
// commentType/value pairs (type, subtype, street, from, to, jamLevel,
// report_time — never all present at once) plus a location block.
const TRAFFIC_ELEMENT_RE = /<traffic:trafficElement>([\s\S]*?)<\/traffic:trafficElement>/g;
const COMMENT_RE = /<common:commentType>([^<]*)<\/common:commentType>\s*<common:value>([^<]*)<\/common:value>/g;
const POINT_COORDS_RE = /<location:pointCoordinates>\s*<common:latitude>([^<]*)<\/common:latitude>\s*<common:longitude>([^<]*)<\/common:longitude>\s*<\/location:pointCoordinates>/;
// waze_traffic's <location:linear> wraps its points by role rather than by
// path order: <startPointCoordinates>, then <endPointCoordinates>, then the
// <intermediatePointCoordinates> list — in that document order, endpoint
// before the intermediates. A plain "every lat/lon in document order" match
// (the old LAT_LON_RE) therefore draws start -> end -> intermediate 1..N,
// a straight jump across the jam followed by a loop back through the real
// path, instead of following the road. These three match by role so the
// caller can reassemble them into actual path order.
const START_POINT_RE = /<location:startPointCoordinates>\s*<common:latitude>([^<]*)<\/common:latitude>\s*<common:longitude>([^<]*)<\/common:longitude>\s*<\/location:startPointCoordinates>/;
const END_POINT_RE = /<location:endPointCoordinates>\s*<common:latitude>([^<]*)<\/common:latitude>\s*<common:longitude>([^<]*)<\/common:longitude>\s*<\/location:endPointCoordinates>/;
const INTERMEDIATE_POINT_RE = /<location:intermediatePointCoordinates>\s*<common:latitude>([^<]*)<\/common:latitude>\s*<common:longitude>([^<]*)<\/common:longitude>\s*<\/location:intermediatePointCoordinates>/g;

// SituationPublication (road works, obstructions, lane closures): repeated
// <q1:situationRecord> blocks with an xsi:type, severity, optional free-text
// description, and a point location.
const SITUATION_RECORD_RE = /<q1:situationRecord xsi:type="q1:([^"]+)"\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/q1:situationRecord>/g;
const SEVERITY_RE = /<q1:severity>([^<]*)<\/q1:severity>/;
const DESCRIPTION_RE = /<description[^>]*>([^<]*)<\/description>/;
// Each situationRecord declares its own incrementing XML namespace prefix
// (q2, q3, q4, ...) for its locationReference, so the prefix on <N:latitude>
// varies record to record — matched generically rather than pinned to "q2".
const SITUATION_POINT_RE = /<\w+:latitude>([^<]*)<\/\w+:latitude>\s*<\w+:longitude>([^<]*)<\/\w+:longitude>/;
const OVERALL_START_RE = /<overallStartTime>([^<]*)<\/overallStartTime>/;
const OVERALL_END_RE = /<overallEndTime>([^<]*)<\/overallEndTime>/;

// Hoisted rather than written as literals inside the per-element parse loops
// below — those run hundreds of times per tick, and the CPU budget here is
// genuinely tight (see the exceededCpu note in README).
const COMMON_ID_RE = /<common:id>([^<]*)<\/common:id>/;
const LINEAR_RE = /<location:linear>([\s\S]*?)<\/location:linear>/;

// Upstream returning a 4xx/5xx with an HTML error body is not an exception —
// `.text()` resolves happily and the parsers below then find nothing, which
// looks identical to "the feed is legitimately empty". Treating a bad status
// as a throw is what lets fetchAndParse's catch and the snapshot health
// checks actually see the failure.
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

function commentsOf(block) {
  const comments = {};
  for (const m of block.matchAll(COMMENT_RE)) comments[m[1]] = unescapeXml(m[2]);
  return comments;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseGeometry(text) {
  const result = new Map();
  for (const m of text.matchAll(BLOCK_RE)) {
    const pid = m[1];
    const block = m[2];
    const nameMatch = NAME_RE.exec(block);
    const name = nameMatch ? unescapeXml(nameMatch[1]) : pid;

    const posListMatch = POSLIST_RE.exec(block);
    let coords = [];
    if (posListMatch) {
      const decoded = unescapeXml(posListMatch[1]);
      const coordsMatch = COORDS_RE.exec(decoded);
      if (coordsMatch) {
        coords = coordsMatch[1]
          .trim()
          .split(/\s+/)
          .map((pair) => pair.split(",").map(Number))
          .filter((p) => p.length === 2 && !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
      }
    }
    if (coords.length) result.set(pid, { name, coords });
  }
  return result;
}

function parseLive(text) {
  const result = new Map();
  for (const m of text.matchAll(BLOCK_RE)) {
    const pid = m[1];
    const block = m[2];
    const speedMatch = SPEED_RE.exec(block);
    const ttimeMatch = TTIME_RE.exec(block);
    const tsMatch = TS_RE.exec(block);
    result.set(pid, {
      speed_kmh: speedMatch ? Math.round(parseFloat(speedMatch[1]) * 10) / 10 : null,
      travel_time_s: ttimeMatch ? Math.round(parseFloat(ttimeMatch[1])) : null,
      measured_at: tsMatch ? tsMatch[1] : null,
    });
  }
  return result;
}

// Alert subtypes excluded entirely — too noisy/low-value to show on the map.
const EXCLUDED_ALERT_SUBTYPES = new Set(["HAZARD_ON_ROAD_POT_HOLE"]);

// Waze crowdsourced point reports: road closures, hazards, jams. Each has a
// type (and for HAZARD, a subtype), an optional street name, and when it was
// reported — but never coordinates outside a single point.
function parseWazeAlerts(text) {
  const alerts = [];
  for (const m of text.matchAll(TRAFFIC_ELEMENT_RE)) {
    const block = m[1];
    const idMatch = COMMON_ID_RE.exec(block);
    const pointMatch = POINT_COORDS_RE.exec(block);
    if (!idMatch || !pointMatch) continue;
    const c = commentsOf(block);
    if (c.subtype && EXCLUDED_ALERT_SUBTYPES.has(c.subtype)) continue;
    alerts.push({
      id: idMatch[1],
      type: c.type || null,
      subtype: c.subtype || null,
      street: c.street || null,
      report_time: c.report_time || null,
      lat: parseFloat(pointMatch[1]),
      lon: parseFloat(pointMatch[2]),
    });
  }
  return alerts;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Waze's own map draws closed road segments as a connected line through
// several barrier icons rather than isolated points — but the feed itself
// (see parseWazeAlerts) only ever gives ROAD_CLOSED alerts as single points,
// with no segment/line geometry anywhere. Reverse-engineered grouping key
// from the raw feed: records sharing the same street AND the exact same
// report_time are waypoints of one closure submission split into multiple
// points. When street is missing, fall back to report_time alone, but only
// chain points within MAX_CLOSURE_GAP_KM of their neighbor — guards against
// two unrelated closures coincidentally reported in the same second.
const MAX_CLOSURE_GAP_KM = 3;

// Points within a group come back from the feed in arbitrary order, not
// necessarily walking along the road — connecting them as-is can zigzag
// back and forth across the same street instead of running straight along
// it. Nearest-neighbor chaining (greedy: repeatedly jump to whichever
// remaining point is closest) reorders them into a sane path first.
function orderPointsAlongPath(points) {
  if (points.length <= 2) return points;
  const remaining = points.slice();
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm([last.lat, last.lon], [remaining[i].lat, remaining[i].lon]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

function groupRoadClosures(alerts) {
  const closed = alerts.filter((a) => a.type === "ROAD_CLOSED");
  const rest = alerts.filter((a) => a.type !== "ROAD_CLOSED");

  const byKey = new Map();
  for (const a of closed) {
    const key = a.street ? `s:${a.street}|${a.report_time}` : `t:${a.report_time}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  }

  const road_closures = [];
  const singles = [];
  const asClosure = (points) => ({
    id: points[0].id,
    street: points[0].street,
    report_time: points[0].report_time,
    points: points.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon })),
  });

  for (const group of byKey.values()) {
    if (group.length === 1) {
      singles.push(group[0]);
    } else if (group[0].street) {
      road_closures.push(asClosure(orderPointsAlongPath(group)));
    } else {
      const ordered = orderPointsAlongPath(group);
      let chain = [ordered[0]];
      for (let i = 1; i < ordered.length; i++) {
        const prev = chain[chain.length - 1];
        if (haversineKm([prev.lat, prev.lon], [ordered[i].lat, ordered[i].lon]) <= MAX_CLOSURE_GAP_KM) {
          chain.push(ordered[i]);
        } else {
          if (chain.length > 1) road_closures.push(asClosure(chain));
          else singles.push(chain[0]);
          chain = [ordered[i]];
        }
      }
      if (chain.length > 1) road_closures.push(asClosure(chain));
      else singles.push(chain[0]);
    }
  }

  return { alerts: [...rest, ...singles], road_closures };
}

// Waze crowdsourced jam segments: a from/to road description, a 0–5 jamLevel,
// and a line (start/intermediate/end points) rather than a single point.
function parseWazeTraffic(text) {
  const jams = [];
  for (const m of text.matchAll(TRAFFIC_ELEMENT_RE)) {
    const block = m[1];
    const idMatch = COMMON_ID_RE.exec(block);
    const linearMatch = LINEAR_RE.exec(block);
    if (!idMatch || !linearMatch) continue;
    const linear = linearMatch[1];
    const startMatch = START_POINT_RE.exec(linear);
    const endMatch = END_POINT_RE.exec(linear);
    if (!startMatch || !endMatch) continue;
    const intermediates = [...linear.matchAll(INTERMEDIATE_POINT_RE)].map((p) => [parseFloat(p[1]), parseFloat(p[2])]);
    const coords = [
      [parseFloat(startMatch[1]), parseFloat(startMatch[2])],
      ...intermediates,
      [parseFloat(endMatch[1]), parseFloat(endMatch[2])],
    ].filter((p) => !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
    if (coords.length < 2) continue;
    const c = commentsOf(block);
    jams.push({
      id: idMatch[1],
      from: c.from || null,
      to: c.to || null,
      jam_level: c.jamLevel != null ? parseInt(c.jamLevel, 10) : null,
      coords,
    });
  }
  return jams;
}

// Road works / obstructions / lane management from the official feed —
// distinct schema from the geometry/live feeds above (situation, not
// predefinedLocation). Descriptions are frequently Greek-only free text.
function parseSituations(text) {
  const situations = [];
  for (const m of text.matchAll(SITUATION_RECORD_RE)) {
    const recordType = m[1];
    const id = m[2];
    const block = m[3];
    const pointMatch = SITUATION_POINT_RE.exec(block);
    if (!pointMatch) continue;
    const severityMatch = SEVERITY_RE.exec(block);
    const descMatch = DESCRIPTION_RE.exec(block);
    const startMatch = OVERALL_START_RE.exec(block);
    const endMatch = OVERALL_END_RE.exec(block);
    situations.push({
      id,
      type: recordType,
      severity: severityMatch ? severityMatch[1] : null,
      description: descMatch ? unescapeXml(descMatch[1]) : null,
      starts_at: startMatch ? startMatch[1] : null,
      ends_at: endMatch ? endMatch[1] : null,
      lat: parseFloat(pointMatch[1]),
      lon: parseFloat(pointMatch[2]),
    });
  }
  return situations;
}

// Fetches one feed and applies `parse`, but never lets a failure here take
// down the whole snapshot — a broken/empty response from any one of these
// degrades to an empty list instead of aborting buildSnapshot() entirely,
// which would otherwise also wipe the core road-speed data on every refresh.
async function fetchAndParse(url, parse, label) {
  try {
    return parse(await fetchText(url));
  } catch (err) {
    console.error(`Failed to fetch/parse ${label}: ${err}`);
    return [];
  }
}

// Sanity floor for a healthy snapshot. Normal runs return ~429 paths; a
// broken upstream fetch (e.g. an expired TLS cert causing a malformed or
// empty response instead of a thrown error) can silently parse down to 0
// with no exception raised at all. Refusing to write anything below this
// floor means a bad upstream response degrades to "serve the last known
// good snapshot" instead of wiping the live app blank for every user.
const MIN_HEALTHY_PATH_COUNT = 50;

// Path count alone stopped being a meaningful health signal once geometry
// moved to the KV cache: it reflects the *cached* road list, so it stays at
// ~429 even when the live-speed feed returns nothing at all, letting an
// all-grey "no data" snapshot sail past the floor above and overwrite a
// perfectly good one. This ratio is the check that actually looks at the
// live feed.
//
// Healthy runs sit at 97-100% matched (worst recorded: 419/431 = 97.2%), so
// 0.8 keeps real headroom below normal while refusing anything badly
// degraded. Being deliberately ratcheted up as confidence grows — the
// tradeoff is that a partial upstream degradation now freezes the app on the
// last good snapshot rather than publishing a half-empty map, which is the
// safer of the two failure modes but does mean less tolerance for a bad day.
const MIN_HEALTHY_LIVE_RATIO = 0.8;

// Re-enabled now that geometry is cached (see loadGeometry below) instead of
// re-parsed every tick — that was the heaviest chunk of the CPU budget that
// caused the exceededCpu failures. If those come back, this is the first
// thing to flip off again.
const FETCH_EVENTS = true;

// Road geometry (shape of each path) essentially never changes tick to tick
// — re-fetching and re-parsing it every 5 min was the single heaviest chunk
// of the CPU budget that caused the exceededCpu failures above, for data
// that's static almost all the time. Cached in KV and only refreshed on its
// own slower cron (see GEOMETRY_CRON below) instead, so the regular 5-min
// tick only has to parse the small live-speed feed.
async function readCachedGeometry(env) {
  const cached = await env.TRAFFIC_KV.get("geometry");
  return cached ? new Map(JSON.parse(cached)) : null;
}

async function fetchAndCacheGeometry(env) {
  const geometry = parseGeometry(await fetchText(GEOMETRY_URL));
  // Never overwrite a good cache with a broken fetch. Without this the
  // geometry cron could persist an empty map, and since every 5-min tick
  // reads that cache, the app would then sit frozen on its last snapshot
  // until the next geometry run hours later — a self-inflicted outage that
  // needs a manual /refresh to clear.
  if (geometry.size < MIN_HEALTHY_PATH_COUNT) {
    console.error(`Refusing to cache suspicious geometry: only ${geometry.size} paths — keeping previous cache`);
    return (await readCachedGeometry(env)) || geometry;
  }
  await env.TRAFFIC_KV.put("geometry", JSON.stringify([...geometry]));
  return geometry;
}

async function loadGeometry(env) {
  const cached = await readCachedGeometry(env);
  if (cached) return cached;
  // No cache yet (first-ever run before the geometry cron has fired once) —
  // fetch it live this one time so the app isn't left with zero paths.
  return fetchAndCacheGeometry(env);
}

async function buildSnapshot(env, { refreshGeometry = false } = {}) {
  const [geometry, liveText, alertsRaw, jams, situations] = await Promise.all([
    refreshGeometry ? fetchAndCacheGeometry(env) : loadGeometry(env),
    fetchText(LIVE_URL),
    FETCH_EVENTS ? fetchAndParse(WAZE_ALERTS_URL, parseWazeAlerts, "waze_alerts") : Promise.resolve([]),
    FETCH_EVENTS ? fetchAndParse(WAZE_TRAFFIC_URL, parseWazeTraffic, "waze_traffic") : Promise.resolve([]),
    FETCH_EVENTS ? fetchAndParse(SITUATION_URL, parseSituations, "SituationPublication") : Promise.resolve([]),
  ]);

  const live = parseLive(liveText);
  const { alerts, road_closures } = groupRoadClosures(alertsRaw);

  const paths = [];
  for (const [pid, geo] of geometry) {
    const liveData = live.get(pid) || { speed_kmh: null, travel_time_s: null, measured_at: null };
    paths.push({ id: pid, name: geo.name, coords: geo.coords, ...liveData });
  }

  return {
    generated_at: new Date().toISOString(),
    path_count: paths.length,
    matched_live_count: paths.filter((p) => p.speed_kmh != null).length,
    // Mode (not max) across all paths' own measured_at — the timestamp most
    // paths share represents the feed's bulk state, resistant to a handful
    // of outlier paths in either direction (one stray fresh path masking a
    // broad freeze, or one permanently-broken path never letting the app
    // report "current"). generated_at above only proves the Worker's own
    // poll succeeded, not that the underlying data actually moved — this is
    // the field that catches a frozen-but-still-200-OK upstream feed.
    common_measurement_timestamp: modeMeasuredAt(paths),
    paths,
    alerts,
    road_closures,
    jams,
    situations,
  };
}

function modeMeasuredAt(paths) {
  const counts = new Map();
  for (const p of paths) {
    if (!p.measured_at) continue;
    counts.set(p.measured_at, (counts.get(p.measured_at) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [ts, count] of counts) {
    if (count > bestCount) { best = ts; bestCount = count; }
  }
  return best;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

const DEPLOYED_HOST = "atsiakkaris.github.io";

// Human-readable label for the Observability list view, e.g.
// "App (atsiakkaris.github.io) — Chrome/Android" or "Local file test (browser) — Edge".
// Categorizes by *what kind* of caller it is, not just the raw host, so it's obvious
// at a glance whether a hit came from the real deployed app, local file:// testing,
// a local dev server, or something unrecognized (e.g. curl, a bot, server-to-server).
// A malformed Origin/Referer must not take the request down with it — this
// runs on every /latest.json hit, so an unparseable header from some bot
// would otherwise 500 a request that could have served cached data fine.
function hostOf(value) {
  if (!value) return null;
  if (value === "null") return "file://"; // sandboxed/file:// origins send the literal string
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function describeCaller(request) {
  const host = hostOf(request.headers.get("origin")) || hostOf(request.headers.get("referer"));

  let category;
  if (host === DEPLOYED_HOST) category = `App (${DEPLOYED_HOST})`;
  else if (host === "file://") category = "Local file test (browser)";
  else if (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) category = `Local dev server (${host})`;
  else if (host) category = `Unknown site (${host})`;
  else category = "Unknown source (no origin header)";

  const ua = request.headers.get("user-agent") || "";
  let browser = "unknown browser";
  if (/EdgA\//.test(ua)) browser = "Edge/Android";
  else if (/EdgiOS\//.test(ua)) browser = "Edge/iOS";
  else if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua) && /Android/.test(ua)) browser = "Chrome/Android";
  else if (/CriOS\//.test(ua)) browser = "Chrome/iOS";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";

  return `${category} — ${browser}`;
}

// Returns a human-readable reason the snapshot looks broken, or null if it's
// fine to publish. Shared by the cron and /refresh so both apply exactly the
// same bar — they used to carry near-duplicate copies of this check, which is
// how the ratio check below could have ended up in only one of them.
function unhealthyReason(snapshot) {
  if (snapshot.path_count < MIN_HEALTHY_PATH_COUNT) {
    return `only ${snapshot.path_count} paths`;
  }
  if (snapshot.matched_live_count / snapshot.path_count < MIN_HEALTHY_LIVE_RATIO) {
    return `only ${snapshot.matched_live_count} of ${snapshot.path_count} paths have live data`;
  }
  return null;
}

async function storeIfHealthy(env, snapshot) {
  const reason = unhealthyReason(snapshot);
  if (reason) {
    console.error(`Refusing to store suspicious snapshot: ${reason} (upstream likely broken)`);
    return reason;
  }
  await env.TRAFFIC_KV.put("latest", JSON.stringify(snapshot));
  return null;
}

// Must match the second entry in wrangler.toml's [triggers] crons — the
// slower schedule that re-fetches/re-parses geometry (see loadGeometry
// above). Every other cron firing (the 5-min tick) uses the cached copy.
const GEOMETRY_CRON = "0 */6 * * *";

export default {
  async scheduled(event, env) {
    const snapshot = await buildSnapshot(env, { refreshGeometry: event.cron === GEOMETRY_CRON });
    await storeIfHealthy(env, snapshot);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/refresh") {
      // Forces an extra fetch against the upstream feeds and burns CPU time
      // (tight budget on the Workers Free plan — see FETCH_EVENTS above), so
      // it's gated behind a shared secret set as a dashboard secret (never
      // committed to wrangler.toml). Fails closed if the secret isn't set.
      if (!env.REFRESH_KEY || url.searchParams.get("key") !== env.REFRESH_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      console.log(`GET /refresh from ${describeCaller(request)}`);
      const snapshot = await buildSnapshot(env, { refreshGeometry: true });
      const reason = await storeIfHealthy(env, snapshot);
      if (reason) {
        return new Response(
          JSON.stringify({ error: `Upstream returned a suspiciously broken feed (${reason}) — last good snapshot kept.`, ...snapshot }),
          { status: 502, headers: JSON_HEADERS }
        );
      }
      return new Response(JSON.stringify(snapshot), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/latest.json" || url.pathname === "/") {
      console.log(`GET /latest.json from ${describeCaller(request)}`);
      const cached = await env.TRAFFIC_KV.get("latest");
      if (!cached) {
        return new Response(
          JSON.stringify({ error: "No snapshot yet — hit /refresh once to seed it." }),
          { status: 503, headers: JSON_HEADERS }
        );
      }
      return new Response(cached, { headers: JSON_HEADERS });
    }

    return new Response("Not found", { status: 404 });
  },
};
