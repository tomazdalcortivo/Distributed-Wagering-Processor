import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/entities/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  LedgerImbalanceError,
} from '../../src/domain/shared/domain-errors';
import { Money } from '../../src/domain/value-objects/money';

describe('Wallet & WalletLedgerEntry Invariants (Sections 6.2 & 6.4)', () => {
  it('opens a wallet at version 1 and increments version only when balance changes', () => {
    const wallet = Wallet.open({
      id: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');

    const debitEntry = wallet.debit({
      ledgerEntryId: 'entry-1',
      transactionId: 'tx-1',
      amount: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(debitEntry.direction).toBe(LedgerDirection.Debit);
    expect(debitEntry.balanceBefore.amount).toBe('100.00');
    expect(debitEntry.balanceAfter.amount).toBe('75.00');
    expect(debitEntry.isBalanced()).toBe(true);

    const creditEntry = wallet.credit({
      ledgerEntryId: 'entry-2',
      transactionId: 'tx-2',
      amount: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(wallet.balance.amount).toBe('125.00');
    expect(wallet.version).toBe(3);
    expect(creditEntry.direction).toBe(LedgerDirection.Credit);
    expect(creditEntry.balanceBefore.amount).toBe('75.00');
    expect(creditEntry.balanceAfter.amount).toBe('125.00');
    expect(creditEntry.isBalanced()).toBe(true);
  });

  it('prevents negative balance on debit and keeps version unchanged when debit throws', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '20.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit({
        ledgerEntryId: 'entry-fail',
        transactionId: 'tx-fail',
        amount: Money.from({ amount: '20.01', currency: 'BRL' }),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects debit or credit with a mismatched currency', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit({
        ledgerEntryId: 'entry-usd',
        transactionId: 'tx-usd',
        amount: Money.from({ amount: '10.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('enforces arithmetic balance invariant on WalletLedgerEntry.create', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'bad-entry',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }), // should be 70.00
      }),
    ).toThrow(LedgerImbalanceError);
  });
});
