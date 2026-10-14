import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const fixture = { schemaVersion: 1, currency: 'chakra', source: 'kyara-public-api', collectedAt: '2026-10-14T15:30:00Z', pools: [{ id: 'waifu', cardIds: [1] }, { id: 'husbando', cardIds: [2] }], cards: [{ id: 1 }, { id: 2 }] };
const request = (path = '/api/prices', method = 'GET') => new Request(`https://example.workers.dev${path}`, { method });

test('serves the stored snapshot and identifies its origin', async () => {
  const response = await worker.fetch(request(), { PRICES: { get: async (key, options) => { assert.equal(key, 'latest'); assert.equal(options.cacheTtl, 60); return JSON.stringify(fixture); } } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), fixture);
  assert.equal(response.headers.get('x-snapshot-origin'), 'kv');
});
test('missing KV key serves the clearly identified bundled snapshot', async () => {
  const response = await worker.fetch(request(), { PRICES: { get: async () => null }, ASSETS: { fetch: async r => { assert.equal(new URL(r.url).pathname, '/seed.json'); return Response.json({ ...fixture, source: 'bundled-snapshot' }); } } });
  assert.equal(response.headers.get('x-snapshot-origin'), 'bundled');
  assert.equal((await response.json()).source, 'bundled-snapshot');
});
test('KV outage is not masked by an old bundled snapshot', async () => {
  const response = await worker.fetch(request(), { PRICES: { get: async () => { throw new Error('outage'); } }, ASSETS: { fetch: () => assert.fail('must not fall back on a storage error') } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('invalid JSON and wrong snapshot shape are rejected', async () => {
  for (const raw of ['invalid', '{}', JSON.stringify({ ...fixture, collectedAt: 'broken' })]) {
    const response = await worker.fetch(request(), { PRICES: { get: async () => raw } });
    assert.equal(response.status, 503);
  }
});
test('the public endpoint cannot trigger a write or collection', async () => {
  const response = await worker.fetch(request('/api/prices', 'POST'), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});
test('unknown API routes return JSON 404, not index.html', async () => {
  const response = await worker.fetch(request('/api/update'), {});
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
});
test('HEAD has headers without a response body', async () => {
  const response = await worker.fetch(request('/api/prices', 'HEAD'), { PRICES: { get: async () => JSON.stringify(fixture) } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});
test('normal pages are delegated to the static asset binding', async () => {
  const response = await worker.fetch(request('/'), { ASSETS: { fetch: async () => new Response('dashboard') } });
  assert.equal(await response.text(), 'dashboard');
});
