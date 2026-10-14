export const RANGE_SECONDS = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
export const isPrice = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function validateHistory(data, cardId, range) {
  if (data?.schemaVersion !== 1 || data.currency !== 'chakra' || data.cardId !== Number(cardId)
      || data.range !== range || !Array.isArray(data.points)
      || !Number.isFinite(Date.parse(data.windowStart)) || !Number.isFinite(Date.parse(data.windowEnd))
      || Date.parse(data.windowEnd) - Date.parse(data.windowStart) !== RANGE_SECONDS[range] * 1000
      || (data.updatedAt !== null && !Number.isFinite(Date.parse(data.updatedAt)))) throw new Error('Invalid history response.');
  let prior = 0;
  for (const point of data.points) {
    const time = Date.parse(point.at);
    if (!Number.isFinite(time) || time <= prior || time < Date.parse(data.windowStart) || time > Date.parse(data.windowEnd)
        || !['median7d', 'median30d'].every(field => point[field] === null || isPrice(point[field]))) throw new Error('Invalid observation.');
    prior = time;
  }
  return data;
}

export function summarizeHistory(points, metric) {
  const known = points.filter(point => isPrice(point[metric]));
  const values = known.map(point => point[metric]);
  const latest = points.length && isPrice(points.at(-1)[metric]) ? points.at(-1)[metric] : null;
  // Missing end values must not turn an old price into a claimed current price.
  const first = points.length && isPrice(points[0][metric]) ? points[0][metric] : null;
  const change = points.length >= 2 && first !== null && latest !== null ? latest - first : null;
  return { latest, change, percent: change !== null && first > 0 ? change / first * 100 : null,
    low: values.length ? Math.min(...values) : null, high: values.length ? Math.max(...values) : null,
    known: known.length, total: points.length };
}

export function chartModel(data, metric, width = 900) {
  const left = 64, right = Math.max(left + 40, width - 22), top = 24, bottom = 274;
  const values = data.points.map(point => point[metric]).filter(isPrice);
  if (!values.length) return { paths: [], dots: [], ticks: [], left, right, top, bottom };
  const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, max * 0.015, 1);
  const floor = Math.max(0, min - padding), ceiling = max + padding;
  const start = Date.parse(data.windowStart), span = Date.parse(data.windowEnd) - start;
  const dots = [], paths = [];
  let path = '', previousTime = null;
  data.points.forEach((point, index) => {
    const time = Date.parse(point.at), value = point[metric];
    if (!isPrice(value)) { if (path) paths.push(path); path = ''; previousTime = null; return; }
    if (previousTime !== null && time - previousTime > 90 * 60000) { if (path) paths.push(path); path = ''; }
    const x = left + (time - start) / span * (right - left);
    const y = bottom - (value - floor) / (ceiling - floor) * (bottom - top);
    path += `${path ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    dots.push({ x, y, index, value, at: point.at });
    previousTime = time;
  });
  if (path) paths.push(path);
  const ticks = Array.from({ length: 5 }, (_, index) => ({ y: bottom - index / 4 * (bottom - top), value: floor + index / 4 * (ceiling - floor) }));
  return { paths, dots, ticks, left, right, top, bottom };
}
