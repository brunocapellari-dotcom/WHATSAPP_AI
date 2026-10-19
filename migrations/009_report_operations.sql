CREATE TABLE IF NOT EXISTS whatsapp_collector_health_samples (
    tenant_id TEXT NOT NULL,
    sampled_at TIMESTAMPTZ NOT NULL,
    healthy BOOLEAN NOT NULL,
    bridge_ok BOOLEAN NOT NULL,
    provider_ok BOOLEAN NOT NULL,
    last_observation_at TIMESTAMPTZ,
    reason TEXT,
    PRIMARY KEY (tenant_id, sampled_at)
);

CREATE INDEX IF NOT EXISTS whatsapp_collector_health_samples_lookup_idx
    ON whatsapp_collector_health_samples (tenant_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_report_runs (
    tenant_id TEXT NOT NULL,
    run_id UUID NOT NULL,
    cutoff_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED')),
    collector_healthy BOOLEAN NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    error_type TEXT,
    PRIMARY KEY (tenant_id, run_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_report_runs_cutoff_idx
    ON whatsapp_report_runs (tenant_id, cutoff_at, started_at DESC);

GRANT SELECT, INSERT ON whatsapp_collector_health_samples TO whatsapp_reporter;
GRANT SELECT, INSERT, UPDATE ON whatsapp_report_runs TO whatsapp_reporter;

ALTER TABLE whatsapp_collector_health_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_collector_health_samples FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_report_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_collector_health_reporter
    ON whatsapp_collector_health_samples;
CREATE POLICY whatsapp_collector_health_reporter
    ON whatsapp_collector_health_samples
    FOR ALL
    TO whatsapp_reporter
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS whatsapp_report_runs_reporter
    ON whatsapp_report_runs;
CREATE POLICY whatsapp_report_runs_reporter
    ON whatsapp_report_runs
    FOR ALL
    TO whatsapp_reporter
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
