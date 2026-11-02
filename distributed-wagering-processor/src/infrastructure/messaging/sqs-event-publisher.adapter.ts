import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { EventPublisherPort } from '../../application/ports/event-publisher.port';
import { OutboxMessage } from '../../domain/entities/outbox-message';
import { SQS_CLIENT_TOKEN } from './sqs-client.factory';

/**
 * Publishes Transactional Outbox events to AWS SQS FIFO queue (`wagering-integration-events.fifo`).
 * Uses `aggregateId` (walletId) as `MessageGroupId` to preserve per-wallet event ordering
 * and `outboxMessage.id` (eventId) as `MessageDeduplicationId`.
 */
@Injectable()
export class SqsEventPublisherAdapter implements EventPublisherPort {
  private readonly queueUrl: string;

  constructor(
    @Inject(SQS_CLIENT_TOKEN)
    private readonly sqsClient: SQSClient,
  ) {
    this.queueUrl =
      process.env.SQS_OUTBOX_EVENTS_QUEUE_URL ??
      'http://localhost:4566/000000000000/wagering-integration-events.fifo';
  }

  async publishOutboxMessage(message: OutboxMessage): Promise<void> {
    const isFifo = this.queueUrl.endsWith('.fifo');

    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        ...(isFifo
          ? {
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }
          : {}),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: message.eventType,
          },
          aggregateId: {
            DataType: 'String',
            StringValue: message.aggregateId,
          },
        },
      }),
    );
  }
}
