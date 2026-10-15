import test from 'node:test';
import assert from 'node:assert/strict';
import { selectHistory, historyResponse } from '../src/history.mjs';
import { comparePools, validateSnapshot } from '../public/app.js';

const now = Date.parse('2026-10-15T15:00:00Z'), stamp = now / 1000;
const card = { name: 'Epic', series: 'Example', firstSeenAt: stamp - 86400, lastSeenAt: stamp,
  median7d: [100, 100, null, 0, 110], median30d: [80, 80, 80, 80, 90] };
function fixtures() {
  const legacy = { schemaVersion: 1, bucket: 1, bucketCount: 8, updatedAt: new Date(now).toISOString(),
    timestamps: [stamp-86400, stamp-3600, stamp-2400, stamp-1200, stamp], cards: { 1: card } };
  const compact = { ...legacy, schemaVersion: 2, cards: { 1: JSON.stringify({ ...card,
    median7d: [[0,100],[2,null],[3,0],[4,110]], median30d: [[0,80],[4,90]] }) } };
  return { legacy, compact };
}
test('compact history decodes identically to legacy, preserving zero, missing and every repeated sample', () => {
  const { legacy, compact } = fixtures();
  for (const range of ['24h','7d','30d']) assert.deepEqual(selectHistory(compact,1,range,now), selectHistory(legacy,1,range,now));
  const broken = structuredClone(compact);
  broken.cards[1] = JSON.stringify({ ...card, median7d: [[1,100]] });
  assert.throws(() => selectHistory(broken,1,'24h',now));
});
test('history cutoff matches snapshot and rejects invalid dates without changing observations', async () => {
  const {compact} = fixtures();
  const env = { PRICES: { get: async () => JSON.stringify(compact) } };
  const request = value => new Request(`https://test/api/history?card=1&range=24h&asOf=${encodeURIComponent(value)}`);
  const result = await historyResponse(request(new Date(now).toISOString()),env,now+600000);
  assert.equal(result.status,200);
  assert.deepEqual((await result.json()).points.map(p=>p.median7d),card.median7d);
  assert.equal((await historyResponse(request('invalid'),env,now)).status,400);
});
test('mixed rarities never contaminate the Mythical booster average and stale prices withhold recommendations', () => {
  const data = {schemaVersion:1,collectedAt:new Date(now).toISOString(),cards:[
    {id:1,name:'M1',rarity:'M',median7d:100},{id:2,name:'M2',rarity:'M',median7d:200},
    {id:3,name:'Legendary',rarity:'L',median7d:99999}],pools:[{id:'waifu',cardIds:[1]},{id:'husbando',cardIds:[2]}]};
  validateSnapshot(data);
  assert.equal(comparePools(data).winner.id,'husbando');
  data.cards[1].stale = true;
  assert.equal(comparePools(data).complete,false);
});
