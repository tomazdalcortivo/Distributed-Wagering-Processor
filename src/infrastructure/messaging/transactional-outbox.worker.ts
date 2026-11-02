import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  EVENT_PUBLISHER_PORT,
  EventPublisherPort,
} from '../../application/ports/event-publisher.port';
import { METRICS_PORT, MetricsPort } from '../../application/ports/metrics.port';
import {
  UNIT_OF_WORK_PORT,
  UnitOfWorkPort,
} from '../../application/ports/unit-of-work.port';
import { StructuredLogger } from '../observability/structured-logger.service';

/**
 * Transactional Outbox Publisher Worker (Section 11).
 *
 * Guarantees:
 * - Safe for multiple concurrent publishers across 3+ instances via PostgreSQL
 *   `SELECT ... FOR UPDATE SKIP LOCKED` inside `claimPendingBatch`.
 * - If an instance crashes after the business SQL commit and before publishing,
 *   another instance picks up the pending outbox records on the next tick.
 * - Uses exponential backoff (`OutboxMessage.scheduleRetry`) when SQS is temporarily unavailable.
 */
@Injectable()
export class TransactionalOutboxWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly enabled: boolean;
  private timer?: ReturnType<typeof setInterval>;
  private isRunningBatch = false;

  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
    @Inject(EVENT_PUBLISHER_PORT)
    private readonly publisher: EventPublisherPort,
    @Inject(METRICS_PORT)
    private readonly metrics: MetricsPort,
    private readonly logger: StructuredLogger,
  ) {
    this.pollIntervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500);
    this.batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 50);
    this.enabled = process.env.DISABLE_BACKGROUND_WORKERS !== 'true';
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      void this.processPendingOutboxBatch();
    }, this.pollIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * Claims and publishes a batch of due outbox messages.
   * Exposed publicly so integration/concurrency tests can invoke multiple publishers in parallel.
   */
  async processPendingOutboxBatch(customBatchSize?: number): Promise<number> {
    if (this.isRunningBatch && !customBatchSize) {
      return 0;
    }

    this.isRunningBatch = true;
    let publishedCount = 0;

    try {
      const now = new Date();
      await this.uow.runInTransaction(async (ctx) => {
        const batch = await ctx.outbox.claimPendingBatch(
          now,
          customBatchSize ?? this.batchSize,
        );

        for (const message of batch) {
          try {
            await this.publisher.publishOutboxMessage(message);
            message.markPublished(new Date());
            await ctx.outbox.update(message);
            publishedCount += 1;
          } catch (err) {
            message.scheduleRetry(new Date());
            await ctx.outbox.update(message);
            this.metrics.incrementRetry('outbox_publisher');

            this.logger.warn('Failed to publish outbox message; scheduled backoff retry', {
              outboxId: message.id,
              aggregateId: message.aggregateId,
              eventType: message.eventType,
              attempts: message.attempts,
              nextAttemptAt: message.nextAttemptAt?.toISOString(),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const remainingLag = await ctx.outbox.countPendingLag(now);
        this.metrics.setOutboxLag(remainingLag);
      });
    } catch (err) {
      this.logger.warn('Outbox worker batch error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isRunningBatch = false;
    }

    return publishedCount;
  }
}
