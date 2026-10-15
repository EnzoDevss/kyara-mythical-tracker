import test from 'node:test';
import assert from 'node:assert/strict';
import { selectHistory, historyResponse } from '../src/history.mjs';
import worker from '../src/worker.mjs';
import { validateHistory, summarizeHistory, chartModel, hourlyPoints, dailyPoints } from '../public/history-data.js';

const now = Date.parse('2026-10-14T16:00:00Z');
const stamp = now / 1000;
const request = (query = '?card=1&range=24h', method = 'GET') => new Request(`https://example.test/api/history${query}`, { method });
function fixture() {
  return { schemaVersion: 1, bucket: 1, bucketCount: 8, updatedAt: new Date(now).toISOString(),
    timestamps: [stamp - 30 * 86400, stamp - 7 * 86400, stamp - 86400, stamp - 1800, stamp],
    cards: { 1: { name: 'Alpha', series: 'Example', firstSeenAt: stamp - 30 * 86400, lastSeenAt: stamp,
      median7d: [100, 120, 140, null, 150], median30d: [90, 100, 130, 140, 145] } } };
}

test('24-hour, 7-day and 30-day windows include boundaries without inventing samples', () => {
  for (const [range, count] of [['24h', 3], ['7d', 4], ['30d', 5]]) {
    const data = validateHistory(selectHistory(fixture(), 1, range, now), 1, range);
    assert.equal(data.points.length, count);
    assert.equal(data.points.at(-1).median7d, 150);
  }
});
test('missing storage or unknown card returns an honest empty history', () => {
  assert.deepEqual(selectHistory(null, 1, '24h', now).points, []);
  assert.deepEqual(selectHistory(fixture(), 9, '24h', now).points, []);
});
test('new and removed cards exclude padded samples outside their observed lifetime', () => {
  const data = fixture(); data.cards[1].firstSeenAt = stamp - 1800; data.cards[1].lastSeenAt = stamp - 1800;
  const result = selectHistory(data, 1, '30d', now);
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].at, new Date(now - 1800000).toISOString());
});
test('history endpoint is read-only and uses one KV read for the selected card', async () => {
  let reads = 0;
  const response = await historyResponse(request(), { PRICES: { get: async (key, options) => { reads++; assert.equal(key, 'history-v1-1'); assert.equal(options.type, 'text'); return JSON.stringify(fixture()); } } }, now);
  assert.equal(response.status, 200); assert.equal(reads, 1);
  assert.equal((await response.json()).points.length, 3);
  assert.equal((await historyResponse(request('', 'POST'), {}, now)).status, 405);
});
test('bad card IDs and unsupported windows do not touch storage', async () => {
  for (const query of ['?card=0', '?card=-1', '?card=../latest', '?card=1&range=year', '?card=1&range=toString', '?card=1.5', '?card=9007199254740992', '']) {
    assert.equal((await historyResponse(request(query), { PRICES: { get: () => assert.fail('invalid query accessed storage') } }, now)).status, 400);
  }
});
test('storage outage and corrupt history return an error, never an empty success', async () => {
  for (const raw of ['not json', '{}', JSON.stringify({ ...fixture(), bucket: 2 })]) {
    assert.equal((await historyResponse(request(), { PRICES: { get: async () => raw } }, now)).status, 503);
  }
  assert.equal((await historyResponse(request(), { PRICES: { get: async () => { throw new Error('outage'); } } }, now)).status, 503);
  const invalid = fixture(); invalid.cards[1].median7d = [10];
  assert.throws(() => selectHistory(invalid, 1, '24h', now));
});
test('Worker dispatches history and HEAD returns no body', async () => {
  const env = { PRICES: { get: async () => null } };
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).cardId, 1);
  assert.equal(await (await historyResponse(request('?card=1', 'HEAD'), env, now)).text(), '');
});
test('history parser rejects a response for a different card or period', () => {
  const data = selectHistory(fixture(), 1, '24h', now);
  assert.throws(() => validateHistory(data, 2, '24h'));
  assert.throws(() => validateHistory(data, 1, '7d'));
  data.points[0].median7d = undefined;
  assert.throws(() => validateHistory(data, 1, '24h'));
});
test('chart summary keeps missing, zero, and unchanged values distinct', () => {
  assert.equal(summarizeHistory([{ median7d: 10 }, { median7d: null }], 'median7d').latest, null);
  const zero = summarizeHistory([{ median7d: 0 }, { median7d: 10 }], 'median7d');
  assert.equal(zero.change, 10); assert.equal(zero.percent, null); assert.equal(zero.low, 0);
  assert.equal(summarizeHistory([{ median7d: 10 }, { median7d: 10 }], 'median7d').percent, 0);
  assert.equal(summarizeHistory([{ median7d: 10 }], 'median7d').change, null);
});
test('chart breaks lines at missing prices and large collection gaps', () => {
  const data = selectHistory(fixture(), 1, '24h', now);
  const model = chartModel(data, 'median7d');
  assert.equal(model.paths.length, 2); assert.equal(model.dots.length, 2);
  const otherMetric = chartModel(data, 'median30d');
  assert.equal(otherMetric.paths.length, 2); assert.equal(otherMetric.dots.length, 3);
});
test('first observation, constant prices and zero all have finite chart coordinates', () => {
  const data = selectHistory(fixture(), 1, '24h', now);
  data.points = [{ at: new Date(now).toISOString(), median7d: 0, median30d: 0 }];
  for (const width of [280, 900]) {
    const model = chartModel(data, 'median7d', width);
    assert.equal(model.dots.length, 1);
    assert.equal(model.dots[0].x, model.right);
    assert.ok(Number.isFinite(model.dots[0].y));
    assert.ok(model.ticks.every(tick => Number.isFinite(tick.y) && Number.isFinite(tick.value)));
  }
});

test('hourly visuals use prior prices on full hours without altering raw observations', () => {
  const data = { windowStart: '2026-10-15T10:15:00Z', windowEnd: '2026-10-15T14:20:00Z', points: [
    { at: '2026-10-15T10:43:00Z', median7d: 100, median30d: 90 },
    { at: '2026-10-15T11:13:00Z', median7d: 120, median30d: 110 }
  ] };
  const original = JSON.stringify(data);
  const points = hourlyPoints(data);
  assert.deepEqual(points.map(p => p.median7d), [100, 120, null, null]);
  assert.ok(points.every(p => new Date(p.at).getUTCMinutes() === 0));
  assert.equal(JSON.stringify(data), original);
});

test('daily chart closes use the last same-day price and exclude today', () => {
  const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
  const data = { windowStart: at(12, 12), windowEnd: at(15, 12), points: [
    { at: at(12, 13), median7d: 100, median30d: 90 },
    { at: at(12, 23), median7d: 120, median30d: 110 },
    { at: at(14, 22), median7d: 140, median30d: 130 },
    { at: at(15, 10), median7d: 150, median30d: 140 }
  ] };
  const original = JSON.stringify(data), points = dailyPoints(data);
  assert.deepEqual(points.map(p => p.median7d), [120, null, 140]);
  assert.ok(points.every(p => { const d = new Date(p.at); return d.getHours() === 23 && d.getMinutes() === 59 && d.getSeconds() === 59; }));
  assert.equal(JSON.stringify(data), original);
  const model = chartModel({ ...data, chartInterval: 'daily', points: points.filter(p => p.median7d !== null) }, 'median7d');
  assert.equal(model.paths.length, 2);
});
