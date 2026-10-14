const POOL_IDS = ['waifu', 'husbando'];
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 90 * 60 * 1000;
const isPrice = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isId = value => (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value));

/** Validate enough of the public contract to reject an error page or unusable snapshot. */
export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.pools)) {
    throw new Error('The price snapshot has an unsupported format.');
  }
  if (!Number.isFinite(Date.parse(snapshot.collectedAt))) throw new Error('The price snapshot has no valid collection date.');
  const seenCards = new Set();
  for (const card of snapshot.cards) {
    if (!card || !isId(card.id) || typeof card.name !== 'string' || !card.name.trim() || seenCards.has(String(card.id))) {
      throw new Error('The price snapshot contains an invalid or duplicate card.');
    }
    seenCards.add(String(card.id));
    for (const key of ['median7d', 'median30d']) {
      if (card[key] != null && !isPrice(card[key])) throw new Error('The price snapshot contains an invalid price.');
    }
  }
  for (const id of POOL_IDS) {
    const pools = snapshot.pools.filter(pool => pool.id === id);
    if (pools.length !== 1 || !Array.isArray(pools[0].cardIds) || !pools[0].cardIds.length || !pools[0].cardIds.every(isId)) {
      throw new Error('The price snapshot does not contain both booster pools.');
    }
    const normalizedIds = pools[0].cardIds.map(String);
    if (new Set(normalizedIds).size !== normalizedIds.length) throw new Error('The price snapshot contains duplicate pool entries.');
  }
  return snapshot;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

/** Unknown prices are excluded from the denominator, while coverage retains every pool entry. */
export function computePoolStats(snapshot, poolId, period = 7) {
  const pool = snapshot.pools.find(item => item.id === poolId);
  if (!pool) throw new Error('Unknown booster pool.');
  const key = Number(period) === 30 ? 'median30d' : 'median7d';
  const byId = new Map(snapshot.cards.map(card => [String(card.id), card]));
  const eligible = [...new Set(pool.cardIds.map(String))].map(id => byId.get(id));
  const pricedCards = eligible.filter(card => card?.rarity === 'M' && isPrice(card[key]));
  const values = pricedCards.map(card => card[key]);
  const sum = values.reduce((total, value) => total + value, 0);
  const highest = pricedCards.reduce((best, card) => !best || card[key] > best[key] ? card : best, null);
  return {
    id: poolId,
    name: poolId === 'waifu' ? 'Waifus' : 'Husbandos',
    total: eligible.length,
    priced: pricedCards.length,
    missing: eligible.length - pricedCards.length,
    mean: values.length ? sum / values.length : null,
    median: median(values),
    sum,
    highest,
    highestValue: highest ? highest[key] : null,
  };
}

/** An equal-weight recommendation requires complete coverage in both pools. */
export function comparePools(snapshot, period = 7) {
  const pools = POOL_IDS.map(id => computePoolStats(snapshot, id, period));
  const complete = pools.every(pool => pool.total > 0 && pool.priced === pool.total && pool.mean !== null);
  if (!complete) return { pools, complete: false, winner: null, difference: null, percent: null };
  const difference = Math.abs(pools[0].mean - pools[1].mean);
  if (difference < 1e-8) return { pools, complete: true, winner: null, difference: 0, percent: 0 };
  const winner = pools[0].mean > pools[1].mean ? pools[0] : pools[1];
  const lower = Math.min(pools[0].mean, pools[1].mean);
  return { pools, complete: true, winner, difference, percent: lower > 0 ? difference / lower * 100 : null };
}

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Quoting alone does not stop a spreadsheet from interpreting a formula.
  if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

if (typeof document !== 'undefined') startDashboard();

function startDashboard() {
  const $ = id => document.getElementById(id);
  const state = { snapshot: null, period: 7, origin: '', refreshing: false, lastCheckedAt: null, error: '' };
  const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const means = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const times = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const formatPrice = value => isPrice(value) ? numbers.format(value) : '—';
  const node = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  };

  function showNotice(message) {
    $('alert').textContent = message;
    $('alert').hidden = !message;
  }

  function renderFreshness() {
    if (!state.snapshot) return;
    const collected = new Date(state.snapshot.collectedAt);
    const age = Date.now() - collected.getTime();
    const bundled = state.origin === 'bundled' || state.snapshot.source === 'bundled-snapshot';
    const stale = age > STALE_AFTER_MS;
    $('status-pill').className = `status-pill ${bundled ? 'bundled' : stale ? 'stale' : 'fresh'}`;
    $('status-pill').textContent = bundled ? 'Bundled starter snapshot' : stale ? 'Snapshot is getting old' : 'Recent snapshot';
    $('updated-at').textContent = `Collected ${dates.format(collected)}`;
    $('updated-at').title = collected.toISOString();
    let note = bundled
      ? 'Starter data only. Your first successful collector run will replace it automatically.'
      : stale
        ? 'This snapshot is more than 90 minutes old. Prices shown are from the last successful collection.'
        : 'Showing the last successful collection. Checks this saved snapshot every five minutes while this tab is visible.';
    if (state.lastCheckedAt) note += ` Last checked ${times.format(state.lastCheckedAt)}.`;
    $('update-note').textContent = note;
  }

  function renderComparison() {
    if (!state.snapshot) return;
    const comparison = comparePools(state.snapshot, state.period);
    const maximumMean = Math.max(...comparison.pools.map(pool => pool.mean || 0));
    const fragment = document.createDocumentFragment();
    for (const pool of comparison.pools) {
      const isWinner = comparison.winner?.id === pool.id;
      const card = node('article', `pool-card${isWinner ? ' winner' : ''}`);
      const top = node('div', 'pool-top');
      top.append(node('h3', 'eyebrow', pool.name));
      top.append(node('span', 'pool-tag', isWinner ? 'HIGHER AVERAGE' : `${pool.total} MYTHICALS`));
      const value = node('p', 'big-number', pool.mean === null ? '— ' : `${means.format(pool.mean)} `);
      value.append(node('span', '', '◆'));
      const coverage = node('p', 'coverage', `${pool.priced} of ${pool.total} card medians · ${pool.missing ? `${pool.missing} unavailable; excluded` : 'complete price coverage'}`);
      const progress = node('progress', '');
      progress.max = maximumMean || 1;
      progress.value = pool.mean || 0;
      progress.setAttribute('aria-label', `${pool.name} mean relative to the higher mean`);
      const details = node('div', 'pool-details');
      const middle = node('div', '');
      middle.append(node('p', 'stat-label', 'Middle card’s price'), node('p', 'stat-value', `${formatPrice(pool.median)} ◆`));
      const high = node('div', '');
      high.append(node('p', 'stat-label', 'Highest card median'), node('p', 'stat-value', `${formatPrice(pool.highestValue)} ◆`));
      if (pool.highest) high.append(node('span', 'stat-card-name', pool.highest.name));
      details.append(middle, high);
      card.append(top, value, coverage, progress, details);
      fragment.append(card);
    }
    $('pool-cards').replaceChildren(fragment);
    $('pool-cards').setAttribute('aria-busy', 'false');
    $('verdict').classList.toggle('incomplete', !comparison.complete);
    if (!comparison.complete) {
      $('verdict-title').textContent = 'Some prices are missing. No booster recommendation yet.';
      $('verdict-copy').textContent = 'The averages above use available prices only. Missing card medians can change the comparison, so wait for complete coverage before choosing on this metric.';
    } else if (!comparison.winner) {
      $('verdict-title').textContent = 'Both boosters have the same average in this snapshot.';
      $('verdict-copy').textContent = `Using ${state.period}-day card medians with equal weight, neither booster leads on Mythical value. This does not compare the value of the whole pack.`;
    } else {
      $('verdict-title').textContent = `${comparison.winner.name} leads${comparison.percent === null ? '' : ` by ${numbers.format(comparison.percent)}%`} in this snapshot.`;
      $('verdict-copy').textContent = `${means.format(comparison.difference)} ◆ more per Mythical, using ${state.period}-day card medians. This favors ${comparison.winner.name} on this metric if Mythical odds match and cards are equally likely within each pool. Exact weights are unverified.`;
    }
  }

  function getRows() {
    if (!state.snapshot) return [];
    const byId = new Map(state.snapshot.cards.map(card => [String(card.id), card]));
    const memberships = new Map();
    for (const poolId of POOL_IDS) {
      const pool = state.snapshot.pools.find(item => item.id === poolId);
      for (const id of pool.cardIds.map(String)) {
        if (!memberships.has(id)) memberships.set(id, []);
        memberships.get(id).push(poolId);
      }
    }
    const search = $('search').value.trim().toLocaleLowerCase();
    const poolFilter = $('pool').value;
    const key = state.period === 30 ? 'median30d' : 'median7d';
    const rows = [...memberships].map(([id, pools]) => ({ card: byId.get(id) || { id, name: `Card #${id}`, median7d: null, median30d: null }, pools }));
    const filtered = rows.filter(({ card, pools }) => (!poolFilter || pools.includes(poolFilter)) && (!search || `${card.name} ${typeof card.series === 'string' ? card.series : ''}`.toLocaleLowerCase().includes(search)));
    const sort = $('sort').value;
    const nameCompare = (a, b) => a.card.name.localeCompare(b.card.name);
    filtered.sort((a, b) => {
      if (sort === 'name') return nameCompare(a, b);
      const field = sort === 'sales' ? 'sales30d' : key;
      const first = a.card[field];
      const second = b.card[field];
      if (!isPrice(first) && !isPrice(second)) return nameCompare(a, b);
      if (!isPrice(first)) return 1;
      if (!isPrice(second)) return -1;
      return (sort === 'price-asc' ? first - second : second - first) || nameCompare(a, b);
    });
    return filtered;
  }

  function renderTable() {
    if (!state.snapshot) return;
    const rows = getRows();
    const fragment = document.createDocumentFragment();
    for (const { card, pools } of rows) {
      const tr = node('tr', '');
      const character = node('td', '');
      const link = node('a', '', card.name);
      // Construct the known source URL, rather than trusting arbitrary links from a snapshot.
      link.href = `https://kyara.games/wiki/${encodeURIComponent(String(card.id))}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      character.append(link);
      if (typeof card.series === 'string' && card.series) character.append(node('span', 'series', card.series));
      const history = node('a', 'history-link', 'Price history');
      history.href = `/history?card=${encodeURIComponent(String(card.id))}`;
      character.append(history);
      const booster = node('td', '');
      for (const pool of pools) booster.append(node('span', `pool-label ${pool}`, pool === 'waifu' ? 'Waifus' : 'Husbandos'));
      tr.append(character, booster);
      for (const period of [7, 30]) {
        const value = card[`median${period}d`];
        tr.append(node('td', `numeric${state.period === period ? ' selected-median' : ''}${!isPrice(value) ? ' missing' : ''}`, formatPrice(value)));
      }
      tr.append(node('td', `numeric${!isPrice(card.sales30d) ? ' missing' : ''}`, isPrice(card.sales30d) ? numbers.format(card.sales30d) : '—'));
      fragment.append(tr);
    }
    if (!rows.length) {
      const tr = node('tr', '');
      const td = node('td', 'empty-state', 'No cards match those filters. Try another character or choose both boosters.');
      td.colSpan = 5;
      tr.append(td);
      fragment.append(tr);
    }
    $('card-rows').replaceChildren(fragment);
    $('result-count').textContent = `${numbers.format(rows.length)} ${rows.length === 1 ? 'card' : 'cards'} shown · selected comparison: ${state.period}-day medians`;
    $('median-7-header').classList.toggle('selected-median', state.period === 7);
    $('median-30-header').classList.toggle('selected-median', state.period === 30);
    $('download').disabled = !rows.length;
  }

  async function fetchSnapshot(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, { cache: 'no-cache', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`The snapshot endpoint returned HTTP ${response.status}.`);
      const snapshot = validateSnapshot(await response.json());
      return { snapshot, origin: response.headers.get('X-Snapshot-Origin') || snapshot.snapshotOrigin || '' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshData() {
    if (state.refreshing) return;
    state.refreshing = true;
    $('refresh').disabled = true;
    $('refresh').textContent = 'Checking…';
    try {
      if (location.protocol === 'file:') throw new Error('Use the local preview server or your Cloudflare URL to load prices.');
      const result = await fetchSnapshot('/api/prices');
      state.snapshot = result.snapshot;
      state.origin = result.origin;
      state.error = '';
      state.lastCheckedAt = new Date();
      showNotice('');
    } catch (error) {
      state.error = error?.name === 'AbortError' ? 'The snapshot request timed out.' : 'Could not reach a valid hosted price snapshot.';
      if (!state.snapshot && location.protocol !== 'file:') {
        try {
          const fallback = await fetchSnapshot('/seed.json');
          state.snapshot = fallback.snapshot;
          state.origin = 'bundled';
          showNotice('The live snapshot is not available yet. Showing the bundled starter data until your collector publishes its first update.');
        } catch {
          showNotice('No price snapshot is available. Check the Cloudflare deployment and collector setup, then select “Check for updates”.');
        }
      } else {
        showNotice(state.snapshot ? `${state.error} Keeping the last successfully loaded prices. Check the collection timestamp before using them.` : 'Open this site through the local preview server or your Cloudflare URL. Local HTML files cannot load the hosted snapshot.');
      }
      if (!state.snapshot) {
        $('status-pill').className = 'status-pill stale';
        $('status-pill').textContent = 'Snapshot unavailable';
        $('updated-at').textContent = 'No prices loaded';
        $('result-count').textContent = 'No cards loaded';
        $('pool-cards').setAttribute('aria-busy', 'false');
      }
    } finally {
      state.refreshing = false;
      $('refresh').disabled = false;
      $('refresh').textContent = 'Check for updates ↻';
      renderFreshness();
      renderComparison();
      renderTable();
    }
  }

  $('refresh').addEventListener('click', refreshData);
  $('search').addEventListener('input', renderTable);
  $('pool').addEventListener('change', renderTable);
  $('sort').addEventListener('change', renderTable);
  for (const radio of document.querySelectorAll('input[name="period"]')) {
    radio.addEventListener('change', event => {
      state.period = Number(event.target.value);
      renderComparison();
      renderTable();
    });
  }
  $('download').addEventListener('click', () => {
    if (!state.snapshot) return;
    const header = ['Character', 'Series', 'Booster', '7-day median (chakra)', '30-day median (chakra)', '30-day sales', 'Collected at (UTC)', 'Source'];
    const lines = getRows().map(({ card, pools }) => [card.name, typeof card.series === 'string' ? card.series : '', pools.map(id => id === 'waifu' ? 'Waifus' : 'Husbandos').join(' / '), card.median7d, card.median30d, card.sales30d, state.snapshot.collectedAt, `https://kyara.games/wiki/${card.id}`]);
    const csv = '\uFEFF' + [header, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = node('a', '');
    link.href = url;
    link.download = `kyara-mythicals-${state.snapshot.collectedAt.slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!state.lastCheckedAt || Date.now() - state.lastCheckedAt.getTime() >= POLL_INTERVAL_MS)) refreshData();
  });
  setInterval(() => { if (!document.hidden) refreshData(); }, POLL_INTERVAL_MS);
  setInterval(() => { if (!document.hidden) renderFreshness(); }, 60000);
  refreshData();
}
