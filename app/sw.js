/* Service Worker — Creatis CRM (Supabase version)
   Cache uniquement l'app shell ; jamais les requêtes Supabase */
const CACHE = 'creatis-crm-app-v3';
const ASSETS = [
  '/app/', '/app/index.html', '/app/manifest.webmanifest',
  '/app/css/style.css', '/app/js/config.js', '/app/js/app.js',
  '/icon-192.png', '/icon-512.png', '/icon-180.png', '/favicon-64.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Ne jamais intercepter les requêtes Supabase (toujours fraîches)
  if (url.hostname.endsWith('.supabase.co')) return;
  // Ne pas cacher les requêtes non-GET
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200 && url.origin === location.origin) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
