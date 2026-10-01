ALTER TABLE freight_events
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);

UPDATE freight_events
SET payload = jsonb_set(
  jsonb_set(payload, '{revision}', to_jsonb(revision), true),
  '{scope}',
  to_jsonb('OBSERVED_OFFER'::text),
  true
)
WHERE NOT (payload ? 'revision') OR NOT (payload ? 'scope');

ALTER TABLE freight_events
  ADD CONSTRAINT freight_events_tenant_event_unique UNIQUE (tenant_id, freight_event_id);

CREATE TABLE IF NOT EXISTS freight_event_revisions (
  freight_event_id uuid NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  revision integer NOT NULL CHECK (revision >= 1),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (freight_event_id, revision),
  CONSTRAINT freight_event_revisions_tenant_event_fkey
    FOREIGN KEY (tenant_id, freight_event_id)
    REFERENCES freight_events(tenant_id, freight_event_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_freight_event_revisions_tenant_event
  ON freight_event_revisions(tenant_id, freight_event_id, revision DESC);

INSERT INTO freight_event_revisions(freight_event_id, tenant_id, revision, payload)
SELECT freight_event_id, tenant_id, revision, payload
FROM freight_events
ON CONFLICT (freight_event_id, revision) DO NOTHING;

ALTER TABLE freight_event_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE freight_event_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON freight_event_revisions;
CREATE POLICY tenant_isolation ON freight_event_revisions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
