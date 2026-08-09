const CACHE = "systemforge-shell-v7";
const PRECACHE_MANIFEST = "/asset-precache.json";
const SHELL = [
  "/",
  "/lab",
  "/custom",
  "/interview",
  "/replay",
  "/manifest.webmanifest",
  "/assets/mahmoud-elephant-192.png?v=8bb95beb",
  "/assets/mahmoud-elephant.png",
];

const manifestAssets = (manifest) =>
  Array.isArray(manifest?.assets)
    ? [...new Set(manifest.assets)].filter(
        (asset) =>
          typeof asset === "string" &&
          /^\/assets\/[A-Za-z0-9._-]+(?:\?v=[a-f0-9]{8})?$/.test(asset),
      )
    : [];

const precacheApplication = async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  const manifestResponse = await fetch(PRECACHE_MANIFEST, {
    cache: "no-store",
  });
  if (!manifestResponse.ok)
    throw new Error("SystemForge asset precache manifest was unavailable.");
  const manifest = await manifestResponse.json();
  const assets = manifestAssets(manifest);
  if (assets.length === 0)
    throw new Error("SystemForge asset precache was empty.");
  await cache.addAll([PRECACHE_MANIFEST, ...assets]);
};

self.addEventListener("install", (event) => {
  event.waitUntil(precacheApplication().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    requestUrl.origin !== self.location.origin ||
    requestUrl.pathname.startsWith("/api/")
  )
    return;
  const fallback = async () =>
    (await caches.match(event.request, { ignoreSearch: true })) ??
    (event.request.mode === "navigate" ? caches.match("/lab") : null);
  let cacheWrite = Promise.resolve();
  const responsePromise = (async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const copy = response.clone();
        cacheWrite = caches
          .open(CACHE)
          .then((cache) => cache.put(event.request, copy));
      }
      if (response.status >= 500) return (await fallback()) ?? response;
      return response;
    } catch {
      return (await fallback()) ?? Response.error();
    }
  })();

  event.respondWith(responsePromise);
  event.waitUntil(
    responsePromise.then(() => cacheWrite).catch(() => undefined),
  );
});
