import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';
import { prng } from './mocks.mjs';

const w = await loadWorker();

// The free-flow estimator's parameters are explicitly out of scope for the
// typical-speed work; this pins them so a drive-by edit can't slip through.
test('free-flow estimator parameters are unchanged', () => {
  assert.equal(w.BASELINE_TARGET_P, 0.95);
  assert.equal(w.BASELINE_STEP_KMH, 0.5);
  assert.equal(w.MIN_BASELINE_SAMPLES, 288);
});

test('quantileStep: median settings move +-0.5 and ties go down', () => {
  assert.equal(w.quantileStep(50, 60, 0.5, 1.0), 50.5);
  assert.equal(w.quantileStep(50, 40, 0.5, 1.0), 49.5);
  // 1[x <= q]: a reading exactly equal to the estimate counts as "not above".
  assert.equal(w.quantileStep(50, 50, 0.5, 1.0), 49.5);
});

test('quantileStep: p95 settings are asymmetric (+0.475 up, -0.025 down)', () => {
  assert.ok(w.quantileStep(100, 120, 0.95, 0.5) > 100);
  assert.ok(w.quantileStep(100, 80, 0.95, 0.5) < 100);
  assert.equal(w.quantileStep(100, 120, 0.95, 0.5), Math.round((100 + 0.5 * 0.95) * 100) / 100);
  assert.equal(w.quantileStep(100, 80, 0.95, 0.5), Math.round((100 + -0.5 * (1 - 0.95)) * 100) / 100);
});

// Verbatim copy of updateBaselines as it was before quantileStep was
// extracted. Do not "simplify" it: its whole purpose is to be the old code.
function legacyUpdateBaselines(prev, paths) {
  const BASELINE_TARGET_P = 0.95;
  const BASELINE_STEP_KMH = 0.5;
  const next = {};
  for (const p of paths) {
    const old = prev[p.id];
    if (p.speed_kmh == null || p.speed_kmh < 0) {
      if (old) next[p.id] = old;
      continue;
    }
    if (!old) {
      next[p.id] = [p.speed_kmh, 1];
      continue;
    }
    const [q, n] = old;
    const step = p.speed_kmh > q
      ? BASELINE_STEP_KMH * BASELINE_TARGET_P
      : -BASELINE_STEP_KMH * (1 - BASELINE_TARGET_P);
    next[p.id] = [Math.round((q + step) * 100) / 100, n + 1];
  }
  return next;
}

test('updateBaselines reproduces the pre-extraction step exactly', () => {
  const rnd = prng(20261014);
  const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
  const base = Object.fromEntries(ids.map((id) => [id, 20 + Math.floor(rnd() * 100)]));
  let mine = {};
  let legacy = {};
  for (let step = 0; step < 2000; step++) {
    const paths = ids.map((id) => {
      const r = rnd();
      let speed;
      if (r < 0.08) speed = null; // missing reading
      else if (r < 0.16) speed = -1; // dead-sensor sentinel
      else if (r < 0.19) speed = 0.1; // implausible low spike the feed really emits
      else if (r < 0.22) speed = 150; // implausible high spike
      else if (r < 0.30 && legacy[id]) speed = legacy[id][0]; // exactly equal to q: the `>` boundary
      else speed = Math.round((base[id] + (rnd() - 0.5) * 30) * 10) / 10;
      return { id, speed_kmh: speed };
    });
    mine = w.updateBaselines(mine, paths);
    legacy = legacyUpdateBaselines(legacy, paths);
    assert.deepStrictEqual(mine, legacy, `diverged at step ${step}`);
  }
});

test('updateBaselines drops paths that left the geometry and carries dead sensors', () => {
  const prev = { a: [60, 5], gone: [70, 9] };
  const out = w.updateBaselines(prev, [
    { id: 'a', speed_kmh: -1 },
    { id: 'b', speed_kmh: 33 },
  ]);
  assert.deepStrictEqual(out, { a: [60, 5], b: [33, 1] });
});
