import { RANGE_SECONDS, isPrice, validateHistory, summarizeHistory, chartModel } from './history-data.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = { cards: [], pools: [], cardId: params.get('card'), range: Object.hasOwn(RANGE_SECONDS, params.get('range')) ? params.get('range') : '24h', metric: params.get('metric') === 'median30d' ? 'median30d' : 'median7d', data: null, dataKey: '', request: 0, controller: null, checked: null, model: null, selected: -1 };
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const money = value => isPrice(value) ? `${number.format(value)} ◆` : '—';
const svgNS = 'http://www.w3.org/2000/svg';
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function svg(tag, attributes, text) { const el = document.createElementNS(svgNS, tag); for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value); if (text !== undefined) el.textContent = text; return el; }
function notice(text) { $('history-alert').textContent = text; $('history-alert').hidden = !text; }
function syncUrl() { const url = new URL(location.href); url.search = new URLSearchParams({ card: state.cardId, range: state.range, metric: state.metric }); history.replaceState(null, '', url); }
function showEmpty(title, copy) { $('history-chart').hidden = true; $('history-chart').setAttribute('hidden', ''); $('chart-empty').hidden = false; $('empty-title').textContent = title; $('empty-copy').textContent = copy; }

async function jsonFetch(url, signal) {
  const response = await fetch(url, { cache: 'no-cache', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

let cardMatches = [], activeCard = -1;
function closeOptions() {
  $('card-suggestions').hidden = true;
  $('card-search').setAttribute('aria-expanded', 'false');
  $('card-search').removeAttribute('aria-activedescendant');
  activeCard = -1;
}
function chooseCard(card) {
  state.cardId = String(card.id);
  $('card-search').value = card.name;
  closeOptions(); renderCard(); syncUrl(); loadHistory();
  $('picker-note').textContent = `${card.name} selected. Type to find another character or series.`;
}
function highlightCard(index) {
  activeCard = index;
  for (const [i, option] of [...$('card-results').children].entries()) option.setAttribute('aria-selected', String(i === index));
  const option = $('card-results').children[index];
  if (option) {
    $('card-search').setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  }
}
function renderOptions() {
  const query = $('card-search').value.trim().toLocaleLowerCase();
  cardMatches = state.cards.filter(card => `${card.name} ${card.series}`.toLocaleLowerCase().includes(query));
  activeCard = -1;
  $('card-search').removeAttribute('aria-activedescendant');
  const fragment = document.createDocumentFragment();
  for (const card of cardMatches) {
    const option = element('li', undefined, 'card-option');
    option.id = `card-option-${card.id}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
    option.append(element('span', card.name, 'card-option-name'), element('span', card.series || 'Mythical', 'card-option-series'));
    option.addEventListener('pointerdown', event => event.preventDefault());
    option.addEventListener('click', () => chooseCard(card));
    fragment.append(option);
  }
  $('card-results').replaceChildren(fragment);
  $('card-no-results').hidden = cardMatches.length !== 0;
  $('card-suggestions').hidden = false;
  $('card-search').setAttribute('aria-expanded', 'true');
  $('picker-note').textContent = `${cardMatches.length} matching characters. Choose a result, or use the arrow keys and Enter.`;
}

function renderCard() {
  const card = state.cards.find(card => String(card.id) === state.cardId) || state.data?.card;
  $('card-name').textContent = card?.name || `Card #${state.cardId}`;
  $('card-series').textContent = card?.series || '';
  document.title = `${card?.name || 'Card'} price history · Kyara`;
  const memberships = state.pools.filter(pool => pool.cardIds.some(id => String(id) === state.cardId)).map(pool => pool.id === 'waifu' ? 'WAIFUS' : 'HUSBANDOS');
  $('card-pool').textContent = `${memberships.join(' / ') || 'MYTHICAL'} · PRICE HISTORY`;
  $('card-source').href = `https://kyara.games/wiki/${state.cardId}`;
  $('card-source').hidden = false;
}

function renderStats() {
  const stats = summarizeHistory(state.data?.points || [], state.metric);
  $('history-latest').textContent = money(stats.latest);
  $('history-low').textContent = money(stats.low);
  $('history-high').textContent = money(stats.high);
  const change = $('history-change');
  change.className = `history-number${stats.change > 0 ? ' positive' : stats.change < 0 ? ' negative' : ''}`;
  change.textContent = stats.change === null ? '—' : `${stats.change > 0 ? '+' : ''}${number.format(stats.change)} ◆`;
  if (stats.percent !== null) change.append(element('small', `${stats.percent > 0 ? '+' : ''}${number.format(stats.percent)}%`));
  $('chart-metric').textContent = `${state.metric === 'median7d' ? '7' : '30'}-day market median · chakra ◆`;
  $('chart-count').textContent = `${stats.known} priced / ${stats.total} recorded observations`;
  return stats;
}

function selectPoint(index) {
  const dots = state.model?.dots || [];
  if (!dots.length) return;
  state.selected = Math.max(0, Math.min(index, dots.length - 1));
  const dot = dots[state.selected];
  $('chart-cursor').setAttribute('x1', dot.x); $('chart-cursor').setAttribute('x2', dot.x);
  $('chart-selection').setAttribute('cx', dot.x); $('chart-selection').setAttribute('cy', dot.y);
  const label = $('chart-price-text');
  label.textContent = money(dot.value);
  const labelWidth = label.getComputedTextLength() + 20;
  const x = Math.max(state.model.left, Math.min(dot.x - labelWidth / 2, state.model.right - labelWidth));
  const y = Math.max(0, dot.y - 40);
  $('chart-price-label').setAttribute('transform', `translate(${x},${y})`);
  $('chart-price-background').setAttribute('width', labelWidth);
  label.setAttribute('x', labelWidth / 2);
  $('point-readout').textContent = `${date.format(new Date(dot.at))} · ${money(dot.value)} · ${state.metric === 'median7d' ? '7' : '30'}-day market median`;
}

function drawChart() {
  const stats = renderStats();
  const data = state.data;
  state.model = null;
  if (!data) return;
  if (!stats.total) {
    showEmpty('No observations in this window yet', 'History starts with the first successful update after this feature is enabled. Try a longer window, or check back after the next collection.');
    $('point-readout').textContent = 'Earlier price changes were not saved. No history is invented or backfilled.';
    return;
  }
  if (!stats.known) {
    showEmpty('No reported prices in this window', 'Collections were recorded, but Kyara did not provide this market median. Try the other price metric or a longer window.');
    $('point-readout').textContent = 'Missing prices stay missing; they are never treated as zero.';
    return;
  }
  const width = Math.max(280, $('chart-frame').clientWidth);
  state.model = chartModel(data, state.metric, width);
  const model = state.model, root = $('history-chart');
  root.removeAttribute('hidden'); $('chart-empty').hidden = true;
  root.setAttribute('viewBox', `0 0 ${width} 320`);
  const fragment = document.createDocumentFragment();
  fragment.append(svg('title', { id: 'plot-title' }, `${$('card-name').textContent}: ${$('chart-metric').textContent}`), svg('desc', { id: 'plot-description' }, `${stats.known} observations in the selected ${state.range} window. Prices range from ${stats.low} to ${stats.high} chakra. Use left and right arrow keys to inspect points. A data table is available below.`));
  for (const tick of model.ticks) fragment.append(svg('line', { x1: model.left, x2: model.right, y1: tick.y, y2: tick.y, class: 'chart-grid' }), svg('text', { x: model.left - 10, y: tick.y + 4, 'text-anchor': 'end', class: 'chart-axis' }, number.format(tick.value)));
  const axisDate = new Intl.DateTimeFormat(undefined, state.range === '24h' ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' });
  const count = width < 500 ? 3 : 5;
  for (let i = 0; i < count; i++) {
    const fraction = i / (count - 1), time = Date.parse(data.windowStart) + fraction * RANGE_SECONDS[state.range] * 1000;
    fragment.append(svg('text', { x: model.left + fraction * (model.right - model.left), y: model.bottom + 27, 'text-anchor': i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle', class: 'chart-axis' }, axisDate.format(new Date(time))));
  }
  const defs = svg('defs', {});
  const gradient = svg('linearGradient', { id: 'price-gradient', gradientUnits: 'userSpaceOnUse', x1: model.dots[0].x, x2: Math.max(model.dots[0].x + 1, model.dots.at(-1).x), y1: 0, y2: 0 });
  gradient.append(svg('stop', { offset: '0%', 'stop-color': '#ff4b2b' }), svg('stop', { offset: '100%', 'stop-color': '#f5cb16' }));
  const labelGradient = svg('linearGradient', { id: 'price-label-gradient', x1: '0%', x2: '100%' });
  labelGradient.append(svg('stop', { offset: '0%', 'stop-color': '#ff6548' }), svg('stop', { offset: '100%', 'stop-color': '#f5cb16' }));
  defs.append(gradient, labelGradient); fragment.append(defs);
  for (const path of model.paths) fragment.append(svg('path', { d: path, class: 'chart-line' }));
  // Keep dense charts legible while still showing isolated observations.
  model.dots.forEach((dot, index, dots) => {
    const connected = other => other && Math.abs(other.index - dot.index) === 1 && Math.abs(Date.parse(other.at) - Date.parse(dot.at)) <= 90 * 60000;
    if (dots.length < 80 || (!connected(dots[index - 1]) && !connected(dots[index + 1]))) {
      fragment.append(svg('circle', { cx: dot.x, cy: dot.y, r: 3, class: 'chart-dot' }));
    }
  });
  fragment.append(svg('line', { id: 'chart-cursor', y1: model.top, y2: model.bottom, class: 'chart-cursor' }), svg('circle', { id: 'chart-selection', r: 5, class: 'chart-selection' }));
  const priceLabel = svg('g', { id: 'chart-price-label', class: 'chart-price-label', 'aria-hidden': 'true' });
  priceLabel.append(svg('rect', { id: 'chart-price-background', height: 26, rx: 6 }), svg('text', { id: 'chart-price-text', y: 17, 'text-anchor': 'middle' }));
  fragment.append(priceLabel);
  root.replaceChildren(fragment);
  selectPoint(model.dots.length - 1);
}

function renderTable() {
  if (!$('observation-details').open) return;
  const rows = [...(state.data?.points || [])].reverse();
  const fragment = document.createDocumentFragment();
  for (const point of rows) { const row = element('tr'); row.append(element('td', date.format(new Date(point.at))), element('td', money(point.median7d), 'numeric'), element('td', money(point.median30d), 'numeric')); fragment.append(row); }
  if (!rows.length) { const row = element('tr'), cell = element('td', 'No observations in this window.', 'empty-state'); cell.colSpan = 3; row.append(cell); fragment.append(row); }
  $('observation-rows').replaceChildren(fragment);
}

function renderFreshness() {
  const data = state.data;
  if (!data) return;
  const pill = $('history-status');
  const stale = data.updatedAt && Date.now() - Date.parse(data.updatedAt) > 90 * 60000;
  pill.className = `status-pill ${!data.updatedAt ? 'pending' : stale ? 'stale' : 'fresh'}`;
  pill.textContent = !data.updatedAt ? 'Waiting for first collection' : stale ? 'History is getting old' : 'History recorded';
  $('history-updated').textContent = `${data.updatedAt ? `Collector updated ${date.format(new Date(data.updatedAt))}. ` : ''}${state.checked ? `Checked ${date.format(state.checked)}.` : ''}`;
  const points = data.points;
  $('history-coverage').textContent = points.length ? `${points.length === 1 ? 'First observation saved. The next successful update adds another point.' : `Showing observations from ${date.format(new Date(points[0].at))} to ${date.format(new Date(points.at(-1).at))}.`} Every successful collection adds a point, even if the price stays the same. Only recorded data is shown.` : 'History fills in over time. A full 7-day or 30-day view needs that much time collecting data.';
}

async function loadHistory() {
  if (!state.cardId) return;
  const ticket = ++state.request, key = `${state.cardId}:${state.range}`;
  state.controller?.abort(); const controller = new AbortController(); state.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  if (state.dataKey !== key) { state.data = null; state.dataKey = key; $('history-coverage').textContent = ''; $('history-updated').textContent = ''; renderStats(); renderTable(); }
  $('chart-frame').setAttribute('aria-busy', 'true'); $('history-refresh').disabled = true;
  $('history-status').textContent = 'Checking history'; $('history-status').className = 'status-pill pending';
  notice(''); if (!state.data) showEmpty('Loading price history', 'Retrieving the observations saved by the collector.');
  try {
    const data = validateHistory(await jsonFetch(`/api/history?card=${encodeURIComponent(state.cardId)}&range=${state.range}`, state.controller.signal), state.cardId, state.range);
    if (ticket !== state.request) return;
    state.data = data; state.checked = new Date();
    renderCard(); drawChart(); renderFreshness(); renderTable();
  } catch {
    if (ticket !== state.request) return;
    notice(state.data ? 'Could not refresh history. Keeping the last loaded observations; check their timestamp.' : 'Could not load price history. Please try “Check for updates” in a moment.');
    if (!state.data) { showEmpty('History is temporarily unavailable', 'Your saved data has not been changed. Try again shortly.'); $('history-status').textContent = 'History unavailable'; $('history-status').className = 'status-pill stale'; }
    else renderFreshness();
  } finally {
    clearTimeout(timeout);
    if (ticket === state.request) { $('chart-frame').setAttribute('aria-busy', 'false'); $('history-refresh').disabled = false; }
  }
}

async function start() {
  for (const input of document.querySelectorAll('input[name="range"]')) {
    input.checked = input.value === state.range;
    input.addEventListener('change', () => { state.range = input.value; syncUrl(); loadHistory(); });
  }
  $('metric').value = state.metric;
  $('metric').addEventListener('change', () => { state.metric = $('metric').value; syncUrl(); drawChart(); });
  $('card-search').addEventListener('input', renderOptions);
  $('card-search').addEventListener('focus', () => { $('card-search').select(); renderOptions(); });
  $('card-search').addEventListener('click', () => { if ($('card-suggestions').hidden) renderOptions(); });
  $('card-search').addEventListener('blur', closeOptions);
  $('card-search').addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); closeOptions(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if ($('card-suggestions').hidden) renderOptions();
      if (cardMatches.length) highlightCard((activeCard + (event.key === 'ArrowDown' ? 1 : activeCard < 0 ? 0 : -1) + cardMatches.length) % cardMatches.length);
    } else if (event.key === 'Enter' && !$('card-suggestions').hidden && cardMatches.length) {
      event.preventDefault(); chooseCard(cardMatches[Math.max(0, activeCard)]);
    }
  });
  $('history-refresh').addEventListener('click', () => state.cards.length ? loadHistory() : location.reload());
  $('observation-details').addEventListener('toggle', renderTable);
  $('history-chart').addEventListener('pointermove', event => {
    const dots = state.model?.dots; if (!dots?.length) return;
    const box = $('history-chart').getBoundingClientRect(), x = (event.clientX - box.left) * Math.max(280, $('chart-frame').clientWidth) / box.width;
    let nearest = 0; for (let i = 1; i < dots.length; i++) if (Math.abs(dots[i].x - x) < Math.abs(dots[nearest].x - x)) nearest = i;
    selectPoint(nearest);
  });
  $('history-chart').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); selectPoint(event.key === 'Home' ? 0 : event.key === 'End' ? (state.model?.dots.length || 1) - 1 : state.selected + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  new ResizeObserver(() => { if (state.data) drawChart(); }).observe($('chart-frame'));
  $('timezone-note').textContent = `Dates and times use your device’s timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const snapshot = await jsonFetch('/api/prices', controller.signal);
    if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.pools)) throw new Error('Invalid catalog');
    state.cards = snapshot.cards.filter(card => Number.isSafeInteger(card.id) && card.id > 0 && card.rarity === 'M' && typeof card.name === 'string').sort((a, b) => a.name.localeCompare(b.name));
    state.pools = snapshot.pools;
    if (!state.cards.length) throw new Error('No cards');
    if (!state.cardId) state.cardId = String(state.cards[0].id);
    if (!/^[1-9][0-9]*$/.test(state.cardId) || !Number.isSafeInteger(Number(state.cardId))) throw new Error('Invalid card');
    $('card-search').disabled = false;
    $('card-search').value = state.cards.find(card => String(card.id) === state.cardId)?.name || '';
    $('picker-note').textContent = `Search ${state.cards.length} Mythicals by character or series.`;
    renderCard(); syncUrl(); await loadHistory();
  } catch {
    notice('Could not load the card list. Refresh this page to try again.');
    showEmpty('Card list unavailable', 'The saved market snapshot could not be loaded.');
    $('chart-frame').setAttribute('aria-busy', 'false'); $('picker-note').textContent = 'Card list unavailable.';
    $('history-status').textContent = 'History unavailable'; $('history-status').className = 'status-pill stale';
  } finally { clearTimeout(timeout); }
  setInterval(() => { if (!document.hidden && state.cards.length) loadHistory(); }, 5 * 60000);
  setInterval(() => { if (!document.hidden) renderFreshness(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.cards.length && (!state.checked || Date.now() - state.checked.getTime() >= 5 * 60000)) loadHistory(); });
}
start();
