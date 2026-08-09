#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");
const clientAssets = path.join(dist, "client", "assets");
const stableAssetVersions = new Map([["blueprint-grid.webp", "4d82d0b0"]]);

for (const file of [index, worker, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "index.js"));
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

const offlineAssets = readdirSync(clientAssets)
  .filter(
    (name) =>
      name.endsWith(".js") ||
      name.endsWith(".css") ||
      name.endsWith(".webp") ||
      (/-latin-\d+-normal-/.test(name) && name.endsWith(".woff2")),
  )
  .sort()
  .map((name) => {
    const version = stableAssetVersions.get(name);
    return `/assets/${name}${version ? `?v=${version}` : ""}`;
  });
writeFileSync(
  path.join(dist, "client", "asset-precache.json"),
  `${JSON.stringify({ schemaVersion: 1, assets: offlineAssets }, null, 2)}\n`,
);

console.log(
  `Prepared Sites build: server adapter, hosting config, and ${offlineAssets.length} offline assets`,
);
