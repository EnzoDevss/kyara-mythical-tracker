import { priceKnown, searchOrder, readEvents, tradeMetrics, compareTradeRows, matchesRequestedCard } from './trades-data.js?v=tabs-1';
import { OWNED_CARDS_KEY, parseOwnedCards, ownedCardChoices, searchOwnedCards, matchesOwnedCards } from './owned-cards.js?v=1';
const $ = id => document.getElementById(id);
const createState = () => ({ cards: new Map(), prices: new Map(), order: [], results: new Map(), failures: new Map(), searched: new Set(), running: false, controller: null, limit: 60, token: 0, renderTimer: null, trackedIds: new Set(), snapshotAt: '', query: '', sort: 'median-desc', requestedFilter: false, message: 'Preparing the search list…', badge: 'Ready to search', badgeClass: 'status-pill pending' });
const tabStates = { M: createState(), L: createState() };
let rarity = 'M', state = tabStates.M, scanTask = null, switching = false;
let ownedIds = new Set(), ownedChoices = [], ownedListReady = false, ownedCanSave = true;
try { ownedIds = parseOwnedCards(localStorage.getItem(OWNED_CARDS_KEY)); } catch { ownedCanSave = false; }
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = id => { const p = state.prices.get(id); return priceKnown(p?.median7d) ? number.format(p.median7d) + ' ◆' + (p.stale ? ' · stale' : '') : 'No saved price'; };
function node(tag, text, className) {
  const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n;
}
function cardLink(card, className) {
  const a = node('a', card.name, className); a.href = 'https://kyara.games/wiki/' + card.id; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function progress(text) {
  state.message = text;
  $('scan-status').textContent = text;
  $('scan-progress').value = state.searched.size;
}
function scheduleRender() { if (!state.renderTimer) state.renderTimer = setTimeout(() => { state.renderTimer = null; render(); }, 70); }
function updateOwnedSummary() {
  $('owned-card-count').textContent = number.format(ownedIds.size) + ' selected';
  $('owned-card-clear').disabled = !ownedIds.size;
  $('owned-card-note').textContent = (ownedCanSave ? 'Saved only in this browser.' : 'Saving is blocked in this browser; selections last only until you leave this page.') + ' Select the cards you own. Kyara checks available copies when you accept a trade.';
}
function saveOwnedSelection() {
  try { localStorage.setItem(OWNED_CARDS_KEY, JSON.stringify([...ownedIds])); ownedCanSave = true; }
  catch { ownedCanSave = false; }
  updateOwnedSummary(); state.limit = 60; render();
}
function renderOwnedList() {
  const matches = searchOwnedCards(ownedChoices, $('owned-card-search').value), fragment = document.createDocumentFragment();
  for (const card of matches) {
    const label = node('label', undefined, 'owned-card-choice'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.dataset.cardId = card.id; checkbox.checked = ownedIds.has(card.id);
    const info = node('span', undefined, 'owned-card-info');
    info.append(node('strong', card.name), node('span', card.series));
    label.append(checkbox, node('span', '#' + String(card.rank).padStart(4, '0'), 'owned-card-rank'), info);
    fragment.append(label);
  }
  $('owned-card-list').replaceChildren(fragment);
  $('owned-card-results').textContent = ownedListReady ? number.format(matches.length) + ' of ' + number.format(ownedChoices.length) + ' cards' : 'Loading the wiki top 1,000…';
  $('owned-card-empty').hidden = !ownedListReady || matches.length > 0;
}
function render() {
  const query = $('trade-search').value.trim().toLocaleLowerCase(), now = Date.now();
  const fragment = document.createDocumentFragment(); let total = 0, shown = 0;
  const rows = [];
  const seen = new Set();
  for (const card of state.order) {
    const result = state.results.get(card.id); if (!result) continue;
    for (const offer of result.offers) {
      if (Date.parse(offer.expiresAt) <= now || seen.has(offer.id)) continue;
      seen.add(offer.id);
      const wanted = offer.wantIds.map(id => state.cards.get(id) || { id, name: 'Card #' + id, series: '' });
      if ($('trade-legendary').checked && !wanted.some(card => matchesRequestedCard(card, rarity, state.trackedIds))) continue;
      if ($('trade-owned').checked && !matchesOwnedCards(offer, ownedIds)) continue;
      const searchable = [card.name, card.series, offer.user.pseudo, ...wanted.flatMap(c => [c.name, c.series])].join(' ').toLocaleLowerCase();
      if (query && !searchable.includes(query)) continue;
      rows.push({ card, result, offer, wanted, metrics: tradeMetrics(offer, state.prices) });
    }
  }
  rows.sort((a, b) => compareTradeRows(a, b, $('trade-sort').value));
  total = rows.length;
  for (const { card, result, offer, wanted, metrics } of rows.slice(0, state.limit)) {
      shown++;
      const article = node('article', undefined, 'trade-offer');
      const main = node('div', undefined, 'trade-offer-main');
      const given = node('div', undefined, 'trade-offered');
      given.append(node('p', rarity === 'M' ? 'OFFERED · MYTHICAL' : 'OFFERED · LEGENDARY', 'eyebrow'), cardLink(card, 'trade-card-name'), node('span', card.series, 'trade-series'), node('div', money(card.id), 'trade-price'));
      const request = node('div', undefined, 'trade-wanted'); request.append(node('p', 'IN RETURN FOR ONE OF', 'eyebrow'));
      const choices = node('div', undefined, 'wanted-list');
      for (const c of wanted) {
        const choice = node('div', undefined, 'wanted-card');
        if ($('trade-legendary').checked && matchesRequestedCard(c, rarity, state.trackedIds)) choice.classList.add(rarity === 'M' ? 'wanted-legendary' : 'wanted-epic');
        choice.append(cardLink(c), node('span', money(c.id)));
        if (ownedIds.has(c.id)) choice.append(node('span', 'You own', 'owned-card-tag'));
        if (rarity === 'L' && !state.trackedIds.has(c.id)) choice.append(node('span', 'Outside top 1,000'));
        choices.append(choice);
      }
      if (!wanted.length) choices.append(node('span', 'No requested cards listed.'));
      request.append(choices); main.append(given, node('div', '⇄', 'trade-arrow'), request);
      const comparison = node('p', undefined, 'trade-comparison');
      if (metrics.gain !== null) {
        const signed = value => (value > 0 ? '+' : '') + number.format(value);
        comparison.classList.add(metrics.gain > 0 ? 'positive' : metrics.gain < 0 ? 'negative' : 'neutral');
        comparison.textContent = `Potential gain: ${signed(metrics.gain)} ◆ · ${metrics.percent === null ? 'percentage unavailable (zero requested median)' : signed(metrics.percent) + '%'} · vs cheapest requested card (${number.format(metrics.lowest)} ◆)`;
      } else comparison.textContent = 'Potential gain unavailable · missing or stale prices.';
      const meta = node('div', undefined, 'trade-meta');
      const details = node('p'); details.append(node('span', 'By ' + offer.user.pseudo), node('br'), node('span', 'Checked ' + clock.format(result.checkedAt) + (result.cached ? ' · cached' : '') + (state.running && !state.searched.has(card.id) ? ' · previous scan' : '') + ' · expires ' + date.format(new Date(offer.expiresAt))));
      const open = node('a', 'Open Kyara ↗', 'trade-open');
      open.href = 'https://kyara.games/marche?onglet=offres&offre=' + encodeURIComponent(offer.id) + '&trackerCard=' + card.id; open.target = '_blank'; open.rel = 'noopener noreferrer';
      meta.append(details, open); article.append(main, comparison, meta); fragment.append(article);
  }
  $('trade-offers').replaceChildren(fragment);
  $('trade-count').textContent = number.format(total) + ' offers' + (total > shown ? ' · ' + shown + ' shown' : '');
  $('trade-more').hidden = total <= shown;
  $('trade-empty').hidden = total > 0;
  const filtered = query || $('trade-legendary').checked || $('trade-owned').checked;
  $('trade-empty').textContent = $('trade-owned').checked && !ownedIds.size ? 'Select cards in “Card I own” to find matching trades.' : state.running ? 'Searching… matching offers will appear as cards are checked.' : state.searched.size && filtered ? 'No loaded offers match your filters.' : state.searched.size ? 'No active offers found in the cards checked.' : 'Press Refresh trades to search. Nothing runs automatically.';
  const warnings = [];
  if (state.failures.size) warnings.push(state.failures.size + ' card searches failed. Any retained results for those cards are older; refresh to retry.');
  const capped = [...state.results.values()].filter(r => r.capped).length;
  if (capped) warnings.push(capped + ' card responses reached 200 offers. Older offers for those cards may be omitted by Kyara.');
  if (state.searched.size && state.searched.size < state.order.length && !state.running) warnings.push('Partial scan: not every ' + (rarity === 'M' ? 'Mythical' : 'Legendary') + ' was checked.');
  $('scan-warnings').textContent = warnings.join(' ');
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Stopped', 'AbortError'));
    const stop = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
async function scan() {
  if (state.running || !state.order.length) return;
  state.running = true; state.controller = new AbortController(); const signal = state.controller.signal;
  const token = ++state.token; state.searched.clear(); state.failures.clear(); state.limit = 60;
  $('scan-start').disabled = true; $('scan-stop').hidden = false;
  $('scan-badge').className = 'status-pill pending'; $('scan-badge').textContent = 'Searching';
  let stopped = false;
  try {
    for (let offset = 0; offset < state.order.length; offset += 10) {
      let remaining = state.order.slice(offset, offset + 10).map(c => c.id);
      for (let attempt = 0; remaining.length && attempt < 3; attempt++) {
        const pending = new Set(remaining); let pause = 0;
        progress(`${state.searched.size} / ${state.order.length} cards checked · searching ${state.cards.get(remaining[0]).name}…`);
        const timeout = setTimeout(() => state.controller?.abort(), 90000);
        try {
          const response = await fetch('/api/trades/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: remaining }), signal, cache: 'no-store' });
          if (response.status === 401) { location.replace('/trades'); return; }
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            if (response.status === 429) pause = Math.max(1000, error.retryAfter || Number(response.headers.get('retry-after')) * 1000 || 10000);
            else throw new Error(error.error || 'Trade search temporarily unavailable.');
          } else {
            let done = false;
            await readEvents(response, event => {
              if (token !== state.token || signal.aborted) return;
              if (event.type === 'done') { done = true; return; }
              if (!pending.has(event.cardId)) return;
              if (event.type === 'card') {
                if (!Array.isArray(event.offers) || !Number.isFinite(event.checkedAt)) throw new Error('Invalid trade response.');
                state.results.set(event.cardId, event); state.failures.delete(event.cardId); state.searched.add(event.cardId); pending.delete(event.cardId);
                progress(`${state.searched.size} / ${state.order.length} cards checked · results appear as each search finishes.`);
              } else if (event.type === 'error') {
                if (event.retryAfter) pause = Math.max(pause, event.retryAfter);
                else { state.failures.set(event.cardId, true); pending.delete(event.cardId); }
              }
              scheduleRender();
            });
            if (!done) throw new Error('The trade stream was interrupted. Refresh to retry.');
          }
        } finally { clearTimeout(timeout); }
        remaining = [...pending];
        if (remaining.length && pause) {
          if (pause > 90000 || attempt === 2) throw new Error('Kyara is still cooling down. Try refreshing later.');
          progress(`Search paused for ${Math.ceil(pause / 1000)} seconds to respect traffic limits. ${state.searched.size} / ${state.order.length} checked.`);
          await sleep(pause + 250, signal);
        } else if (remaining.length) throw new Error('Some searches were interrupted. Refresh to retry.');
      }
    }
    progress(`${state.searched.size} / ${state.order.length} cards checked · finished ${clock.format(Date.now())}${state.failures.size ? ' · some searches failed' : ''}. Refresh whenever you want a new list.`);
  } catch (error) {
    stopped = true;
    progress(signal.aborted ? `Stopped · ${state.searched.size} / ${state.order.length} checked. Results collected so far are kept.` : error.message);
  } finally {
    state.running = false; state.controller = null;
    $('scan-start').disabled = false; $('scan-stop').hidden = true;
    $('scan-badge').className = 'status-pill ' + (stopped || state.failures.size ? 'stale' : 'fresh');
    $('scan-badge').textContent = stopped ? 'Partial scan' : state.failures.size ? 'Some searches failed' : 'Scan complete';
    render();
  }
}
async function init() {
  try {
    const [catalogResponse, pricesResponse] = await Promise.all([fetch('/api/trades/catalog', { cache: 'no-store' }), fetch('/api/prices', { cache: 'no-store' })]);
    if (catalogResponse.status === 401) { location.replace('/trades'); return; }
    if (!catalogResponse.ok || !pricesResponse.ok) throw new Error('Could not load cards and saved prices. Reload to try again.');
    const [catalog, snapshot] = await Promise.all([catalogResponse.json(), pricesResponse.json()]);
    const cards = new Map(catalog.cards.map(c => [c.id, c])), prices = new Map(snapshot.cards.map(c => [c.id, c]));
    const trackedIds = new Set(snapshot.cards.filter(c => c.inTop !== false && c.rank >= 1 && c.rank <= 1000).map(c => c.id));
    ownedChoices = ownedCardChoices(snapshot.cards); ownedListReady = true;
    if ($('owned-card-picker').open) renderOwnedList();
    for (const [key, tab] of Object.entries(tabStates)) {
      tab.cards = cards; tab.prices = prices; tab.trackedIds = trackedIds; tab.snapshotAt = snapshot.collectedAt;
      tab.order = searchOrder(catalog.cards.filter(c => key === 'M' || trackedIds.has(c.id)), prices, key);
      tab.message = 'Ready. Press Refresh trades to start your own scan.';
    }
    state.query = $('trade-search').value;
    state.sort = $('trade-sort').value;
    state.requestedFilter = $('trade-legendary').checked;
    updateTab();
  } catch (error) { $('scan-badge').textContent = 'Unavailable'; progress(error.message); }
}
function updateTab() {
  const mythical = rarity === 'M', label = mythical ? 'Mythical' : 'Legendary';
  for (const [id, selected] of [['tab-mythical', mythical], ['tab-legendary', !mythical]]) {
    $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1;
  }
  $('trade-panel').setAttribute('aria-labelledby', mythical ? 'tab-mythical' : 'tab-legendary');
  $('trade-eyebrow').textContent = 'THE ' + label.toUpperCase() + ' TRADE BOARD';
  $('trade-intro-copy').textContent = (mythical ? 'Search every Mythical' : 'Search the Legendaries in the tracked wiki top 1,000') + ', from highest 7-day median to lowest. Offers appear as each card is checked. Your refresh updates only your list.';
  $('results-title').textContent = label + ' offers';
  $('trade-request-filter-label').textContent = mythical ? 'Requests at least one Legendary' : 'Requests at least one Epic or a card outside the top 1,000';
  $('trade-epic-note').hidden = mythical;
  $('scan-progress').max = Math.max(1, state.order.length);
  $('scan-progress').setAttribute('aria-label', (mythical ? 'Mythicals' : 'Legendaries') + ' searched');
  $('price-note').textContent = state.snapshotAt ? `${state.order.length} ${mythical ? 'Mythicals' : 'Legendaries'} · order uses 7-day medians saved ${date.format(new Date(state.snapshotAt))}` : 'Loading card catalog and saved prices…';
  $('trade-search').value = state.query; $('trade-sort').value = state.sort; $('trade-legendary').checked = state.requestedFilter;
  $('scan-badge').textContent = state.badge; $('scan-badge').className = state.badgeClass;
  $('scan-start').disabled = !state.order.length; $('scan-stop').hidden = true;
  progress(state.message); render();
}
async function switchTab(next) {
  if (next === rarity || switching) return;
  switching = true;
  try {
    state.query = $('trade-search').value; state.sort = $('trade-sort').value; state.requestedFilter = $('trade-legendary').checked;
    if (state.running) { state.controller?.abort(); await scanTask; }
    state.badge = $('scan-badge').textContent; state.badgeClass = $('scan-badge').className;
    clearTimeout(state.renderTimer); state.renderTimer = null;
    rarity = next; state = tabStates[next]; updateTab();
  } finally { switching = false; }
}
$('scan-start').addEventListener('click', () => { if (!switching) scanTask = scan(); });
$('tab-mythical').addEventListener('click', () => switchTab('M'));
$('tab-legendary').addEventListener('click', () => switchTab('L'));
for (const id of ['tab-mythical', 'tab-legendary']) $(id).addEventListener('keydown', async event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const next = event.key === 'Home' ? 'M' : event.key === 'End' ? 'L' : rarity === 'M' ? 'L' : 'M';
  await switchTab(next); $(next === 'M' ? 'tab-mythical' : 'tab-legendary').focus();
});
$('scan-stop').addEventListener('click', () => state.controller?.abort());
$('trade-search').addEventListener('input', () => { state.limit = 60; render(); });
$('trade-sort').addEventListener('change', () => { state.limit = 60; render(); });
$('trade-legendary').addEventListener('change', () => { state.limit = 60; render(); });
$('trade-owned').addEventListener('change', () => { state.limit = 60; render(); });
$('owned-card-picker').addEventListener('toggle', () => { if ($('owned-card-picker').open) renderOwnedList(); });
$('owned-card-search').addEventListener('input', renderOwnedList);
$('owned-card-list').addEventListener('change', event => {
  const checkbox = event.target;
  if (!checkbox.matches('input[data-card-id]')) return;
  const id = Number(checkbox.dataset.cardId);
  if (checkbox.checked) ownedIds.add(id); else ownedIds.delete(id);
  saveOwnedSelection();
});
$('owned-card-clear').addEventListener('click', () => { ownedIds.clear(); saveOwnedSelection(); renderOwnedList(); });
window.addEventListener('storage', event => {
  if (event.key !== OWNED_CARDS_KEY && event.key !== null) return;
  ownedIds = parseOwnedCards(event.newValue); updateOwnedSummary();
  if ($('owned-card-picker').open) renderOwnedList();
  state.limit = 60; render();
});
$('trade-more').addEventListener('click', () => { state.limit += 60; render(); });
window.addEventListener('pagehide', () => state.controller?.abort());
updateOwnedSummary();
init();
