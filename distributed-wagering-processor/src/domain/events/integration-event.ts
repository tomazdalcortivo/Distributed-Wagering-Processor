import { randomUUID } from 'crypto';
import { Wallet } from '../entities/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../entities/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind } from '../entities/wager-transaction';
import { FailureCode } from '../shared/failure-code';
import { MoneyProps } from '../value-objects/money';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventContext {
  eventId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}

export interface SerializedIntegrationEvent<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Abstract Integration Event Envelope (Section 11).
 * Concrete subclasses define `eventType` and `version` on the class type.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /**
   * Serialized envelope stored in the outbox JSONB payload.
   */
  toJSON(): SerializedIntegrationEvent<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

// ============================================================================
// 1. WalletBalanceChanged (emitted ONLY when wallet balance actually changes)
// ============================================================================

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId ?? randomUUID(),
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? entry.transactionId,
      occurredAt: ctx.occurredAt ?? new Date(),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

// ============================================================================
// 2. WagerTransactionProcessed (emitted for every applied transaction, incl. LOSS)
// ============================================================================

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    observedBalance: MoneyProps,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const processedAt = transaction.processedAt ?? ctx.occurredAt ?? new Date();
    return new WagerTransactionProcessed({
      eventId: ctx.eventId ?? randomUUID(),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? transaction.id,
      occurredAt: ctx.occurredAt ?? processedAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: observedBalance,
        ...(transaction.referenceTransactionId
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

// ============================================================================
// 3. WagerTransactionRejected (emitted when rejected by a business rule)
// ============================================================================

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const rejectedAt = transaction.processedAt ?? ctx.occurredAt ?? new Date();
    return new WagerTransactionRejected({
      eventId: ctx.eventId ?? randomUUID(),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? transaction.id,
      occurredAt: ctx.occurredAt ?? rejectedAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode ?? FailureCode.PermanentProcessingFailure,
        rejectedAt: rejectedAt.toISOString(),
      },
    });
  }
}

// ============================================================================
// 4. WagerTransactionPendingReference (emitted when referenced tx is missing)
// ============================================================================

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  retryCount: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId ?? randomUUID(),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? transaction.id,
      occurredAt: ctx.occurredAt ?? new Date(),
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? '',
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        retryCount: transaction.retryCount,
      },
    });
  }
}
