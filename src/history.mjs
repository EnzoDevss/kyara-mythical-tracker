import { summarizeHistory } from '../public/history-data.js';
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
  if (![1, 2].includes(history?.schemaVersion) || history.bucket !== id % BUCKETS || history.bucketCount !== BUCKETS
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
  let card = history.cards[String(id)];
  if (!card) return result;
  if (history.schemaVersion === 2) {
    if (typeof card !== 'string') throw new Error('Invalid compact card.');
    card = JSON.parse(card);
    for (const field of ['median7d', 'median30d']) {
      const runs = card[field], values = [];
      if (!Array.isArray(runs) || !runs.length) throw new Error('Invalid price runs.');
      for (let i = 0; i < runs.length; i++) {
        const pair = runs[i], end = i + 1 < runs.length ? runs[i + 1]?.[0] : history.timestamps.length;
        if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || pair[0] !== values.length
            || !Number.isSafeInteger(end) || end <= pair[0] || end > history.timestamps.length || !price(pair[1])) throw new Error('Invalid price run.');
        for (let j = pair[0]; j < end; j++) values.push(pair[1]);
      }
      card[field] = values;
    }
  }
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

export async function changesResponse(request, env, now = Date.now()) {
  const head = request.method === 'HEAD';
  if (!['GET', 'HEAD'].includes(request.method)) return reply({ error: 'Read-only endpoint.' }, 405);
  const rawBucket = new URL(request.url).searchParams.get('bucket');
  if (!/^[0-7]$/.test(rawBucket ?? '')) return reply({ error: 'Invalid history bucket.' }, 400, head);
  const bucket = Number(rawBucket);
  try {
    if (!env.PRICES) throw new Error('Missing binding');
    const raw = await env.PRICES.get(`history-v1-${bucket}`, { type: 'text', cacheTtl: 60 });
    const history = raw === null ? null : JSON.parse(raw);
    // Validate even an empty bucket, then reuse the chart's exact window and percentage rules.
    selectHistory(history, bucket || 8, '24h', now);
    const cards = {};
    for (const key of Object.keys(history?.cards || {})) {
      const id = Number(key);
      if (!Number.isSafeInteger(id) || id <= 0 || id % BUCKETS !== bucket) throw new Error('Invalid card');
      const data = selectHistory(history, id, '24h', now);
      cards[key] = { median7d: summarizeHistory(data.points, 'median7d').percent,
        median30d: summarizeHistory(data.points, 'median30d').percent };
    }
    return reply({ schemaVersion: 1, bucket, range: '24h', calculatedAt: new Date(now).toISOString(), cards }, 200, head);
  } catch {
    return reply({ error: 'Price changes are temporarily unavailable.' }, 503, head);
  }
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
    const asOf = params.get('asOf'), stamp = asOf ? Date.parse(asOf) : now;
    if (!Number.isFinite(stamp) || stamp > now + 60000 || stamp < now - 31 * 86400000) return reply({ error: 'Invalid history cutoff.' }, 400, head);
    const data = selectHistory(raw === null ? null : JSON.parse(raw), id, range, stamp);
    return reply(data, 200, head);
  } catch {
    return reply({ error: 'Price history is temporarily unavailable. Please try again.' }, 503, head);
  }
}
