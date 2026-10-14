import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadWorker } from './load-worker.mjs';
import { withWorld, runTick, CRON_5MIN, CRON_GEOMETRY } from './mocks.mjs';

const w = await loadWorker();
const at = (iso) => Date.parse(iso);

test('wrangler.toml declares exactly the two crons the code expects', async () => {
  const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const m = /^\s*crons\s*=\s*\[([^\]]*)\]/m.exec(toml);
  assert.ok(m, 'no `crons = [...]` line found in wrangler.toml');
  const crons = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepStrictEqual(crons, [CRON_5MIN, CRON_GEOMETRY]);
  assert.equal(w.GEOMETRY_CRON, CRON_GEOMETRY);
});

test('the guard matches exactly the four minutes "0 */6 * * *" fires, every day', () => {
  for (const day of ['2026-10-13', '2026-03-29', '2026-10-25', '2027-01-01']) {
    const fires = [];
    for (let m = 0; m < 24 * 60; m++) {
      const t = at(`${day}T00:00:00Z`) + m * 60000;
      if (w.coincidesWithGeometryCron(t)) fires.push(new Date(t).toISOString().slice(11, 16));
    }
    assert.deepStrictEqual(fires, ['00:00', '06:00', '12:00', '18:00'], day);
  }
});

test('at a coincident minute the 5-minute run steps aside and the geometry run does the tick', async () => {
  await withWorld({}, async ({ kv, env, upstream, con }) => {
    const t = at('2026-10-13T12:00:00Z');
    await runTick(w, env, { cron: CRON_5MIN, scheduledTime: t });
    assert.deepStrictEqual(kv.puts, []);
    assert.deepStrictEqual(upstream.requests, [], 'it did not even fetch');
    assert.ok(
      con.logs.some((l) => l.includes('Skipping the "*/5 * * * *" tick at 2026-10-13T12:00:00.000Z') && l.includes(`scheduledTime=${t}`)),
      `logs: ${con.logs}`
    );

    await runTick(w, env, { cron: CRON_GEOMETRY, scheduledTime: t });
    assert.deepStrictEqual([...kv.puts].sort(), ['geometry', 'latest', 'staleness', 'state']);
  });
});

test('the order the two crons arrive in makes no difference', async () => {
  await withWorld({}, async ({ kv, env }) => {
    const t = at('2026-10-13T18:00:00Z');
    await runTick(w, env, { cron: CRON_GEOMETRY, scheduledTime: t });
    const afterGeometry = kv.puts.length;
    await runTick(w, env, { cron: CRON_5MIN, scheduledTime: t });
    assert.equal(kv.puts.length, afterGeometry, 'the 5-minute run added no writes');
  });
});

test('one minute later the 5-minute run ticks normally', async () => {
  await withWorld({}, async ({ kv, env }) => {
    await runTick(w, env, { cron: CRON_5MIN, scheduledTime: at('2026-10-13T12:05:00Z') });
    assert.deepStrictEqual([...kv.puts].sort(), ['latest', 'staleness', 'state']);
  });
});

test('a seconds-valued scheduledTime is guarded the same way', async () => {
  await withWorld({}, async ({ kv, env }) => {
    await runTick(w, env, { cron: CRON_5MIN, scheduledTime: at('2026-10-13T06:00:00Z') / 1000 });
    assert.deepStrictEqual(kv.puts, []);
  });
});
