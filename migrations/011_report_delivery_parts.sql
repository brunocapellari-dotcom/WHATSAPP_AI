-- Durable, per-attachment acknowledgments. Unknown external send outcome is NEVER retried.
-- This lets a worker resume unsent parts without replaying acknowledged messages.
ALTER TABLE whatsapp_report_delivery_outbox
    ADD CONSTRAINT whatsapp_report_delivery_tenant_id_unique
    UNIQUE (tenant_id, delivery_id);

CREATE TABLE IF NOT EXISTS whatsapp_report_delivery_parts (
    tenant_id TEXT NOT NULL,
    delivery_id BIGINT NOT NULL,
    part_kind TEXT NOT NULL CHECK (part_kind IN ('TEXT', 'PDF', 'XLSX')),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'CLAIMED', 'ACKNOWLEDGED', 'REVIEW_REQUIRED')),
    claimed_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    provider_message_id TEXT,
    PRIMARY KEY (tenant_id, delivery_id, part_kind),
    FOREIGN KEY (tenant_id, delivery_id)
        REFERENCES whatsapp_report_delivery_outbox (tenant_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_report_delivery_parts_pending_idx
    ON whatsapp_report_delivery_parts (tenant_id, status, delivery_id);
GRANT SELECT, INSERT, UPDATE ON whatsapp_report_delivery_parts TO whatsapp_reporter;
ALTER TABLE whatsapp_report_delivery_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_report_delivery_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_report_delivery_parts_tenant
    ON whatsapp_report_delivery_parts
    FOR ALL TO whatsapp_reporter
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
