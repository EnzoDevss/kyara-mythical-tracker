import { counterRows, counterType } from './counter-data.js?v=counter-1';
const $ = id => document.getElementById(id);
const labels = { seek: 'LOOKING FOR', trade: 'TRADING', offer: 'TRADE OFFER', listing: 'LISTING', look: 'CARD SHARED', text: 'MESSAGE' };
const rarityNames = { M: 'Mythical', L: 'Legendary', E: 'Epic', R: 'Rare', U: 'Uncommon', C: 'Common' };
export function renderCounter({ state, ownedIds, node, cardLink, money, number, date }) {
  const rows = counterRows(state.messages.values(), { cutoff: state.cutoff, query: $('trade-search').value, type: $('counter-type').value, room: $('counter-room').value, rarity: $('trade-rarity').value, owned: $('trade-owned').checked ? ownedIds : null, cards: state.cards, prices: state.prices, sort: $('trade-sort').value });
  const fragment = document.createDocumentFragment();
  for (const m of rows.slice(0, state.limit)) {
    const article = node('article', undefined, 'trade-offer counter-message');
    const kind = counterType(m), a = m.attachment;
    const heading = node('div', undefined, 'counter-heading'), person = node('a', m.author.pseudo, 'counter-author');
    person.href = 'https://kyara.games/profil/' + encodeURIComponent(m.author.id); person.target = '_blank'; person.rel = 'noopener noreferrer';
    heading.append(person, node('span', 'Room ' + m.room + ' · ' + date.format(new Date(m.createdAt)), 'counter-time'));
    article.append(heading, node('p', labels[kind] || 'CARD SHARED', 'eyebrow counter-kind'));
    if (a) {
      const card = node('div', undefined, 'counter-card wanted-card');
      const outline = { M: 'wanted-mythical', L: 'wanted-legendary', E: 'wanted-epic' }[a.character.rarity];
      if (outline) card.classList.add(outline);
      const saved = money(a.character.id);
      card.append(cardLink(a.character, 'trade-card-name'), node('span', (rarityNames[a.character.rarity] || 'Card') + ' · ' + a.character.series, 'trade-series'), node('span', saved === 'No saved price' ? saved : saved + ' · saved median'));
      if (ownedIds.has(a.character.id)) card.append(node('span', 'You own', 'owned-card-tag'));
      article.append(card);
      if (a.kind === 'offer') {
        article.append(node('p', 'IN RETURN FOR ONE OF', 'eyebrow counter-wanted-label'));
        const wanted = node('div', undefined, 'wanted-list');
        for (const id of a.wantIds) {
          const c = state.cards.get(id) || { id, name: 'Card #' + id };
          const choice = node('div', undefined, 'wanted-card');
          const outline = { M: 'wanted-mythical', L: 'wanted-legendary', E: 'wanted-epic' }[c.rarity];
          if (outline) choice.classList.add(outline);
          choice.append(cardLink(c), node('span', money(id)));
          if (ownedIds.has(id)) choice.append(node('span', 'You own', 'owned-card-tag'));
          wanted.append(choice);
        }
        article.append(wanted);
      }
      if (a.kind === 'listing') article.append(node('p', (a.type === 'auction' ? 'Auction bid' : 'Asking price') + ': ' + (a.price === null ? 'unavailable' : number.format(a.price) + ' ◆'), 'trade-comparison'));
    }
    if (m.text) article.append(node('p', m.text, 'counter-text'));
    const meta = node('div', undefined, 'trade-meta');
    const link = node('a', a?.kind === 'offer' ? 'Open trade on Kyara ↗' : a?.kind === 'listing' ? 'Open listing on Kyara ↗' : 'Open player on Kyara ↗', 'trade-open');
    link.href = a?.kind === 'offer' && a.offerId ? 'https://kyara.games/marche?onglet=offres&offre=' + encodeURIComponent(a.offerId) + '&trackerCard=' + a.character.id
      : a?.kind === 'listing' && a.listingId ? 'https://kyara.games/marche?annonce=' + encodeURIComponent(a.listingId) : person.href;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    meta.append(node('span', 'Posted ' + date.format(new Date(m.createdAt))), link); article.append(meta); fragment.append(article);
  }
  $('trade-offers').replaceChildren(fragment);
  $('trade-count').textContent = number.format(rows.length) + ' messages' + (rows.length > state.limit ? ' · ' + state.limit + ' shown' : '');
  $('trade-more').hidden = rows.length <= state.limit;
  $('trade-empty').hidden = rows.length > 0;
  $('trade-empty').textContent = $('trade-owned').checked && !ownedIds.size ? 'Select cards in “Card I own” to find people requesting them.' : state.running ? 'Loading rooms… matches appear as each page arrives.' : state.rooms.length ? 'No loaded messages match your filters.' : 'Press Refresh counter to load the past hour from current rooms.';
  const issues = [...state.coverage].filter(([, value]) => ['failed','partial'].includes(value));
  const ended = [...state.coverage].filter(([, value]) => value === 'end').length;
  $('scan-warnings').textContent = [issues.length ? 'Incomplete history in room' + (issues.length > 1 ? 's ' : ' ') + issues.map(([room]) => room).join(', ') + '. Refresh to retry.' : '', ended ? ended + ' room(s) reached the end of Kyara’s available history before the one-hour cutoff.' : '', !state.running && state.rooms.length > state.coverage.size ? 'Stopped before all rooms were checked.' : ''].filter(Boolean).join(' ');
}
