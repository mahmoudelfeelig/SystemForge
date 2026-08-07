import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/canonicalThread.ts", "src/healthcheck.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@systemforge/contracts", "@systemforge/sim-core"],
});
