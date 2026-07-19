// Minimal service worker: makes the app installable and keeps the static
// shell available offline. All API traffic goes straight to the network.
const CACHE = 'grabbit-v2';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/logo.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
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
        if (res.ok && res.type === 'basic') {
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
