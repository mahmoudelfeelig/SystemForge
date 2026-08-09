import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

const expectedHtmlSecurityHeaders = {
  "content-security-policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const assertHtmlSecurityHeaders = (response) => {
  for (const [name, value] of Object.entries(expectedHtmlSecurityHeaders))
    assert.equal(response.headers.get(name), value, name);
};

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/assets/app.js"),
    {
      ASSETS: {
        fetch: async (request) => {
          calls.push(new URL(request.url).pathname);
          return new Response("asset", { status: 200 });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
  assert.equal(response.headers.has("content-security-policy"), false);
});

test("adds the production HTML security policy to an existing shell", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () =>
          new Response("app", {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              server: "asset-host",
            },
          }),
      },
    },
  );

  assert.equal(response.status, 200);
  assertHtmlSecurityHeaders(response);
  assert.equal(response.headers.has("server"), false);
});

test("serves the app shell with a real 404 for an unknown route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(
            url.pathname === "/index.html" ? "app" : "missing",
            {
              status: url.pathname === "/index.html" ? 200 : 404,
            },
          );
        },
      },
    },
  );

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "app");
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
  assertHtmlSecurityHeaders(response);
});

test("falls back to index.html for known client routes", async () => {
  for (const route of ["/lab", "/replay"]) {
    const calls = [];
    const response = await worker.fetch(
      new Request(`https://example.test${route}`, {
        headers: { accept: "text/html" },
      }),
      {
        ASSETS: {
          fetch: async (request) => {
            const pathname = new URL(request.url).pathname;
            calls.push(pathname);
            return new Response(
              pathname === "/index.html" ? "app" : "missing",
              {
                status: pathname === "/index.html" ? 200 : 404,
              },
            );
          },
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app");
    assert.deepEqual(calls, [route, "/index.html"]);
    assertHtmlSecurityHeaders(response);
  }
});

test("keeps shared scenario routes out of non-JavaScript search indexes", async () => {
  const route = "/scenario/8b109e42-88e0-4c5d-8179-7e4104d5d836";
  const response = await worker.fetch(
    new Request(`https://example.test${route}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) =>
          new Response(
            new URL(request.url).pathname === "/index.html" ? "app" : "missing",
            {
              status:
                new URL(request.url).pathname === "/index.html" ? 200 : 404,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
  );
  assertHtmlSecurityHeaders(response);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", {
      headers: { accept: "application/json" },
    }),
    new Request("https://example.test/flow", {
      method: "POST",
      headers: { accept: "text/html" },
    }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
  const precache = JSON.parse(
    await readFile(
      new URL("../dist/client/asset-precache.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    precache.assets.some((asset) => /simulation\.worker-.*\.js$/.test(asset)),
    "simulation worker must be available to a cold offline Lab",
  );
  assert.ok(
    precache.assets.some((asset) => /solver\.worker-.*\.js$/.test(asset)),
    "solver worker must be available to a cold offline Lab",
  );
  assert.ok(
    precache.assets.some((asset) => /share\.worker-.*\.js$/.test(asset)),
    "local-share decoder must be available to a cold offline Lab",
  );
  assert.ok(
    precache.assets.some((asset) => /ReplayPage-.*\.js$/.test(asset)),
    "lazy replay workspace must be available to a warm offline session",
  );
  assert.ok(
    precache.assets.some((asset) =>
      /replayComparison\.worker-.*\.js$/.test(asset),
    ),
    "replay comparison worker must be available to a warm offline session",
  );
  assert.ok(
    precache.assets.includes("/assets/blueprint-grid.webp?v=4d82d0b0"),
    "stable public assets must use content-versioned cache keys",
  );
  assert.equal(
    precache.assets.includes("/assets/blueprint-grid.webp"),
    false,
    "the negatively cached unversioned blueprint key must not be precached",
  );
  assert.equal(
    precache.assets.some((asset) => asset.includes("-latin-ext-")),
    false,
    "cold offline install should not duplicate Latin fonts with Latin-ext subsets",
  );
});
