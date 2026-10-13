CREATE TABLE IF NOT EXISTS whatsapp_freight_event_versions (
    tenant_id text NOT NULL,
    event_id uuid NOT NULL,
    version integer NOT NULL CHECK (version >= 1),
    logical_key text NOT NULL,
    payload jsonb NOT NULL,
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, event_id, version)
);

CREATE INDEX IF NOT EXISTS whatsapp_freight_event_versions_lookup_idx
    ON whatsapp_freight_event_versions (tenant_id, event_id, version DESC);

GRANT SELECT, INSERT ON whatsapp_freight_event_versions TO whatsapp_ingestor;

ALTER TABLE whatsapp_freight_event_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_freight_event_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_freight_event_versions_tenant
    ON whatsapp_freight_event_versions;

CREATE POLICY whatsapp_freight_event_versions_tenant
    ON whatsapp_freight_event_versions
    FOR ALL
    TO whatsapp_ingestor
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
