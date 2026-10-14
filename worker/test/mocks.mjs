// Test doubles for the Worker: an in-memory KV namespace that records every
// write, and a fake upstream (geometry + live feeds) served through a stubbed
// global fetch. Only the shapes the Worker's own regexes look for are
// produced — see BLOCK_RE / NAME_RE / POSLIST_RE / COORDS_RE / SPEED_RE /
// TTIME_RE / TS_RE in worker.js.

export class MockKV {
  constructor(initial = {}) {
    this.store = new Map(Object.entries(initial));
    this.puts = []; // key of every successful put, in order
    this.gets = []; // key of every get, in order
    this.failPuts = new Set(); // keys whose put should throw
  }

  async get(key) {
    this.gets.push(key);
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value) {
    if (this.failPuts.has(key)) throw new Error(`mock KV: put(${key}) failed`);
    this.puts.push(key);
    this.store.set(key, String(value));
  }

  putCount(key) {
    return this.puts.filter((k) => k === key).length;
  }

  json(key) {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

const EMPTY_FEED = '<feed/>';

function geometryXml(ids) {
  return ids
    .map(
      (id, i) =>
        `<q1:predefinedLocationReference id="${id}" version="1">` +
        `<value lang="en-US">Path ${id}</value>` +
        // posList is XML-escaped inside the real feed; the Worker unescapes it.
        `<q1:posList>&lt;gml:coordinates&gt;35.${10 + i},33.30 35.${10 + i},33.40&lt;/gml:coordinates&gt;</q1:posList>` +
        `</q1:predefinedLocationReference>`
    )
    .join('\n');
}

function liveXml(ids, speedOf, measuredAt) {
  return ids
    .map((id) => {
      const speed = speedOf(id);
      if (speed === undefined) return ''; // path absent from the live feed entirely
      const speedEl = speed === null ? '' : `<obs_speed>${speed}</obs_speed><obs_t_time>300</obs_t_time>`;
      return (
        `<q1:predefinedLocationReference id="${id}" version="1">` +
        `${speedEl}<measurement_timestamp>${measuredAt}</measurement_timestamp>` +
        `</q1:predefinedLocationReference>`
      );
    })
    .join('\n');
}

// Serves the upstream feeds the Worker fetches. `speedOf(id)` decides each
// path's reading: a number, -1 (dead sensor), null (block without a speed), or
// undefined (path missing from the live feed). Waze and situations are empty.
export class FakeUpstream {
  constructor(ids, speedOf = () => 50) {
    this.ids = ids;
    this.speedOf = speedOf;
    this.measuredAt = '2026-10-14T10:00:00.0000000Z';
    this.live = { status: 200 }; // override status to simulate an upstream error
    this.requests = [];
    this._original = null;
  }

  install() {
    this._original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      this.requests.push(u);
      let status = 200;
      let body = EMPTY_FEED;
      if (u.includes('PredefinedLocationDataPublication')) {
        status = this.live.status;
        body = liveXml(this.ids, this.speedOf, this.measuredAt);
      } else if (u.includes('PredefinedLocationPublication')) {
        body = geometryXml(this.ids);
      }
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    };
    return this;
  }

  restore() {
    if (this._original !== null) globalThis.fetch = this._original;
    this._original = null;
  }
}

// Deterministic PRNG (mulberry32) so randomized tests are reproducible.
export function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
