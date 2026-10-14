import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSnapshot, computePoolStats, comparePools, median, csvCell } from '../public/app.js';

function sample() {
  return {
    schemaVersion: 1, currency: 'chakra', source: 'kyara-public-api', collectedAt: '2026-10-14T15:31:00Z',
    pools: [{ id: 'waifu', cardIds: [1, 2] }, { id: 'husbando', cardIds: [3] }],
    cards: [
      { id: 1, name: 'First', rarity: 'M', median7d: 100, median30d: 20 },
      { id: 2, name: 'Second', rarity: 'M', median7d: 300, median30d: 40 },
      { id: 3, name: 'Third', rarity: 'M', median7d: 150, median30d: 60 },
    ],
  };
}

test('uses a mean of card medians, independent of sales volume', () => {
  const data = sample();
  data.cards[0].sales7d = 1000;
  data.cards[1].sales7d = 1;
  const result = comparePools(data, 7);
  assert.equal(result.winner.id, 'waifu');
  assert.equal(result.winner.mean, 200);
  assert.equal(result.difference, 50);
  assert.ok(Math.abs(result.percent - 100 / 3) < 1e-8);
});

test('changing price window can change the recommendation', () => {
  const result = comparePools(sample(), 30);
  assert.equal(result.winner.id, 'husbando');
  assert.equal(result.winner.mean, 60);
  assert.equal(result.percent, 100);
});

test('null prices are excluded from averages and withhold a recommendation', () => {
  const data = sample();
  data.cards[1].median7d = null;
  const result = comparePools(data);
  assert.equal(result.pools[0].mean, 100);
  assert.equal(result.pools[0].priced, 1);
  assert.equal(result.pools[0].missing, 1);
  assert.equal(result.complete, false);
  assert.equal(result.winner, null);
});

test('zero is a valid price, including a zero-price comparison', () => {
  const data = sample();
  data.cards[0].median7d = 0;
  data.cards[1].median7d = 0;
  const result = comparePools(data);
  assert.equal(result.complete, true);
  assert.equal(result.pools[0].mean, 0);
  assert.equal(result.winner.id, 'husbando');
  assert.equal(result.percent, null);
});

test('equal means do not produce an arbitrary winner', () => {
  const data = sample();
  data.cards[2].median7d = 200;
  const result = comparePools(data);
  assert.equal(result.complete, true);
  assert.equal(result.winner, null);
  assert.equal(result.difference, 0);
});

test('a card shared by both boosters contributes once to each pool', () => {
  const data = sample();
  data.pools[1].cardIds.push(1);
  assert.equal(computePoolStats(data, 'husbando').mean, 125);
  assert.equal(computePoolStats(data, 'waifu').mean, 200);
});

test('a pool referencing an absent or non-Mythical card reports missing coverage', () => {
  const data = sample();
  data.cards[1].rarity = 'L';
  data.pools[0].cardIds.push(999);
  const result = computePoolStats(data, 'waifu');
  assert.equal(result.total, 3);
  assert.equal(result.priced, 1);
  assert.equal(result.missing, 2);
  assert.equal(comparePools(data).complete, false);
});

test('median handles empty, odd and even arrays without mutating input', () => {
  const values = [300, 100, 200];
  assert.equal(median([]), null);
  assert.equal(median(values), 200);
  assert.equal(median([300, 100]), 200);
  assert.deepEqual(values, [300, 100, 200]);
});

test('invalid dates, prices, duplicate cards and duplicate pool entries are rejected', () => {
  for (const corrupt of [
    data => { data.collectedAt = 'not a date'; },
    data => { data.cards[0].median7d = '100'; },
    data => { data.cards[0].median7d = -1; },
    data => { data.cards.push({ ...data.cards[0] }); },
    data => { data.pools[0].cardIds.push(1); },
  ]) {
    const data = sample();
    corrupt(data);
    assert.throws(() => validateSnapshot(data));
  }
});

test('CSV keeps quotes, commas, null and formula-like names safe', () => {
  assert.equal(csvCell('A, "B"'), '"A, ""B"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(0), '"0"');
  assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell('  @name'), '"\'  @name"');
});

test('bundled snapshot reproduces the verified full-pool comparison', async () => {
  const data = validateSnapshot(JSON.parse(await readFile(new URL('../public/seed.json', import.meta.url), 'utf8')));
  const result = comparePools(data, 7);
  assert.equal(data.cards.length, 200);
  assert.deepEqual(result.pools.map(pool => pool.total), [77, 123]);
  assert.equal(result.complete, true);
  assert.equal(result.winner.id, 'waifu');
  assert.ok(Math.abs(result.pools[0].mean - 1887.5064935064936) < 1e-8);
  assert.ok(Math.abs(result.pools[1].mean - 1802.308943089431) < 1e-8);
});
