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
const LAT_LON_RE = /<common:latitude>([^<]*)<\/common:latitude>\s*<common:longitude>([^<]*)<\/common:longitude>/g;

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
    const idMatch = /<common:id>([^<]*)<\/common:id>/.exec(block);
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

// Waze crowdsourced jam segments: a from/to road description, a 0–5 jamLevel,
// and a line (start/intermediate/end points) rather than a single point.
function parseWazeTraffic(text) {
  const jams = [];
  for (const m of text.matchAll(TRAFFIC_ELEMENT_RE)) {
    const block = m[1];
    const idMatch = /<common:id>([^<]*)<\/common:id>/.exec(block);
    const linearMatch = /<location:linear>([\s\S]*?)<\/location:linear>/.exec(block);
    if (!idMatch || !linearMatch) continue;
    const coords = [...linearMatch[1].matchAll(LAT_LON_RE)]
      .map((p) => [parseFloat(p[1]), parseFloat(p[2])])
      .filter((p) => !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
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
    const text = await fetch(url).then((r) => r.text());
    return parse(text);
  } catch (err) {
    console.error(`Failed to fetch/parse ${label}: ${err}`);
    return [];
  }
}

async function buildSnapshot() {
  const [geometryText, liveText, alerts, jams, situations] = await Promise.all([
    fetch(GEOMETRY_URL).then((r) => r.text()),
    fetch(LIVE_URL).then((r) => r.text()),
    fetchAndParse(WAZE_ALERTS_URL, parseWazeAlerts, "waze_alerts"),
    fetchAndParse(WAZE_TRAFFIC_URL, parseWazeTraffic, "waze_traffic"),
    fetchAndParse(SITUATION_URL, parseSituations, "SituationPublication"),
  ]);

  const geometry = parseGeometry(geometryText);
  const live = parseLive(liveText);

  const paths = [];
  for (const [pid, geo] of geometry) {
    const liveData = live.get(pid) || { speed_kmh: null, travel_time_s: null, measured_at: null };
    paths.push({ id: pid, name: geo.name, coords: geo.coords, ...liveData });
  }

  return {
    generated_at: new Date().toISOString(),
    path_count: paths.length,
    matched_live_count: paths.filter((p) => p.speed_kmh != null).length,
    paths,
    alerts,
    jams,
    situations,
  };
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
function describeCaller(request) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const host = origin === "null" ? "file://" : origin ? new URL(origin).host : (referer ? new URL(referer).host : null);

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

// Sanity floor for a healthy snapshot. Normal runs return ~429 paths; a
// broken upstream fetch (e.g. an expired TLS cert causing a malformed or
// empty response instead of a thrown error) can silently parse down to 0
// with no exception raised at all. Refusing to write anything below this
// floor means a bad upstream response degrades to "serve the last known
// good snapshot" instead of wiping the live app blank for every user.
const MIN_HEALTHY_PATH_COUNT = 50;

export default {
  async scheduled(event, env, ctx) {
    const snapshot = await buildSnapshot();
    if (snapshot.path_count < MIN_HEALTHY_PATH_COUNT) {
      console.error(`Refusing to store suspicious snapshot: only ${snapshot.path_count} paths (upstream likely broken)`);
      return;
    }
    await env.TRAFFIC_KV.put("latest", JSON.stringify(snapshot));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/refresh") {
      console.log(`GET /refresh from ${describeCaller(request)}`);
      const snapshot = await buildSnapshot();
      if (snapshot.path_count < MIN_HEALTHY_PATH_COUNT) {
        console.error(`Refusing to store suspicious snapshot: only ${snapshot.path_count} paths (upstream likely broken)`);
        return new Response(
          JSON.stringify({ error: "Upstream returned a suspiciously empty/broken feed — last good snapshot kept.", ...snapshot }),
          { status: 502, headers: JSON_HEADERS }
        );
      }
      await env.TRAFFIC_KV.put("latest", JSON.stringify(snapshot));
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
