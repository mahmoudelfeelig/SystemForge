import { randomUUID } from "node:crypto";
import type {
  Architecture,
  RunSubmission,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";
import { Pool, type PoolClient } from "pg";
import {
  QueueCapacityError,
  type ControlStore,
  type RunRecord,
  type SharedScenarioRecord,
} from "./store";

interface RunRow {
  id: string;
  status: RunRecord["status"];
  result: SimulationResult | null;
  digest: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
}

interface ScenarioRow {
  id: string;
  host_token: string;
  scenario: Scenario;
  architecture: Architecture;
}

const mapRun = (row: RunRow): RunRecord => ({
  id: row.id,
  status: row.status,
  ...(row.result ? { result: row.result } : {}),
  ...(row.digest ? { digest: row.digest } : {}),
  ...(row.failure_code ? { failureCode: row.failure_code } : {}),
  ...(row.failure_message ? { failureMessage: row.failure_message } : {}),
  createdAt: row.created_at.toISOString(),
});

export class PostgresControlStore implements ControlStore {
  readonly #pool: Pool;

  constructor(databaseUrl: string) {
    this.#pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 20_000,
    });
  }

  async ready(): Promise<boolean> {
    try {
      await this.#pool.query(
        "SELECT 1 FROM schema_migrations WHERE version = '001_initial'",
      );
      return true;
    } catch {
      return false;
    }
  }

  async queueRun(
    submission: RunSubmission,
    maximumQueued: number,
  ): Promise<RunRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(74192011)");
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM simulation_runs WHERE status IN ('queued', 'running')",
      );
      if (Number(count.rows[0]?.count ?? 0) >= maximumQueued)
        throw new QueueCapacityError();
      const id = randomUUID();
      const inserted = await client.query<RunRow>(
        "INSERT INTO simulation_runs (id, status, submission) VALUES ($1, 'queued', $2::jsonb) RETURNING id, status, result, digest, failure_code, failure_message, created_at",
        [id, JSON.stringify(submission)],
      );
      await client.query("COMMIT");
      const row = inserted.rows[0];
      if (!row) throw new Error("The queued run could not be read back.");
      return mapRun(row);
    } catch (error) {
      await this.#rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const result = await this.#pool.query<RunRow>(
      "SELECT id, status, result, digest, failure_code, failure_message, created_at FROM simulation_runs WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async shareScenario(
    scenario: Scenario,
    architecture: Architecture,
  ): Promise<SharedScenarioRecord> {
    const id = randomUUID();
    const hostToken = randomUUID();
    await this.#pool.query(
      "INSERT INTO shared_scenarios (id, host_token, scenario, architecture) VALUES ($1, $2, $3::jsonb, $4::jsonb)",
      [id, hostToken, JSON.stringify(scenario), JSON.stringify(architecture)],
    );
    return { id, hostToken, scenario, architecture };
  }

  async getScenario(id: string): Promise<SharedScenarioRecord | null> {
    const result = await this.#pool.query<ScenarioRow>(
      "SELECT id, host_token, scenario, architecture FROM shared_scenarios WHERE id = $1 AND expires_at > now()",
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          hostToken: row.host_token,
          scenario: row.scenario,
          architecture: row.architecture,
        }
      : null;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #rollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original transaction error remains the actionable failure.
    }
  }
}
