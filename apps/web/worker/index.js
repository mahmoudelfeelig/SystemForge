const APP_ROUTES = new Set([
  "/",
  "/lab",
  "/custom",
  "/interview",
  "/replay",
  "/decisions",
]);
const SHARED_SCENARIO_ROUTE = /^\/scenario\/[A-Za-z0-9-]+$/;
const HTML_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const withHtmlSecurityHeaders = (response, { noIndex = false } = {}) => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS))
    headers.set(name, value);
  if (noIndex) headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.delete("Server");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const isHtmlResponse = (response) =>
  response.headers.get("content-type")?.includes("text/html") ?? false;

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    const isSharedScenarioRoute = SHARED_SCENARIO_ROUTE.test(pathname);
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404)
      return isHtmlResponse(response)
        ? withHtmlSecurityHeaders(response, {
            noIndex: isSharedScenarioRoute,
          })
        : response;
    if (!acceptsHtml || !["GET", "HEAD"].includes(request.method))
      return response;

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    const shell = await env.ASSETS.fetch(new Request(indexUrl, request));
    const isAppRoute =
      APP_ROUTES.has(pathname) || isSharedScenarioRoute;
    if (isAppRoute || !shell.ok)
      return withHtmlSecurityHeaders(shell, {
        noIndex: isSharedScenarioRoute,
      });
    return withHtmlSecurityHeaders(
      new Response(request.method === "HEAD" ? null : shell.body, {
        status: 404,
        statusText: "Not Found",
        headers: shell.headers,
      }),
    );
  },
};
