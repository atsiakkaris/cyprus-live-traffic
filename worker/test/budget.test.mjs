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
// Returns one entry per cron invocation: the keys it put.
async function fireDay(env, startMs) {
  const kv = env.TRAFFIC_KV;
  const invocations = [];
  const fire = async (cron, t) => {
    const before = kv.puts.length;
    await runTick(w, env, { cron, scheduledTime: t });
    invocations.push({ t, cron, puts: kv.puts.slice(before) });
  };
  for (let t = startMs; t < startMs + DAY; t += 5 * MIN) {
    await fire(CRON_5MIN, t);
    if (w.coincidesWithGeometryCron(t)) await fire(CRON_GEOMETRY, t);
  }
  return invocations;
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

// Per invocation: a tick puts latest + state + staleness (3), plus one profile
// slot on the first tick of each half hour (+1), plus geometry on the geometry
// cron (+1). At 00/06/12/18 UTC the 5-minute run steps aside (0) and the
// geometry run does that minute's tick, which is also a half-hour boundary: 5.
// Nicosia is a whole number of hours from UTC, so its slot boundaries fall on
// UTC :00 and :30; computed here from the clock, not from slotFor.
for (const [label, day] of [
  ['an ordinary day', '2026-10-13'],
  ['the spring-forward day', '2026-03-29'],
  ['the fall-back day', '2026-10-25'],
]) {
  test(`${label} (${day}): every cron invocation makes the expected puts`, async () => {
    await withWorld({}, async ({ kv, env }) => {
      const start = at(`${day}T00:00:00Z`);
      await fireDay(env, start - DAY);
      const invocations = await fireDay(env, start);

      const tally = {};
      for (const { t, cron, puts } of invocations) {
        const geometryMinute = w.coincidesWithGeometryCron(t);
        const when = new Date(t).toISOString();
        if (cron === CRON_5MIN && geometryMinute) {
          assert.deepStrictEqual(puts, [], `${when}: the 5-minute run steps aside`);
          continue;
        }
        const expected = ['latest', 'staleness', 'state'];
        if (t % (30 * MIN) === 0) expected.push('profile');
        if (cron === CRON_GEOMETRY) expected.push('geometry');
        assert.deepStrictEqual(
          puts.map((k) => (k.startsWith('profile:') ? 'profile' : k)).sort(),
          expected.sort(),
          `${when} ${cron}`
        );
        tally[puts.length] = (tally[puts.length] || 0) + 1;
      }
      assert.deepStrictEqual(tally, { 3: 240, 4: 44, 5: 4 });
      assert.equal(240 * 3 + 44 * 4 + 4 * 5, EXPECTED_WRITES_PER_DAY);
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
