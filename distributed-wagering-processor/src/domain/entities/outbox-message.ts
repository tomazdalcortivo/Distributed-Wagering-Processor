import { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Transactional Outbox message entity (Section 6.5 & Section 11).
 * Persisted in the exact same SQL transaction as wallet, ledger, and inbox changes.
 */
export class OutboxMessage {
  private static readonly BASE_BACKOFF_MS = 1000;
  private static readonly MAX_BACKOFF_EXPONENT = 7; // caps single backoff step at 128s

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const serialized = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...serialized }),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined || this._publishedAt === null;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) {
      return false;
    }
    if (!this._nextAttemptAt) {
      return true;
    }
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /**
   * Increments attempts and computes the next retry timestamp using exponential backoff.
   */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const exponent = Math.min(this._attempts - 1, OutboxMessage.MAX_BACKOFF_EXPONENT);
    const delayMs = OutboxMessage.BASE_BACKOFF_MS * Math.pow(2, exponent);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
