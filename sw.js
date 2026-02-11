
const CACHE_NAME = 'sinonimoak-v10';
const ASSETS = [
  '/',
  'index.html',
  'manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  // Estrategia: Intentar red, si falla usar caché.
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request) || caches.match('/'))
  );
});
