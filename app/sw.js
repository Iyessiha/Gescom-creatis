/* Service Worker — Creatis CRM (Supabase version)
   Cache uniquement l'app shell ; jamais les requêtes Supabase */
const CACHE = 'creatis-crm-app-v10';
const ASSETS = [
  '/app/', '/app/index.html', '/app/manifest.webmanifest',
  '/app/css/style.css?v=3', '/app/js/config.js?v=3', '/app/js/app.js?v=3',
  '/connexion.html',
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
  if (url.hostname.endsWith('.supabase.co')) return;  // Supabase → toujours réseau
  if (url.hostname.endsWith('googleapis.com')) return; // Google Fonts → réseau
  if (url.hostname.endsWith('jsdelivr.net')) return;   // CDN Supabase JS → réseau
  if (e.request.method !== 'GET') return;

  const isAsset = /\.(css|js|png|ico|webmanifest)($|\?)/.test(url.pathname);
  const isNav   = e.request.mode === 'navigate';

  if (isNav) {
    // Navigation → network-first, fallback sur le cache
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/app/index.html'))
    );
  } else if (isAsset) {
    // Assets → cache-first (ils sont versionnés via ?v=X)
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp && resp.status === 200) {
            caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        });
      })
    );
  } else {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
