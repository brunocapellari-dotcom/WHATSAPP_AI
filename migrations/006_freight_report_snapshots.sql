-- Durable freight-report snapshots. Apply after core tenant tables and RLS.
-- One immutable logical closure per tenant, scheduled local cutoff and report kind.
CREATE TABLE IF NOT EXISTS whatsapp_freight_report_snapshots (
    tenant_id TEXT NOT NULL,
    cutoff_at TIMESTAMPTZ NOT NULL,
    report_kind TEXT NOT NULL CHECK (report_kind IN ('FULL', 'SIMPLIFIED')),
    status TEXT NOT NULL CHECK (status IN ('DRAFT', 'READY', 'PUBLISHED', 'FAILED')),
    payload JSONB NOT NULL,
    rendered_markdown TEXT,
    content_sha256 CHAR(64),
    collector_healthy BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, cutoff_at, report_kind)
);

ALTER TABLE whatsapp_freight_report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_freight_report_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_report_tenant_policy ON whatsapp_freight_report_snapshots;
CREATE POLICY whatsapp_report_tenant_policy ON whatsapp_freight_report_snapshots
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE INDEX IF NOT EXISTS idx_whatsapp_report_snapshot_status
    ON whatsapp_freight_report_snapshots (tenant_id, status, cutoff_at);
