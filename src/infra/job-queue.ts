import { PgBoss } from 'pg-boss';

export class JobQueue {
  private readonly boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss(connectionString);
    this.boss.on('error', (error) => console.error('pg-boss', error));
  }

  async start() {
    await this.boss.start();

    await this.boss.createQueue('outbox-publish-dlq');
    await this.boss.createQueue('outbox-publish', {
      retryLimit: 8,
      retryDelay: 15,
      retryBackoff: true,
      deadLetter: 'outbox-publish-dlq',
    });

    await this.boss.createQueue('followup-deliver-dlq');
    await this.boss.createQueue('followup-deliver', {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      deadLetter: 'followup-deliver-dlq',
    });

    await this.boss.createQueue('quarantine-purge-dlq');
    await this.boss.createQueue('quarantine-purge', {
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      deadLetter: 'quarantine-purge-dlq',
    });
  }

  async stop() {
    await this.boss.stop({ graceful: true });
  }

  async scheduleOutbox() {
    return this.boss.send(
      'outbox-publish',
      {},
      { singletonKey: 'outbox-publish', singletonSeconds: 5 },
    );
  }

  async scheduleFollowups() {
    return this.boss.send(
      'followup-deliver',
      {},
      { singletonKey: 'followup-deliver', singletonSeconds: 10 },
    );
  }

  async scheduleQuarantinePurge() {
    return this.boss.send(
      'quarantine-purge',
      {},
      { singletonKey: 'quarantine-purge', singletonSeconds: 900 },
    );
  }

  async workOutbox(handler: () => Promise<void>) {
    await this.boss.work('outbox-publish', async () => {
      await handler();
    });
  }

  async workFollowups(handler: () => Promise<void>) {
    await this.boss.work('followup-deliver', async () => {
      await handler();
    });
  }

  async workQuarantinePurge(handler: () => Promise<void>) {
    await this.boss.work('quarantine-purge', async () => {
      await handler();
    });
  }
}
