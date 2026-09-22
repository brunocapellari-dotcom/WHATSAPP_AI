ALTER TABLE collectors
  DROP CONSTRAINT IF EXISTS collectors_source_type_check;

ALTER TABLE collectors
  ADD CONSTRAINT collectors_source_type_check
  CHECK (source_type IN ('business','conversation','group','webhook','reconciliation'));
