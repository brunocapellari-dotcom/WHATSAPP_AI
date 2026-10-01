CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collectors (
  collector_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  provider text NOT NULL,
  account text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('business','conversation','group','webhook')),
  purpose text NOT NULL DEFAULT 'BUSINESS' CHECK (purpose IN ('BUSINESS','FREIGHT_INTELLIGENCE')),
  source_id text,
  status text NOT NULL CHECK (status IN ('HEALTHY','DEGRADED','DOWN','DISABLED')),
  last_success timestamptz,
  last_failure timestamptz,
  last_message timestamptz,
  latency_ms integer,
  retry_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  rate_limit jsonb NOT NULL DEFAULT '{}'::jsonb,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  version text NOT NULL,
  webhook_secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collectors_tenant_status ON collectors(tenant_id, status);

CREATE TABLE IF NOT EXISTS quarantine_messages (
  quarantine_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  provider text NOT NULL,
  provider_message_id text NOT NULL,
  encrypted_payload bytea,
  content_hash text NOT NULL,
  disposition text NOT NULL DEFAULT 'PENDING' CHECK (disposition IN ('PENDING','PROMOTED','DISCARDED','REJECTED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, provider, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_quarantine_expiry ON quarantine_messages(expires_at) WHERE disposition='PENDING';

CREATE TABLE IF NOT EXISTS raw_messages (
  event_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  provider text NOT NULL,
  collector_id text NOT NULL,
  account_id text NOT NULL,
  message_id text NOT NULL,
  chat_id text NOT NULL,
  group_id text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  sender_reference text NOT NULL,
  message_type text NOT NULL,
  text_content text,
  attachment_reference text,
  reply_context jsonb,
  content_hash text NOT NULL,
  source_payload jsonb,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, provider, message_id)
);
CREATE INDEX IF NOT EXISTS idx_raw_messages_tenant_occurred ON raw_messages(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_messages_group ON raw_messages(tenant_id, group_id, occurred_at DESC) WHERE group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS canonical_entities (
  entity_id text PRIMARY KEY,
  tenant_id text,
  entity_type text NOT NULL CHECK (entity_type IN ('CITY','COMPANY','FARM','WAREHOUSE','TERMINAL','CARRIER','PRODUCT')),
  canonical_name text NOT NULL,
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(5,4) NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entities_type_name ON canonical_entities(entity_type, canonical_name);

CREATE TABLE IF NOT EXISTS freight_observations (
  observation_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  event_id uuid NOT NULL REFERENCES raw_messages(event_id),
  source_message_id text NOT NULL,
  chat_id text NOT NULL,
  group_id text,
  observed_at timestamptz NOT NULL,
  fields jsonb NOT NULL,
  quality_score numeric(5,4) NOT NULL,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical jsonb NOT NULL,
  fingerprint text NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freight_observations_tenant_date ON freight_observations(tenant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_freight_observations_fingerprint ON freight_observations(tenant_id, fingerprint);

CREATE TABLE IF NOT EXISTS freight_events (
  freight_event_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  fingerprint text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  duplicate_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','SUPERSEDED')),
  payload jsonb NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_freight_events_tenant_last_seen ON freight_events(tenant_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  outbox_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  topic text NOT NULL,
  aggregate_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token uuid,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(next_attempt_at, created_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_lock ON outbox_events(locked_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ALLOW','DENY','ERROR')),
  target text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_date ON audit_logs(tenant_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  provider text NOT NULL,
  provider_chat_id text NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','WAITING_HUMAN','HUMAN','CLOSED')),
  assigned_to text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, provider, provider_chat_id)
);

CREATE TABLE IF NOT EXISTS customers (
  customer_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  name text NOT NULL,
  phone_reference text NOT NULL,
  email text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone ON customers(tenant_id, phone_reference);

CREATE TABLE IF NOT EXISTS leads (
  lead_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  name text,
  phone_reference text,
  interest text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','QUALIFIED','WON','LOST')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotes (
  quote_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  customer_id uuid REFERENCES customers(customer_id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED')),
  currency text NOT NULL DEFAULT 'BRL',
  total numeric(18,2),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  order_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  customer_id uuid REFERENCES customers(customer_id),
  quote_id uuid REFERENCES quotes(quote_id),
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','CONFIRMED','PROCESSING','FULFILLED','CANCELLED')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appointments (
  appointment_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  customer_id uuid REFERENCES customers(customer_id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','CONFIRMED','CANCELLED','COMPLETED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  product_id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  sku text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  UNIQUE (tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_search ON products(tenant_id, name);

CREATE TABLE IF NOT EXISTS product_prices (
  price_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  product_id text NOT NULL,
  currency text NOT NULL DEFAULT 'BRL',
  price numeric(18,2) NOT NULL CHECK(price >= 0),
  effective_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_product_prices_current ON product_prices(tenant_id, product_id, effective_at DESC);

CREATE TABLE IF NOT EXISTS inventory (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  product_id text NOT NULL,
  location_id text NOT NULL DEFAULT 'default',
  quantity numeric(18,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id, location_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, product_id)
);

CREATE TABLE IF NOT EXISTS followups (
  followup_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  customer_id uuid REFERENCES customers(customer_id),
  due_at timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DONE','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(tenant_id, due_at) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS payments (
  payment_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  order_id uuid NOT NULL REFERENCES orders(order_id),
  amount numeric(18,2) NOT NULL CHECK(amount > 0),
  reference text NOT NULL,
  status text NOT NULL DEFAULT 'RECORDED',
  created_at timestamptz NOT NULL DEFAULT now()
);
