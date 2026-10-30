// Offline support: serve app files from cache, refresh the cache in the background.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = "checklist-v3";
const ASSETS = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "icon.svg",
  "js/app.js",
];
// Everything else (the sync API, share link pages) goes straight to the network.
const ASSET_PATHS = new Set(
  ASSETS.map((a) => new URL(a, sw.location.href).pathname),
);

sw.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() =>
      sw.skipWaiting()
    ),
  );
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        )
      )
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (
    e.request.method !== "GET" || url.origin !== sw.location.origin ||
    !ASSET_PATHS.has(url.pathname)
  ) return;
  e.respondWith(respond(e));
});

async function respond(e: FetchEvent): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(e.request, { ignoreSearch: true });
  const network = fetch(e.request).then((res) => {
    if (res.ok) void cache.put(e.request, res.clone());
    return res;
  });
  if (cached) {
    // Being offline is the normal case here, not an error: keep serving the cached copy.
    e.waitUntil(
      network.catch((err: unknown) =>
        console.warn(`Background refresh of ${e.request.url} failed:`, err)
      ),
    );
    return cached;
  }
  return network;
}
