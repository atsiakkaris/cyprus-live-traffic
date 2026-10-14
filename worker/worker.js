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
// Measured against 72 days / 416 runs of the ITS monitor's own status history
// (traffic-control-room's results/history.db, 2026-06-12..08-28): the live
// ratio ran min 0.801, median 0.830, max 0.872 — it never once reached 0.88.
// An earlier note here claimed "healthy runs sit at 97-100%"; that was an
// artefact of the same -1 counting bug fixed in matched_live_count below, and
// the plan it justified (ratcheting this floor *up*) was backwards. At 0.85
// this check would have rejected 81% of all runs; at 0.90, 100% of them.
//
// The ceiling is structural, not a feed fault: ~66 of the paths are
// permanently dead sensors (never once reporting in 72 days), so the ratio
// simply cannot approach 1.0. Excluding those, live runs sit at 0.895-0.964 —
// which is the better metric to move to eventually, rather than tuning a
// global floor against a denominator that's ~15% dead by construction.
//
// 0.80 sat about one point under that observed floor, which bought almost no
// margin before a normal-but-poor day started rejecting snapshots — and a
// rejected snapshot now also stalls free-flow baseline learning (see
// storeIfHealthy). Lowered to 0.75 on 2026-08-28 for real headroom: still far
// below anything seen in 72 days of history, so a genuinely broken feed is
// still caught, but an ordinary bad day no longer freezes the app.
const MIN_HEALTHY_LIVE_RATIO = 0.75;

// Re-enabled now that geometry is cached (see loadGeometry below) instead of
// re-parsed every tick — that was the heaviest chunk of the CPU budget that
// caused the exceededCpu failures. If those come back, this is the first
// thing to flip off again.
const FETCH_EVENTS = true;

// --- Free-flow baselines ---------------------------------------------------
//
// Absolute speed thresholds mislead: 50 km/h is severe congestion on a
// motorway and completely normal on an urban street. What matters is speed
// relative to how *this* road behaves when it's flowing freely.
//
// Classifying roads by type was the obvious approach and doesn't work here —
// 377 of ~397 paths are named as sensor-node pairs ("1004->1008"), so there's
// no road name to match on, and while length correlates with road class
// (>8km paths run at a ~102 km/h median, urban ones ~28), the 3-8km band is
// genuinely mixed: Kiprianou is 5.8km of urban arterial that a length rule
// would call motorway and then paint permanently red.
//
// So instead each path learns its own free-flow speed from what it actually
// observes. No classification, no manual table to maintain, and it adapts on
// its own if a road changes.
//
// BASELINE_KEY is where the baselines lived before the "state" key existed.
// It is read once, to carry them over when "state" is absent (see readState),
// and is never written again — it's left in place on purpose.
const BASELINE_KEY = "baselines";

// Tracked as a running 95th percentile rather than a max: a max is set
// forever by a single spurious reading (the feed does emit implausible
// values — 0.1 km/h on a 19km motorway path), whereas a percentile needs
// sustained evidence to move.
//
// Estimated by stochastic approximation — one add per sample, no history
// array to store or sort. Each sample nudges the estimate up by
// STEP*P if it's above and down by STEP*(1-P) if below; that 19:1 asymmetry
// is what makes it settle at the 95th percentile. Cost is O(1) per path and
// two numbers of storage, which matters on a CPU budget this tight.
//
// Simulated against synthetic motorway/arterial/side-street traffic before
// committing: lands within ~1 km/h of the true p95, reaches 5% of it inside
// 40 samples, and a single spurious reading (the 116 km/h kind) moves it by
// at most +0.475.
//
// The same asymmetry that buys that outlier resistance makes it slow in the
// other direction: a road that *permanently* slows from 110 to 70 takes
// roughly five days to follow it down (0.025 km/h per sample). That's the
// intended trade — permanent slowdowns are rare, bogus spikes are not — but
// it does mean a genuine long-term change shows up as "slower than usual"
// for several days before the baseline catches up.
const BASELINE_TARGET_P = 0.95;
const BASELINE_STEP_KMH = 0.5;

// Withheld from the snapshot until the estimate has seen this many samples,
// so the app falls back to absolute thresholds rather than colouring roads
// against a baseline that's still climbing out of wherever it was seeded.
// 288 = a full 24h at one sample per 5-min tick, so every path has seen a
// complete daily cycle — its own night-time free-flow as well as its peaks —
// before it's allowed to judge anything. Counted per path in actual readings,
// not elapsed time: a path whose sensor drops out for an hour simply takes
// correspondingly longer to qualify.
const MIN_BASELINE_SAMPLES = 288;

// --- Per-path staleness -----------------------------------------------------
//
// The feed's own per-path measurement_timestamp is useless for this: every
// path shares one bulk value (see modeMeasuredAt) that advances every 5-min
// tick regardless of whether that path's actual reading changed, so a sensor
// that's been silently stuck for hours still carries a "fresh" timestamp.
// The only real signal is whether the *value itself* is moving — if
// speed_kmh and travel_time_s come back byte-identical tick after tick, the
// upstream sensor isn't producing new data, it's re-serving its last one.
const STALE_KEY = "staleness";

async function readStaleness(env) {
  const raw = await env.TRAFFIC_KV.get(STALE_KEY);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("Staleness state unparseable — starting over");
    return {};
  }
}

// Same shape of function as updateBaselines and for the same reason: returns
// a fresh object keyed only by paths in the current geometry so a removed
// path's tracking state doesn't linger in KV forever.
function updateStaleness(prev, paths, now) {
  const next = {};
  for (const p of paths) {
    // No reading (dead sensor or missing) isn't evidence of staleness — it's
    // already rendered distinctly as "No data" (see colorFor). Drop tracking
    // rather than counting toward or resetting a streak that means something
    // different once real data resumes.
    if (p.speed_kmh == null || p.speed_kmh < 0) continue;
    const old = prev[p.id];
    const unchanged = old && old[0] === p.speed_kmh && old[1] === p.travel_time_s;
    next[p.id] = unchanged
      ? [p.speed_kmh, p.travel_time_s, old[2], old[3] + 1]
      : [p.speed_kmh, p.travel_time_s, now, 1];
  }
  return next;
}

async function readBaselines(env) {
  const raw = await env.TRAFFIC_KV.get(BASELINE_KEY);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    // Corrupt value shouldn't take the whole tick down — relearning from
    // scratch costs a day of context, a thrown error costs the snapshot.
    console.error("Baselines unparseable — starting over");
    return {};
  }
}

// --- Learned state ----------------------------------------------------------
//
// Everything the Worker learns lives in one KV value, "state", so a healthy
// tick costs a fixed three writes (latest, state, staleness) however much is
// learned — the Free plan allows 1,000 KV writes a day across all keys:
//
//   { v: 1,
//     baselines: { [pathId]: [freeFlowKmh, samples] },
//     slot: { key, paths: { [pathId]: [typicalKmh, samples] } } | null }
//
// `slot` is the typical-speed profile slot currently being learned (null
// until the first tick); finished slots are written once each to their own
// "profile:<slot key>" key.
const STATE_KEY = "state";

function emptyState() {
  return { v: 1, baselines: {}, slot: null };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Returns a normalised state, or null if `raw` isn't a usable one.
function parseState(raw) {
  let s;
  try {
    s = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!isPlainObject(s) || !isPlainObject(s.baselines)) return null;
  const slot = s.slot === undefined ? null : s.slot;
  if (slot !== null && !(isPlainObject(slot) && typeof slot.key === "string" && isPlainObject(slot.paths))) {
    return null;
  }
  return { v: 1, baselines: s.baselines, slot };
}

async function readState(env) {
  const raw = await env.TRAFFIC_KV.get(STATE_KEY);
  if (raw !== null && raw !== undefined) {
    const state = parseState(raw);
    if (state) return state;
    // State exists but is unusable: start empty and say so. Deliberately NOT
    // a reason to fall back to the old "baselines" key — that key stopped
    // being updated when "state" was introduced, so loading it would
    // silently resurrect stale free-flow speeds.
    console.error("State unparseable or malformed — starting its learned state over");
    return emptyState();
  }
  // No "state" yet: first run since it was introduced. Carry over the
  // free-flow speeds already learned under the old key instead of making
  // every road relearn a day of context.
  return { ...emptyState(), baselines: await readBaselines(env) };
}

// One step of the stochastic-approximation quantile estimator both the
// free-flow baselines and the per-slot typical-speed profiles are built on:
//
//   q <- q + eta * (p - 1[x <= q])
//
// i.e. nudge up by eta*p when the reading x is above the estimate, down by
// eta*(1-p) otherwise, so q settles at the p-quantile of the readings.
// p = 0.95 gives a free-flow speed, p = 0.5 a median. Rounded to two
// decimals — see updateBaselines for why one is not enough. The operand
// order is deliberate: it must stay bit-for-bit what updateBaselines computed
// before this was extracted.
function quantileStep(q, x, p, eta) {
  const step = x > q ? eta * p : -eta * (1 - p);
  return Math.round((q + step) * 100) / 100;
}

// Advances one set of per-path estimates ({ [pathId]: [q, samples] }) by one
// tick of readings, with the given quantile p and step eta. Shared by the
// free-flow baselines and the typical-speed profile slots.
//
// Returns a fresh object keyed only by paths in the current geometry, which
// is what keeps this from growing without bound as the upstream road network
// changes over the years (an earlier review caught the same class of bug in
// the service worker's tile cache).
function updateEstimates(prev, paths, p, eta) {
  const next = {};
  for (const path of paths) {
    const old = prev[path.id];
    // A dead sensor (-1) or missing reading is not evidence about the road,
    // so carry the existing estimate forward untouched rather than letting
    // an outage drag every estimate toward zero.
    if (path.speed_kmh == null || path.speed_kmh < 0) {
      if (old) next[path.id] = old;
      continue;
    }
    if (!old) {
      next[path.id] = [path.speed_kmh, 1];
      continue;
    }
    const [q, n] = old;
    // Two decimals, not one (inside quantileStep): the free-flow downward
    // step is only 0.025 km/h, so rounding to 1dp snapped every decrease
    // straight back to where it started and the estimate could only ever
    // ratchet upward — a baseline that silently never adapts down. 2dp is
    // still enough to keep float drift from growing the stored JSON with
    // 17-digit values.
    next[path.id] = [quantileStep(q, path.speed_kmh, p, eta), n + 1];
  }
  return next;
}

function updateBaselines(prev, paths) {
  return updateEstimates(prev, paths, BASELINE_TARGET_P, BASELINE_STEP_KMH);
}

// --- Typical speed by time of day -------------------------------------------
//
// Free flow says how fast a road *can* go; it can't say whether 40 km/h at
// 08:30 on a Tuesday is a crawl or just Tuesday. So each path also keeps a
// running median speed per 30-minute slot of the day, separately for weekdays
// and for weekends/public holidays — what is normal *at this time, on this
// kind of day*. The app compares the live reading against it
// (I_anom = typical / speed * 100, the Anomaly Indicator).
//
// Slots are Nicosia local time, not UTC, so they stay put across daylight
// saving: 08:30 is the morning peak all year, whichever offset applies. That
// also means a local hour can be visited twice (autumn) or never (spring) —
// both are fine, a slot is just "that clock time".
const PROFILE_SLOT_MINUTES = 30;

// The same estimator as the free-flow baselines, aimed at the median (p = 0.5)
// with a larger step: a slot only sees one reading per tick, six a day, so it
// has to move faster to settle within a few days. Each step moves the
// estimate by at most eta*(p or 1-p) = 0.5 km/h.
const PROFILE_TARGET_P = 0.5;
const PROFILE_STEP_KMH = 1.0;

// Withheld from the snapshot until a slot's estimate has seen this many
// readings — 18 is three matching days at six readings a day — so the app
// doesn't present a number that's still just the first reading it was seeded
// with. Counted per path per slot in actual readings, like MIN_BASELINE_SAMPLES.
// Caveat: a bad first reading (the feed does emit implausible values) seeds a
// bad estimate, and at 0.5 km/h per reading it takes weeks to heal; nothing
// here detects that.
const MIN_PROFILE_SAMPLES = 18;

// Finished slots are stored one per key, "profile:wd:0830" / "profile:we:1400"
// — 96 keys in all, each written once as its slot ends.
const PROFILE_KEY_PREFIX = "profile:";

// Created once per isolate: building an Intl.DateTimeFormat is real CPU and
// the budget is ~10 ms per invocation. en-US + hourCycle h23 keeps the parts
// stable (Latin digits, midnight as "00" rather than "24"). The weekday is
// derived from the date below instead of formatted, so no locale's weekday
// abbreviations are ever relied on.
const NICOSIA_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Nicosia",
  year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric",
  hourCycle: "h23",
});

function nicosiaClock(ms) {
  const parts = {};
  for (const p of NICOSIA_CLOCK.formatToParts(ms)) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  };
}

function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Orthodox Easter Sunday as a Gregorian {month, day}: Meeus' Julian
// algorithm, then +13 days to convert Julian to Gregorian (the offset is 13
// from 1900 through 2099).
function orthodoxEaster(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const julianMonth = Math.floor((d + e + 114) / 31);
  const julianDay = ((d + e + 114) % 31) + 1;
  const g = new Date(Date.UTC(year, julianMonth - 1, julianDay + 13));
  return { month: g.getUTCMonth() + 1, day: g.getUTCDate() };
}

// Public holidays that count as "weekend" for profiling. Cross-checked on
// 2026-10-14 against CySEC's published 2026 list and two Cypriot embassy
// pages; the Public Service's own list and the holiday law could not be
// reached, so this is NOT verified against the primary source — re-check it
// each January. Two judgement calls: 24 December is included (CySEC and the
// embassies list it), Easter Tuesday is not (no Cypriot source lists it).
// Holy Saturday and Easter Sunday need no entry — they are always a Saturday
// and a Sunday. No "observed on Monday" substitution is modelled; Cyprus
// doesn't shift holidays that fall on a weekend.
const CYPRUS_FIXED_HOLIDAYS = [
  "01-01", // New Year's Day
  "01-06", // Epiphany
  "03-25", // Greek Independence Day
  "04-01", // Cyprus National Day
  "05-01", // Labour Day
  "08-15", // Assumption
  "10-01", // Cyprus Independence Day
  "10-28", // Ochi Day
  "12-24", // Christmas Eve
  "12-25", // Christmas Day
  "12-26", // Boxing Day
];
// Days relative to Orthodox Easter Sunday.
const CYPRUS_EASTER_OFFSETS = [
  -48, // Green Monday (Clean Monday)
  -2, // Good Friday
  1, // Easter Monday
  50, // Whit Monday (Kataklysmos)
];

const holidayCache = new Map();

function cyprusHolidays(year) {
  let set = holidayCache.get(year);
  if (set) return set;
  set = new Set(CYPRUS_FIXED_HOLIDAYS.map((md) => `${year}-${md}`));
  const easter = orthodoxEaster(year);
  const easterMs = Date.UTC(year, easter.month - 1, easter.day);
  for (const offset of CYPRUS_EASTER_OFFSETS) {
    const d = new Date(easterMs + offset * 86400000);
    set.add(ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }
  holidayCache.set(year, set);
  return set;
}

// Which profile slot an instant falls in. `key` ("wd:0830" / "we:1400") names
// the slot; the KV key for its stored estimates is "profile:" + key.
function slotFor(ms) {
  const c = nicosiaClock(ms);
  const holiday = cyprusHolidays(c.year).has(ymd(c.year, c.month, c.day));
  const dow = new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay(); // 0 = Sunday
  const weekend = dow === 0 || dow === 6 || holiday;
  const startMinute = Math.floor(c.minute / PROFILE_SLOT_MINUTES) * PROFILE_SLOT_MINUTES;
  const hh = String(c.hour).padStart(2, "0");
  const mm = String(startMinute).padStart(2, "0");
  return {
    key: `${weekend ? "we" : "wd"}:${hh}${mm}`,
    dayType: weekend ? "weekend" : "weekday",
    holiday,
    starts: `${hh}:${mm}`,
  };
}

function updateProfile(prev, paths) {
  return updateEstimates(prev, paths, PROFILE_TARGET_P, PROFILE_STEP_KMH);
}

// A slot's stored estimates, or {} if it has never been written. A corrupt
// value costs that one slot a few days of learning, not the whole tick.
async function readSlot(env, slotKey) {
  const raw = await env.TRAFFIC_KV.get(PROFILE_KEY_PREFIX + slotKey);
  if (raw === null || raw === undefined) return {};
  try {
    const paths = JSON.parse(raw);
    if (isPlainObject(paths)) return paths;
  } catch (e) {
    // fall through to the error below
  }
  console.error(`Profile slot ${slotKey} unparseable — starting it over`);
  return {};
}

// The instant a tick is *for*: the cron's scheduled time, so a run that
// starts a few seconds late still lands in the right slot (and so tests can
// say exactly when a tick happens). Falls back to now, which is what /refresh
// has — it isn't a scheduled event. The runtime documents scheduledTime in
// milliseconds, but the Observability logs show the same field in seconds, so
// either is accepted: anything below 1e11 can only be seconds (1e11 ms is
// early 1973, 1e11 s is the year 5138).
function tickTimeMs(event) {
  const t = Number(event && event.scheduledTime);
  if (!Number.isFinite(t) || t <= 0) return Date.now();
  return t < 1e11 ? t * 1000 : t;
}

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

// Returns the snapshot plus the updated learned state rather than writing the
// latter itself: learned state must only be persisted alongside a snapshot
// that passes the health checks, so that a broken upstream feed can't quietly
// teach every road a wrong idea of normal. storeIfHealthy owns all the writes.
async function buildSnapshot(env, { refreshGeometry = false, nowMs = Date.now() } = {}) {
  const [geometry, liveText, alertsRaw, jams, situations, prevState, prevStaleness] = await Promise.all([
    refreshGeometry ? fetchAndCacheGeometry(env) : loadGeometry(env),
    fetchText(LIVE_URL),
    FETCH_EVENTS ? fetchAndParse(WAZE_ALERTS_URL, parseWazeAlerts, "waze_alerts") : Promise.resolve([]),
    FETCH_EVENTS ? fetchAndParse(WAZE_TRAFFIC_URL, parseWazeTraffic, "waze_traffic") : Promise.resolve([]),
    FETCH_EVENTS ? fetchAndParse(SITUATION_URL, parseSituations, "SituationPublication") : Promise.resolve([]),
    readState(env),
    readStaleness(env),
  ]);

  const live = parseLive(liveText);
  const { alerts, road_closures } = groupRoadClosures(alertsRaw);

  const paths = [];
  for (const [pid, geo] of geometry) {
    const liveData = live.get(pid) || { speed_kmh: null, travel_time_s: null, measured_at: null };
    paths.push({ id: pid, name: geo.name, coords: geo.coords, ...liveData });
  }

  const baselines = updateBaselines(prevState.baselines, paths);
  for (const p of paths) {
    const b = baselines[p.id];
    // Null until warmed up — the app treats that as "no baseline, use the
    // absolute thresholds" rather than guessing from a half-learned value.
    p.free_flow_kmh = (b && b[1] >= MIN_BASELINE_SAMPLES) ? b[0] : null;
  }

  // Typical speed for this time of day. When the clock has moved into a new
  // slot, the slot being learned is handed back as `flush` (storeIfHealthy
  // writes it once, to its own key) and the new slot's stored estimates are
  // loaded. Nothing is persisted here: if this tick turns out unhealthy the
  // stored state still points at the old slot, so the first healthy tick
  // after any run of bad ones does the hand-over — nothing in the finished
  // slot is lost.
  const slot = slotFor(nowMs);
  let slotState = prevState.slot;
  let flush = null;
  if (!slotState || slotState.key !== slot.key) {
    flush = slotState;
    slotState = { key: slot.key, paths: await readSlot(env, slot.key) };
  }
  const slotPaths = updateProfile(slotState.paths, paths);
  for (const p of paths) {
    const s = slotPaths[p.id];
    // Null until warmed up, like free_flow_kmh: the app shows nothing for it.
    p.typical_kmh = (s && s[1] >= MIN_PROFILE_SAMPLES) ? s[0] : null;
  }

  // Tracking runs every tick regardless (see updateStaleness above), but as
  // of 2026-09-01 nothing is derived from it yet: a first attempt at a
  // 30-min/6-tick "stale" threshold flagged 247 of ~397 paths within an
  // hour of deploy, which means most roads legitimately go that long
  // between real value changes — the assumption behind the threshold was
  // wrong, not just its number. Exposing the raw streak length instead of a
  // guessed-at boolean, so a few days of real /latest.json polls can show
  // the actual distribution before anything picks a threshold again.
  const now = new Date().toISOString();
  const staleness = updateStaleness(prevStaleness, paths, now);
  for (const p of paths) {
    const s = staleness[p.id];
    p.unchanged_ticks = s ? s[3] : 0;
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    path_count: paths.length,
    // -1 is the feed's sentinel for a malfunctioning sensor — the app
    // renders it identically to null (grey, "No data", see colorFor in
    // preview/index.html), so it must not count as "matched" here either.
    // Previously only null was excluded, letting dead-sensor paths inflate
    // this ratio above what the app actually shows as having data.
    matched_live_count: paths.filter((p) => p.speed_kmh != null && p.speed_kmh >= 0).length,
    // Mode (not max) across all paths' own measured_at — the timestamp most
    // paths share represents the feed's bulk state, resistant to a handful
    // of outlier paths in either direction (one stray fresh path masking a
    // broad freeze, or one permanently-broken path never letting the app
    // report "current"). generated_at above only proves the Worker's own
    // poll succeeded, not that the underlying data actually moved — this is
    // the field that catches a frozen-but-still-200-OK upstream feed.
    common_measurement_timestamp: modeMeasuredAt(paths),
    // How many paths have a warmed-up baseline — lets the app (and a glance
    // at /refresh) tell "still learning" apart from "learned, and this road
    // genuinely has no data".
    baseline_ready_count: paths.filter((p) => p.free_flow_kmh != null).length,
    // Which slot every path's typical_kmh is for, and how many paths have one
    // yet — the typical-speed counterpart of baseline_ready_count.
    typical_slot: { day_type: slot.dayType, starts: slot.starts, holiday: slot.holiday },
    typical_ready_count: paths.filter((p) => p.typical_kmh != null).length,
    paths,
    alerts,
    road_closures,
    jams,
    situations,
  };

  return {
    snapshot,
    state: { v: 1, baselines, slot: { key: slot.key, paths: slotPaths } },
    flush,
    staleness,
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

// `flush` is a finished profile slot ({ key, paths }) when the clock has moved
// into a new one, else null. It is written before — and on its own, not in the
// Promise.all below — because `state` is what remembers which slot is being
// learned. If the flush were written alongside and `state` landed first, a
// failed flush would leave `state` already pointing at the new slot with the
// old slot's readings gone. In this order a failed flush throws before
// anything else is written, so `state` still holds the old slot and the next
// healthy tick simply tries again; and a failed `state` write after a good
// flush just re-writes the same slot next time. Either way nothing is lost.
// Empty slots aren't written (nothing to keep, and a write is a scarce thing).
async function storeIfHealthy(env, snapshot, state, staleness, flush = null) {
  const reason = unhealthyReason(snapshot);
  if (reason) {
    console.error(`Refusing to store suspicious snapshot: ${reason} (upstream likely broken)`);
    return reason;
  }
  if (flush && Object.keys(flush.paths).length > 0) {
    await env.TRAFFIC_KV.put(PROFILE_KEY_PREFIX + flush.key, JSON.stringify(flush.paths));
  }
  await Promise.all([
    env.TRAFFIC_KV.put("latest", JSON.stringify(snapshot)),
    // Gated on the same health check as the snapshot itself: a degraded feed
    // must not get a vote on what each road's normal speed looks like.
    env.TRAFFIC_KV.put(STATE_KEY, JSON.stringify(state)),
    // Same gating logic, and for the same reason as above — a rejected
    // snapshot's readings shouldn't reset or advance any path's unchanged
    // streak either.
    env.TRAFFIC_KV.put(STALE_KEY, JSON.stringify(staleness)),
  ]);
  return null;
}

// Must match the second entry in wrangler.toml's [triggers] crons — the
// slower schedule that re-fetches/re-parses geometry (see loadGeometry
// above). Every other cron firing (the 5-min tick) uses the cached copy.
const GEOMETRY_CRON = "0 */6 * * *";

export default {
  async scheduled(event, env) {
    const { snapshot, state, flush, staleness } = await buildSnapshot(env, {
      refreshGeometry: event.cron === GEOMETRY_CRON,
      nowMs: tickTimeMs(event),
    });
    await storeIfHealthy(env, snapshot, state, staleness, flush);
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
      const { snapshot, state, flush, staleness } = await buildSnapshot(env, { refreshGeometry: true });
      const reason = await storeIfHealthy(env, snapshot, state, staleness, flush);
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
