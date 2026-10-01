ALTER TABLE canonical_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_entities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS canonical_entity_scope ON canonical_entities;
CREATE POLICY canonical_entity_scope ON canonical_entities
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)
  );
