import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';
import { MockKV, pathIds, runTick, withWorld } from './mocks.mjs';

const w = await loadWorker();
const IDS = pathIds(60);

const oldBaselines = () => Object.fromEntries(IDS.map((id) => [id, [60.5, 100]]));

test('a healthy tick writes exactly latest, state and staleness', async () => {
  await withWorld({}, async ({ kv, env }) => {
    await runTick(w, env);
    assert.deepStrictEqual([...kv.puts].sort(), ['latest', 'staleness', 'state']);
  });
});

test('first run migrates free-flow baselines from the old key and leaves it alone', async () => {
  const kv = new MockKV({ baselines: JSON.stringify(oldBaselines()) });
  await withWorld({ kv }, async ({ env }) => {
    await runTick(w, env);
    const state = kv.json('state');
    assert.deepStrictEqual(state.baselines.p00, [w.quantileStep(60.5, 70, 0.95, 0.5), 101]);
    assert.equal(typeof state.slot.key, 'string', 'the profile slot being learned is recorded in state');
    assert.equal(kv.putCount('baselines'), 0, 'the old key is never written');
    assert.deepStrictEqual(JSON.parse(kv.store.get('baselines')), oldBaselines(), 'and is left untouched');
  });
});

test('when state exists the old baselines key is ignored', async () => {
  const state = { v: 1, baselines: Object.fromEntries(IDS.map((id) => [id, [80, 10]])), slot: null };
  const kv = new MockKV({
    state: JSON.stringify(state),
    baselines: JSON.stringify(Object.fromEntries(IDS.map((id) => [id, [10, 1]]))),
  });
  await withWorld({ kv }, async ({ env }) => {
    await runTick(w, env);
    // 70 is below 80, so one downward step from 80 — nothing to do with the old key's 10.
    assert.deepStrictEqual(kv.json('state').baselines.p00, [w.quantileStep(80, 70, 0.95, 0.5), 11]);
  });
});

for (const [label, raw] of [
  ['unparseable JSON', '{not json'],
  ['empty string', ''],
  ['JSON null', 'null'],
  ['a JSON string', '"hello"'],
  ['baselines is an array', '{"v":1,"baselines":[1,2],"slot":null}'],
  ['baselines missing', '{"v":1,"slot":null}'],
  ['slot malformed', '{"v":1,"baselines":{},"slot":{"key":7,"paths":{}}}'],
]) {
  test(`corrupt state (${label}): logs, starts empty, never falls back to the old key`, async () => {
    const kv = new MockKV({ state: raw, baselines: JSON.stringify(oldBaselines()) });
    await withWorld({ kv }, async ({ env, con }) => {
      await runTick(w, env);
      assert.ok(con.errors.some((e) => /State unparseable or malformed/.test(e)), `errors: ${con.errors}`);
      // Seeded fresh from this tick's reading ([70, 1]), not derived from the old key's 60.5.
      assert.deepStrictEqual(kv.json('state').baselines.p00, [70, 1]);
      assert.deepStrictEqual(JSON.parse(kv.store.get('baselines')), oldBaselines());
    });
  });
}

test('an unhealthy tick writes nothing at all', async () => {
  // Only 20 of 60 paths report: 0.33 live ratio, under the 0.75 floor.
  const speedOf = (id) => (Number(id.slice(1)) < 20 ? 70 : -1);
  const state = { v: 1, baselines: { p00: [80, 10] }, slot: null };
  const kv = new MockKV({ state: JSON.stringify(state) });
  await withWorld({ kv, speedOf }, async ({ env, con }) => {
    await runTick(w, env);
    assert.deepStrictEqual(kv.puts, []);
    assert.ok(con.errors.some((e) => /Refusing to store suspicious snapshot/.test(e)));
    assert.deepStrictEqual(kv.json('state'), state, 'learned state untouched');
  });
});

test('free-flow speed is still withheld until 288 samples, then exposed', async () => {
  await withWorld({}, async ({ kv, env }) => {
    for (let i = 1; i <= 288; i++) {
      await runTick(w, env);
      if (i === 287) assert.equal(kv.json('latest').paths[0].free_flow_kmh, null);
    }
    // A constant reading can't pin the estimator exactly (it hovers a step or
    // two around it), so check "exposed and about right", not equality.
    const ff = kv.json('latest').paths[0].free_flow_kmh;
    assert.ok(ff !== null && Math.abs(ff - 70) < 1, `free_flow_kmh = ${ff}`);
    assert.equal(kv.json('latest').baseline_ready_count, 60);
  });
});
