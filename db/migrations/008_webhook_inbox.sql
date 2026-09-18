CREATE TABLE IF NOT EXISTS webhook_inbox (
  ingress_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  provider text NOT NULL,
  collector_id text NOT NULL REFERENCES collectors(collector_id),
  payload_hash text NOT NULL,
  encrypted_payload bytea NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVED'
    CHECK (state IN ('RECEIVED','PROCESSING','DONE','FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  last_error text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, collector_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_pending
  ON webhook_inbox(next_attempt_at, received_at)
  WHERE state='RECEIVED';

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_stale
  ON webhook_inbox(locked_at)
  WHERE state='PROCESSING';

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_expiry
  ON webhook_inbox(expires_at);

ALTER TABLE webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_inbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook_inbox;
CREATE POLICY tenant_isolation ON webhook_inbox
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
