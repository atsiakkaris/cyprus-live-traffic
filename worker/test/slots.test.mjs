import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';

const w = await loadWorker();
const at = (iso) => w.slotFor(Date.parse(iso));

test('weekday slot is the 30-minute block in Nicosia local time (summer, UTC+3)', () => {
  // Wed 2026-10-14 05:40Z = 08:40 EEST
  assert.deepStrictEqual(at('2026-10-14T05:40:00Z'), {
    key: 'wd:0830', dayType: 'weekday', holiday: false, starts: '08:30',
  });
  // Exactly on the boundary belongs to the new slot.
  assert.equal(at('2026-10-14T05:30:00Z').key, 'wd:0830');
  assert.equal(at('2026-10-14T05:29:59Z').key, 'wd:0800');
});

test('winter uses UTC+2 and summer UTC+3 for the same UTC time of day', () => {
  assert.equal(at('2026-01-15T10:00:00Z').key, 'wd:1200'); // Thu, EET
  assert.equal(at('2026-07-15T10:00:00Z').key, 'wd:1300'); // Wed, EEST
});

test('Saturday and Sunday are weekend slots', () => {
  assert.deepStrictEqual(at('2026-10-17T11:05:00Z'), {
    key: 'we:1400', dayType: 'weekend', holiday: false, starts: '14:00',
  });
  assert.equal(at('2026-10-18T20:59:00Z').key, 'we:2330'); // Sun 23:59 local
});

test('fixed public holiday on a weekday is a weekend slot with holiday=true', () => {
  // Wed 2026-10-28 (Ochi Day); after the 25 Oct change Nicosia is UTC+2.
  assert.deepStrictEqual(at('2026-10-28T09:00:00Z'), {
    key: 'we:1100', dayType: 'weekend', holiday: true, starts: '11:00',
  });
  assert.equal(at('2026-10-01T09:00:00Z').holiday, true); // Thu, Independence Day
});

test('moveable (Orthodox-Easter-relative) holidays are weekend slots', () => {
  assert.equal(at('2026-02-23T08:00:00Z').key, 'we:1000'); // Green Monday
  assert.equal(at('2026-04-10T07:00:00Z').key, 'we:1000'); // Good Friday
  assert.equal(at('2026-04-13T07:00:00Z').key, 'we:1000'); // Easter Monday
  assert.equal(at('2026-06-01T07:00:00Z').key, 'we:1000'); // Whit Monday (Kataklysmos)
});

test('Easter Tuesday is an ordinary weekday; 24 December is a holiday', () => {
  assert.deepStrictEqual(at('2026-04-14T07:00:00Z'), {
    key: 'wd:1000', dayType: 'weekday', holiday: false, starts: '10:00',
  });
  assert.deepStrictEqual(at('2026-12-24T10:00:00Z'), { // Thursday
    key: 'we:1200', dayType: 'weekend', holiday: true, starts: '12:00',
  });
});

test('the day type follows the Nicosia date, not the UTC date', () => {
  // Friday in UTC, already Saturday in Nicosia (summer and winter).
  assert.equal(at('2026-09-04T21:30:00Z').key, 'we:0030');
  assert.equal(at('2026-01-09T22:30:00Z').key, 'we:0030');
  // Sunday in UTC, already Monday in Nicosia.
  assert.equal(at('2026-09-06T21:30:00Z').key, 'wd:0030');
  // One minute earlier it is still Friday, 23:59 local.
  assert.equal(at('2026-09-04T20:59:00Z').key, 'wd:2330');
});

test('Orthodox Easter matches the published dates', () => {
  assert.deepStrictEqual(w.orthodoxEaster(2024), { month: 5, day: 5 });
  assert.deepStrictEqual(w.orthodoxEaster(2025), { month: 4, day: 20 });
  assert.deepStrictEqual(w.orthodoxEaster(2026), { month: 4, day: 12 });
  assert.deepStrictEqual(w.orthodoxEaster(2027), { month: 5, day: 2 });
  assert.deepStrictEqual(w.orthodoxEaster(2028), { month: 4, day: 16 });
});

test('the 2026 holiday set is exactly the agreed list', () => {
  assert.deepStrictEqual([...w.cyprusHolidays(2026)].sort(), [
    '2026-01-01', '2026-01-06', '2026-02-23', '2026-03-25', '2026-04-01',
    '2026-04-10', '2026-04-13', '2026-05-01', '2026-06-01', '2026-08-15',
    '2026-10-01', '2026-10-28', '2026-12-24', '2026-12-25', '2026-12-26',
  ]);
});

// Walk a local day in 5-minute steps and return the run-length list of slot
// keys it passes through.
function runsBetween(startIso, endIso) {
  const runs = [];
  for (let t = Date.parse(startIso); t < Date.parse(endIso); t += 5 * 60000) {
    const key = w.slotFor(t).key;
    if (runs[runs.length - 1] !== key) runs.push(key);
  }
  return runs;
}

test('spring forward (2026-03-29): local 03:00-03:59 never occurs', () => {
  assert.equal(at('2026-03-29T00:59:00Z').key, 'we:0230'); // 02:59 EET
  assert.equal(at('2026-03-29T01:00:00Z').key, 'we:0400'); // 04:00 EEST
  const runs = runsBetween('2026-03-28T22:00:00Z', '2026-03-29T21:00:00Z'); // local Mar 29
  assert.equal(runs.length, 46);
  assert.ok(!runs.includes('we:0300') && !runs.includes('we:0330'));
});

test('fall back (2026-10-25): local 03:00-03:59 happens twice, nothing is skipped', () => {
  assert.equal(at('2026-10-25T00:59:00Z').key, 'we:0330'); // 03:59 EEST
  assert.equal(at('2026-10-25T01:00:00Z').key, 'we:0300'); // 03:00 EET, again
  const runs = runsBetween('2026-10-24T21:00:00Z', '2026-10-25T22:00:00Z'); // local Oct 25
  assert.equal(runs.length, 50);
  assert.equal(runs.filter((k) => k === 'we:0300').length, 2);
  assert.equal(runs.filter((k) => k === 'we:0330').length, 2);
  assert.equal(new Set(runs).size, 48);
});

test('every instant in a year maps to a well-formed key; all 96 slots exist', () => {
  const seen = new Set();
  for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 30 * 60000) {
    const s = w.slotFor(t);
    assert.match(s.key, /^(wd|we):([01]\d|2[0-3])(00|30)$/);
    assert.match(s.starts, /^([01]\d|2[0-3]):(00|30)$/);
    seen.add(s.key);
  }
  assert.equal(seen.size, 96);
});
