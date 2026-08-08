import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("apps/web/public/sw.js", "utf8");
const listeners = new Map();
const cachedLab = new Response("cached local lab", { status: 200 });
let originResponse = new Response("origin unavailable", { status: 503 });

const context = vm.createContext({
  URL,
  Response,
  Promise,
  console,
  fetch: async () => originResponse,
  caches: {
    keys: async () => [],
    delete: async () => true,
    open: async () => ({ addAll: async () => {}, put: async () => {} }),
    match: async (request) => (request === "/lab" ? cachedLab.clone() : null),
  },
  self: {
    location: { origin: "https://systemforge.example.test" },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type, listener) => listeners.set(type, listener),
  },
});

vm.runInContext(source, context, { filename: "apps/web/public/sw.js" });
const fetchListener = listeners.get("fetch");
assert.equal(
  typeof fetchListener,
  "function",
  "fetch handler was not registered",
);

const dispatch = async (request) => {
  let responsePromise = null;
  fetchListener({
    request,
    respondWith: (promise) => {
      responsePromise = promise;
    },
  });
  assert.ok(responsePromise, "same-origin GET was not handled");
  return responsePromise;
};

const navigation = {
  method: "GET",
  mode: "navigate",
  url: "https://systemforge.example.test/lab",
};
const fallback = await dispatch(navigation);
assert.equal(fallback.status, 200);
assert.equal(await fallback.text(), "cached local lab");

originResponse = new Response("not found", { status: 404 });
const notFound = await dispatch(navigation);
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
