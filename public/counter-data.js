export const COUNTER_HOUR = 60 * 60 * 1000;
export function counterType(message) {
  const a = message.attachment;
  return !a ? 'text' : a.kind === 'card' ? a.tag : a.kind;
}
export function counterMatchesOwned(message, owned) {
  const a = message.attachment;
  return a?.kind === 'card' && a.tag === 'seek' ? owned.has(a.character.id)
    : a?.kind === 'offer' && a.status === 'open' && a.wantIds.some(id => owned.has(id));
}
export function counterRows(messages, { cutoff, query = '', type = 'posts', room = '', rarity = '', owned = null, cards = new Map(), prices = new Map(), sort = 'newest', now = Date.now() }) {
  query = query.trim().toLocaleLowerCase();
  const rows = [...messages].filter(m => {
    const a = m.attachment, kind = counterType(m);
    if (Date.parse(m.createdAt) < cutoff || room && m.room !== Number(room)) return false;
    if (a?.kind === 'offer' && (a.status !== 'open' || Date.parse(a.expiresAt) <= now)) return false;
    if (a?.kind === 'listing' && (a.status !== 'active' || Date.parse(a.endsAt) <= now)) return false;
    if (type === 'posts' ? !a : type !== 'all' && kind !== type) return false;
    if (rarity && a?.character.rarity !== rarity || owned && !counterMatchesOwned(m, owned)) return false;
    const wanted = (a?.wantIds || []).map(id => cards.get(id)).filter(Boolean);
    return !query || [m.text, m.author.pseudo, a?.character.name, a?.character.series, ...wanted.flatMap(c => [c.name,c.series])].join(' ').toLocaleLowerCase().includes(query);
  });
  const value = m => { const p = prices.get(m.attachment?.character.id); return !p?.stale && typeof p?.median7d === 'number' ? p.median7d : null; };
  return rows.sort((a, b) => {
    if (sort.startsWith('median-')) {
      const x = value(a), y = value(b);
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      if (x !== null && y !== null && x !== y) return sort === 'median-asc' ? x - y : y - x;
    }
    return (sort === 'oldest' ? 1 : -1) * (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  });
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});
export async function loadCounter({ signal, onRooms, onPage, onRoom, onPause = () => {}, fetcher = fetch, maxPages = 400, maxMessages = 50000 }) {
  async function read(path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const response = await fetcher('/api/trades/counter/' + path, { signal, cache: 'no-store' });
      const data = await response.json();
      if (response.status === 401) throw Object.assign(new Error('Unlock Trades again to continue.'), { unauthorized: true });
      if (response.ok) return data;
      if (response.status !== 429 || attempt === 2) throw Object.assign(new Error(data.error || 'Counter refresh failed.'), { throttled: response.status === 429 });
      const delay = Math.max(1000, data.retryAfter || 10000);
      if (delay > 90000) throw Object.assign(new Error('Kyara is cooling down. Refresh later.'), { throttled: true });
      onPause(delay); await pause(delay + 250, signal);
    }
  }
  const data = await read('rooms');
  if (!Array.isArray(data.rooms) || !data.rooms.every(r => Number.isSafeInteger(r) && r > 0) || !Number.isFinite(data.checkedAt)) throw new Error('Invalid counter room list.');
  const rooms = [...new Set(data.rooms)], cutoff = data.checkedAt - COUNTER_HOUR;
  onRooms(rooms, cutoff);
  // Round-robin pages: every room gets a recent page before busy rooms load more history.
  const queue = rooms.map(room => ({ room, before: null, pages: 0, cursors: new Set() }));
  let count = 0, fatal = null;
  async function worker() {
    while (queue.length && !fatal) {
      signal.throwIfAborted();
      const job = queue.shift();
      try {
        const query = new URLSearchParams({ room: String(job.room), ...(job.before ? { before: job.before } : {}) });
        const page = await read('page?' + query);
        signal.throwIfAborted();
        if (page.room !== job.room || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw new Error('Invalid counter page.');
        job.pages++; count += page.items.length;
        onPage(page);
        if (page.oldestAt && Date.parse(page.oldestAt) <= cutoff) onRoom(job.room, 'hour');
        else if (!page.hasMore) onRoom(job.room, 'end');
        else if (!page.nextBefore || job.cursors.has(page.nextBefore) || job.pages >= maxPages || count >= maxMessages) onRoom(job.room, 'partial');
        else { job.cursors.add(page.nextBefore); job.before = page.nextBefore; queue.push(job); }
        if (count >= maxMessages) {
          for (const pending of queue.splice(0)) onRoom(pending.room, 'partial');
        }
      } catch (error) {
        if (signal.aborted || error.unauthorized || error.throttled) { fatal = error; return; }
        onRoom(job.room, 'failed', error.message);
      }
    }
  }
  await Promise.all([worker(), worker()]);
  if (fatal) throw fatal;
  signal.throwIfAborted();
}
