import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction';
import { computeWagerPayloadHash } from '../../src/domain/shared/canonical-json';
import {
  InvalidTransactionContractError,
  InvalidTransactionStateError,
} from '../../src/domain/shared/domain-errors';
import { FailureCode } from '../../src/domain/shared/failure-code';
import { Money } from '../../src/domain/value-objects/money';

describe('WagerTransaction, Canonical Payload Hash & Rules (Sections 6.3, 7, 9)', () => {
  const baseProps = {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  };

  it('starts in PENDING and prevents transitions once terminal (PROCESSED, REJECTED, FAILED)', () => {
    const tx = WagerTransaction.create(baseProps);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);

    tx.markProcessed(undefined, new Date(), Money.from({ amount: '75.00', currency: 'BRL' }));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('blocks external submission of internal OPENING kind', () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Opening,
      }),
    ).toThrow(InvalidTransactionContractError);
  });

  it('requires referenceExternalTransactionId for REFUND and ROLLBACK', () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
      }),
    ).toThrow(InvalidTransactionContractError);

    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Rollback,
      }),
    ).toThrow(InvalidTransactionContractError);
  });

  it('computes correct ledgerDirectionFor BET, WIN, REFUND, and ROLLBACK', () => {
    const betTx = WagerTransaction.create(baseProps);
    const winTx = WagerTransaction.create({
      ...baseProps,
      id: 'tx-win',
      kind: WagerTransactionKind.Win,
    });
    const refundTx = WagerTransaction.create({
      ...baseProps,
      id: 'tx-refund',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-1',
    });
    const rollbackTx = WagerTransaction.create({
      ...baseProps,
      id: 'tx-rollback',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-1',
    });

    expect(betTx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(winTx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refundTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
    // ROLLBACK of a BET is a CREDIT; ROLLBACK of a WIN is a DEBIT
    expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
    expect(rollbackTx.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);
  });

  it('computes identical canonical payloadHash regardless of key order and detects payload conflicts', () => {
    const hashA = computeWagerPayloadHash({
      providerId: 'provider-a',
      externalTransactionId: 'tx-100',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    const hashB = computeWagerPayloadHash({
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'tx-100',
      providerId: 'provider-a',
      money: { currency: 'BRL', amount: '25.00' },
    });

    const hashDifferentAmount = computeWagerPayloadHash({
      providerId: 'provider-a',
      externalTransactionId: 'tx-100',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashDifferentAmount);

    const tx = WagerTransaction.create({
      ...baseProps,
      payloadHash: hashA,
    });

    expect(tx.matchesPayload(hashB)).toBe(true);
    expect(tx.matchesPayload(hashDifferentAmount)).toBe(false);
  });
});
