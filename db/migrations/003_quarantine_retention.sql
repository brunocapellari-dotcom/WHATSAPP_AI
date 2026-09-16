CREATE INDEX IF NOT EXISTS idx_quarantine_expires_all
  ON quarantine_messages(expires_at);
