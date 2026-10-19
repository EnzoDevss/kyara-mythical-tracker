const validId = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const validCardId = value => Number.isSafeInteger(value) && value > 0;
export function cleanRooms(raw) {
  if (!Array.isArray(raw?.rooms) || raw.rooms.length > 1000) throw new Error('Unexpected counter room list.');
  return [...new Set(raw.rooms.map(r => r?.room).filter(r => Number.isSafeInteger(r) && r > 0))].sort((a, b) => a - b);
}
export function cleanCounterPage(raw, room, checkedAt) {
  if (!Array.isArray(raw?.items) || raw.items.length > 200 || typeof raw.hasMore !== 'boolean') throw new Error('Unexpected counter messages.');
  // Keep the cursor separate from display validation so a malformed post cannot hide older pages.
  const ordered = raw.items.filter(m => validId(m?.id) && Number.isFinite(Date.parse(m.createdAt)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (raw.items.length && !ordered.length) throw new Error('Counter messages have no usable cursor.');
  const items = ordered.filter(m => m.room === room && validId(m.author?.id) && typeof m.author.pseudo === 'string').map(m => {
    const item = { id: m.id, room, createdAt: m.createdAt, text: typeof m.text === 'string' ? m.text.slice(0, 2000) : '', author: { id: m.author.id, pseudo: m.author.pseudo.slice(0, 80) } };
    const a = m.attachment, c = a?.character;
    if (['card', 'listing', 'offer'].includes(a?.kind) && validCardId(c?.id) && typeof c.name === 'string') {
      const character = { id: c.id, name: c.name.slice(0, 200), series: typeof c.series === 'string' ? c.series.slice(0, 200) : '', rarity: ['M','L','E','R','U','C'].includes(c.rarity) ? c.rarity : '', rank: Number.isSafeInteger(c.rank) ? c.rank + 1 : null };
      item.attachment = { kind: a.kind, character };
      if (a.kind === 'card') item.attachment.tag = ['seek','trade','look'].includes(a.tag) ? a.tag : 'look';
      else {
        item.attachment.status = typeof a.status === 'string' ? a.status.slice(0, 30) : '';
        if (a.kind === 'offer' && validId(a.offerId) && Number.isFinite(Date.parse(a.expiresAt))) Object.assign(item.attachment, { offerId: a.offerId, wantIds: Array.isArray(a.wantIds) ? [...new Set(a.wantIds.filter(validCardId))].slice(0, 5) : [], expiresAt: new Date(a.expiresAt).toISOString() });
        else if (a.kind === 'offer') delete item.attachment;
        if (a.kind === 'listing' && validId(a.listingId) && Number.isFinite(Date.parse(a.endsAt))) Object.assign(item.attachment, { listingId: a.listingId, type: a.type === 'auction' ? 'auction' : 'fixed', price: Number.isFinite(a.price) && a.price >= 0 ? a.price : null, endsAt: new Date(a.endsAt).toISOString() });
        else if (a.kind === 'listing') delete item.attachment;
      }
    }
    return item;
  });
  return { room, checkedAt, items, hasMore: raw.hasMore, nextBefore: ordered[0]?.id || null, oldestAt: ordered[0]?.createdAt || null };
}
