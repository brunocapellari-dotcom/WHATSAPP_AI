-- Canonical IBGE municipality reference and validated report observations.
-- Municipality data is populated separately from the official IBGE API.
CREATE TABLE IF NOT EXISTS whatsapp_municipalities (
    ibge_code BIGINT PRIMARY KEY,
    official_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    uf CHAR(2) NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
    source_url TEXT NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (normalized_name, uf)
);

CREATE TABLE IF NOT EXISTS whatsapp_municipality_aliases (
    alias_normalized TEXT NOT NULL,
    ibge_code BIGINT NOT NULL
        REFERENCES whatsapp_municipalities (ibge_code) ON DELETE CASCADE,
    alias_kind TEXT NOT NULL DEFAULT 'OFFICIAL'
        CHECK (alias_kind IN ('OFFICIAL', 'MANUAL')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (alias_normalized, ibge_code)
);

CREATE INDEX IF NOT EXISTS whatsapp_municipality_alias_lookup_idx
    ON whatsapp_municipality_aliases (alias_normalized);

GRANT SELECT ON whatsapp_municipalities TO whatsapp_ingestor, whatsapp_reporter;
GRANT SELECT ON whatsapp_municipality_aliases TO whatsapp_ingestor, whatsapp_reporter;

CREATE TABLE IF NOT EXISTS whatsapp_freight_observations (
    tenant_id TEXT NOT NULL,
    source_observation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_line_number INTEGER CHECK (source_line_number IS NULL OR source_line_number > 0),
    published_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ,
    carrier TEXT NOT NULL,
    product TEXT NOT NULL,
    origin_ibge_code BIGINT NOT NULL REFERENCES whatsapp_municipalities (ibge_code),
    origin_city TEXT NOT NULL,
    origin_uf CHAR(2) NOT NULL,
    destination_ibge_code BIGINT NOT NULL REFERENCES whatsapp_municipalities (ibge_code),
    destination_city TEXT NOT NULL,
    destination_uf CHAR(2) NOT NULL,
    loading_point TEXT NOT NULL,
    rate NUMERIC NOT NULL CHECK (rate >= 0),
    rate_unit TEXT NOT NULL,
    toll_status TEXT NOT NULL DEFAULT 'UNKNOWN'
        CHECK (toll_status IN ('INCLUDED', 'ADDITIONAL', 'UNKNOWN')),
    vehicle_type TEXT,
    vehicle_count INTEGER CHECK (vehicle_count IS NULL OR vehicle_count >= 0),
    offer_reference TEXT,
    cargo_reference TEXT,
    shipment_reference TEXT,
    source_text_sha256 CHAR(64) NOT NULL,
    extraction_confidence NUMERIC NOT NULL
        CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
    validation_status TEXT NOT NULL DEFAULT 'VALIDATED'
        CHECK (validation_status IN ('VALIDATED', 'REVIEW')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source_observation_id)
);

CREATE INDEX IF NOT EXISTS whatsapp_freight_observations_replay_idx
    ON whatsapp_freight_observations (tenant_id, published_at, source_observation_id);
CREATE INDEX IF NOT EXISTS whatsapp_freight_observations_route_idx
    ON whatsapp_freight_observations (
        tenant_id, origin_ibge_code, destination_ibge_code, product
    );

GRANT SELECT, INSERT ON whatsapp_freight_observations TO whatsapp_ingestor;
GRANT SELECT ON whatsapp_freight_observations TO whatsapp_reporter;

ALTER TABLE whatsapp_freight_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_freight_observations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_freight_observations_ingestor
    ON whatsapp_freight_observations;
CREATE POLICY whatsapp_freight_observations_ingestor
    ON whatsapp_freight_observations
    FOR ALL
    TO whatsapp_ingestor
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS whatsapp_freight_observations_reporter
    ON whatsapp_freight_observations;
CREATE POLICY whatsapp_freight_observations_reporter
    ON whatsapp_freight_observations
    FOR SELECT
    TO whatsapp_reporter
    USING (tenant_id = current_setting('app.tenant_id', true));
