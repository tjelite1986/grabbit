// Minimal service worker: makes the app installable and keeps the static
// shell available offline. All API traffic goes straight to the network.
// v6: the icon set was replaced with the new Grabbit logo — bump so the old
// shell cache (and its stale icons) is dropped on activate.
const CACHE = 'grabbit-v6';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon-32.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload' bypasses the browser's HTTP cache. Without it addAll is
      // happy to re-cache whatever stale copy the browser is still holding, so
      // bumping CACHE above would not actually pick up a changed shell or icon.
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Job-finished notifications from the server. Skipped while a grabbit window
// is focused — the queue view already shows the result there.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data.json(); } catch { /* ignore malformed payloads */ }
  event.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some((w) => w.focused)) return;
      await self.registration.showNotification(d.title || 'grabbit', {
        body: d.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: d.tag || undefined,
        data: { url: d.url || '/?tab=queue' },
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.length) return wins[0].focus();
      return clients.openWindow(url);
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Never touch API calls (incl. the SSE job stream), auth, or cross-origin.
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') return;

  // Network-first so the UI is always fresh; fall back to cache offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        // res.redirected guards the shell: an expired session 302s '/' to
        // /login, and caching that followed response would replace the offline
        // app shell with the login form. /share?... is unique per share —
        // caching it grows the cache without bound and is never needed.
        if (res.ok && res.type === 'basic' && !res.redirected && url.pathname !== '/share') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error()))
      )
  );
});
