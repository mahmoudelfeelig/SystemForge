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
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(74192012)");
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = file.slice(0, -4);
    const applied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version],
    );
    if (applied.rowCount) {
      process.stdout.write(`skipped ${file}\n`);
      continue;
    }
    const sql = await readFile(join(migrationsDirectory, file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [version],
      );
      await client.query("COMMIT");
      process.stdout.write(`applied ${file}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const legacyTokenColumn = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'shared_scenarios'
         AND column_name = 'host_token'
     ) AS present`,
  );
  if (legacyTokenColumn.rows[0]?.present) {
    await client.query(
      `UPDATE shared_scenarios
       SET host_token_hash = encode(
             sha256(convert_to(host_token::text, 'UTF8')),
             'hex'
           ),
           host_token = NULL
       WHERE host_token IS NOT NULL`,
    );
    process.stdout.write("reconciled legacy interviewer tokens\n");
  }
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock(74192012)");
  } finally {
    client.release();
  }
  await pool.end();
}
