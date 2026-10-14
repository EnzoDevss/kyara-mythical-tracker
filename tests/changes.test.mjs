import test from 'node:test';
import assert from 'node:assert/strict';
import { changesResponse, selectHistory } from '../src/history.mjs';
import { summarizeHistory } from '../public/history-data.js';
import { compareChanges } from '../public/app.js';

const now = Date.parse('2026-10-14T20:00:00Z'), stamp = now / 1000;
const card = (values, extra = {}) => ({ name: 'Test', series: '', firstSeenAt: stamp - 90000, lastSeenAt: stamp, median7d: values, median30d: values, ...extra });
const fixture = () => ({ schemaVersion: 1, bucket: 1, bucketCount: 8, updatedAt: new Date(now).toISOString(), timestamps: [stamp - 90000, stamp - 86400, stamp], cards: {
  1: card([50, 100, 110]), 9: card([200, 100, 90]), 17: card([80, 100, 100]),
  25: card([100, null, 110]), 33: card([100, 0, 10]), 41: card([null, null, 10], { firstSeenAt: stamp }),
} });
const request = (query = '?bucket=1', method = 'GET') => new Request(`https://test/api/changes${query}`, { method });
test('24h changes match chart percentages, excluding older points and preserving missing values', async () => {
  const history = fixture(); let reads = 0;
  const response = await changesResponse(request(), { PRICES: { get: async key => { reads++; assert.equal(key, 'history-v1-1'); return JSON.stringify(history); } } }, now);
  assert.equal(response.status, 200); assert.equal(reads, 1);
  const data = await response.json();
  for (const id of Object.keys(history.cards)) assert.equal(data.cards[id].median7d, summarizeHistory(selectHistory(history, Number(id), '24h', now).points, 'median7d').percent);
  assert.equal(data.cards[1].median7d, 10); assert.equal(data.cards[9].median7d, -10); assert.equal(data.cards[17].median7d, 0);
  for (const id of [25, 33, 41]) assert.equal(data.cards[id].median7d, null);
});
test('change sorting orders gains, zero, losses, then missing in both directions', () => {
  const values = [null, -20, 0, 10, -5, 2];
  assert.deepEqual([...values].sort((a,b) => compareChanges(a,b)), [10,2,0,-5,-20,null]);
  assert.deepEqual([...values].sort((a,b) => compareChanges(a,b,true)), [-20,-5,0,2,10,null]);
});
test('changes API is read-only and distinguishes absent history from invalid data', async () => {
  assert.equal((await changesResponse(request('', 'POST'), {}, now)).status, 405);
  assert.equal((await changesResponse(request('?bucket=8'), {}, now)).status, 400);
  const empty = await changesResponse(request(), { PRICES: { get: async () => null } }, now);
  assert.deepEqual((await empty.json()).cards, {});
  assert.equal((await changesResponse(request(), { PRICES: { get: async () => '{}' } }, now)).status, 503);
  assert.equal(await (await changesResponse(request('?bucket=1', 'HEAD'), { PRICES: { get: async () => null } }, now)).text(), '');
});
