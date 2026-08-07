import { hostname } from "node:os";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) process.exit(1);

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 2_000,
});

try {
  const result = await pool.query<{ healthy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM worker_heartbeats
       WHERE worker_id = $1 AND last_seen > now() - interval '20 seconds'
     ) AS healthy`,
    [hostname()],
  );
  if (!result.rows[0]?.healthy) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
