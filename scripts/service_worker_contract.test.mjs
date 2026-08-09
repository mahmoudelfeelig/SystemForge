import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("apps/web/public/sw.js", "utf8");
const listeners = new Map();
const cachedLab = new Response("cached local lab", { status: 200 });
const cachedReplay = new Response("cached replay console", { status: 200 });
let originResponse = new Response("origin unavailable", { status: 503 });
const precached = [];

const context = vm.createContext({
  URL,
  Response,
  Promise,
  console,
  fetch: async (request) =>
    String(request) === "/asset-precache.json"
      ? new Response(
          JSON.stringify({
            schemaVersion: 1,
            assets: [
              "/assets/index-test.js",
              "/assets/index-test.css",
              "/assets/LabPage-test.js",
              "/assets/ReplayPage-test.js",
              "/assets/simulation.worker-test.js",
              "/assets/share.worker-test.js",
              "/assets/replayComparison.worker-test.js",
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : originResponse,
  caches: {
    keys: async () => [],
    delete: async () => true,
    open: async () => ({
      addAll: async (urls) => precached.push(...urls),
      put: async () => {},
    }),
    match: async (request) => {
      const pathname =
        typeof request === "string" ? request : new URL(request.url).pathname;
      if (pathname === "/lab") return cachedLab.clone();
      if (pathname === "/replay") return cachedReplay.clone();
      return null;
    },
  },
  self: {
    location: { origin: "https://systemforge.example.test" },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type, listener) => listeners.set(type, listener),
  },
});

vm.runInContext(source, context, { filename: "apps/web/public/sw.js" });
const installListener = listeners.get("install");
const fetchListener = listeners.get("fetch");
assert.equal(
  typeof installListener,
  "function",
  "install handler was not registered",
);
assert.equal(
  typeof fetchListener,
  "function",
  "fetch handler was not registered",
);

let installPromise = null;
installListener({
  waitUntil: (promise) => {
    installPromise = promise;
  },
});
assert.ok(installPromise, "install work was not lifetime-bound");
await installPromise;
assert.ok(precached.includes("/lab"), "Lab route was not precached");
assert.ok(precached.includes("/replay"), "Replay route was not precached");
assert.ok(
  precached.includes("/assets/LabPage-test.js"),
  "lazy Lab chunk was not precached",
);
assert.ok(
  precached.includes("/assets/ReplayPage-test.js"),
  "lazy replay chunk was not precached",
);
assert.ok(
  precached.includes("/assets/simulation.worker-test.js"),
  "simulation worker was not precached",
);
assert.ok(
  precached.includes("/assets/share.worker-test.js"),
  "share decoder worker was not precached",
);
assert.ok(
  precached.includes("/assets/replayComparison.worker-test.js"),
  "replay comparison worker was not precached",
);

const dispatch = (request) => {
  let responsePromise = null;
  let lifetimePromise = null;
  let dispatching = true;
  fetchListener({
    request,
    waitUntil: (promise) => {
      assert.equal(
        dispatching,
        true,
        "fetch cache work must be registered during event dispatch",
      );
      lifetimePromise = promise;
    },
    respondWith: (promise) => {
      responsePromise = promise;
    },
  });
  dispatching = false;
  assert.ok(responsePromise, "same-origin GET was not handled");
  assert.ok(lifetimePromise, "fetch cache work was not lifetime-bound");
  return { responsePromise, lifetimePromise };
};

const navigation = {
  method: "GET",
  mode: "navigate",
  url: "https://systemforge.example.test/lab",
};
const fallbackDispatch = dispatch(navigation);
const fallback = await fallbackDispatch.responsePromise;
await fallbackDispatch.lifetimePromise;
assert.equal(fallback.status, 200);
assert.equal(await fallback.text(), "cached local lab");

const replayFallbackDispatch = dispatch({
  method: "GET",
  mode: "navigate",
  url: "https://systemforge.example.test/replay",
});
const replayFallback = await replayFallbackDispatch.responsePromise;
await replayFallbackDispatch.lifetimePromise;
assert.equal(replayFallback.status, 200);
assert.equal(await replayFallback.text(), "cached replay console");

originResponse = new Response("not found", { status: 404 });
const notFoundDispatch = dispatch(navigation);
const notFound = await notFoundDispatch.responsePromise;
await notFoundDispatch.lifetimePromise;
assert.equal(notFound.status, 404, "ordinary client errors must not be hidden");

let apiHandled = false;
fetchListener({
  request: {
    method: "GET",
    mode: "cors",
    url: "https://systemforge.example.test/api/health/ready",
  },
  respondWith: () => {
    apiHandled = true;
  },
});
assert.equal(apiHandled, false, "API requests must bypass the shell cache");

process.stdout.write("Service-worker overload fallback contract passed.\n");
