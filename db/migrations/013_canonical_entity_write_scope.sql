DROP POLICY IF EXISTS canonical_entity_scope ON canonical_entities;
DROP POLICY IF EXISTS canonical_entity_read ON canonical_entities;
DROP POLICY IF EXISTS canonical_entity_insert ON canonical_entities;
DROP POLICY IF EXISTS canonical_entity_update ON canonical_entities;
DROP POLICY IF EXISTS canonical_entity_delete ON canonical_entities;

CREATE POLICY canonical_entity_read ON canonical_entities
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY canonical_entity_insert ON canonical_entities
  FOR INSERT
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY canonical_entity_update ON canonical_entities
  FOR UPDATE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  );

CREATE POLICY canonical_entity_delete ON canonical_entities
  FOR DELETE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)
  );
