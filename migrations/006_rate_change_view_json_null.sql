-- 005 filtered with `payload->'rate_change' IS NOT NULL`, which is also true for
-- JSON null (pydantic serializes rate_change=None as `null`). Initial versions
-- without a previous rate therefore leaked into the rate-change view as rows
-- with NULL previous/delta/movement. Only real rate_change objects qualify.

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
WHERE jsonb_typeof(payload->'rate_change') = 'object';

GRANT SELECT ON whatsapp_freight_rate_changes TO whatsapp_ingestor;
