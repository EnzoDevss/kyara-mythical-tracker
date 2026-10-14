const RANGES = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
const BUCKETS = 8;
const price = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

function reply(body, status = 200, head = false) {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
    },
  });
}

export function selectHistory(history, id, range, now = Date.now()) {
  const end = Math.floor(now / 1000);
  const start = end - RANGES[range];
  const result = { schemaVersion: 1, cardId: id, range, currency: 'chakra',
    windowStart: new Date(start * 1000).toISOString(), windowEnd: new Date(end * 1000).toISOString(),
    updatedAt: null, firstSeenAt: null, card: null, points: [] };
  if (history === null) return result;
  if (history?.schemaVersion !== 1 || history.bucket !== id % BUCKETS || history.bucketCount !== BUCKETS
      || !Array.isArray(history.timestamps) || !history.timestamps.length || !history.cards
      || typeof history.cards !== 'object' || Array.isArray(history.cards)
      || typeof history.updatedAt !== 'string' || !Number.isFinite(Date.parse(history.updatedAt))) {
    throw new Error('Invalid stored history.');
  }
  let prior = 0;
  for (const t of history.timestamps) {
    if (!Number.isSafeInteger(t) || t <= prior) throw new Error('Invalid history timestamp.');
    prior = t;
  }
  if (prior !== Date.parse(history.updatedAt) / 1000) throw new Error('Misaligned history timestamp.');
  result.updatedAt = history.updatedAt;
  const card = history.cards[String(id)];
  if (!card) return result;
  if (typeof card.name !== 'string' || !card.name || typeof card.series !== 'string'
      || !Number.isSafeInteger(card.firstSeenAt) || !Number.isSafeInteger(card.lastSeenAt)
      || card.firstSeenAt <= 0 || card.lastSeenAt < card.firstSeenAt || card.lastSeenAt > prior
      || !['median7d', 'median30d'].every(field => Array.isArray(card[field])
        && card[field].length === history.timestamps.length && card[field].every(price))) {
    throw new Error('Invalid stored card history.');
  }
  result.card = { id, name: card.name, series: card.series };
  result.firstSeenAt = new Date(card.firstSeenAt * 1000).toISOString();
  history.timestamps.forEach((t, index) => {
    if (t >= start && t <= end && t >= card.firstSeenAt && t <= card.lastSeenAt) {
      result.points.push({ at: new Date(t * 1000).toISOString(), median7d: card.median7d[index], median30d: card.median30d[index] });
    }
  });
  return result;
}

export async function historyResponse(request, env, now = Date.now()) {
  const head = request.method === 'HEAD';
  if (!['GET', 'HEAD'].includes(request.method)) return reply({ error: 'Read-only endpoint.' }, 405);
  const params = new URL(request.url).searchParams;
  const rawId = params.get('card') || '';
  const id = Number(rawId), range = params.get('range') || '24h';
  if (!/^[1-9][0-9]*$/.test(rawId) || !Number.isSafeInteger(id) || !Object.hasOwn(RANGES, range)) {
    return reply({ error: 'Choose a valid card and range: 24h, 7d or 30d.' }, 400, head);
  }
  try {
    if (!env.PRICES) throw new Error('Missing binding.');
    const raw = await env.PRICES.get(`history-v1-${id % BUCKETS}`, { type: 'text', cacheTtl: 60 });
    const data = selectHistory(raw === null ? null : JSON.parse(raw), id, range, now);
    return reply(data, 200, head);
  } catch {
    return reply({ error: 'Price history is temporarily unavailable. Please try again.' }, 503, head);
  }
}
