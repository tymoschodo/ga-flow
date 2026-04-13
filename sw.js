const CACHE = 'ga-flow-v2';
const ASSETS = [
  '/ga-flow/participant.html',
  '/ga-flow/manifest.json',
  '/ga-flow/icon-192.png',
  '/ga-flow/icon-512.png',
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', e => {
  // Always go network-first for Firebase (real-time data)
  if(e.request.url.includes('firebasedatabase') ||
     e.request.url.includes('googleapis') ||
     e.request.url.includes('gstatic')) {
    return; // let Firebase handle its own requests
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
