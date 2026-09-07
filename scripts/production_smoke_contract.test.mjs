import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [engineSource, smokeSource] = await Promise.all([
  readFile("packages/sim-core/src/simulate.ts", "utf8"),
  readFile("scripts/production_smoke.mjs", "utf8"),
]);

const engineVersion = engineSource.match(
  /export const ENGINE_VERSION = "([^"]+)";/,
)?.[1];
const smokeVersion = smokeSource.match(
  /const expectedEngineVersion = "([^"]+)";/,
)?.[1];

assert.ok(engineVersion, "The simulation engine must declare ENGINE_VERSION.");
assert.ok(
  smokeVersion,
  "The production smoke test must declare expectedEngineVersion.",
);
assert.equal(
  smokeVersion,
  engineVersion,
  "The production smoke test must submit the current simulation engine version.",
);

console.log(`Production smoke engine contract passed (${engineVersion}).`);
