-- Tenant-scoped report delivery queue. No recipients are created automatically.
-- A transport adapter may claim rows only after explicit recipient authorization.
CREATE TABLE IF NOT EXISTS whatsapp_report_recipients (
    tenant_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    destination TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('EMAIL', 'WHATSAPP')),
    authorized BOOLEAN NOT NULL DEFAULT FALSE,
    authorized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, recipient_id),
    CHECK (NOT authorized OR authorized_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS whatsapp_report_delivery_outbox (
    delivery_id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    cutoff_at TIMESTAMPTZ NOT NULL,
    report_kind TEXT NOT NULL CHECK (report_kind IN ('FULL', 'SIMPLIFIED')),
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'DEAD')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cutoff_at, report_kind, recipient_id),
    FOREIGN KEY (tenant_id, cutoff_at, report_kind)
        REFERENCES whatsapp_freight_report_snapshots (tenant_id, cutoff_at, report_kind),
    FOREIGN KEY (tenant_id, recipient_id)
        REFERENCES whatsapp_report_recipients (tenant_id, recipient_id)
);

ALTER TABLE whatsapp_report_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_report_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_report_delivery_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_report_delivery_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_report_recipients_tenant ON whatsapp_report_recipients;
CREATE POLICY whatsapp_report_recipients_tenant ON whatsapp_report_recipients
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS whatsapp_report_delivery_tenant ON whatsapp_report_delivery_outbox;
CREATE POLICY whatsapp_report_delivery_tenant ON whatsapp_report_delivery_outbox
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE INDEX IF NOT EXISTS idx_whatsapp_report_delivery_pending
    ON whatsapp_report_delivery_outbox (tenant_id, status, next_attempt_at);
