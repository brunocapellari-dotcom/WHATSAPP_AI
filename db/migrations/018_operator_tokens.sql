CREATE TABLE IF NOT EXISTS operator_tokens (
  token_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  operator_reference text NOT NULL,
  role text NOT NULL CHECK (role IN ('OPERATOR','SUPERVISOR','ADMIN')),
  label text,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_tokens_active
  ON operator_tokens(tenant_id,operator_reference,role)
  WHERE revoked_at IS NULL;

ALTER TABLE operator_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operator_tokens;
CREATE POLICY tenant_isolation ON operator_tokens
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
