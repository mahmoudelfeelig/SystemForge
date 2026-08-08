import type { RunSubmission, SimulationResult } from "@systemforge/contracts";
import { Pool } from "pg";

export interface ClaimedJob {
  id: string;
  submission: RunSubmission;
}

interface JobRow {
  id: string;
  submission: RunSubmission;
}

export class JobStore {
  readonly #pool: Pool;

  constructor(databaseUrl: string, maximumConnections: number) {
    this.#pool = new Pool({
      connectionString: databaseUrl,
      max: maximumConnections,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 20_000,
    });
  }

  async ready(): Promise<boolean> {
    try {
      const result = await this.#pool.query<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations
           WHERE version = '005_legacy_token_rollback_bridge'
         ) AS ready`,
      );
      return result.rows[0]?.ready ?? false;
    } catch {
      return false;
    }
  }

  async claim(leaseSeconds: number): Promise<ClaimedJob | null> {
    const result = await this.#pool.query<JobRow>(
      `WITH candidate AS (
         SELECT id
         FROM simulation_runs
         WHERE (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
           AND attempts < 3
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE simulation_runs AS run
       SET status = 'running',
           attempts = attempts + 1,
           started_at = COALESCE(started_at, now()),
           lease_expires_at = now() + ($1::text || ' seconds')::interval
       FROM candidate
       WHERE run.id = candidate.id
       RETURNING run.id, run.submission`,
      [leaseSeconds],
    );
    return result.rows[0] ?? null;
  }

  async maintain(retentionDays: number): Promise<number> {
    const exhausted = await this.#pool.query(
      `UPDATE simulation_runs
       SET status = 'failed',
           failure_code = 'lease_exhausted',
           failure_message = 'The canonical worker lease expired after three attempts.',
           completed_at = now(),
           lease_expires_at = NULL
       WHERE status = 'running'
         AND attempts >= 3
         AND lease_expires_at < now()`,
    );
    await this.#pool.query(
      "DELETE FROM simulation_runs WHERE completed_at < now() - ($1::text || ' days')::interval",
      [retentionDays],
    );
    await this.#pool.query(
      "DELETE FROM shared_scenarios WHERE expires_at < now()",
      [],
    );
    await this.#pool.query(
      "DELETE FROM worker_heartbeats WHERE last_seen < now() - interval '1 day'",
      [],
    );
    return exhausted.rowCount ?? 0;
  }

  async complete(
    id: string,
    result: SimulationResult,
    digest: string,
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE simulation_runs
       SET status = 'completed', result = $2::jsonb, digest = $3, completed_at = now(), lease_expires_at = NULL
       WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify(result), digest],
    );
  }

  async fail(id: string, code: string, message: string): Promise<void> {
    await this.#pool.query(
      `UPDATE simulation_runs
       SET status = 'failed', failure_code = $2, failure_message = $3, completed_at = now(), lease_expires_at = NULL
       WHERE id = $1 AND status = 'running'`,
      [id, code.slice(0, 80), message.slice(0, 500)],
    );
  }

  async heartbeat(workerId: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO worker_heartbeats (worker_id, last_seen)
       VALUES ($1, now())
       ON CONFLICT (worker_id) DO UPDATE SET last_seen = excluded.last_seen`,
      [workerId],
    );
  }

  async removeHeartbeat(workerId: string): Promise<void> {
    await this.#pool.query(
      "DELETE FROM worker_heartbeats WHERE worker_id = $1",
      [workerId],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
