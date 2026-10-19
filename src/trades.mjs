const SOURCE = 'https://kyara.games/api/';
const TTL = 15000;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const problem = (message, retryAfter = 0) => Object.assign(new Error(message), { retryAfter });
export function retryDelay(headers, now = Date.now()) {
  const value = headers.get('retry-after');
  const seconds = Number(value);
  if (value && Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  if (value && Number.isFinite(Date.parse(value))) return Math.max(1000, Date.parse(value) - now);
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 && reset <= 3600 ? reset * 1000 : 10000;
}
export function cleanOffers(raw, cardId, knownIds, now = Date.now()) {
  if (!Array.isArray(raw) || raw.length > 1000) throw problem('Unexpected trade response.');
  const seen = new Set();
  return raw.filter(o => o && o.characterId === cardId && o.status === 'open' && Date.parse(o.expiresAt) > now
    && typeof o.id === 'string' && /^[\w-]{1,80}$/.test(o.id) && !seen.has(o.id)
    && Array.isArray(o.wantIds) && o.wantIds.length <= 5 && o.wantIds.every(id => knownIds.has(id))
    && typeof o.user?.pseudo === 'string' && typeof o.user?.id === 'string')
    .filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; })
    .map(o => { return { id: o.id, characterId: cardId, wantIds: o.wantIds, user: { pseudo: o.user.pseudo.slice(0,80) },
      createdAt: o.createdAt, expiresAt: o.expiresAt, counterOk: o.counterOk === true }; });
}

// One named object for the entire site. No persistence writes, alarms, or background scans.
export class TradesCoordinator {
  constructor(ctx, env, dependencies = {}) {
    this.ctx = ctx; this.env = env;
    this.request = dependencies.fetch || ((...args) => fetch(...args));
    this.now = dependencies.now || Date.now;
    this.sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.cache = new Map(); this.inflight = new Map(); this.queue = [];
    this.interval = 100; this.nextStart = 0; this.blockedUntil = 0; this.active = 0; this.pumping = false; this.successes = 0;
    this.catalog = null; this.catalogAt = 0; this.catalogLoading = null;
  }
  async getCatalog() {
    if (this.catalog && this.now() - this.catalogAt < 300000) return this.catalog;
    if (this.catalogLoading) return this.catalogLoading;
    this.catalogLoading = (async () => {
      if (this.now() < this.blockedUntil) throw problem('Kyara is cooling down.', this.blockedUntil - this.now());
      const response = await this.request(SOURCE + 'characters', { signal: AbortSignal.timeout(15000) });
      if (response.status === 429) { this.blockedUntil = this.now() + retryDelay(response.headers, this.now()); throw problem('Kyara requested a pause.', this.blockedUntil - this.now()); }
      if (!response.ok) throw problem('Card catalog temporarily unavailable (HTTP ' + response.status + ').');
      const raw = await response.json();
      if (!Array.isArray(raw) || raw.length < 200 || raw.length > 20000) throw problem('Unexpected card catalog.');
      const cards = raw.filter(c => Number.isSafeInteger(c.id) && c.id > 0 && typeof c.name === 'string')
        .map(c => ({ id: c.id, name: c.name, series: typeof c.series === 'string' ? c.series : '', rarity: c.rarity, rank: Number.isSafeInteger(c.rank) ? c.rank + 1 : null }));
      const mythicals = new Set(cards.filter(c => c.rarity === 'M').map(c => c.id));
      if (!mythicals.size) throw problem('No Mythicals found in the catalog.');
      const searchable = new Set(cards.filter(c => c.rarity === 'M' || c.rarity === 'L' && c.rank >= 1 && c.rank <= 1000 || c.series.trim().toLowerCase() === 'fairy tail').map(c => c.id));
      this.catalog = { cards, mythicals, searchable, knownIds: new Set(cards.map(c => c.id)) }; this.catalogAt = this.now();
      return this.catalog;
    })().finally(() => { this.catalogLoading = null; });
    return this.catalogLoading;
  }
  search(id, catalog) {
    const saved = this.cache.get(id);
    if (saved && this.now() - saved.checkedAt < TTL) return Promise.resolve({ ...saved, cached: true });
    if (this.inflight.has(id)) return this.inflight.get(id);
    if (this.now() < this.blockedUntil) return Promise.reject(problem('Kyara requested a pause.', this.blockedUntil - this.now()));
    if (this.queue.length >= 60) return Promise.reject(problem('Other searches are running. Please wait.', 3000));
    // The scheduler grants slots; each caller performs its own bounded upstream request.
    const work = new Promise((resolve, reject) => this.queue.push({ resolve, reject }))
      .then(() => this.run({ id, catalog }).finally(() => { this.active--; }));
    const promise = work.finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise); this.pump();
    return promise;
  }
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        if (this.now() < this.blockedUntil) {
          const queued = this.queue.splice(0);
          queued.forEach(job => job.reject(problem('Kyara requested a pause.', this.blockedUntil - this.now())));
          break;
        }
        if (this.active >= 3) { await this.sleep(25); continue; }
        const delay = this.nextStart - this.now();
        if (delay > 0) { await this.sleep(delay); continue; }
        const job = this.queue.shift(); this.active++;
        this.nextStart = this.now() + this.interval;
        job.resolve();
        await Promise.resolve();
      }
    } finally { this.pumping = false; }
  }
  async run({ id, catalog }) {
    try {
      const response = await this.request(SOURCE + 'trades/offers?characterId=' + id, { signal: AbortSignal.timeout(12000), redirect: 'manual' });
      if (response.status === 429 || response.status === 403) {
        const pause = response.status === 429 ? retryDelay(response.headers, this.now()) : 60000;
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + pause);
        this.interval = Math.min(2000, Math.max(200, this.interval * 2)); this.successes = 0;
        throw problem(response.status === 403 ? 'Kyara declined access. Scanning paused.' : 'Kyara requested a pause.', pause);
      }
      if (!response.ok) throw problem('Kyara returned an error. Try again later.');
      const raw = await response.json();
      const value = { cardId: id, checkedAt: this.now(), offers: cleanOffers(raw, id, catalog.knownIds, this.now()), capped: Array.isArray(raw) && raw.length >= 200, cached: false };
      this.cache.set(id, value);
      if (this.cache.size > 512) for (const [key, saved] of this.cache) if (this.now() - saved.checkedAt >= TTL) this.cache.delete(key);
      if (++this.successes >= 30) { this.interval = Math.max(100, this.interval * 0.9); this.successes = 0; }
      const remaining = Number(response.headers.get('x-ratelimit-remaining'));
      if (response.headers.has('x-ratelimit-remaining') && remaining < 50) this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryDelay(response.headers, this.now()));
      return value;
    } catch (error) {
      console.error('Trade search:', error.message);
      if (!error.retryAfter) { this.interval = Math.min(2000, Math.max(200, this.interval * 1.25)); this.successes = 0; }
      throw error;
    }
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if ((path !== '/api/trades/catalog' || request.method !== 'GET') && (path !== '/api/trades/batch' || request.method !== 'POST')) return json({ error: 'Unsupported trade request.' }, 405);
    try {
      let ids;
      if (path.endsWith('/batch')) {
        if (Number(request.headers.get('content-length')) > 1024) return json({ error: 'Request too large.' }, 413);
        const body = await request.text(); if (body.length > 1024) return json({ error: 'Request too large.' }, 413);
        try { ids = JSON.parse(body).ids; } catch { return json({ error: 'Invalid request.' }, 400); }
        if (!Array.isArray(ids) || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return json({ error: 'Choose up to ten distinct tracked cards.' }, 400);
      }
      const catalog = await this.getCatalog();
      if (path.endsWith('/catalog')) return json({ cards: catalog.cards, cachedAt: this.catalogAt });
      if (ids.some(id => !(catalog.searchable || catalog.mythicals).has(id))) return json({ error: 'Choose a Mythical, a top-1,000 Legendary, or a Fairy Tail card.' }, 400);
      if (this.now() < this.blockedUntil) return json({ error: 'Kyara requested a pause.', retryAfter: this.blockedUntil - this.now() }, 429, { 'Retry-After': String(Math.ceil((this.blockedUntil - this.now()) / 1000)) });
      let cancelled = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start: controller => {
          const send = value => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); };
          const work = Promise.all(ids.map(id => this.search(id, catalog).then(value => send({ type: 'card', ...value }), error => send({ type: 'error', cardId: id, message: error.retryAfter ? error.message : 'Search failed. Try again later.', retryAfter: error.retryAfter || 0 }))))
            .then(() => { send({ type: 'done', searchesPerSecond: Math.round(1000 / this.interval) }); if (!cancelled) controller.close(); });
          this.ctx.waitUntil(work);
        },
        cancel: () => { cancelled = true; }
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      console.error('Trade coordinator:', error.message);
      return json({ error: error.retryAfter ? error.message : 'Trades are temporarily unavailable.', retryAfter: error.retryAfter || 0 }, error.retryAfter ? 429 : 503);
    }
  }
}

export async function tradesResponse(request, env) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Open the tracker to search trades.' }, 403);
  if (!env.TRADES) return json({ error: 'Trade scanning is not configured.' }, 503);
  return env.TRADES.get(env.TRADES.idFromName('shared-trade-search-v1')).fetch(request);
}
