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

// Gentle monotone curves pass through samples without inventing price peaks.
function smoothPath(points) {
  if (!points.length) return '';
  const slopes = points.slice(1).map((point, i) => (point.y - points[i].y) / (point.x - points[i].x));
  const tangents = points.map((_, i) => {
    if (i === 0) return (slopes[0] ?? 0) * 0.7;
    if (i === points.length - 1) return slopes[i - 1] * 0.7;
    const a = slopes[i - 1], b = slopes[i];
    return a * b > 0 ? 0.7 * 2 * a * b / (a + b) : 0;
  });
  let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = (b.x - a.x) / 3;
    path += ` C${(a.x + dx).toFixed(2)},${(a.y + tangents[i - 1] * dx).toFixed(2)} ${(b.x - dx).toFixed(2)},${(b.y - tangents[i] * dx).toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
  }
  return path;
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
  let segment = [], previousTime = null;
  const flush = () => { if (segment.length) paths.push(smoothPath(segment)); segment = []; };
  data.points.forEach((point, index) => {
    const time = Date.parse(point.at), value = point[metric];
    if (!isPrice(value)) { flush(); previousTime = null; return; }
    if (previousTime !== null && time - previousTime > 90 * 60000) flush();
    const x = left + (time - start) / span * (right - left);
    const y = bottom - (value - floor) / (ceiling - floor) * (bottom - top);
    segment.push({ x, y });
    dots.push({ x, y, index, value, at: point.at });
    previousTime = time;
  });
  flush();
  const ticks = Array.from({ length: 5 }, (_, index) => ({ y: bottom - index / 4 * (bottom - top), value: floor + index / 4 * (ceiling - floor) }));
  return { paths, dots, ticks, left, right, top, bottom };
}
