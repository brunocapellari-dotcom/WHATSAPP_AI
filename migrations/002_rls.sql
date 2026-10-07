DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsapp_ingestor') THEN
        CREATE ROLE whatsapp_ingestor NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsapp_worker') THEN
        CREATE ROLE whatsapp_worker NOLOGIN;
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON whatsapp_raw_events TO whatsapp_ingestor;
GRANT SELECT, INSERT, UPDATE ON whatsapp_freight_events TO whatsapp_ingestor;
GRANT SELECT, INSERT ON whatsapp_processed_source_events TO whatsapp_ingestor;
GRANT SELECT, INSERT ON whatsapp_agrolog_outbox TO whatsapp_ingestor;

GRANT SELECT, UPDATE ON whatsapp_agrolog_outbox TO whatsapp_worker;
GRANT USAGE, SELECT ON SEQUENCE whatsapp_agrolog_outbox_outbox_id_seq TO whatsapp_ingestor;

ALTER TABLE whatsapp_raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_raw_events FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_freight_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_freight_events FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_processed_source_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_processed_source_events FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_agrolog_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_agrolog_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_raw_events_tenant ON whatsapp_raw_events;
CREATE POLICY whatsapp_raw_events_tenant ON whatsapp_raw_events
    FOR ALL
    TO whatsapp_ingestor
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS whatsapp_freight_events_tenant ON whatsapp_freight_events;
CREATE POLICY whatsapp_freight_events_tenant ON whatsapp_freight_events
    FOR ALL
    TO whatsapp_ingestor
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS whatsapp_processed_events_tenant ON whatsapp_processed_source_events;
CREATE POLICY whatsapp_processed_events_tenant ON whatsapp_processed_source_events
    FOR ALL
    TO whatsapp_ingestor
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS whatsapp_outbox_tenant ON whatsapp_agrolog_outbox;
CREATE POLICY whatsapp_outbox_tenant ON whatsapp_agrolog_outbox
    FOR ALL
    TO whatsapp_ingestor
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS whatsapp_outbox_worker ON whatsapp_agrolog_outbox;
CREATE POLICY whatsapp_outbox_worker ON whatsapp_agrolog_outbox
    FOR ALL
    TO whatsapp_worker
    USING (true)
    WITH CHECK (true);
