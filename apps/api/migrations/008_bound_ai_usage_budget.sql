CREATE TABLE ai_usage_reservations (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  model text NOT NULL,
  reserved_cost_cents integer NOT NULL CHECK (reserved_cost_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_usage_reservations_created_at_idx
  ON ai_usage_reservations (created_at);
