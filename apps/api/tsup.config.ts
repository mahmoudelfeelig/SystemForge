import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@systemforge/contracts"],
});
