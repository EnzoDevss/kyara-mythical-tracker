export const priceKnown = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
