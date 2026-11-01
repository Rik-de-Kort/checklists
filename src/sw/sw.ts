// Offline support: serve app files from the network so a launch always gets the latest deploy,
// keeping a copy in the cache for when we're offline or the server is slow to wake up.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = "checklist-v3";
const NETWORK_TIMEOUT_MS = 3000;
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
  const network = fetch(e.request);
  // Keep the worker alive until the copy is written; the browser may stop it right after responding.
  e.waitUntil(
    network
      .then((res) => res.ok ? cache.put(e.request, res.clone()) : undefined)
      // Being offline is the normal case here, not an error: the cached copy is served instead.
      .catch((err: unknown) =>
        console.warn(`Refreshing the cached ${e.request.url} failed:`, err)
      ),
  );
  const cached = await cache.match(e.request, { ignoreSearch: true });
  if (!cached) return network;
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS)
  );
  try {
    const res = await Promise.race([network, timeout]);
    return res?.ok ? res : cached;
  } catch {
    return cached; // offline; already logged above
  }
}
