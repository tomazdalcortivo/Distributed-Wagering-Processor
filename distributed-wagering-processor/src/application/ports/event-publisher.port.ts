import { OutboxMessage } from '../../domain/entities/outbox-message';

export const EVENT_PUBLISHER_PORT = Symbol('EVENT_PUBLISHER_PORT');

export interface EventPublisherPort {
  publishOutboxMessage(message: OutboxMessage): Promise<void>;
}
