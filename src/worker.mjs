import { historyResponse, changesResponse } from './history.mjs';
// This Worker only serves stored public data. It cannot collect, buy, or open cards.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function error(message, status, extra = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

export function validSnapshotShape(data) {
  return data?.schemaVersion === 1 && data.currency === 'chakra'
    && ['kyara-public-api', 'bundled-snapshot'].includes(data.source)
    && typeof data.collectedAt === 'string' && Number.isFinite(Date.parse(data.collectedAt))
    && Array.isArray(data.cards) && data.cards.length > 0
    && Array.isArray(data.pools) && data.pools.length === 2
    && ['waifu', 'husbando'].every(id => data.pools.some(pool => pool.id === id && Array.isArray(pool.cardIds) && pool.cardIds.length > 0));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/history') return historyResponse(request, env);
    if (url.pathname === '/api/changes') return changesResponse(request, env);
    if (url.pathname !== '/api/prices') return error('Unknown endpoint.', 404);
    if (!['GET', 'HEAD'].includes(request.method)) return error('Read-only endpoint.', 405, { Allow: 'GET, HEAD' });

    let raw, origin = 'kv';
    try {
      raw = env.PRICES ? await env.PRICES.get('latest', { type: 'text', cacheTtl: 60 }) : null;
    } catch {
      // A storage outage must not silently replace a working live snapshot with the seed.
      return error('Stored prices are temporarily unavailable. Keep the last successful snapshot.', 503);
    }
    if (raw === null) {
      origin = 'bundled';
      try {
        const seed = await env.ASSETS.fetch(new Request(new URL('/seed.json', request.url)));
        if (!seed.ok) return error('No price snapshot has been uploaded yet.', 503);
        raw = await seed.text();
      } catch {
        return error('No price snapshot has been uploaded yet.', 503);
      }
    }
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
      if (!validSnapshotShape(snapshot)) throw new Error('Invalid snapshot');
    } catch {
      return error('The stored snapshot is invalid. Run the updater again.', 503);
    }
    return new Response(request.method === 'HEAD' ? null : raw, {
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': origin === 'kv' ? 'public, max-age=60' : 'no-cache',
        'X-Snapshot-Origin': origin,
        'X-Snapshot-Collected-At': snapshot.collectedAt,
      },
    });
  },
};
