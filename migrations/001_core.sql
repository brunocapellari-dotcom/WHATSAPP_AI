CREATE TABLE IF NOT EXISTS whatsapp_raw_events (
    tenant_id text NOT NULL,
    provider text NOT NULL,
    source_event_id text NOT NULL,
    source text NOT NULL,
    message_timestamp timestamptz NOT NULL,
    ingestion_timestamp timestamptz NOT NULL DEFAULT now(),
    payload_hash text NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    attachment_metadata jsonb NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (tenant_id, provider, source_event_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_freight_events (
    tenant_id text NOT NULL,
    logical_key text NOT NULL,
    event_id uuid NOT NULL,
    version integer NOT NULL CHECK (version >= 1),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, logical_key),
    UNIQUE (event_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_processed_source_events (
    tenant_id text NOT NULL,
    provider text NOT NULL,
    source_event_id text NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, provider, source_event_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_agrolog_outbox (
    outbox_id bigserial PRIMARY KEY,
    tenant_id text NOT NULL,
    event_id uuid NOT NULL,
    event_version integer NOT NULL CHECK (event_version >= 1),
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'DEAD')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    processing_started_at timestamptz,
    dead_at timestamptz,
    last_error text,
    UNIQUE (event_id, event_version)
);

CREATE INDEX IF NOT EXISTS whatsapp_freight_events_tenant_updated_idx
    ON whatsapp_freight_events (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_outbox_dispatch_idx
    ON whatsapp_agrolog_outbox (status, next_attempt_at, outbox_id);
