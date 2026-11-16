import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';
import { CRON_GEOMETRY, runTick, withWorld } from './mocks.mjs';

const w = await loadWorker();

// Shapes copied from the real feeds: each controller declares its own
// namespace prefix (q2, q3, ...) for the location, and a controller with no
// status at all has no <workingStatus>.
function controllerXml({ id, name, lat, lon, prefix = 'q2' }) {
  return `<q1:vmsController id="${id}" version="1.0"><q1:numberOfVms>1</q1:numberOfVms><q1:externalIdentifier>000${id}</q1:externalIdentifier><q1:vms vmsIndex="1"><q1:vms><q1:description><values xmlns="http://datex2.eu/schema/3/common"><value lang="en-US">${name}</value></values></q1:description><q1:vmsType>fullMatrixSign</q1:vmsType><q1:vmsLocation xmlns:${prefix}="http://datex2.eu/schema/3/locationReferencing" xsi:type="${prefix}:PointLocation"><${prefix}:coordinatesForDisplay><${prefix}:latitude>${lat}</${prefix}:latitude><${prefix}:longitude>${lon}</${prefix}:longitude></${prefix}:coordinatesForDisplay></q1:vmsLocation></q1:vms></q1:vms></q1:vmsController>`;
}

function statusXml({ id, status, at = '2026-11-16T11:05:21.333' }) {
  const working = status ? `<q1:workingStatus>${status}</q1:workingStatus>` : '';
  return `<q1:vmsControllerStatus><q1:vmsControllerTableReference id="1.0" version="1.0" targetClass="vms:VmsControllerTable" /><q1:vmsControllerReference id="${id}" version="1.0" targetClass="vms:VmsController" /><q1:statusUpdateTime>${at}</q1:statusUpdateTime><q1:vmsStatus vmsIndex="1"><q1:vmsStatus><q1:statusUpdateTime>${at}</q1:statusUpdateTime>${working}<q1:vmsMessage messageIndex="0"><q1:vmsMessage><q1:timeLastSet>0001-01-01T00:00:00</q1:timeLastSet></q1:vmsMessage></q1:vmsMessage></q1:vmsStatus></q1:vmsStatus></q1:vmsControllerStatus>`;
}

const TABLE = [
  controllerXml({ id: '7', name: 'A2 Highway Larnaka-Nicosia (Lymbia)', lat: 35.00042, lon: 33.40133, prefix: 'q2' }),
  controllerXml({ id: '8', name: 'A1 Highway Limassol-Nicosia (Alambra)', lat: 35.05, lon: 33.2, prefix: 'q3' }),
  controllerXml({ id: '9', name: 'Sign &amp; Co', lat: 34.9, lon: 33.1, prefix: 'q44' }),
].join('\n');

const LIVE = [
  statusXml({ id: '7', status: 'working' }),
  statusXml({ id: '8', status: 'notWorking', at: '2026-11-16T11:05:21.35' }),
  statusXml({ id: '9', status: null }),
].join('\n');

test('parseVmsInventory reads id, name and position whatever the namespace prefix', () => {
  assert.deepStrictEqual(w.parseVmsInventory(TABLE), [
    { id: '7', name: 'A2 Highway Larnaka-Nicosia (Lymbia)', lat: 35.00042, lon: 33.40133 },
    { id: '8', name: 'A1 Highway Limassol-Nicosia (Alambra)', lat: 35.05, lon: 33.2 },
    { id: '9', name: 'Sign & Co', lat: 34.9, lon: 33.1 },
  ]);
});

test('parseVmsInventory skips a controller with no usable position', () => {
  const noPosition = TABLE.replace(/<q2:latitude>[^<]*<\/q2:latitude>/, '');
  assert.deepStrictEqual(w.parseVmsInventory(noPosition).map((s) => s.id), ['8', '9']);
  assert.deepStrictEqual(w.parseVmsInventory('<feed/>'), []);
});

test('parseVmsStatus reads status and update time; a missing status is null', () => {
  assert.deepStrictEqual(w.parseVmsStatus(LIVE), [
    { id: '7', status: 'working', updated_at: '2026-11-16T11:05:21.333' },
    { id: '8', status: 'notWorking', updated_at: '2026-11-16T11:05:21.35' },
    { id: '9', status: null, updated_at: '2026-11-16T11:05:21.333' },
  ]);
});

test('the snapshot lists every sign from the inventory with its live status', async () => {
  await withWorld({}, async ({ kv, upstream, env }) => {
    upstream.vmsTableXml = TABLE;
    upstream.vmsLiveXml = LIVE;
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T09:05:00Z') });
    const vms = kv.json('latest').vms;
    assert.equal(vms.length, 3);
    assert.deepStrictEqual(vms[0], {
      id: '7', name: 'A2 Highway Larnaka-Nicosia (Lymbia)', lat: 35.00042, lon: 33.40133,
      status: 'working', updated_at: '2026-11-16T11:05:21.333',
    });
    assert.equal(vms[2].status, null);
  });
});

test('the inventory is stored once under its own key, then never rewritten while unchanged', async () => {
  await withWorld({}, async ({ kv, upstream, env }) => {
    upstream.vmsTableXml = TABLE;
    upstream.vmsLiveXml = LIVE;
    const t0 = Date.parse('2026-11-16T06:05:00Z');
    for (let i = 0; i < 6; i++) await runTick(w, env, { scheduledTime: t0 + i * 5 * 60000 });
    assert.equal(kv.putCount('vms_inventory'), 1);
    // A geometry-cron run refetches the inventory but finds it unchanged.
    await runTick(w, env, { cron: CRON_GEOMETRY, scheduledTime: Date.parse('2026-11-16T12:00:00Z') });
    assert.equal(kv.putCount('vms_inventory'), 1, 'an unchanged inventory costs no write');
  });
});

test('a changed inventory is picked up only on the geometry run, with one write', async () => {
  await withWorld({}, async ({ kv, upstream, env }) => {
    upstream.vmsTableXml = TABLE;
    upstream.vmsLiveXml = LIVE;
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T11:55:00Z') });
    upstream.vmsTableXml = TABLE + '\n' + controllerXml({ id: '10', name: 'New sign', lat: 35.2, lon: 33.3, prefix: 'q45' });
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T11:58:00Z') });
    assert.equal(kv.json('latest').vms.length, 3, 'the 5-minute run uses the cached inventory');
    await runTick(w, env, { cron: CRON_GEOMETRY, scheduledTime: Date.parse('2026-11-16T12:00:00Z') });
    assert.equal(kv.json('latest').vms.length, 4);
    assert.equal(kv.putCount('vms_inventory'), 2);
  });
});

test('an ordinary tick still makes exactly its three puts with VMS data present', async () => {
  await withWorld({}, async ({ kv, upstream, env }) => {
    upstream.vmsTableXml = TABLE;
    upstream.vmsLiveXml = LIVE;
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T09:05:00Z') });
    const before = kv.puts.length;
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T09:10:00Z') });
    assert.deepStrictEqual(kv.puts.slice(before).sort(), ['latest', 'staleness', 'state']);
  });
});

test('a failed live feed keeps every sign, with status and update time null', async () => {
  await withWorld({}, async ({ kv, upstream, con, env }) => {
    upstream.vmsTableXml = TABLE;
    upstream.vmsLive.status = 503;
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T09:05:00Z') });
    const vms = kv.json('latest').vms;
    assert.equal(vms.length, 3);
    assert.ok(vms.every((s) => s.status === null && s.updated_at === null));
    assert.ok(con.errors.some((e) => e.includes('VmsPublication')));
  });
});

test('a failed inventory feed never stops the road data being stored', async () => {
  await withWorld({}, async ({ kv, upstream, con, env }) => {
    upstream.vmsTable.status = 503;
    upstream.vmsLiveXml = LIVE;
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T09:05:00Z') });
    const snap = kv.json('latest');
    assert.deepStrictEqual(snap.vms, []);
    assert.equal(snap.path_count, 60);
    assert.equal(kv.putCount('vms_inventory'), 0);
    assert.ok(con.errors.some((e) => e.includes('VMS inventory')));
  });
});

test('a broken inventory fetch on the geometry run keeps the stored one', async () => {
  await withWorld({}, async ({ kv, upstream, env }) => {
    upstream.vmsTableXml = TABLE;
    upstream.vmsLiveXml = LIVE;
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T11:55:00Z') });
    upstream.vmsTableXml = '<feed/>'; // parses to nothing: a broken fetch, not "no signs"
    await runTick(w, env, { cron: CRON_GEOMETRY, scheduledTime: Date.parse('2026-11-16T12:00:00Z') });
    assert.equal(kv.json('latest').vms.length, 3);
    assert.equal(kv.json('vms_inventory').length, 3);
    assert.equal(kv.putCount('vms_inventory'), 1);
  });
});

test('a corrupt stored inventory is replaced, not trusted', async () => {
  await withWorld({}, async ({ kv, upstream, env }) => {
    upstream.vmsTableXml = TABLE;
    upstream.vmsLiveXml = LIVE;
    kv.store.set('vms_inventory', '{not json');
    await runTick(w, env, { scheduledTime: Date.parse('2026-11-16T09:05:00Z') });
    assert.equal(kv.json('latest').vms.length, 3);
    assert.equal(kv.json('vms_inventory').length, 3);
  });
});
