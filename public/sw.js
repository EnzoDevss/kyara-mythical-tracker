// Network-only: installation support without caching old prices or site versions.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => new Response('You are offline. Reconnect and reopen Kyara Market.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })));
});
