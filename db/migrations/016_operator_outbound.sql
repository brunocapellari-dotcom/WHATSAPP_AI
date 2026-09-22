CREATE TABLE IF NOT EXISTS operator_outbound_messages (
  outbound_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  conversation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  operator_reference text NOT NULL,
  content_hash text NOT NULL,
  text_encrypted bytea NOT NULL,
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','SENDING','SENT','FAILED','DELIVERY_UNCERTAIN')),
  attempts integer NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error text,
  send_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,request_id),
  FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES conversations(tenant_id,conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_outbound_state
  ON operator_outbound_messages(tenant_id,state,updated_at DESC);

ALTER TABLE operator_outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_outbound_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operator_outbound_messages;
CREATE POLICY tenant_isolation ON operator_outbound_messages
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
