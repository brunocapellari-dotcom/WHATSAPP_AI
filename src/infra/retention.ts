import type { Pool } from 'pg';

export class QuarantineRetention {
  constructor(private readonly pool: Pool) {}

  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM quarantine_messages
       WHERE expires_at <= $1
       RETURNING quarantine_id`,
      [now],
    );
    return result.rowCount ?? 0;
  }
}
