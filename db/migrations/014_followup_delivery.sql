ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS message_text text;

ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS lock_token uuid;

ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS sent_message_id text;

ALTER TABLE followups
  ADD COLUMN IF NOT EXISTS last_error text;

UPDATE followups
SET next_attempt_at=COALESCE(next_attempt_at,due_at)
WHERE next_attempt_at IS NULL;

ALTER TABLE followups
  ALTER COLUMN next_attempt_at SET DEFAULT now();

ALTER TABLE followups
  ALTER COLUMN next_attempt_at SET NOT NULL;

ALTER TABLE followups
  DROP CONSTRAINT IF EXISTS followups_status_check;

ALTER TABLE followups
  ADD CONSTRAINT followups_status_check
  CHECK (status IN ('PENDING','SENDING','DONE','CANCELLED','FAILED','DELIVERY_UNCERTAIN'));

ALTER TABLE followups
  DROP CONSTRAINT IF EXISTS followups_conversation_id_fkey;

ALTER TABLE followups
  ADD CONSTRAINT followups_tenant_conversation_fkey
  FOREIGN KEY (tenant_id,conversation_id)
  REFERENCES conversations(tenant_id,conversation_id);

CREATE INDEX IF NOT EXISTS idx_followups_delivery_due
  ON followups(next_attempt_at,due_at)
  WHERE status='PENDING';

CREATE INDEX IF NOT EXISTS idx_followups_delivery_lock
  ON followups(locked_at)
  WHERE status='PENDING';
