import { createHash, randomUUID } from "node:crypto";
import type {
  Architecture,
  RunSubmission,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";
import { Pool, type PoolClient } from "pg";
import {
  QueueCapacityError,
  SharedScenarioCapacityError,
  type ControlStore,
  type InterviewCollaborationPatch,
  type RunRecord,
  type SharedScenarioRecord,
  type SharedScenarioView,
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
  host_token_hash: string;
  scenario: Scenario;
  architecture: Architecture;
  candidate_revealed: boolean;
  first_run_at: Date | null;
  candidate_notes: string;
  candidate_cursor: string;
  interviewer_notes: string;
  session_started_at: Date | null;
  collaboration_updated_at: Date;
}

const scenarioColumns = `id, host_token_hash, scenario, architecture,
  candidate_revealed, first_run_at, candidate_notes, candidate_cursor,
  interviewer_notes, session_started_at, collaboration_updated_at`;

const hashHostToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

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
      const result = await this.#pool.query<{ ready: boolean }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM schema_migrations
           WHERE version = '006_interview_collaboration'
           )
           AND EXISTS (
             SELECT 1 FROM worker_heartbeats
             WHERE last_seen > now() - interval '20 seconds'
           ) AS ready`,
      );
      return result.rows[0]?.ready ?? false;
    } catch {
      return false;
    }
  }

  async queueRun(
    submission: RunSubmission,
    maximumQueued: number,
    maximumStored: number,
  ): Promise<RunRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(74192011)");
      const count = await client.query<{ active: string; total: string }>(
        `SELECT
           count(*) FILTER (WHERE status IN ('queued', 'running'))::text AS active,
           count(*)::text AS total
         FROM simulation_runs`,
      );
      if (Number(count.rows[0]?.active ?? 0) >= maximumQueued)
        throw new QueueCapacityError();
      const requiredEvictions = Math.max(
        0,
        Number(count.rows[0]?.total ?? 0) - maximumStored + 1,
      );
      if (requiredEvictions > 0) {
        const evicted = await client.query(
          `DELETE FROM simulation_runs
           WHERE id IN (
             SELECT id
             FROM simulation_runs
             WHERE status IN ('completed', 'failed')
             ORDER BY completed_at ASC NULLS LAST, created_at ASC
             LIMIT $1
           )`,
          [requiredEvictions],
        );
        if ((evicted.rowCount ?? 0) < requiredEvictions)
          throw new QueueCapacityError();
      }
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
    maximumShared: number,
  ): Promise<SharedScenarioRecord> {
    const id = randomUUID();
    const hostToken = randomUUID();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(74192013)");
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM shared_scenarios WHERE expires_at > now()",
      );
      if (Number(count.rows[0]?.count ?? 0) >= maximumShared)
        throw new SharedScenarioCapacityError();
      await client.query(
        "INSERT INTO shared_scenarios (id, host_token_hash, scenario, architecture) VALUES ($1, $2, $3::jsonb, $4::jsonb)",
        [
          id,
          hashHostToken(hostToken),
          JSON.stringify(scenario),
          JSON.stringify(architecture),
        ],
      );
      await client.query("COMMIT");
      return { id, hostToken, scenario, architecture };
    } catch (error) {
      await this.#rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getScenario(
    id: string,
    hostToken?: string,
  ): Promise<SharedScenarioView | null> {
    const result = await this.#pool.query<ScenarioRow>(
      `SELECT ${scenarioColumns}
       FROM shared_scenarios WHERE id = $1 AND expires_at > now()`,
      [id],
    );
    const row = result.rows[0];
    return row ? this.#mapScenario(row, hostToken) : null;
  }

  async markScenarioRun(id: string): Promise<SharedScenarioView | null> {
    const result = await this.#pool.query<ScenarioRow>(
      `UPDATE shared_scenarios
       SET first_run_at = COALESCE(first_run_at, now())
       WHERE id = $1 AND expires_at > now()
       RETURNING ${scenarioColumns}`,
      [id],
    );
    const row = result.rows[0];
    return row ? this.#mapScenario(row) : null;
  }

  async setScenarioReveal(
    id: string,
    hostToken: string,
    revealed: boolean,
  ): Promise<SharedScenarioView | null> {
    const result = await this.#pool.query<ScenarioRow>(
      `UPDATE shared_scenarios
       SET candidate_revealed = $3
       WHERE id = $1
         AND host_token_hash = $2
         AND expires_at > now()
       RETURNING ${scenarioColumns}`,
      [id, hashHostToken(hostToken), revealed],
    );
    const row = result.rows[0];
    return row ? this.#mapScenario(row, hostToken) : null;
  }

  async updateScenarioCollaboration(
    id: string,
    hostToken: string | undefined,
    patch: InterviewCollaborationPatch,
  ): Promise<SharedScenarioView | null> {
    const current = await this.getScenario(id, hostToken);
    if (!current) return null;
    const modifiesPrivateState =
      patch.interviewerNotes !== undefined || patch.clockAction !== undefined;
    if (modifiesPrivateState && !current.isHost) return null;
    const result = await this.#pool.query<ScenarioRow>(
      `UPDATE shared_scenarios
       SET candidate_notes = COALESCE($3, candidate_notes),
           candidate_cursor = COALESCE($4, candidate_cursor),
           interviewer_notes = COALESCE($5, interviewer_notes),
           session_started_at = CASE
             WHEN $6 = 'start' THEN now()
             WHEN $6 = 'reset' THEN NULL
             ELSE session_started_at
           END,
           collaboration_updated_at = now()
       WHERE id = $1
         AND expires_at > now()
         AND ($2::text IS NULL OR host_token_hash = $2)
       RETURNING ${scenarioColumns}`,
      [
        id,
        modifiesPrivateState && hostToken ? hashHostToken(hostToken) : null,
        patch.candidateNotes ?? null,
        patch.candidateCursor ?? null,
        patch.interviewerNotes ?? null,
        patch.clockAction ?? null,
      ],
    );
    const row = result.rows[0];
    return row ? this.#mapScenario(row, hostToken) : null;
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

  #mapScenario(row: ScenarioRow, hostToken?: string): SharedScenarioView {
    const policy = row.scenario.interview?.revealPolicy;
    const revealed =
      row.scenario.mode === "interview" &&
      ((policy === "after-run" && row.first_run_at !== null) ||
        (policy === "interviewer-controlled" && row.candidate_revealed));
    const isHost = hostToken
      ? hashHostToken(hostToken) === row.host_token_hash
      : false;
    return {
      id: row.id,
      scenario: row.scenario,
      architecture: row.architecture,
      isHost,
      revealState: revealed ? "revealed" : "hidden",
      collaboration: {
        candidateNotes: row.candidate_notes,
        candidateCursor: row.candidate_cursor,
        startedAt: row.session_started_at?.toISOString() ?? null,
        updatedAt: row.collaboration_updated_at.toISOString(),
        ...(isHost ? { interviewerNotes: row.interviewer_notes } : {}),
      },
    };
  }
}
