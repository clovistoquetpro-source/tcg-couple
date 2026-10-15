// Garde le site disponible hors ligne ; les données Supabase ne sont jamais mises en cache ici.
const CACHE = 'nos-cartes-v13';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'vendor/supabase.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'fonts/dm-sans-latin-wght-normal.woff2', 'fonts/fraunces-latin-opsz-normal.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // réseau d'abord pour toujours avoir la dernière version, cache en secours
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
