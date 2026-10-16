(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  let banner, status = '', closed = false;
  const target = () => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get('trackerCard');
    if (url.origin !== 'https://kyara.games' || url.pathname !== '/marche' || url.searchParams.get('onglet') !== 'offres'
      || !value || !/^[1-9]\d{0,8}$/.test(value)) return null;
    return { cardId: Number(value), offerId: url.searchParams.get('offre') };
  };
  function show(message) {
    status = message;
    if (!document.body || closed) return;
    if (!banner) {
      banner = document.createElement('aside');
      banner.className = 'kyara-market-helper-notice';
      banner.setAttribute('aria-label', 'Kyara Market trade helper');
      const text = document.createElement('span'); text.setAttribute('role', 'status');
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close helper message');
      close.addEventListener('click', () => { closed = true; banner.remove(); });
      banner.append(text, close); document.body.prepend(banner);
    }
    banner.firstChild.textContent = status;
  }
  document.addEventListener('DOMContentLoaded', () => { if (status) show(status); }, { once: true });
  if (target()) show('Kyara Market helper ready. Loading this character’s offers in Kyara…');
  window.fetch = async function(input, init) {
    const selection = target();
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let url;
    try { url = new URL(input instanceof Request ? input.url : input, window.location.href); } catch { return nativeFetch(input, init); }
    // Only replace the normal public listing GET. Never touch authentication, trades, or mutations.
    if (!selection || method !== 'GET' || url.origin !== 'https://kyara.games' || url.pathname !== '/api/trades/offers' || url.search) return nativeFetch(input, init);
    url.searchParams.set('characterId', String(selection.cardId));
    show('Kyara Market helper: loading offers for card #' + selection.cardId + '…');
    try {
      const replacement = input instanceof Request ? new Request(url, input) : url.href;
      const response = await nativeFetch(replacement, init);
      if (!response.ok) { show('Kyara could not load this character’s offers (HTTP ' + response.status + '). No trades were changed.'); return response; }
      // Inspect a clone; Kyara consumes the original response normally.
      const offers = await response.clone().json();
      if (!Array.isArray(offers) || offers.some(o => o.characterId !== selection.cardId)) {
        show('Kyara returned an unexpected listing. The helper may need an update.');
      } else {
        const found = selection.offerId && offers.some(o => o.id === selection.offerId && o.status === 'open');
        show('Kyara Market helper: ' + offers.length + ' character-filtered offers loaded. '
          + (found ? 'The selected offer is present; use Kyara’s normal controls.' : selection.offerId ? 'The selected offer was not returned; it may have ended or been omitted by Kyara.' : 'Use Kyara’s normal controls to view offers.'));
      }
      return response;
    } catch (error) {
      show('The character-filtered request failed. Reload to retry. No trades were changed.');
      throw error;
    }
  };
})();
