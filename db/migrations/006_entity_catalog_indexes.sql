CREATE INDEX IF NOT EXISTS idx_canonical_entities_aliases
  ON canonical_entities USING GIN (aliases);

CREATE INDEX IF NOT EXISTS idx_canonical_entities_scope_type
  ON canonical_entities(tenant_id, entity_type, confidence DESC);
