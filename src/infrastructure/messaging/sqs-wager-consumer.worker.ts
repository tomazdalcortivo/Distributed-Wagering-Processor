import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { METRICS_PORT, MetricsPort } from '../../application/ports/metrics.port';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction';
import {
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidTransactionContractError,
} from '../../domain/shared/domain-errors';
import { StructuredLogger } from '../observability/structured-logger.service';
import { SQS_CLIENT_TOKEN } from './sqs-client.factory';

export interface SqsWagerEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

/**
 * SQS FIFO Consumer Worker for `wager-transactions.fifo` (Section 10).
 *
 * Guarantees:
 * - Reuses the exact same `ProcessWagerTransactionUseCase` as the HTTP entrypoint.
 * - Deduplicates via persistent `inbox_messages` table by `(consumerName, messageId)` inside the SQL transaction.
 * - Sends `DeleteMessageCommand` (ack) STRICTLY AFTER the SQL transaction commits.
 * - Distinguishes:
 *   1. Business rejections (`PROCESSED` / `REJECTED` / `PENDING_REFERENCE` / idempotent replay) -> terminal, ack message.
 *   2. Permanent contract/payload errors (malformed JSON, invalid Money, IdempotencyConflict, unknown wallet after max receives) ->
 *      routes to `wager-transactions-dlq.fifo` and acks original message so FIFO group is not blocked indefinitely.
 *   3. Transient infrastructure errors (PostgreSQL timeout, connection drop, lock conflict) ->
 *      applies visibility backoff and leaves message on queue for redelivery up to `maxReceiveCount`.
 * - Graceful `SIGTERM` / `OnModuleDestroy` shutdown: waits for in-flight message to complete or
 *   releases message visibility (`VisibilityTimeout = 0`) if shutting down before completion.
 */
@Injectable()
export class SqsWagerConsumerWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  public static readonly CONSUMER_NAME = 'sqs-wager-transactions-consumer';

  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  private readonly maxReceiveCount: number;
  private readonly enabled: boolean;
  private isShuttingDown = false;
  private pollingLoopPromise?: Promise<void>;
  private readonly inFlightMessages = new Map<string, string>(); // messageId -> receiptHandle

  constructor(
    @Inject(SQS_CLIENT_TOKEN)
    private readonly sqsClient: SQSClient,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    @Inject(METRICS_PORT)
    private readonly metrics: MetricsPort,
    private readonly logger: StructuredLogger,
  ) {
    this.queueUrl =
      process.env.SQS_WAGER_QUEUE_URL ??
      'http://localhost:4566/000000000000/wager-transactions.fifo';
    this.dlqUrl =
      process.env.SQS_WAGER_DLQ_URL ??
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
    this.maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);
    this.enabled = process.env.DISABLE_BACKGROUND_WORKERS !== 'true';
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }
    this.pollingLoopPromise = this.runPollingLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.pollingLoopPromise) {
      await Promise.race([
        this.pollingLoopPromise,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    // Release visibility for any messages that could not finish before shutdown deadline
    for (const [messageId, receiptHandle] of this.inFlightMessages.entries()) {
      try {
        await this.sqsClient.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 0,
          }),
        );
        this.logger.info('Released SQS message visibility during graceful shutdown', {
          messageId,
        });
      } catch (err) {
        this.logger.warn('Failed to release SQS visibility on shutdown', {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Processes a single SQS `Message`. Exposed publicly for deterministic integration & crash-recovery testing.
   */
  async handleSqsMessage(
    msg: Message,
    options?: { simulateCrashBeforeAck?: boolean },
  ): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    const rawBody = msg.Body ?? '';
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');
    const correlationId = randomUUID();

    let envelope: SqsWagerEnvelope;
    try {
      envelope = JSON.parse(rawBody) as SqsWagerEnvelope;
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        !envelope.messageId ||
        envelope.type !== 'WagerTransactionRequested' ||
        !envelope.data
      ) {
        throw new InvalidTransactionContractError('Malformed SQS WagerTransactionRequested envelope');
      }
    } catch (err) {
      await this.moveToDlqAndAck(
        msg,
        'MALFORMED_ENVELOPE',
        err instanceof Error ? err.message : String(err),
        correlationId,
      );
      return;
    }

    const messageId = envelope.messageId;
    if (receiptHandle) {
      this.inFlightMessages.set(messageId, receiptHandle);
    }

    const payloadHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    const data = envelope.data;
    const idempotencyKey =
      data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`;

    try {
      // 1. Execute core domain use case (commits Inbox, Wallet, Transaction, Ledger, Outbox atomically)
      await this.processWagerUseCase.execute({
        idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId,
        inboxContext: {
          consumerName: SqsWagerConsumerWorker.CONSUMER_NAME,
          messageId,
          payloadHash,
        },
      });

      // Optional crash-injection hook for Section 13 Concurrency Test #5:
      // "worker morto depois do commit e antes do ack"
      if (options?.simulateCrashBeforeAck) {
        throw new SimulatedWorkerCrashAfterCommitError(
          `Simulated worker crash after SQL commit and before SQS ack for message "${messageId}"`,
        );
      }

      // 2. ACK message ONLY AFTER SQL transaction has committed
      if (receiptHandle) {
        await this.sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
          }),
        );
      }
    } catch (err) {
      if (err instanceof SimulatedWorkerCrashAfterCommitError) {
        throw err;
      }

      // Permanent contract / validation / idempotency conflict errors -> route to DLQ immediately
      if (this.isPermanentError(err)) {
        await this.moveToDlqAndAck(
          msg,
          err.code,
          err.message,
          correlationId,
          messageId,
          data.walletId,
          data.providerId,
        );
        return;
      }

      // Transient error or missing wallet (could be replication lag or transient DB outage)
      this.metrics.incrementRetry('sqs_consumer');

      if (receiveCount >= this.maxReceiveCount) {
        await this.moveToDlqAndAck(
          msg,
          'MAX_RECEIVE_COUNT_EXCEEDED',
          err instanceof Error ? err.message : String(err),
          correlationId,
          messageId,
          data.walletId,
          data.providerId,
        );
        return;
      }

      // Exponential backoff visibility timeout for transient retry
      if (receiptHandle) {
        const backoffSeconds = Math.min(60, Math.pow(2, receiveCount));
        try {
          await this.sqsClient.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: backoffSeconds,
            }),
          );
        } catch {
          // Ignore visibility update failure if connection dropped
        }
      }

      this.logger.warn('Transient error processing SQS wager message; scheduled retry', {
        correlationId,
        messageId,
        walletId: data.walletId,
        providerId: data.providerId,
        receiveCount,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlightMessages.delete(messageId);
    }
  }

  private async runPollingLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        const response = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: Number(process.env.SQS_WAIT_TIME_SECONDS ?? 2),
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
        );

        const messages = response.Messages ?? [];
        for (const msg of messages) {
          if (this.isShuttingDown) break;
          await this.handleSqsMessage(msg);
        }
      } catch (err) {
        if (!this.isShuttingDown) {
          this.logger.warn('SQS consumer poll error', {
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  private isPermanentError(
    err: unknown,
  ): err is InvalidMoneyError | InvalidTransactionContractError | IdempotencyConflictError {
    return (
      err instanceof InvalidMoneyError ||
      err instanceof InvalidTransactionContractError ||
      err instanceof IdempotencyConflictError
    );
  }

  private async moveToDlqAndAck(
    msg: Message,
    failureReason: string,
    errorMessage: string,
    correlationId: string,
    messageId?: string,
    walletId?: string,
    providerId?: string,
  ): Promise<void> {
    this.metrics.incrementDlqMessages(failureReason);
    this.logger.error('Routing permanent failed SQS message to DLQ', {
      correlationId,
      messageId: messageId ?? msg.MessageId,
      walletId,
      providerId,
      failureReason,
      errorMessage,
    });

    const isFifo = this.dlqUrl.endsWith('.fifo');
    const dedupId = messageId ?? msg.MessageId ?? randomUUID();

    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: msg.Body ?? '{}',
        ...(isFifo
          ? {
              MessageGroupId: walletId ?? 'dlq-default-group',
              MessageDeduplicationId: `dlq:${dedupId}`,
            }
          : {}),
        MessageAttributes: {
          failureReason: {
            DataType: 'String',
            StringValue: failureReason,
          },
          errorMessage: {
            DataType: 'String',
            StringValue: errorMessage.slice(0, 250),
          },
        },
      }),
    );

    if (msg.ReceiptHandle) {
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
    }
  }
}

export class SimulatedWorkerCrashAfterCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulatedWorkerCrashAfterCommitError';
  }
}
