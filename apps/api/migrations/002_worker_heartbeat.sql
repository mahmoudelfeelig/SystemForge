CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_last_seen_idx ON worker_heartbeats (last_seen);

INSERT INTO schema_migrations (version) VALUES ('002_worker_heartbeat') ON CONFLICT DO NOTHING;
