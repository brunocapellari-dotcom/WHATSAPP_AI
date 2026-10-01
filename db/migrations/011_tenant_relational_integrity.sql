-- Composite tenant foreign keys prevent accidental cross-tenant references even
-- when application code contains a scoping bug. RLS remains a separate layer.

ALTER TABLE collectors
  ADD CONSTRAINT collectors_tenant_collector_unique UNIQUE (tenant_id, collector_id);

ALTER TABLE raw_messages
  ADD CONSTRAINT raw_messages_tenant_event_unique UNIQUE (tenant_id, event_id);

ALTER TABLE conversations
  ADD CONSTRAINT conversations_tenant_conversation_unique UNIQUE (tenant_id, conversation_id);

ALTER TABLE customers
  ADD CONSTRAINT customers_tenant_customer_unique UNIQUE (tenant_id, customer_id);

ALTER TABLE quotes
  ADD CONSTRAINT quotes_tenant_quote_unique UNIQUE (tenant_id, quote_id);

ALTER TABLE orders
  ADD CONSTRAINT orders_tenant_order_unique UNIQUE (tenant_id, order_id);

ALTER TABLE freight_observations
  DROP CONSTRAINT IF EXISTS freight_observations_event_id_fkey;
ALTER TABLE freight_observations
  ADD CONSTRAINT freight_observations_tenant_event_fkey
  FOREIGN KEY (tenant_id, event_id)
  REFERENCES raw_messages(tenant_id, event_id);

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_customer_id_fkey;
ALTER TABLE quotes
  ADD CONSTRAINT quotes_tenant_customer_fkey
  FOREIGN KEY (tenant_id, customer_id)
  REFERENCES customers(tenant_id, customer_id);

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_customer_id_fkey;
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_quote_id_fkey;
ALTER TABLE orders
  ADD CONSTRAINT orders_tenant_customer_fkey
  FOREIGN KEY (tenant_id, customer_id)
  REFERENCES customers(tenant_id, customer_id);
ALTER TABLE orders
  ADD CONSTRAINT orders_tenant_quote_fkey
  FOREIGN KEY (tenant_id, quote_id)
  REFERENCES quotes(tenant_id, quote_id);

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_customer_id_fkey;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_tenant_customer_fkey
  FOREIGN KEY (tenant_id, customer_id)
  REFERENCES customers(tenant_id, customer_id);

ALTER TABLE followups
  DROP CONSTRAINT IF EXISTS followups_customer_id_fkey;
ALTER TABLE followups
  ADD CONSTRAINT followups_tenant_customer_fkey
  FOREIGN KEY (tenant_id, customer_id)
  REFERENCES customers(tenant_id, customer_id);

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_order_id_fkey;
ALTER TABLE payments
  ADD CONSTRAINT payments_tenant_order_fkey
  FOREIGN KEY (tenant_id, order_id)
  REFERENCES orders(tenant_id, order_id);

ALTER TABLE business_message_runs
  DROP CONSTRAINT IF EXISTS business_message_runs_conversation_id_fkey;
ALTER TABLE business_message_runs
  ADD CONSTRAINT business_message_runs_tenant_conversation_fkey
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations(tenant_id, conversation_id);

ALTER TABLE webhook_inbox
  DROP CONSTRAINT IF EXISTS webhook_inbox_collector_id_fkey;
ALTER TABLE webhook_inbox
  ADD CONSTRAINT webhook_inbox_tenant_collector_fkey
  FOREIGN KEY (tenant_id, collector_id)
  REFERENCES collectors(tenant_id, collector_id);
