ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS routing_address_encrypted bytea;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_state_updated
  ON conversations(tenant_id, state, updated_at DESC);
