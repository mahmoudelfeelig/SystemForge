import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(path, "utf8");
const [app, nginx, worker, serviceWorker, sitemap] = await Promise.all([
  read("apps/web/src/App.tsx"),
  read("deploy/nginx.conf"),
  read("apps/web/worker/index.js"),
  read("apps/web/public/sw.js"),
  read("apps/web/public/sitemap.xml"),
]);

const exactAppRoutes = [...app.matchAll(/<Route\s+path="(\/[^":*]*)"/g)]
  .map((match) => match[1])
  .sort();
assert.ok(
  exactAppRoutes.includes("/"),
  "The root application route is missing.",
);

const nestedRoutes = exactAppRoutes.filter((route) => route !== "/");
const nginxRoutes = nginx
  .match(/location ~ \^\/\(([^)]+)\)\$ \{/)?.[1]
  ?.split("|")
  .map((route) => `/${route}`)
  .sort();
assert.deepEqual(
  nginxRoutes,
  nestedRoutes,
  "Nginx must serve every exact React application route.",
);

const readQuotedRoutes = (source, startPattern) => {
  const block = source.match(startPattern)?.[1];
  assert.ok(block, "The route allowlist block is missing.");
  return [...block.matchAll(/"(\/[^"?]*)"/g)].map((match) => match[1]).sort();
};

assert.deepEqual(
  readQuotedRoutes(worker, /const APP_ROUTES = new Set\(\[([\s\S]*?)\]\);/),
  exactAppRoutes,
  "The static-host worker must serve every exact React application route.",
);
assert.deepEqual(
  readQuotedRoutes(serviceWorker, /const SHELL = \[([\s\S]*?)\];/).filter(
    (route) =>
      !route.startsWith("/assets/") && route !== "/manifest.webmanifest",
  ),
  exactAppRoutes,
  "The PWA shell must precache every exact React application route.",
);

const sitemapRoutes = [
  ...sitemap.matchAll(/<loc>https:\/\/[^/]+(\/[^<]*)<\/loc>/g),
]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  sitemapRoutes,
  exactAppRoutes,
  "The sitemap must list every indexable exact React application route.",
);

console.log(`Web route contract passed for ${exactAppRoutes.length} routes.`);
