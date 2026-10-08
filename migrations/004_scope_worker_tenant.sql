DROP POLICY IF EXISTS whatsapp_outbox_worker ON whatsapp_agrolog_outbox;

CREATE POLICY whatsapp_outbox_worker ON whatsapp_agrolog_outbox
    FOR ALL
    TO whatsapp_worker
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
