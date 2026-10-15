import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';
import { pathIds, runTick, withWorld } from './mocks.mjs';

const w = await loadWorker();

// Shapes copied from the real feeds (see the Accident records in
// SituationPublication and the ACCIDENT elements in waze_alerts).
function situationXml({ id, type = 'Accident', source = 'Waze', desc = '', start, end = null, lat, lon, withSource = true }) {
  return `<q1:situationRecord xsi:type="q1:${type}" id="${id}" version="1">
<q1:severity>high</q1:severity>
${withSource ? `<q1:source><sourceIdentification xmlns="http://datex2.eu/schema/3/common">${source}</sourceIdentification></q1:source>` : ''}
<q1:validity><validityTimeSpecification xmlns="http://datex2.eu/schema/3/common"><overallStartTime>${start}</overallStartTime>${end ? `<overallEndTime>${end}</overallEndTime>` : ''}</validityTimeSpecification></q1:validity>
<q1:locationReference xsi:type="q48:PointLocation"><q48:pointByCoordinates><q48:pointCoordinates><q48:latitude>${lat}</q48:latitude><q48:longitude>${lon}</q48:longitude></q48:pointCoordinates></q48:pointByCoordinates></q1:locationReference>
<q1:_situationRecordExtension><description xmlns="">${desc}</description></q1:_situationRecordExtension>
</q1:situationRecord>`;
}

function alertXml({ id, type = 'ACCIDENT', street = 'Some St', time, lat, lon }) {
  return `<traffic:trafficElement>
<common:id>${id}</common:id>
<common:generalPublicComment>
<common:comment><common:commentType>type</common:commentType><common:value>${type}</common:value><common:lang>en</common:lang></common:comment>
<common:comment><common:commentType>street</common:commentType><common:value>${street}</common:value><common:lang>en</common:lang></common:comment>
<common:comment><common:commentType>report_time</common:commentType><common:value>${time}</common:value><common:lang>en</common:lang></common:comment>
</common:generalPublicComment>
<location:location><location:pointByCoordinates><location:pointCoordinates><common:latitude>${lat}</common:latitude><common:longitude>${lon}</common:longitude></location:pointCoordinates></location:pointByCoordinates></location:location>
</traffic:trafficElement>`;
}

test('parseSituations reads each record\'s declared source', () => {
  const xml = [
    situationXml({ id: 'a', source: 'Waze', desc: 'City:Larnaka, Street:E202, Category:ACCIDENT.NO_SUBTYPE', start: '2026-10-15T07:11:15', lat: 34.92997, lon: 33.618504 }),
    situationXml({ id: 'b', source: 'Operator', desc: 'Test Accident', start: '2026-10-15T10:37:00', end: '2026-10-15T11:07:00', lat: 35.09646, lon: 33.389248 }),
    situationXml({ id: 'c', type: 'MaintenanceWorks', withSource: false, start: '2026-08-24T08:00:00', lat: 34.9, lon: 33.1 }),
  ].join('\n');
  const [a, b, c] = w.parseSituations(xml);
  assert.deepStrictEqual([a.source, b.source, c.source], ['Waze', 'Operator', null]);
  assert.equal(a.type, 'Accident');
  assert.equal(a.description, 'City:Larnaka, Street:E202, Category:ACCIDENT.NO_SUBTYPE');
  assert.equal(a.ends_at, null);
  assert.equal(b.ends_at, '2026-10-15T11:07:00');
  assert.deepStrictEqual([b.lat, b.lon], [35.09646, 33.389248]);
});

// ~0.00045 degrees of latitude is about 50 m.
const sit = (over = {}) => ({ id: 's', type: 'Accident', source: 'Waze', starts_at: '2026-10-15T09:59:59', lat: 35.154144, lon: 33.34841, ...over });
const alert = (over = {}) => ({ id: 'al', type: 'ACCIDENT', report_time: '2026-10-15 09:59:59', lat: 35.154144, lon: 33.348412, ...over });

test('a Waze-sourced record is dropped when a Waze alert has the same second and place', () => {
  assert.deepStrictEqual(w.dropWazeTwins([sit()], [alert()]), []);
  // still a twin about 50 m away
  assert.deepStrictEqual(w.dropWazeTwins([sit()], [alert({ lat: 35.154144 + 0.00045 })]), []);
});

test('it is kept when the second differs, the place is far, or there is nothing to match', () => {
  assert.equal(w.dropWazeTwins([sit()], [alert({ report_time: '2026-10-15 10:00:00' })]).length, 1);
  assert.equal(w.dropWazeTwins([sit()], [alert({ lat: 35.154144 + 0.00135 })]).length, 1, '~150 m away is not a twin');
  assert.equal(w.dropWazeTwins([sit()], [alert({ lat: 35.2 })]).length, 1);
  const only = [sit()];
  assert.strictEqual(w.dropWazeTwins(only, []), only, 'no alerts: nothing to do');
  assert.equal(w.dropWazeTwins([sit({ starts_at: '2026-10-15T09:59:59.5' })], [alert()]).length, 1, 'uncertain match is kept');
  assert.equal(w.dropWazeTwins([sit()], [alert({ report_time: null }), alert({ lat: null })]).length, 1);
});

test('operator-entered and unknown-source records are never dropped, even on top of an alert', () => {
  for (const source of ['Operator', null, 'SomethingNew']) {
    assert.equal(w.dropWazeTwins([sit({ source })], [alert()]).length, 1, String(source));
  }
});

test('only the twin goes; other records keep their order', () => {
  const keep1 = sit({ id: 'k1', source: 'Operator' });
  const twin = sit({ id: 'twin' });
  const keep2 = sit({ id: 'k2', starts_at: '2026-10-15T10:20:32', lat: 34.7, lon: 33.0 });
  const out = w.dropWazeTwins([keep1, twin, keep2], [alert()]);
  assert.deepStrictEqual(out.map((s) => s.id), ['k1', 'k2']);
});

test('end to end: a tick publishes source, drops the Waze twin, keeps the rest', async () => {
  await withWorld({}, async ({ kv, env, upstream }) => {
    upstream.wazeAlertsXml = [
      alertXml({ id: 'w1', street: 'E902 - Proedrikou Megarou Ave', time: '2026-10-15 09:59:59', lat: 35.154144, lon: 33.348412 }),
      alertXml({ id: 'w2', street: 'Elsewhere', time: '2026-10-15 10:05:00', lat: 34.7, lon: 33.0 }),
    ].join('\n');
    upstream.situationsXml = [
      situationXml({ id: 'twin', source: 'Waze', desc: 'City:Lefkosia, Street:E902 - Proedrikou Megarou Ave, Category:ACCIDENT.NO_SUBTYPE', start: '2026-10-15T09:59:59', lat: 35.154144, lon: 33.34841 }),
      situationXml({ id: 'lonely-waze', source: 'Waze', desc: 'no alert for this one', start: '2026-10-15T10:20:32', lat: 34.8, lon: 33.2 }),
      situationXml({ id: 'op', source: 'Operator', desc: 'Test Accident', start: '2026-10-15T10:37:00', end: '2026-10-15T11:07:00', lat: 35.09646, lon: 33.389248 }),
      situationXml({ id: 'works', type: 'MaintenanceWorks', source: 'Operator', start: '2026-08-24T08:00:00', lat: 34.9, lon: 33.1 }),
    ].join('\n');
    await runTick(w, env);
    const snap = kv.json('latest');
    assert.deepStrictEqual(snap.situations.map((s) => s.id).sort(), ['lonely-waze', 'op', 'works']);
    assert.deepStrictEqual(Object.fromEntries(snap.situations.map((s) => [s.id, s.source])), { 'lonely-waze': 'Waze', op: 'Operator', works: 'Operator' });
    assert.equal(snap.alerts.length, 2, 'the Waze alerts themselves are untouched');
  });
});
