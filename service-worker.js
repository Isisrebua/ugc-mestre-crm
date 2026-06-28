/* UGC Mestre CRM — Service Worker v2.6 */
const CACHE_NAME = 'ugc-mestre-v2.6';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon.svg',
];

/* INSTALL — pré-cache do app shell */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

/* ACTIVATE — limpa caches antigos de versões anteriores */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('ugc-mestre-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* FETCH — cache-first para assets locais, network-only para externos */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  /* Requisições externas (logos Clearbit, etc.) — passa direto sem cache */
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(e.request);
      if (cached) return cached;

      try {
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        /* Offline e não está em cache: retorna o app shell (index.html) */
        const fallback = await cache.match('./index.html');
        return fallback || new Response('Offline — abra o app conectado primeiro.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })
  );
});

/* Recebe mensagem do cliente para forçar atualização */
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
