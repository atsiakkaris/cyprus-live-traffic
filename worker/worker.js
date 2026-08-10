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

const BLOCK_RE = /<q1:predefinedLocationReference[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/q1:predefinedLocationReference>/g;
const NAME_RE = /<value lang="en-US">([^<]*)<\/value>/;
const POSLIST_RE = /<q1:posList>([\s\S]*?)<\/q1:posList>/;
const COORDS_RE = /<gml:coordinates[^>]*>([\s\S]*?)<\/gml:coordinates>/;
const SPEED_RE = /<obs_speed[^>]*>([^<]*)<\/obs_speed>/;
const TTIME_RE = /<obs_t_time[^>]*>([^<]*)<\/obs_t_time>/;
const TS_RE = /<measurement_timestamp[^>]*>([^<]*)<\/measurement_timestamp>/;

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

async function buildSnapshot() {
  const [geometryText, liveText] = await Promise.all([
    fetch(GEOMETRY_URL).then((r) => r.text()),
    fetch(LIVE_URL).then((r) => r.text()),
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
