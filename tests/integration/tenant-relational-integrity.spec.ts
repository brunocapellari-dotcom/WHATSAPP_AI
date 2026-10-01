import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run('tenant relational integrity', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tenants = ['rel-a-' + randomUUID(), 'rel-b-' + randomUUID()];

  afterAll(async () => {
    for (const tenantId of tenants) {
      await pool.query('DELETE FROM webhook_inbox WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM business_message_runs WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM freight_observations WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM payments WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM orders WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM quotes WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM appointments WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM followups WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM customers WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM raw_messages WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM conversations WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM collectors WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE tenant_id=$1', [tenantId]);
    }
    await pool.end();
  });

  it('rejects cross-tenant references throughout Business, Freight and Webhook domains', async () => {
    const [tenantA, tenantB] = tenants;
    await pool.query(
      'INSERT INTO tenants(tenant_id,name) VALUES($1,$2),($3,$4)',
      [tenantA, 'Tenant A', tenantB, 'Tenant B'],
    );

    const customerB = randomUUID();
    const quoteB = randomUUID();
    const orderB = randomUUID();
    const conversationB = randomUUID();
    const eventB = randomUUID();
    const collectorB = 'collector-' + randomUUID();

    await pool.query(
      'INSERT INTO customers(customer_id,tenant_id,name,phone_reference) VALUES($1,$2,$3,$4)',
      [customerB, tenantB, 'Customer B', 'hmac:b'],
    );
    await pool.query(
      "INSERT INTO quotes(quote_id,tenant_id,customer_id,payload) VALUES($1,$2,$3,'{}'::jsonb)",
      [quoteB, tenantB, customerB],
    );
    await pool.query(
      "INSERT INTO orders(order_id,tenant_id,customer_id,quote_id,payload) VALUES($1,$2,$3,$4,'{}'::jsonb)",
      [orderB, tenantB, customerB, quoteB],
    );
    await pool.query(
      "INSERT INTO conversations(conversation_id,tenant_id,provider,provider_chat_id) VALUES($1,$2,'mock',$3)",
      [conversationB, tenantB, 'chat-' + randomUUID()],
    );
    await pool.query(
      `INSERT INTO raw_messages(
        event_id,tenant_id,provider,collector_id,account_id,message_id,chat_id,occurred_at,received_at,
        sender_reference,message_type,content_hash,schema_version
      ) VALUES($1,$2,'mock','collector-placeholder','acct',$3,'chat',now(),now(),'hmac:x','text',$4,1)`,
      [eventB, tenantB, 'message-' + randomUUID(), 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO collectors(
        collector_id,tenant_id,provider,account,source_type,purpose,status,version
      ) VALUES($1,$2,'mock','acct','webhook','BUSINESS','HEALTHY','test')`,
      [collectorB, tenantB],
    );

    await expect(pool.query(
      "INSERT INTO quotes(quote_id,tenant_id,customer_id,payload) VALUES($1,$2,$3,'{}'::jsonb)",
      [randomUUID(), tenantA, customerB],
    )).rejects.toThrow();

    await expect(pool.query(
      "INSERT INTO orders(order_id,tenant_id,customer_id,quote_id,payload) VALUES($1,$2,$3,$4,'{}'::jsonb)",
      [randomUUID(), tenantA, customerB, quoteB],
    )).rejects.toThrow();

    await expect(pool.query(
      `INSERT INTO payments(payment_id,tenant_id,order_id,amount,reference)
       VALUES($1,$2,$3,10,'test')`,
      [randomUUID(), tenantA, orderB],
    )).rejects.toThrow();

    await expect(pool.query(
      `INSERT INTO business_message_runs(
         run_id,tenant_id,provider,source_message_id,conversation_id,state
       ) VALUES($1,$2,'mock',$3,$4,'PROCESSING')`,
      [randomUUID(), tenantA, 'msg-' + randomUUID(), conversationB],
    )).rejects.toThrow();

    await expect(pool.query(
      `INSERT INTO freight_observations(
        observation_id,tenant_id,event_id,source_message_id,chat_id,observed_at,fields,
        quality_score,issues,canonical,fingerprint,schema_version
      ) VALUES($1,$2,$3,$4,'chat',now(),'{}'::jsonb,1,'[]'::jsonb,'{}'::jsonb,$5,1)`,
      [randomUUID(), tenantA, eventB, 'msg-' + randomUUID(), 'fingerprint-' + randomUUID()],
    )).rejects.toThrow();

    await expect(pool.query(
      `INSERT INTO webhook_inbox(
        ingress_id,tenant_id,provider,collector_id,payload_hash,encrypted_payload
      ) VALUES($1,$2,'mock',$3,$4,$5)`,
      [randomUUID(), tenantA, collectorB, 'hash-' + randomUUID(), Buffer.from('encrypted')],
    )).rejects.toThrow();
  });
});
