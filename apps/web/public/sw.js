const CACHE = "systemforge-shell-v3";
const SHELL = ["/", "/lab", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
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
    (await caches.match(event.request)) ??
    (event.request.mode === "navigate" ? caches.match("/lab") : null);
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const copy = response.clone();
          void caches
            .open(CACHE)
            .then((cache) => cache.put(event.request, copy));
        }
        if (response.status >= 500) return (await fallback()) ?? response;
        return response;
      } catch {
        return (await fallback()) ?? Response.error();
      }
    })(),
  );
});
