import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';
import { withWorld, runTick, CRON_5MIN, CRON_GEOMETRY } from './mocks.mjs';

const w = await loadWorker();
const at = (iso) => Date.parse(iso);
const MIN = 60000;
const DAY = 86400000;

// Fire every cron the way the platform does across one UTC day (KV's write
// quota resets at 00:00 UTC): the 5-minute cron every 5 minutes, and the
// geometry cron alongside it at 00/06/12/18.
async function fireDay(env, startMs) {
  for (let t = startMs; t < startMs + DAY; t += 5 * MIN) {
    await runTick(w, env, { cron: CRON_5MIN, scheduledTime: t });
    if (w.coincidesWithGeometryCron(t)) await runTick(w, env, { cron: CRON_GEOMETRY, scheduledTime: t });
  }
}

// Healthy tick = latest + state + staleness (3). 288 ticks a day = 864.
// A slot ends every 30 minutes = 48 profile writes. Geometry cron = 4.
// 864 + 48 + 4 = 916, which leaves 84 of the 1,000 free writes a day spare.
const EXPECTED_WRITES_PER_DAY = 288 * 3 + 48 + 4;

// A UTC day always contains 48 real half-hour boundaries, so the count holds
// on the daylight-saving days too (the local clock jumps, real time doesn't).
for (const [label, day] of [
  ['an ordinary day', '2026-10-13'],
  ['the spring-forward day', '2026-03-29'],
  ['the fall-back day', '2026-10-25'],
]) {
  test(`${label} (${day}) costs exactly ${EXPECTED_WRITES_PER_DAY} KV writes, under the 1,000 limit`, async () => {
    await withWorld({}, async ({ kv, env }) => {
      const start = at(`${day}T00:00:00Z`);
      await fireDay(env, start - DAY); // warm-up day, so no first-ever-tick effects are counted
      kv.puts.length = 0;
      await fireDay(env, start);

      assert.equal(kv.putCount('latest'), 288, 'one tick per 5 minutes, none doubled at 00/06/12/18');
      assert.equal(kv.putCount('state'), 288);
      assert.equal(kv.putCount('staleness'), 288);
      assert.equal(kv.putCount('geometry'), 4);
      assert.equal(kv.putCount('baselines'), 0, 'the old key is never written');
      assert.equal(kv.puts.filter((k) => k.startsWith('profile:')).length, 48);
      assert.ok(kv.puts.every((k) => ['latest', 'state', 'staleness', 'geometry'].includes(k) || /^profile:(wd|we):\d{4}$/.test(k)));
      assert.equal(kv.puts.length, EXPECTED_WRITES_PER_DAY);
      assert.ok(kv.puts.length < 1000);
    });
  });
}

test('an unhealthy day writes (almost) nothing: only the geometry cache', async () => {
  await withWorld({ speedOf: () => -1 }, async ({ kv, env }) => {
    await fireDay(env, at('2026-10-13T00:00:00Z'));
    assert.deepStrictEqual([...new Set(kv.puts)], ['geometry'], 'learned state is never written behind a bad feed');
    assert.equal(kv.puts.length, 4);
  });
});

test('/refresh works with the state and flush plumbing, and costs four writes', async () => {
  await withWorld({}, async ({ kv, env }) => {
    const call = (key) => w.default.fetch(new Request(`https://example.test/refresh?key=${key}`), { ...env, REFRESH_KEY: 's3cret' });

    const denied = await call('nope');
    assert.equal(denied.status, 401);
    assert.deepStrictEqual(kv.puts, []);

    const res = await call('s3cret');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.typical_slot && typeof body.typical_ready_count === 'number');
    assert.deepStrictEqual([...kv.puts].sort(), ['geometry', 'latest', 'staleness', 'state']);
  });
});
