import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnedCards, ownedCardChoices, searchOwnedCards, matchesOwnedCards } from '../public/owned-cards.js';
import { matchesRequestedCard } from '../public/trades-data.js';

test('saved ownership survives JSON round-trips and rejects malformed or non-ID values', () => {
  assert.deepEqual([...parseOwnedCards(JSON.stringify([31, 7, 31, '4', null, -1, 0, 2.5]))], [31, 7]);
  assert.deepEqual([...parseOwnedCards(JSON.stringify([...new Set([31, 7])]))], [31, 7]);
  for (const raw of [null, 'broken', '{}', 'true', JSON.stringify(Array(10001).fill(1))]) assert.equal(parseOwnedCards(raw).size, 0);
});

test('the checklist uses wiki order and excludes pool-only cards and cards outside the current top 1,000', () => {
  const cards = [{ id: 7, rank: 1000 }, { id: 31, rank: 1 }, { id: 8, rank: 1001 }, { id: 4, rank: 2, inTop: false }, { id: 10, rank: 0 }, { id: 5 }];
  assert.deepEqual(ownedCardChoices(cards).map(c => c.id), [31, 7]);
  assert.equal(cards[0].id, 7);
});

test('checklist searches names, series and wiki ranks while preserving wiki order', () => {
  const cards = [{ id: 1, rank: 1, name: 'Satoru Gojou', series: 'JUJUTSU KAISEN' }, { id: 2, rank: 2, name: 'Lévi', series: 'Attack on Titan' }];
  assert.deepEqual(searchOwnedCards(cards, '  gojou ').map(c => c.id), [1]);
  assert.deepEqual(searchOwnedCards(cards, 'levi').map(c => c.id), [2]);
  assert.deepEqual(searchOwnedCards(cards, 'attack').map(c => c.id), [2]);
  assert.deepEqual(searchOwnedCards(cards, '#0001').map(c => c.id), [1]);
  assert.equal(searchOwnedCards(cards, 'missing').length, 0);
  assert.deepEqual(searchOwnedCards(cards, '').map(c => c.id), [1, 2]);
});

test('acceptance filter matches any requested owned card, never the offered card; rarity filter remains independent', () => {
  const offer = { characterId: 1, wantIds: [2, 3] };
  assert.equal(matchesOwnedCards(offer, new Set([1])), false);
  assert.equal(matchesOwnedCards(offer, new Set()), false);
  assert.equal(matchesOwnedCards(offer, new Set([3])), true);
  assert.equal(matchesOwnedCards({ ...offer, wantIds: [] }, new Set([1, 3])), false);
  const requested = [{ id: 2, rarity: 'L' }, { id: 3, rarity: 'E' }];
  assert.equal(requested.some(c => matchesRequestedCard(c, 'M', new Set([2, 3]))) && matchesOwnedCards(offer, new Set([3])), true);
});
