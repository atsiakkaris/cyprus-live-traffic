import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';
import { MockKV, pathIds, runTick, withWorld, simulate, prng } from './mocks.mjs';

const w = await loadWorker();
const DAY = 86400000;
const MIN = 60000;
const at = (iso) => Date.parse(iso);
// Mon 2026-10-12 00:00 Nicosia (EEST, UTC+3). That whole week has no public
// holiday and no daylight-saving change, so "ms since MON" is local time.
const MON = at('2026-10-11T21:00:00Z');
const local = (day, hh, mm = 0) => MON + day * DAY + (hh * 60 + mm) * MIN; // day 0 = Mon

test('a finished slot is written once, to its own key, when the clock moves on', async () => {
  await withWorld({}, async ({ kv, env }) => {
    await runTick(w, env, { scheduledTime: at('2026-10-14T05:20:00Z') }); // Wed 08:20 local
    await runTick(w, env, { scheduledTime: at('2026-10-14T05:25:00Z') }); // 08:25
    assert.equal(kv.json('state').slot.key, 'wd:0800');
    assert.equal(kv.putCount('profile:wd:0800'), 0, 'not written while it is still being learned');
    const finished = kv.json('state').slot.paths;

    await runTick(w, env, { scheduledTime: at('2026-10-14T05:30:00Z') }); // 08:30 -> next slot
    assert.equal(kv.putCount('profile:wd:0800'), 1);
    assert.deepStrictEqual(kv.json('profile:wd:0800'), finished);
    assert.equal(kv.json('state').slot.key, 'wd:0830');

    await runTick(w, env, { scheduledTime: at('2026-10-14T05:35:00Z') });
    assert.equal(kv.putCount('profile:wd:0800'), 1, 'and not written again');
    assert.equal(kv.putCount('profile:wd:0830'), 0);
  });
});

test('the snapshot says which slot typical_kmh is for, and has the field on every path', async () => {
  await withWorld({}, async ({ kv, env }) => {
    await runTick(w, env, { scheduledTime: at('2026-10-14T05:40:00Z') }); // Wed 08:40 local
    const latest = kv.json('latest');
    assert.deepStrictEqual(latest.typical_slot, { day_type: 'weekday', starts: '08:30', holiday: false });
    assert.equal(latest.typical_ready_count, 0);
    assert.ok(latest.paths.every((p) => 'typical_kmh' in p && p.typical_kmh === null));
  });
});

test('typical_kmh is null until a slot has 18 readings, across days, then exposed', async () => {
  await withWorld({}, async ({ kv, env, upstream }) => {
    const seen = {};
    await simulate(w, env, upstream, {
      fromMs: MON, toMs: local(2, 8, 30), // Mon 00:00 .. Wed 08:25 inclusive
      speedOf: () => 70,
      onTick: (t) => {
        if (t === local(2, 8, 20) || t === local(2, 8, 25)) seen[t] = kv.json('latest').paths[0].typical_kmh;
      },
    });
    // wd:0800 gets six readings a day (08:00..08:25): 6 + 6 + 5 = 17, then the 18th.
    assert.equal(seen[local(2, 8, 20)], null);
    assert.ok(seen[local(2, 8, 25)] !== null && Math.abs(seen[local(2, 8, 25)] - 70) < 1);
    assert.equal(kv.json('state').slot.paths.p00[1], 18, 'the slot was read back from KV each morning, not restarted');
  });
});

test('weekend slots take longer: after one weekend they are still withheld', async () => {
  await withWorld({}, async ({ kv, env, upstream }) => {
    const seen = {};
    await simulate(w, env, upstream, {
      fromMs: MON, toMs: local(7, 0),
      speedOf: () => 70,
      onTick: (t) => {
        if (t === local(4, 12) || t === local(6, 12)) {
          const s = kv.json('latest');
          seen[t] = { day: s.typical_slot.day_type, ready: s.typical_ready_count, p: s.paths[0].typical_kmh };
        }
      },
    });
    assert.deepStrictEqual(seen[local(4, 12)].day, 'weekday');
    assert.equal(seen[local(4, 12)].ready, 60); // Friday noon: Mon-Thu gave 24 readings
    assert.ok(seen[local(4, 12)].p !== null);
    assert.deepStrictEqual(seen[local(6, 12)].day, 'weekend'); // Sunday noon: only Saturday + 1
    assert.equal(seen[local(6, 12)].ready, 0);
    assert.equal(seen[local(6, 12)].p, null);
  });
});

test('a simulated working week converges on each slot\'s own median', async () => {
  // Rush hour (07:30-09:00) ~30 km/h, midday (11:00-14:00) ~70, otherwise ~90,
  // with symmetric +-8 km/h noise, so each slot's true median is its base.
  const rnd = prng(424242);
  const base = (t) => {
    const m = ((t - MON) % DAY) / MIN;
    return m >= 7 * 60 + 30 && m < 9 * 60 ? 30 : m >= 11 * 60 && m < 14 * 60 ? 70 : 90;
  };
  const speedOf = (id, t) => Math.round((base(t) + (rnd() - 0.5) * 16) * 10) / 10;
  await withWorld({}, async ({ kv, env, upstream }) => {
    const seen = {};
    await simulate(w, env, upstream, {
      fromMs: MON, toMs: local(5, 0), // Mon-Fri
      speedOf,
      onTick: (t) => {
        for (const [k, d, h, m] of [['rush', 4, 8, 25], ['midday', 4, 12, 25], ['evening', 4, 20, 25]]) {
          if (t === local(d, h, m)) seen[k] = kv.json('latest').paths[0].typical_kmh;
        }
      },
    });
    assert.ok(Math.abs(seen.rush - 30) <= 5, `rush ${seen.rush}`);
    assert.ok(Math.abs(seen.midday - 70) <= 5, `midday ${seen.midday}`);
    assert.ok(Math.abs(seen.evening - 90) <= 5, `evening ${seen.evening}`);
    assert.ok(seen.midday - seen.rush > 30, 'the slots are genuinely distinct');
  });
});

test('dead and missing readings leave a slot estimate alone and never seed one', async () => {
  const reading = { p01: 60, p02: -1 };
  await withWorld({ speedOf: (id) => (id in reading ? reading[id] : 70) }, async ({ kv, env }) => {
    const tick = (hh, mm) => runTick(w, env, { scheduledTime: at(`2026-10-14T${hh}:${mm}:00Z`) }); // 05:00Z = 08:00 local
    await tick('05', '00');
    assert.deepStrictEqual(kv.json('state').slot.paths.p01, [60, 1]);
    assert.ok(!('p02' in kv.json('state').slot.paths), 'a dead first reading seeds nothing');

    reading.p01 = -1; await tick('05', '05');
    reading.p01 = null; await tick('05', '10');
    assert.deepStrictEqual(kv.json('state').slot.paths.p01, [60, 1], 'carried forward, count not advanced');

    reading.p01 = 65; reading.p02 = 50; await tick('05', '15');
    assert.deepStrictEqual(kv.json('state').slot.paths.p01, [w.quantileStep(60, 65, 0.5, 1.0), 2]);
    assert.deepStrictEqual(kv.json('state').slot.paths.p02, [50, 1]);
  });
});

test('a slot change delayed across unhealthy ticks is not lost', async () => {
  const ctl = { healthy: true };
  await withWorld({ speedOf: () => (ctl.healthy ? 70 : -1) }, async ({ kv, env }) => {
    const tick = (iso) => runTick(w, env, { scheduledTime: at(iso) });
    for (const m of ['00', '05', '10', '15', '20', '25']) await tick(`2026-10-14T05:${m}:00Z`); // wd:0800
    const before = kv.json('state');
    assert.equal(before.slot.key, 'wd:0800');

    ctl.healthy = false; // 08:30 .. 09:25 local, spanning two slot changes
    const putsBefore = kv.puts.length;
    for (const [h, m] of [['05', '30'], ['05', '35'], ['05', '40'], ['05', '45'], ['05', '50'], ['05', '55'],
                          ['06', '00'], ['06', '05'], ['06', '10'], ['06', '15'], ['06', '20'], ['06', '25']]) {
      await tick(`2026-10-14T${h}:${m}:00Z`);
    }
    assert.equal(kv.puts.length, putsBefore, 'unhealthy ticks wrote nothing');
    assert.deepStrictEqual(kv.json('state'), before, 'state still points at the old slot');

    ctl.healthy = true;
    await tick('2026-10-14T06:30:00Z'); // 09:30 local -> wd:0930
    assert.equal(kv.putCount('profile:wd:0800'), 1);
    assert.deepStrictEqual(kv.json('profile:wd:0800'), before.slot.paths, 'every reading from before the gap is kept');
    assert.equal(kv.json('state').slot.key, 'wd:0930');
    // The flush is written first, on its own, ahead of latest/state/staleness.
    assert.equal(kv.puts[putsBefore], 'profile:wd:0800');
  });
});

test('a failed flush leaves state on the old slot, and the next healthy tick retries it', async () => {
  await withWorld({}, async ({ kv, env }) => {
    const tick = (iso) => runTick(w, env, { scheduledTime: at(iso) });
    for (const m of ['00', '05', '10', '15', '20', '25']) await tick(`2026-10-14T05:${m}:00Z`);
    const before = kv.json('state');
    const latestPuts = kv.putCount('latest');

    kv.failPuts.add('profile:wd:0800');
    await assert.rejects(() => tick('2026-10-14T05:30:00Z'), /put\(profile:wd:0800\) failed/);
    assert.deepStrictEqual(kv.json('state'), before, 'state did not advance');
    assert.equal(kv.putCount('latest'), latestPuts, 'nothing else was written either');

    kv.failPuts.clear();
    await tick('2026-10-14T05:35:00Z');
    assert.deepStrictEqual(kv.json('profile:wd:0800'), before.slot.paths, 'the retry wrote the old slot, complete');
    assert.equal(kv.json('profile:wd:0800').p00[1], 6);
    assert.equal(kv.json('state').slot.key, 'wd:0830');
  });
});

test('a failed state write after a good flush just re-writes the same slot next time', async () => {
  await withWorld({}, async ({ kv, env }) => {
    const tick = (iso) => runTick(w, env, { scheduledTime: at(iso) });
    for (const m of ['00', '05', '10', '15', '20', '25']) await tick(`2026-10-14T05:${m}:00Z`);
    const before = kv.json('state');

    kv.failPuts.add('state');
    await assert.rejects(() => tick('2026-10-14T05:30:00Z'), /put\(state\) failed/);
    const firstWrite = kv.store.get('profile:wd:0800');
    assert.deepStrictEqual(JSON.parse(firstWrite), before.slot.paths);
    assert.deepStrictEqual(kv.json('state'), before, 'state still on the old slot');

    kv.failPuts.clear();
    await tick('2026-10-14T05:35:00Z');
    assert.equal(kv.store.get('profile:wd:0800'), firstWrite, 'identical content, so the retry is harmless');
    assert.equal(kv.putCount('profile:wd:0800'), 2);
    assert.equal(kv.json('state').slot.key, 'wd:0830');
  });
});

test('a corrupt stored slot is logged and that slot starts over; the tick still succeeds', async () => {
  const kv = new MockKV({ 'profile:wd:0830': '{bad' });
  await withWorld({ kv }, async ({ env, con }) => {
    await runTick(w, env, { scheduledTime: at('2026-10-14T05:25:00Z') });
    await runTick(w, env, { scheduledTime: at('2026-10-14T05:30:00Z') }); // reads wd:0830
    assert.ok(con.errors.some((e) => /Profile slot wd:0830 unparseable/.test(e)), `errors: ${con.errors}`);
    assert.deepStrictEqual(kv.json('state').slot.paths.p00, [70, 1]);
  });
});

test('tickTimeMs accepts milliseconds or seconds, and falls back to now', () => {
  const ms = at('2026-10-14T05:40:00Z');
  assert.equal(w.tickTimeMs({ scheduledTime: ms }), ms);
  assert.equal(w.tickTimeMs({ scheduledTime: ms / 1000 }), ms);
  for (const bad of [undefined, null, {}, { scheduledTime: 'x' }, { scheduledTime: 0 }, { scheduledTime: -5 }]) {
    assert.ok(Math.abs(w.tickTimeMs(bad) - Date.now()) < 1000, `fallback for ${JSON.stringify(bad)}`);
  }
});

test('a seconds-valued scheduledTime lands in the same slot as milliseconds', async () => {
  await withWorld({}, async ({ kv, env }) => {
    await runTick(w, env, { scheduledTime: at('2026-10-14T05:40:00Z') / 1000 });
    assert.equal(kv.json('state').slot.key, 'wd:0830');
  });
});
