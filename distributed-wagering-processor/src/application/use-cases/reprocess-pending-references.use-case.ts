import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OutboxMessage } from '../../domain/entities/outbox-message';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import {
  IntegrationEvent,
  WagerTransactionRejected,
} from '../../domain/events/integration-event';
import { FailureCode } from '../../domain/shared/failure-code';
import { StructuredLogger } from '../../infrastructure/observability/structured-logger.service';
import { METRICS_PORT, MetricsPort } from '../ports/metrics.port';
import { UNIT_OF_WORK_PORT, UnitOfWorkPort } from '../ports/unit-of-work.port';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

/**
 * Reprocesses `PENDING_REFERENCE` transactions (Section 7.1).
 *
 * - Claims due `PENDING_REFERENCE` transactions using `FOR UPDATE SKIP LOCKED` so multiple
 *   instances can safely run this worker concurrently.
 * - If the referenced transaction has arrived, applies the reversal inside the locked wallet transaction.
 * - If the retry count or TTL limit is exhausted and the reference is still missing, transitions
 *   to `REJECTED` with `FailureCode.ReferenceNotFoundTimeout` and enqueues `WagerTransactionRejected`
 *   in the Outbox.
 */
@Injectable()
export class ReprocessPendingReferencesUseCase {
  private readonly maxAttempts: number;
  private readonly ttlMs: number;

  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
    @Inject(METRICS_PORT)
    private readonly metrics: MetricsPort,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly logger: StructuredLogger,
  ) {
    this.maxAttempts = Number(process.env.PENDING_REF_MAX_ATTEMPTS ?? 8);
    this.ttlMs = Number(process.env.PENDING_REF_TTL_MS ?? 120_000);
  }

  async executeBatch(batchSize = 25): Promise<number> {
    const now = new Date();
    let processedCount = 0;

    await this.uow.runInTransaction(async (ctx) => {
      const pendingTxs = await ctx.transactions.claimDuePendingReferences(now, batchSize);

      for (const tx of pendingTxs) {
        processedCount += 1;
        const correlationId = randomUUID();
        const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
        if (!wallet) {
          continue;
        }

        const outboxEvents: IntegrationEvent<unknown>[] = [];
        await this.processWagerUseCase.applyOperationRules(
          ctx,
          wallet,
          tx,
          outboxEvents,
          correlationId,
          now,
          true,
        );

        // If still in PENDING_REFERENCE, check if retry count or TTL is exhausted
        if (tx.status === WagerTransactionStatus.PendingReference) {
          const ageMs = now.getTime() - tx.createdAt.getTime();
          if (tx.retryCount >= this.maxAttempts || ageMs >= this.ttlMs) {
            tx.reject(FailureCode.ReferenceNotFoundTimeout, now, wallet.balance);
            await ctx.transactions.update(tx);

            const rejectedEvent = WagerTransactionRejected.from(tx, {
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            });
            await ctx.outbox.insertMany([OutboxMessage.enqueue(rejectedEvent)]);
            this.metrics.incrementTransactionStatus(tx.status, tx.kind);

            this.logger.warn(
              'PENDING_REFERENCE transaction exhausted retries/TTL and was REJECTED',
              {
                correlationId,
                transactionId: tx.id,
                walletId: tx.walletId,
                providerId: tx.providerId,
                retryCount: tx.retryCount,
                failureCode: tx.failureCode,
              },
            );
          } else {
            this.metrics.incrementRetry('pending_reference');
            await ctx.transactions.update(tx);
          }
        } else {
          // Transitioned to PROCESSED or REJECTED
          if (tx.status === WagerTransactionStatus.Rejected) {
            await ctx.transactions.update(tx);
          }
          if (outboxEvents.length > 0) {
            await ctx.outbox.insertMany(
              outboxEvents.map((ev) => OutboxMessage.enqueue(ev)),
            );
          }
          this.metrics.incrementTransactionStatus(tx.status, tx.kind);
        }
      }
    });

    return processedCount;
  }
}
