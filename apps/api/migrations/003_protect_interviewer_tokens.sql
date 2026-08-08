ALTER TABLE shared_scenarios
  ADD COLUMN IF NOT EXISTS host_token_hash text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shared_scenarios'
      AND column_name = 'host_token'
  ) THEN
    UPDATE shared_scenarios
    SET host_token_hash = encode(
      sha256(convert_to(host_token::text, 'UTF8')),
      'hex'
    )
    WHERE host_token_hash IS NULL;
  END IF;
END
$$;

ALTER TABLE shared_scenarios
  ALTER COLUMN host_token_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shared_scenarios_host_token_hash_idx
  ON shared_scenarios (host_token_hash);

ALTER TABLE shared_scenarios
  ALTER COLUMN host_token DROP NOT NULL;

-- Keep the nullable compatibility column through the first release so the
-- previous image can still start if an application rollback is required.
-- Current images never write raw tokens, and the migrator clears any values
-- written by a temporary rollback after hashing them.
UPDATE shared_scenarios
SET host_token = NULL
WHERE host_token IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('003_protect_interviewer_tokens')
ON CONFLICT DO NOTHING;
