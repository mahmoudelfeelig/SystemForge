ALTER TABLE shared_scenarios
  ALTER COLUMN expires_at SET DEFAULT now() + interval '30 days';

INSERT INTO schema_migrations (version)
VALUES ('007_bound_shared_scenario_retention')
ON CONFLICT DO NOTHING;
