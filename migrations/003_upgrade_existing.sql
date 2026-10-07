ALTER TABLE whatsapp_agrolog_outbox
    ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

ALTER TABLE whatsapp_agrolog_outbox
    ADD COLUMN IF NOT EXISTS dead_at timestamptz;

CREATE INDEX IF NOT EXISTS whatsapp_freight_events_tenant_updated_idx
    ON whatsapp_freight_events (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS whatsapp_outbox_dispatch_idx
    ON whatsapp_agrolog_outbox (status, next_attempt_at, outbox_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'whatsapp_freight_events_version_check'
    ) THEN
        ALTER TABLE whatsapp_freight_events
            ADD CONSTRAINT whatsapp_freight_events_version_check
            CHECK (version >= 1) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'whatsapp_agrolog_outbox_event_version_check'
    ) THEN
        ALTER TABLE whatsapp_agrolog_outbox
            ADD CONSTRAINT whatsapp_agrolog_outbox_event_version_check
            CHECK (event_version >= 1) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'whatsapp_agrolog_outbox_attempts_check'
    ) THEN
        ALTER TABLE whatsapp_agrolog_outbox
            ADD CONSTRAINT whatsapp_agrolog_outbox_attempts_check
            CHECK (attempts >= 0) NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'whatsapp_agrolog_outbox_status_check'
    ) THEN
        ALTER TABLE whatsapp_agrolog_outbox
            ADD CONSTRAINT whatsapp_agrolog_outbox_status_check
            CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'DEAD')) NOT VALID;
    END IF;
END
$$;

ALTER TABLE whatsapp_freight_events
    VALIDATE CONSTRAINT whatsapp_freight_events_version_check;

ALTER TABLE whatsapp_agrolog_outbox
    VALIDATE CONSTRAINT whatsapp_agrolog_outbox_event_version_check;

ALTER TABLE whatsapp_agrolog_outbox
    VALIDATE CONSTRAINT whatsapp_agrolog_outbox_attempts_check;

ALTER TABLE whatsapp_agrolog_outbox
    VALIDATE CONSTRAINT whatsapp_agrolog_outbox_status_check;
