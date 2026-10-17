export const OWNED_CARDS_KEY = 'kyara:owned-card-ids:v1';

export function parseOwnedCards(raw) {
  try {
    const values = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 10000) return new Set();
    return new Set(values.filter(id => Number.isSafeInteger(id) && id > 0));
  } catch { return new Set(); }
}

export function ownedCardChoices(cards) {
  return cards.filter(card => card.inTop !== false && Number.isSafeInteger(card.rank) && card.rank >= 1 && card.rank <= 1000)
    .sort((a, b) => a.rank - b.rank || a.id - b.id);
}

const normalize = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();
export function searchOwnedCards(cards, query) {
  const term = normalize(query);
  return term ? cards.filter(card => normalize(`${card.name} ${card.series} #${String(card.rank).padStart(4, '0')} ${card.rank}`).includes(term)) : cards;
}

export function matchesOwnedCards(offer, ownedIds) {
  return offer.wantIds.some(id => ownedIds.has(id));
}
