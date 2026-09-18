ALTER TABLE business_message_runs
  ADD COLUMN IF NOT EXISTS send_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE business_message_runs
  ADD COLUMN IF NOT EXISTS send_started_at timestamptz;

ALTER TABLE business_message_runs
  DROP CONSTRAINT IF EXISTS business_message_runs_state_check;

ALTER TABLE business_message_runs
  ADD CONSTRAINT business_message_runs_state_check
  CHECK (state IN (
    'PROCESSING',
    'PENDING_SEND',
    'SENDING',
    'SENT',
    'FAILED',
    'DELIVERY_UNCERTAIN'
  ));

CREATE INDEX IF NOT EXISTS idx_business_message_runs_sending
  ON business_message_runs(updated_at)
  WHERE state IN ('PROCESSING','SENDING');
