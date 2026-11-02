import { LedgerImbalanceError } from '../shared/domain-errors';
import { Money } from '../value-objects/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
  sequenceNumber?: bigint;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
  sequenceNumber?: bigint;
}

/**
 * Strictly immutable WalletLedgerEntry (Section 6.4).
 *
 * Invariants:
 * - Structural immutability (`Object.freeze(this)`), zero mutable fields or transition methods.
 * - `create` validates that `money` is strictly positive, all currencies match, and
 *   `balanceBefore ± money === balanceAfter` (`isBalanced()`).
 * - Neither `balanceBefore` nor `balanceAfter` can be negative.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
    public readonly sequenceNumber?: bigint,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new LedgerImbalanceError(
        `Ledger entry money must be strictly positive, received ${props.money.toString()}`,
      );
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new LedgerImbalanceError(
        `Ledger entry balances cannot be negative (before=${props.balanceBefore.toString()}, after=${props.balanceAfter.toString()})`,
      );
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
      props.sequenceNumber,
    );

    if (!entry.isBalanced()) {
      throw new LedgerImbalanceError(
        `Ledger arithmetic imbalance for transaction "${props.transactionId}": ` +
          `direction=${props.direction}, balanceBefore=${props.balanceBefore.toString()}, ` +
          `money=${props.money.toString()}, balanceAfter=${props.balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
      state.sequenceNumber,
    );
  }

  /**
   * Verifies `balanceBefore ± money === balanceAfter`.
   */
  isBalanced(): boolean {
    const expectedAfter =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedAfter.equals(this.balanceAfter) && !this.balanceAfter.isNegative();
  }
}
