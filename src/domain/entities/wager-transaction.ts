import {
  InvalidTransactionContractError,
  InvalidTransactionStateError,
} from '../shared/domain-errors';
import { FailureCode } from '../shared/failure-code';
import { Money } from '../value-objects/money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: initial credit when opening a wallet with balance > 0
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // accepted, not yet applied
  PendingReference = 'PENDING_REFERENCE', // waiting for referenced transaction
  Processed = 'PROCESSED', // applied (terminal)
  Rejected = 'REJECTED', // business rule violation (terminal)
  Failed = 'FAILED', // permanent infrastructure error (terminal, auditable)
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
  allowInternalOpening?: boolean;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  observedBalance?: Money;
  failureCode?: FailureCode;
  processedAt?: Date;
  retryCount?: number;
  nextRetryAt?: Date;
}

/**
 * WagerTransaction Domain Entity (Section 6.3).
 *
 * State Machine Transitions:
 * - Initial state: `PENDING`
 * - `PENDING` -> `PROCESSED` | `REJECTED` | `FAILED` | `PENDING_REFERENCE`
 * - `PENDING_REFERENCE` -> `PROCESSED` | `REJECTED` | `FAILED`
 * - Terminal states (`PROCESSED`, `REJECTED`, `FAILED`) never transition again;
 *   any attempt throws `InvalidTransactionStateError`.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _retryCount = 0,
    private _nextRetryAt?: Date,
  ) {}

  /**
   * Creates a new WagerTransaction in `PENDING` state.
   * Validates reference requirement by kind and blocks external `OPENING` submission.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && !props.allowInternalOpening) {
      throw new InvalidTransactionContractError(
        'Transaction kind "OPENING" is strictly internal and cannot be submitted via API or queue',
      );
    }

    const requiresRef =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;

    if (requiresRef && (!props.referenceExternalTransactionId || !props.referenceExternalTransactionId.trim())) {
      throw new InvalidTransactionContractError(
        `Transaction kind "${props.kind}" requires a non-empty referenceExternalTransactionId`,
      );
    }

    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionContractError(
        `Transaction kind "${props.kind}" requires a strictly positive money amount`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Reconstructs from database persistence without re-running creation validation.
   */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.retryCount ?? 0,
      state.nextRetryAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get retryCount(): number {
    return this._retryCount;
  }

  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  // ---- State Transitions ----

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance?: Money,
  ): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextRetryAt = undefined;
  }

  markPendingReference(nextRetryAt?: Date): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    if (nextRetryAt) {
      this._nextRetryAt = nextRetryAt;
    }
  }

  schedulePendingReferenceRetry(now: Date, baseDelayMs = 1000): void {
    this.assertNotTerminal('schedulePendingReferenceRetry');
    this._status = WagerTransactionStatus.PendingReference;
    this._retryCount += 1;
    const delayMs = baseDelayMs * Math.pow(2, Math.min(this._retryCount - 1, 6));
    this._nextRetryAt = new Date(now.getTime() + delayMs);
  }

  reject(code: FailureCode, at: Date = new Date(), observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextRetryAt = undefined;
  }

  fail(code: FailureCode, at: Date = new Date(), observedBalance?: Money): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextRetryAt = undefined;
  }

  // ---- Domain Queries ----

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Computes the ledger direction for this transaction (Section 6.3 & Section 7).
   * - `OPENING`, `WIN`, `REFUND` -> `CREDIT`
   * - `BET` -> `DEBIT`
   * - `ROLLBACK` -> inverse of the referenced transaction's ledger direction
   *   (if reference is `BET` -> `CREDIT`; if reference is `WIN` or `REFUND` -> `DEBIT`)
   * - `LOSS` -> throws because `LOSS` does not affect balance or generate a ledger entry.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionContractError(
            `Cannot determine ledger direction for ROLLBACK "${this.id}" without a resolved reference transaction`,
          );
        }
        const refDirection = reference.ledgerDirectionFor();
        return refDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }

      case WagerTransactionKind.Loss:
        throw new InvalidTransactionContractError(
          `Transaction kind "LOSS" does not affect balance or generate a ledger direction`,
        );
    }
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attemptedTransition);
    }
  }
}
