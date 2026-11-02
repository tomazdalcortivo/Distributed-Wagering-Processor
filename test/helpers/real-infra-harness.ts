import {
  CreateQueueCommand,
  PurgeQueueCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { buildMikroOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client.factory';

export interface TestHarness {
  app: INestApplication;
  orm: MikroORM;
  sqsClient: SQSClient;
  resetDatabaseAndQueues: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Bootstraps a real NestJS application connected to the real PostgreSQL and LocalStack SQS
 * containers provisioned by `docker-compose.yml`.
 */
export async function createRealInfraTestHarness(): Promise<TestHarness> {
  process.env.DISABLE_BACKGROUND_WORKERS = 'true';
  process.env.LOG_SILENT = 'true';

  const orm = await MikroORM.init(buildMikroOrmConfig());
  const migrator = orm.getMigrator();
  await migrator.up();

  const sqsClient = createSqsClient();
  await ensureSqsQueuesExist(sqsClient);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();

  const resetDatabaseAndQueues = async (): Promise<void> => {
    const conn = orm.em.getConnection();
    await conn.execute(`
      TRUNCATE TABLE
        outbox_messages,
        inbox_messages,
        wallet_ledger_entries,
        wager_transactions,
        wallets
      RESTART IDENTITY CASCADE;
    `);
  };

  const close = async (): Promise<void> => {
    await app.close();
    await orm.close(true);
  };

  return {
    app,
    orm,
    sqsClient,
    resetDatabaseAndQueues,
    close,
  };
}

async function ensureSqsQueuesExist(sqsClient: SQSClient): Promise<void> {
  const queues = [
    'wager-transactions-dlq.fifo',
    'wager-transactions.fifo',
    'wagering-integration-events.fifo',
  ];

  for (const queueName of queues) {
    try {
      await sqsClient.send(
        new CreateQueueCommand({
          QueueName: queueName,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
          },
        }),
      );
    } catch {
      // Queue already exists
    }
  }
}
