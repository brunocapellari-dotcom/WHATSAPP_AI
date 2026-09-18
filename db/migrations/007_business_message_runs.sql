CREATE TABLE IF NOT EXISTS business_message_runs (
  run_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  provider text NOT NULL,
  source_message_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id),
  state text NOT NULL CHECK (state IN ('PROCESSING','PENDING_SEND','SENT','FAILED')),
  result_encrypted bytea,
  reply_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_business_message_runs_state
  ON business_message_runs(tenant_id, state, updated_at DESC);

ALTER TABLE business_message_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_message_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_message_runs;
CREATE POLICY tenant_isolation ON business_message_runs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
