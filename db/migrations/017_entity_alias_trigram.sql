CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS canonical_entity_aliases (
  entity_id text NOT NULL REFERENCES canonical_entities(entity_id) ON DELETE CASCADE,
  tenant_id text,
  entity_type text NOT NULL CHECK (
    entity_type IN ('CITY','COMPANY','FARM','WAREHOUSE','TERMINAL','CARRIER','PRODUCT')
  ),
  alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, alias)
);

INSERT INTO canonical_entity_aliases(entity_id,tenant_id,entity_type,alias)
SELECT
  entity_id,
  tenant_id,
  entity_type,
  alias
FROM canonical_entities
CROSS JOIN LATERAL unnest(aliases) AS alias
WHERE alias <> ''
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_canonical_entity_aliases_scope_type
  ON canonical_entity_aliases(tenant_id, entity_type);

CREATE INDEX IF NOT EXISTS idx_canonical_entity_aliases_trgm
  ON canonical_entity_aliases USING GIN (alias gin_trgm_ops);

ALTER TABLE canonical_entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_entity_aliases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS canonical_entity_alias_read ON canonical_entity_aliases;
DROP POLICY IF EXISTS canonical_entity_alias_insert ON canonical_entity_aliases;
DROP POLICY IF EXISTS canonical_entity_alias_update ON canonical_entity_aliases;
DROP POLICY IF EXISTS canonical_entity_alias_delete ON canonical_entity_aliases;

CREATE POLICY canonical_entity_alias_read ON canonical_entity_aliases
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY canonical_entity_alias_insert ON canonical_entity_aliases
  FOR INSERT
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY canonical_entity_alias_update ON canonical_entity_aliases
  FOR UPDATE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY canonical_entity_alias_delete ON canonical_entity_aliases
  FOR DELETE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  );

CREATE OR REPLACE FUNCTION sync_canonical_entity_alias_rows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM canonical_entity_aliases
  WHERE entity_id = NEW.entity_id;

  INSERT INTO canonical_entity_aliases(entity_id,tenant_id,entity_type,alias)
  SELECT
    NEW.entity_id,
    NEW.tenant_id,
    NEW.entity_type,
    alias
  FROM unnest(NEW.aliases) AS alias
  WHERE alias <> ''
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_canonical_entity_alias_rows ON canonical_entities;
CREATE TRIGGER trg_sync_canonical_entity_alias_rows
AFTER INSERT OR UPDATE OF tenant_id,entity_type,aliases
ON canonical_entities
FOR EACH ROW
EXECUTE FUNCTION sync_canonical_entity_alias_rows();
