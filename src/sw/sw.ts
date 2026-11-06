// Launches are served from the cache, so they never wait for the network or for the server to wake
// up. Each launch refreshes the cache in the background: a new deploy shows up on the next launch.
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

// All or nothing, so the cache never mixes files from two deploys.
async function refresh(): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.addAll(ASSETS.map((a) => new Request(a, { cache: "no-cache" })));
}

sw.addEventListener("install", (e) => {
  e.waitUntil(refresh().then(() => sw.skipWaiting()));
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
  if (e.request.mode === "navigate") {
    e.waitUntil(
      // Being offline is the normal case here, not an error: the cached copy keeps being served.
      refresh().catch((err: unknown) =>
        console.warn("Refreshing the cached app files failed:", err)
      ),
    );
  }
  e.respondWith(respond(e.request));
});

async function respond(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  return await cache.match(request, { ignoreSearch: true }) ?? fetch(request);
}

// "Check for updates" asks for the new files now, and reloads once they're in the cache.
sw.addEventListener("message", (e) => {
  const port = e.ports[0];
  if (e.data !== "refresh" || !port) {
    throw new Error(`Unexpected message: ${JSON.stringify(e.data)}`);
  }
  e.waitUntil(
    refresh().then(
      () => port.postMessage(null),
      (err: unknown) => port.postMessage(String(err)),
    ),
  );
});
