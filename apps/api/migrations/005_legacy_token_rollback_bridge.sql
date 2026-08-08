ALTER TABLE shared_scenarios
  ADD COLUMN IF NOT EXISTS host_token uuid;

ALTER TABLE shared_scenarios
  ALTER COLUMN host_token DROP NOT NULL;

CREATE OR REPLACE FUNCTION bridge_legacy_interviewer_token()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.host_token_hash IS NULL AND NEW.host_token IS NOT NULL THEN
    NEW.host_token_hash := encode(
      sha256(convert_to(NEW.host_token::text, 'UTF8')),
      'hex'
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS shared_scenarios_legacy_token_bridge
  ON shared_scenarios;

CREATE TRIGGER shared_scenarios_legacy_token_bridge
BEFORE INSERT OR UPDATE OF host_token, host_token_hash
ON shared_scenarios
FOR EACH ROW
EXECUTE FUNCTION bridge_legacy_interviewer_token();

INSERT INTO schema_migrations (version)
VALUES ('005_legacy_token_rollback_bridge')
ON CONFLICT DO NOTHING;
