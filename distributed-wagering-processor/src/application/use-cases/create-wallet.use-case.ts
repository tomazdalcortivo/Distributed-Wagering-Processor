import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OutboxMessage } from '../../domain/entities/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction';
import { Wallet } from '../../domain/entities/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../domain/events/integration-event';
import { computeWagerPayloadHash } from '../../domain/shared/canonical-json';
import { DuplicateWalletError } from '../../domain/shared/domain-errors';
import { Money, MoneyProps } from '../../domain/value-objects/money';
import { UNIT_OF_WORK_PORT, UnitOfWorkPort } from '../ports/unit-of-work.port';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Creates a new Wallet for `(playerId, currency)` (Section 9).
 *
 * When `initialBalance > 0.00`, atomically creates an internal `OPENING` WagerTransaction
 * in `PROCESSED` state and a `CREDIT` WalletLedgerEntry in the exact same SQL transaction,
 * keeping `wallet.version = 1` and `wallet.balance === sum(ledger)`.
 */
@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    if (!command.playerId || typeof command.playerId !== 'string' || !command.playerId.trim()) {
      throw new Error('playerId must be a non-empty UUID string');
    }

    const initialMoney = Money.from(command.initialBalance);
    const correlationId = command.correlationId ?? randomUUID();
    const now = new Date();

    return this.uow.runInTransaction(async (ctx) => {
      const existing = await ctx.wallets.findByPlayerAndCurrency(
        command.playerId,
        initialMoney.currency,
      );
      if (existing) {
        throw new DuplicateWalletError(command.playerId, initialMoney.currency);
      }

      const walletId = randomUUID();
      const wallet = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: initialMoney,
        createdAt: now,
      });

      try {
        await ctx.wallets.insert(wallet);
      } catch (err) {
        if (this.isUniqueConstraintViolation(err)) {
          throw new DuplicateWalletError(command.playerId, initialMoney.currency);
        }
        throw err;
      }

      if (initialMoney.isPositive()) {
        const openingTxId = randomUUID();
        const externalTxId = `opening:${walletId}`;
        const idempotencyKey = `internal:opening:${walletId}`;
        const payloadHash = computeWagerPayloadHash({
          providerId: 'internal-system',
          externalTransactionId: externalTxId,
          playerId: command.playerId,
          walletId,
          roundId: `opening-round:${walletId}`,
          gameId: 'wallet-opening',
          kind: WagerTransactionKind.Opening,
          money: initialMoney.toJSON(),
        });

        const openingTx = WagerTransaction.create({
          id: openingTxId,
          providerId: 'internal-system',
          externalTransactionId: externalTxId,
          idempotencyKey,
          payloadHash,
          walletId,
          playerId: command.playerId,
          roundId: `opening-round:${walletId}`,
          gameId: 'wallet-opening',
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
          createdAt: now,
          allowInternalOpening: true,
        });

        openingTx.markProcessed(undefined, now, initialMoney);
        await ctx.transactions.insert(openingTx);

        const openingEntry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId,
          transactionId: openingTxId,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: Money.zero(initialMoney.currency),
          balanceAfter: initialMoney,
          createdAt: now,
        });

        await ctx.ledger.insert(openingEntry);

        const balanceEvent = WalletBalanceChanged.from(wallet, openingEntry, {
          correlationId,
          causationId: openingTxId,
          occurredAt: now,
        });
        const processedEvent = WagerTransactionProcessed.from(
          openingTx,
          initialMoney.toJSON(),
          {
            correlationId,
            causationId: openingTxId,
            occurredAt: now,
          },
        );

        await ctx.outbox.insertMany([
          OutboxMessage.enqueue(balanceEvent),
          OutboxMessage.enqueue(processedEvent),
        ]);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  private isUniqueConstraintViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? '';
    return code === '23505' || message.includes('uq_wallets_player_currency');
  }
}
