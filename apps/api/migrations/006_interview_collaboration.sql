ALTER TABLE shared_scenarios
  ADD COLUMN IF NOT EXISTS candidate_notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS candidate_cursor text NOT NULL DEFAULT 'Preparing workspace',
  ADD COLUMN IF NOT EXISTS interviewer_notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS session_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS collaboration_updated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO schema_migrations (version)
VALUES ('006_interview_collaboration')
ON CONFLICT DO NOTHING;
