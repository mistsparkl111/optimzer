/* Радар service worker: push notifications + light offline cache. */
const CACHE = 'radar-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/geo/russia.topo.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Network first so alerts UI is always fresh; cached shell only when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (/^\/(assets|geo|icons)\//.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'Радар', body: e.data ? e.data.text() : '' };
  }
  const alertLike = d.kind === 'alert' || d.kind === 'test';
  // Custom sounds are not supported by Web Push; the system sound plays, Android also vibrates.
  const options = {
    body: d.body || '',
    tag: d.tag || 'radar',
    renotify: true,
    requireInteraction: d.kind === 'alert',
    silent: false,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    vibrate: alertLike ? [400, 150, 400, 150, 800] : d.kind === 'report' ? [200, 100, 200] : [150, 80, 150],
    timestamp: d.ts || Date.now(),
    data: { url: d.url || '/' },
  };
  e.waitUntil(
    (async () => {
      await self.registration.showNotification(d.title || 'Радар', options);
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      list.forEach((c) => c.postMessage({ type: 'push', kind: d.kind }));
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if ('focus' in c) {
          if ('navigate' in c) await c.navigate(url).catch(() => undefined);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
