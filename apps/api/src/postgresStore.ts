import { createHash, randomUUID } from "node:crypto";
import type {
  Architecture,
  RunSubmission,
  Scenario,
  SimulationResult,
} from "@systemforge/contracts";
import { Pool, type PoolClient } from "pg";
import {
  AiUsageBudgetExceededError,
  QueueCapacityError,
  SharedScenarioCapacityError,
  type ControlStore,
  type AiUsageBudgetState,
  type AiUsageReservation,
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
             WHERE version = '008_bound_ai_usage_budget'
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

  async reserveAiUsage(
    reservation: AiUsageReservation,
  ): Promise<AiUsageBudgetState> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(74192014)");
      await client.query(
        "DELETE FROM ai_usage_reservations WHERE created_at < now() - interval '400 days'",
      );
      const usage = await client.query<{
        daily_requests: string;
        monthly_requests: string;
        monthly_reserved_cost_cents: string;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           )::text AS daily_requests,
           count(*) FILTER (
             WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           )::text AS monthly_requests,
           COALESCE(sum(reserved_cost_cents) FILTER (
             WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           ), 0)::text AS monthly_reserved_cost_cents
         FROM ai_usage_reservations`,
      );
      const dailyRequests = Number(usage.rows[0]?.daily_requests ?? 0);
      const monthlyRequests = Number(usage.rows[0]?.monthly_requests ?? 0);
      const monthlyReservedCostCents = Number(
        usage.rows[0]?.monthly_reserved_cost_cents ?? 0,
      );
      const monthlyCostExceeded =
        reservation.maximumMonthlyCostCents !== undefined &&
        monthlyReservedCostCents + reservation.reservedCostCents >
          reservation.maximumMonthlyCostCents;
      if (
        dailyRequests >= reservation.maximumDailyRequests ||
        monthlyRequests >= reservation.maximumMonthlyRequests ||
        monthlyCostExceeded
      ) {
        const retry = await client.query<{ retry_after_seconds: string }>(
          `SELECT CEIL(EXTRACT(EPOCH FROM (
             CASE
               WHEN $1::boolean THEN
                 (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
               ELSE
                 (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
             END - now()
           )))::text AS retry_after_seconds`,
          [dailyRequests >= reservation.maximumDailyRequests],
        );
        throw new AiUsageBudgetExceededError(
          Math.max(1, Number(retry.rows[0]?.retry_after_seconds ?? 1)),
        );
      }
      await client.query(
        `INSERT INTO ai_usage_reservations
           (id, provider_id, model, reserved_cost_cents)
         VALUES ($1, $2, $3, $4)`,
        [
          randomUUID(),
          reservation.providerId,
          reservation.model,
          reservation.reservedCostCents,
        ],
      );
      await client.query("COMMIT");
      return {
        dailyRequests: dailyRequests + 1,
        monthlyRequests: monthlyRequests + 1,
        monthlyReservedCostCents:
          monthlyReservedCostCents + reservation.reservedCostCents,
      };
    } catch (error) {
      await this.#rollback(client);
      throw error;
    } finally {
      client.release();
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

  async getRunSubmission(id: string): Promise<RunSubmission | null> {
    const result = await this.#pool.query<{ submission: RunSubmission }>(
      "SELECT submission FROM simulation_runs WHERE id = $1",
      [id],
    );
    return result.rows[0]?.submission ?? null;
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
      await client.query(
        "DELETE FROM shared_scenarios WHERE expires_at <= now()",
      );
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
