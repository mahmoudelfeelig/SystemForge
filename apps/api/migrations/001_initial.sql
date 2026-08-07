CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shared_scenarios (
  id uuid PRIMARY KEY,
  host_token uuid NOT NULL UNIQUE,
  scenario jsonb NOT NULL,
  architecture jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days'
);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  submission jsonb NOT NULL,
  result jsonb,
  digest text,
  failure_code text,
  failure_message text,
  attempts integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS simulation_runs_queue_idx
  ON simulation_runs (status, created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS shared_scenarios_expiry_idx ON shared_scenarios (expires_at);

INSERT INTO schema_migrations (version) VALUES ('001_initial') ON CONFLICT DO NOTHING;
