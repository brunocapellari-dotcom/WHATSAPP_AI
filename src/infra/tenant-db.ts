import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Execute one tenant-scoped DB operation under PostgreSQL RLS. */
export async function withTenant<T>(pool: Pool, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function tenantQuery<R extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  tenantId: string,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<R>> {
  return withTenant(pool, tenantId, (client) => client.query<R>(text, values));
}
