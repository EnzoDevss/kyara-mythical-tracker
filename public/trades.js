import { priceKnown, searchOrder, readEvents, tradeMetrics, ownedTradeMetrics, compareTradeRows, matchesRequestedCard } from './trades-data.js?v=owned-gain-2';
import { OWNED_CARDS_KEY, parseOwnedCards, ownedCardChoices, searchOwnedCards, matchesOwnedCards } from './owned-cards.js?v=1';
import { loadCounter } from './counter-data.js?v=counter-1';
import { renderCounter } from './counter.js?v=counter-1';
const $ = id => document.getElementById(id);
const createState = () => ({ cards: new Map(), prices: new Map(), order: [], results: new Map(), failures: new Map(), searched: new Set(), running: false, controller: null, limit: 60, token: 0, renderTimer: null, trackedIds: new Set(), snapshotAt: '', query: '', sort: 'median-desc', offeredRarity: '', requestedFilter: false, message: 'Preparing the search list…', badge: 'Ready to search', badgeClass: 'status-pill pending' });
const tabStates = { M: createState(), L: createState(), FT: createState(), CT: { ...createState(), sort: 'newest', messages: new Map(), rooms: [], coverage: new Map(), cutoff: 0, counterType: 'posts', room: '' } };
const tabIds = { M: 'tab-mythical', L: 'tab-legendary', FT: 'tab-fairy-tail', CT: 'tab-counter' };
const rarityNames = { M: 'Mythical', L: 'Legendary', E: 'Epic', R: 'Rare', U: 'Uncommon', C: 'Common' };
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
  const chips = document.createDocumentFragment();
  const wikiRank = id => state.prices.get(id)?.rank ?? state.cards.get(id)?.rank ?? Infinity;
  // Sort a display copy; keep every saved selection, including cards outside the current top 1,000.
  for (const id of [...ownedIds].sort((a, b) => wikiRank(a) - wikiRank(b) || a - b)) {
    const card = state.cards.get(id) || state.prices.get(id), name = card?.name || 'Card #' + id;
    const chip = node('span', undefined, 'owned-selection-chip'), remove = node('button', '×');
    remove.type = 'button'; remove.dataset.cardId = id; remove.setAttribute('aria-label', 'Remove ' + name);
    chip.append(node('span', name), remove); chips.append(chip);
  }
  $('owned-card-chips').replaceChildren(chips);
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
  if (rarity === 'CT') return renderCounter({ state, ownedIds, node, cardLink, money, number, date });
  const query = $('trade-search').value.trim().toLocaleLowerCase(), now = Date.now();
  const offeredRarity = rarity === 'FT' ? $('trade-rarity').value : '';
  const fragment = document.createDocumentFragment(); let total = 0, shown = 0;
  const rows = [];
  const seen = new Set();
  for (const card of state.order) {
    if (offeredRarity && card.rarity !== offeredRarity) continue;
    const result = state.results.get(card.id); if (!result) continue;
    for (const offer of result.offers) {
      if (Date.parse(offer.expiresAt) <= now || seen.has(offer.id)) continue;
      seen.add(offer.id);
      const wanted = offer.wantIds.map(id => state.cards.get(id) || { id, name: 'Card #' + id, series: '' });
      if (rarity !== 'FT' && $('trade-legendary').checked && !wanted.some(card => matchesRequestedCard(card, rarity, state.trackedIds))) continue;
      if ($('trade-owned').checked && !matchesOwnedCards(offer, ownedIds)) continue;
      const searchable = [card.name, card.series, offer.user.pseudo, ...wanted.flatMap(c => [c.name, c.series])].join(' ').toLocaleLowerCase();
      if (query && !searchable.includes(query)) continue;
      rows.push({ card, result, offer, wanted, metrics: tradeMetrics(offer, state.prices), ownedMetrics: ownedTradeMetrics(offer, state.prices, ownedIds) });
    }
  }
  rows.sort((a, b) => compareTradeRows(a, b, $('trade-sort').value));
  total = rows.length;
  for (const { card, result, offer, wanted, metrics, ownedMetrics } of rows.slice(0, state.limit)) {
      shown++;
      const article = node('article', undefined, 'trade-offer');
      const main = node('div', undefined, 'trade-offer-main');
      const given = node('div', undefined, 'trade-offered');
      given.append(node('p', 'OFFERED · ' + (rarityNames[card.rarity] || 'Card').toUpperCase(), 'eyebrow'), cardLink(card, 'trade-card-name'), node('span', card.series, 'trade-series'), node('div', money(card.id), 'trade-price'));
      const request = node('div', undefined, 'trade-wanted'); request.append(node('p', 'IN RETURN FOR ONE OF', 'eyebrow'));
      const choices = node('div', undefined, 'wanted-list');
      for (const c of wanted) {
        const choice = node('div', undefined, 'wanted-card');
        const outline = { M: 'wanted-mythical', L: 'wanted-legendary', E: 'wanted-epic' }[c.rarity]
          || (rarity === 'L' && !state.trackedIds.has(c.id) ? 'wanted-epic' : null);
        if (outline) choice.classList.add(outline);
        choice.append(cardLink(c), node('span', money(c.id)));
        if (ownedIds.has(c.id)) choice.append(node('span', 'You own', 'owned-card-tag'));
        if (rarity === 'L' && !state.trackedIds.has(c.id)) choice.append(node('span', 'Outside top 1,000'));
        choices.append(choice);
      }
      if (!wanted.length) choices.append(node('span', 'No requested cards listed.'));
      request.append(choices); main.append(given, node('div', '⇄', 'trade-arrow'), request);
      const comparison = node('p', undefined, 'trade-comparison');
      const signed = value => (value > 0 ? '+' : '') + number.format(value);
      if (metrics.gain !== null) {
        comparison.classList.add(metrics.gain > 0 ? 'positive' : metrics.gain < 0 ? 'negative' : 'neutral');
        comparison.textContent = `Potential gain: ${signed(metrics.gain)} ◆ · ${metrics.percent === null ? 'percentage unavailable (zero requested median)' : signed(metrics.percent) + '%'} · vs cheapest requested card (${number.format(metrics.lowest)} ◆)`;
      } else comparison.textContent = 'Potential gain unavailable · missing or stale prices.';
      const ownedComparison = node('p', undefined, 'trade-comparison');
      if (ownedMetrics.gain !== null) {
        ownedComparison.classList.add(ownedMetrics.gain > 0 ? 'positive' : ownedMetrics.gain < 0 ? 'negative' : 'neutral');
        ownedComparison.textContent = `Owned potential gain: ${signed(ownedMetrics.gain)} ◆ · ${ownedMetrics.percent === null ? 'percentage unavailable (zero requested median)' : signed(ownedMetrics.percent) + '%'} · vs cheapest owned requested card (${number.format(ownedMetrics.lowest)} ◆)`;
      } else ownedComparison.textContent = 'Owned potential gain unavailable · missing or stale prices.';
      const meta = node('div', undefined, 'trade-meta');
      const details = node('p'); details.append(node('span', 'By ' + offer.user.pseudo), node('br'), node('span', 'Checked ' + clock.format(result.checkedAt) + (result.cached ? ' · cached' : '') + (state.running && !state.searched.has(card.id) ? ' · previous scan' : '') + ' · expires ' + date.format(new Date(offer.expiresAt))));
      const open = node('a', 'Open Kyara ↗', 'trade-open');
      open.href = 'https://kyara.games/marche?onglet=offres&offre=' + encodeURIComponent(offer.id) + '&trackerCard=' + card.id; open.target = '_blank'; open.rel = 'noopener noreferrer';
      meta.append(details, open); article.append(main, comparison);
      if (matchesOwnedCards(offer, ownedIds)) article.append(ownedComparison);
      article.append(meta); fragment.append(article);
  }
  $('trade-offers').replaceChildren(fragment);
  $('trade-count').textContent = number.format(total) + ' offers' + (total > shown ? ' · ' + shown + ' shown' : '');
  $('trade-more').hidden = total <= shown;
  $('trade-empty').hidden = total > 0;
  const filtered = query || offeredRarity || (rarity !== 'FT' && $('trade-legendary').checked) || $('trade-owned').checked;
  $('trade-empty').textContent = $('trade-owned').checked && !ownedIds.size ? 'Select cards in “Card I own” to find matching trades.' : state.running ? 'Searching… matching offers will appear as cards are checked.' : state.searched.size && filtered ? 'No loaded offers match your filters.' : state.searched.size ? 'No active offers found in the cards checked.' : 'Press Refresh trades to search. Nothing runs automatically.';
  const warnings = [];
  if (state.failures.size) warnings.push(state.failures.size + ' card searches failed. Any retained results for those cards are older; refresh to retry.');
  const capped = [...state.results.values()].filter(r => r.capped).length;
  if (capped) warnings.push(capped + ' card responses reached 200 offers. Older offers for those cards may be omitted by Kyara.');
  if (state.searched.size && state.searched.size < state.order.length && !state.running) warnings.push('Partial scan: not every ' + (rarity === 'FT' ? 'Fairy Tail card' : rarityNames[rarity]) + ' was checked.');
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
async function scanCounter() {
  if (state.running) return;
  state.running = true; state.limit = 60; state.controller = new AbortController();
  const signal = state.controller.signal;
  $('scan-start').disabled = true; $('scan-stop').hidden = false;
  $('scan-badge').className = 'status-pill pending'; $('scan-badge').textContent = 'Loading counter';
  let stopped = false;
  try {
    progress('Discovering current counter rooms…');
    await loadCounter({ signal,
      onRooms(rooms, cutoff) {
        state.messages.clear(); state.searched.clear(); state.coverage.clear(); state.rooms = rooms; state.cutoff = cutoff;
        $('scan-progress').max = Math.max(1, rooms.length);
        updateCounterRooms();
        $('price-note').textContent = rooms.length + ' current rooms · messages since ' + date.format(new Date(cutoff));
        progress('Loading the past hour across ' + rooms.length + ' rooms…'); render();
      },
      onPage(page) {
        for (const message of page.items) if (Date.parse(message.createdAt) >= state.cutoff) state.messages.set(message.id, message);
        progress(state.searched.size + ' / ' + state.rooms.length + ' rooms finished · ' + number.format(state.messages.size) + ' messages loaded'); scheduleRender();
      },
      onRoom(room, coverage) {
        state.coverage.set(room, coverage); state.searched.add(room);
        progress(state.searched.size + ' / ' + state.rooms.length + ' rooms finished · ' + number.format(state.messages.size) + ' messages loaded'); scheduleRender();
      },
      onPause(ms) { progress('Kyara requested a pause · retrying in ' + Math.ceil(ms / 1000) + ' seconds.'); }
    });
    progress(state.searched.size + ' / ' + state.rooms.length + ' rooms checked · finished ' + clock.format(Date.now()) + '. Refresh to discover current rooms and new messages.');
  } catch (error) {
    stopped = true;
    if (error.unauthorized) { location.replace('/trades'); return; }
    progress(signal.aborted ? 'Stopped. Messages loaded so far are kept.' : error.message);
  } finally {
    state.running = false; state.controller = null;
    const partial = stopped || [...state.coverage.values()].some(value => ['failed','partial'].includes(value));
    $('scan-start').disabled = false; $('scan-stop').hidden = true;
    $('scan-badge').className = 'status-pill ' + (partial ? 'stale' : 'fresh');
    $('scan-badge').textContent = partial ? 'Partial counter scan' : 'Counter loaded'; render();
  }
}
function updateCounterRooms() {
  const select = $('counter-room');
  select.replaceChildren(new Option('All rooms', ''), ...state.rooms.map(room => new Option('Room ' + room, String(room))));
  if (!state.rooms.includes(Number(state.room))) state.room = '';
  select.value = state.room;
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
      tab.order = key === 'CT' ? [] : searchOrder(catalog.cards.filter(c => key !== 'L' || trackedIds.has(c.id)), prices, key);
      tab.message = key === 'CT' ? 'Ready. Press Refresh counter to load at least the past hour from current rooms.' : 'Ready. Press Refresh trades to start your own scan.';
    }
    updateOwnedSummary();
    state.query = $('trade-search').value;
    state.sort = $('trade-sort').value;
    state.requestedFilter = $('trade-legendary').checked;
    updateTab();
  } catch (error) { $('scan-badge').textContent = 'Unavailable'; progress(error.message); }
}
function updateTab() {
  const mythical = rarity === 'M', fairyTail = rarity === 'FT', counter = rarity === 'CT', label = counter ? 'Counter' : fairyTail ? 'Fairy Tail' : rarityNames[rarity];
  for (const [key, id] of Object.entries(tabIds)) {
    const selected = key === rarity;
    $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1;
  }
  $('trade-panel').setAttribute('aria-labelledby', tabIds[rarity]);
  $('trade-eyebrow').textContent = 'THE ' + label.toUpperCase() + ' TRADE BOARD';
  $('trade-intro-copy').textContent = (fairyTail ? 'Search every Fairy Tail card, across all rarities and wiki ranks' : mythical ? 'Search every Mythical' : 'Search the Legendaries in the tracked wiki top 1,000') + ', from highest 7-day median to lowest. Offers appear as each card is checked. Your refresh updates only your list.';
  if (counter) $('trade-intro-copy').textContent = 'Discover current counter rooms and load their messages from the past hour. Find people looking for your cards or offering a card you want. Results appear progressively; your filters and owned cards stay local.';
  $('results-title').textContent = counter ? 'Counter messages' : label + ' offers';
  $('results-eyebrow').textContent = counter ? 'POSTED IN THE PAST HOUR' : 'AVAILABLE WHEN CHECKED';
  $('trade-search-label').textContent = counter ? 'Filter loaded messages' : 'Filter loaded offers';
  $('trade-sort-label').textContent = counter ? 'Sort loaded messages' : 'Sort loaded offers';
  $('trade-more').textContent = counter ? 'Show more messages' : 'Show more offers';
  $('trade-request-filter-label').textContent = mythical ? 'Requests at least one Legendary' : 'Requests at least one Epic or a card outside the top 1,000';
  $('trade-request-filter').hidden = fairyTail || counter;
  $('trade-rarity-field').hidden = !fairyTail && !counter;
  $('trade-rarity-label').textContent = counter ? 'Card rarity' : 'Offered rarity';
  document.querySelector('.trade-filters').classList.toggle('has-rarity', fairyTail || counter);
  $('counter-filters').hidden = !counter;
  $('trade-owned-label').textContent = counter ? 'Requests cards I own' : 'Trades I can accept';
  $('trade-comparison-note').hidden = counter;
  $('counter-note').hidden = !counter;
  $('scan-explanation').textContent = counter ? 'Each refresh discovers current rooms and pages backward to the one-hour cutoff or the end of available history. Results may be reused for up to 15 seconds. Requests share pacing with trade searches and pause when needed. Nothing runs automatically.' : 'Results may be reused for up to 15 seconds. Traffic is shared at up to 10 searches/second, with automatic pauses when needed. Offers can be taken or withdrawn after checking. Complete trades on Kyara.';
  $('scan-start').textContent = counter ? 'Refresh counter ↻' : 'Refresh trades ↻';
  $('trade-search').placeholder = counter ? 'Search card, requested card, series, message, or player…' : 'Search offered card, requested card, series, or player…';
  $('trade-sort').replaceChildren(...(counter ? [['newest','Newest messages first'],['oldest','Oldest messages first'],['median-desc','Card median: high to low'],['median-asc','Card median: low to high']] : [['median-desc','Offered median: high to low'],['median-asc','Offered median: low to high'],['gain-desc','Potential gain: highest first'],['owned-gain-desc','Owned potential gain: highest first'],['percent-desc','Percentage gain: highest first']]).map(([value, text]) => new Option(text, value)));
  if (counter) { updateCounterRooms(); $('counter-type').value = state.counterType; }
  $('trade-rarity').value = state.offeredRarity;
  $('trade-epic-note').hidden = rarity !== 'L';
  $('scan-progress').max = Math.max(1, counter ? state.rooms.length : state.order.length);
  const group = fairyTail ? 'Fairy Tail cards · all rarities' : mythical ? 'Mythicals' : 'Legendaries';
  $('scan-progress').setAttribute('aria-label', group + ' searched');
  if (counter) $('scan-progress').setAttribute('aria-label', 'Counter rooms checked');
  $('price-note').textContent = state.snapshotAt ? `${state.order.length} ${group} · order uses 7-day medians saved ${date.format(new Date(state.snapshotAt))}` : 'Loading card catalog and saved prices…';
  if (counter) $('price-note').textContent = state.rooms.length ? state.rooms.length + ' rooms · messages since ' + date.format(new Date(state.cutoff)) : 'Current rooms are discovered when you refresh.';
  $('trade-search').value = state.query; $('trade-sort').value = state.sort; $('trade-legendary').checked = state.requestedFilter;
  $('scan-badge').textContent = state.badge; $('scan-badge').className = state.badgeClass;
  $('scan-start').disabled = counter ? !state.cards.size : !state.order.length; $('scan-stop').hidden = true;
  progress(state.message); render();
}
async function switchTab(next) {
  if (next === rarity || switching) return;
  switching = true;
  try {
    state.query = $('trade-search').value; state.sort = $('trade-sort').value; state.requestedFilter = $('trade-legendary').checked;
    if (rarity === 'CT') { state.counterType = $('counter-type').value; state.room = $('counter-room').value; }
    if (state.running) { state.controller?.abort(); await scanTask; }
    state.badge = $('scan-badge').textContent; state.badgeClass = $('scan-badge').className;
    clearTimeout(state.renderTimer); state.renderTimer = null;
    rarity = next; state = tabStates[next]; updateTab();
  } finally { switching = false; }
}
$('scan-start').addEventListener('click', () => { if (!switching) scanTask = rarity === 'CT' ? scanCounter() : scan(); });
$('tab-mythical').addEventListener('click', () => switchTab('M'));
$('tab-legendary').addEventListener('click', () => switchTab('L'));
$('tab-fairy-tail').addEventListener('click', () => switchTab('FT'));
$('tab-counter').addEventListener('click', () => switchTab('CT'));
for (const id of Object.values(tabIds)) $(id).addEventListener('keydown', async event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const keys = Object.keys(tabIds), offset = event.key === 'ArrowLeft' ? -1 : 1;
  const next = event.key === 'Home' ? 'M' : event.key === 'End' ? 'CT' : keys[(keys.indexOf(rarity) + offset + keys.length) % keys.length];
  await switchTab(next); $(tabIds[next]).focus();
});
$('scan-stop').addEventListener('click', () => state.controller?.abort());
$('trade-search').addEventListener('input', () => { state.limit = 60; render(); });
$('trade-sort').addEventListener('change', () => { state.limit = 60; render(); });
$('trade-rarity').addEventListener('change', () => { state.offeredRarity = $('trade-rarity').value; state.limit = 60; render(); });
$('trade-legendary').addEventListener('change', () => { state.limit = 60; render(); });
$('trade-owned').addEventListener('change', () => { state.limit = 60; render(); });
for (const id of ['counter-type','counter-room']) $(id).addEventListener('change', () => { state.counterType = $('counter-type').value; state.room = $('counter-room').value; state.limit = 60; render(); });
$('owned-card-picker').addEventListener('toggle', () => { if ($('owned-card-picker').open) renderOwnedList(); });
$('owned-card-search').addEventListener('input', renderOwnedList);
$('owned-card-chips').addEventListener('click', event => {
  const button = event.target.closest('button[data-card-id]');
  if (!button) return;
  const id = Number(button.dataset.cardId);
  ownedIds.delete(id);
  const checkbox = $('owned-card-list').querySelector('input[data-card-id="' + id + '"]');
  if (checkbox) checkbox.checked = false;
  saveOwnedSelection(); $('owned-card-search').focus({ preventScroll: true });
});
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
