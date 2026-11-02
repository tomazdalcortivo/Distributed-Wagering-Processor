import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from '../shared/domain-errors';
import { Money } from '../value-objects/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementCommand {
  ledgerEntryId: string;
  transactionId: string;
  amount: Money;
  at?: Date;
}

/**
 * Wallet Aggregate Root (Section 6.2).
 *
 * Invariants:
 * - Balance is never negative.
 * - Every balance change produces a corresponding `WalletLedgerEntry` atomically.
 * - Operation currency must match wallet currency.
 * - `version` starts at 1 upon creation and increments ONLY when balance changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial wallet balance cannot be negative');
    }

    const now = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1, // version starts at 1 after creation
      now,
      now,
    );
  }

  /**
   * Reconstructs a Wallet from persistence without re-running transition rules.
   */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Debits the wallet and returns the corresponding immutable `WalletLedgerEntry`.
   * Throws `InsufficientFundsError` if resulting balance would be negative.
   * Increments `version` only when balance actually changes.
   */
  debit(command: WalletMovementCommand): WalletLedgerEntry {
    this.assertSameCurrency(command.amount);

    if (!command.amount.isPositive()) {
      throw new InvalidMoneyError('Debit amount must be strictly positive');
    }

    if (this._balance.isLessThan(command.amount)) {
      throw new InsufficientFundsError(
        this.id,
        this._balance.amount,
        command.amount.amount,
        this.currency,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(command.amount);
    const now = command.at ?? new Date();

    const ledgerEntry = WalletLedgerEntry.create({
      id: command.ledgerEntryId,
      walletId: this.id,
      transactionId: command.transactionId,
      direction: LedgerDirection.Debit,
      money: command.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return ledgerEntry;
  }

  /**
   * Credits the wallet and returns the corresponding immutable `WalletLedgerEntry`.
   * Increments `version` only when balance actually changes.
   */
  credit(command: WalletMovementCommand): WalletLedgerEntry {
    this.assertSameCurrency(command.amount);

    if (!command.amount.isPositive()) {
      throw new InvalidMoneyError('Credit amount must be strictly positive');
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(command.amount);
    const now = command.at ?? new Date();

    const ledgerEntry = WalletLedgerEntry.create({
      id: command.ledgerEntryId,
      walletId: this.id,
      transactionId: command.transactionId,
      direction: LedgerDirection.Credit,
      money: command.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return ledgerEntry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
