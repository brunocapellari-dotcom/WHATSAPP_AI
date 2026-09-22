CREATE TABLE IF NOT EXISTS approval_requests (
  approval_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  conversation_id uuid NOT NULL,
  source_message_id text NOT NULL,
  request_key text NOT NULL,
  tool_name text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('FINANCIAL','IRREVERSIBLE')),
  input_encrypted bytea NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','EXECUTING','EXECUTED','REJECTED','FAILED','EXPIRED')),
  requested_by text NOT NULL,
  decided_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  execution_result_encrypted bytea,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,request_key),
  FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES conversations(tenant_id,conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON approval_requests(tenant_id,status,requested_at)
  WHERE status IN ('PENDING','EXECUTING');

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval_requests;
CREATE POLICY tenant_isolation ON approval_requests
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
