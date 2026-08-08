ALTER TABLE shared_scenarios
  ADD COLUMN IF NOT EXISTS candidate_revealed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS first_run_at timestamptz;

INSERT INTO schema_migrations (version)
VALUES ('004_interview_reveal_state')
ON CONFLICT DO NOTHING;
