import { FailureCode } from './failure-code';

export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;
  constructor(expectedCurrency: string, actualCurrency: string) {
    super(`Currency mismatch: expected "${expectedCurrency}", received "${actualCurrency}"`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;
  constructor(walletId: string, balance: string, requestedDebit: string, currency: string) {
    super(
      `Insufficient funds in wallet "${walletId}": available ${balance} ${currency}, requested debit ${requestedDebit} ${currency}`,
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(transactionId: string, currentStatus: string, attemptedTransition: string) {
    super(
      `Cannot transition transaction "${transactionId}" from terminal/invalid status "${currentStatus}" via "${attemptedTransition}"`,
    );
  }
}

export class InvalidTransactionContractError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_CONTRACT';
  constructor(message: string) {
    super(message);
  }
}

export class LedgerImbalanceError extends DomainError {
  readonly code = 'LEDGER_IMBALANCE';
  constructor(message: string) {
    super(message);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_PAYLOAD_CONFLICT';
  constructor(
    public readonly idempotencyKey: string,
    message = `Idempotency key "${idempotencyKey}" was already used with a different request payload`,
  ) {
    super(message);
  }
}

export class DuplicateWalletError extends DomainError {
  readonly code = 'DUPLICATE_WALLET';
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player "${playerId}" and currency "${currency}"`);
  }
}

export class EntityNotFoundError extends DomainError {
  readonly code = 'ENTITY_NOT_FOUND';
  constructor(entityName: string, identifier: string) {
    super(`${entityName} not found: ${identifier}`);
  }
}

export class ConcurrencyConflictError extends DomainError {
  readonly code = 'CONCURRENCY_CONFLICT';
  constructor(aggregateId: string) {
    super(`Concurrency conflict detected on aggregate "${aggregateId}"`);
  }
}
