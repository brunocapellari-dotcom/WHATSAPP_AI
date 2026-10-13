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


CREATE OR REPLACE VIEW whatsapp_freight_rate_changes
WITH (security_invoker = true) AS
SELECT
    tenant_id,
    event_id,
    version,
    observed_at,
    payload->>'product' AS product,
    payload #>> '{entities,company,0,raw_value}' AS carrier,
    payload #>> '{entities,company,0,normalized_value}' AS carrier_normalized,
    payload #>> '{entities,loading_point,0,raw_value}' AS loading_point,
    payload #>> '{entities,loading_point,0,normalized_value}' AS loading_point_normalized,
    payload #>> '{origin,raw_value}' AS origin,
    payload #>> '{destination,raw_value}' AS destination,
    (payload #>> '{rate_change,previous_rate}')::numeric AS rate_previous,
    (payload->>'rate')::numeric AS rate_current,
    (payload #>> '{rate_change,delta}')::numeric AS rate_delta,
    (payload #>> '{rate_change,delta_percent}')::numeric AS rate_delta_percent,
    payload #>> '{rate_change,movement}' AS rate_movement,
    payload->>'rate_unit' AS rate_unit,
    (payload #>> '{rate_change,previous_timestamp}')::timestamptz
        AS rate_previous_timestamp,
    (payload #>> '{rate_change,changed_at}')::timestamptz AS rate_changed_at
FROM whatsapp_freight_event_versions
WHERE payload->'rate_change' IS NOT NULL;

GRANT SELECT ON whatsapp_freight_rate_changes TO whatsapp_ingestor;
