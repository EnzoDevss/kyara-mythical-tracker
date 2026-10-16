export const priceKnown = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function tradeMetrics(offer, prices) {
  const value = id => { const card = prices.get(id); return !card?.stale && priceKnown(card?.median7d) ? card.median7d : null; };
  const median = value(offer.characterId), requested = offer.wantIds.map(value);
  const lowest = requested.length && requested.every(v => v !== null) ? Math.min(...requested) : null;
  const gain = median !== null && lowest !== null ? median - lowest : null;
  return { median, lowest, gain, percent: gain !== null && lowest > 0 ? gain / lowest * 100 : null };
}
export function compareTradeRows(a, b, mode) {
  const key = mode === 'gain-desc' ? 'gain' : mode === 'percent-desc' ? 'percent' : 'median';
  const x = a.metrics[key], y = b.metrics[key];
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return mode === 'median-asc' ? x - y : y - x;
}
export function searchOrder(cards, prices) {
  return cards.filter(c => c.rarity === 'M').sort((a, b) => {
    const pa = prices.get(a.id), pb = prices.get(b.id);
    const va = !pa?.stale && priceKnown(pa?.median7d) ? pa.median7d : -1;
    const vb = !pb?.stale && priceKnown(pb?.median7d) ? pb.median7d : -1;
    return vb - va || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id - b.id;
  });
}
export async function readEvents(response, onEvent) {
  if (!response.body) throw new Error('Streaming response unavailable.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim()) onEvent(JSON.parse(line));
      }
      if (buffer.length > 2000000) throw new Error('Trade response too large.');
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  } finally { reader.releaseLock(); }
}
