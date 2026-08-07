import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDirectory, file), "utf8");
    await pool.query(sql);
    process.stdout.write(`applied ${file}\n`);
  }
} finally {
  await pool.end();
}
