import { spawn } from "node:child_process";
import { createServer } from "node:http";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The contract server did not expose a TCP port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

let burstRequests = 0;
const api = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/health/live") {
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/api/health/ready") {
    response.end(JSON.stringify({ status: "ready" }));
    return;
  }
  if (request.url?.startsWith("/api/runs/")) {
    if (request.headers["x-forwarded-for"] === "198.51.100.61") {
      burstRequests += 1;
      if (burstRequests > 4) {
        response.statusCode = 429;
        response.setHeader("retry-after", "3");
        response.end(
          JSON.stringify({
            error: {
              code: "rate_limited",
              message: "Synthetic abusive client is limited.",
              retryAfterSeconds: 3,
              localModeAvailable: true,
            },
          }),
        );
        return;
      }
    }
    response.statusCode = 404;
    response.end(
      JSON.stringify({
        error: { code: "run_not_found", localModeAvailable: true },
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { code: "route_not_found" } }));
});

const web = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.setHeader(
    "cache-control",
    "public, max-age=0, must-revalidate, no-transform",
  );
  response.setHeader(
    "cloudflare-cdn-cache-control",
    "public, max-age=300, stale-while-revalidate=60, stale-if-error=86400",
  );
  response.end("<!doctype html><title>SystemForge</title>");
});

const [apiOrigin, webOrigin] = await Promise.all([listen(api), listen(web)]);

try {
  const child = spawn(process.execPath, ["scripts/overload_smoke.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OVERLOAD_API_ORIGIN: apiOrigin,
      OVERLOAD_WEB_ORIGIN: webOrigin,
      OVERLOAD_BURST_REQUESTS: "24",
      OVERLOAD_WEB_PROBES: "8",
      OVERLOAD_EXPECT_MIN_ADMITTED: "1",
      OVERLOAD_EXPECT_MIN_OVERLOAD: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0)
    throw new Error(
      `Overload smoke contract exited ${exitCode}.\n${stderr || stdout}`,
    );
  const result = JSON.parse(stdout);
  if (
    result.ok !== true ||
    result.admitted !== 4 ||
    result.rateLimited !== 20 ||
    result.capacityLimited !== 0 ||
    result.webProbes !== 8
  ) {
    throw new Error(`Unexpected overload smoke result: ${stdout}`);
  }
  process.stdout.write("Production overload smoke contract passed.\n");
} finally {
  await Promise.all([close(api), close(web)]);
}
