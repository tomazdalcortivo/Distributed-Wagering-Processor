import { Inject, Injectable } from '@nestjs/common';
import { EntityNotFoundError, InvalidTransactionContractError } from '../../domain/shared/domain-errors';
import { MoneyProps } from '../../domain/value-objects/money';
import { UNIT_OF_WORK_PORT, UnitOfWorkPort } from '../ports/unit-of-work.port';

export interface WalletViewDto {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryViewDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface PaginatedLedgerViewDto {
  walletId: string;
  items: LedgerEntryViewDto[];
  nextCursor: string | null;
}

export interface WagerTransactionViewDto {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  balance?: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  createdAt: string;
  processedAt?: string;
}

@Injectable()
export class QueryWageringUseCases {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async getWalletById(walletId: string): Promise<WalletViewDto> {
    const ctx = this.uow.getReadContext();
    const wallet = await ctx.wallets.findById(walletId);
    if (!wallet) {
      throw new EntityNotFoundError('Wallet', walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  async getWalletLedger(
    walletId: string,
    cursor: string | undefined,
    limit = 50,
  ): Promise<PaginatedLedgerViewDto> {
    if (limit < 1 || limit > 200 || !Number.isInteger(limit)) {
      throw new InvalidTransactionContractError('limit must be an integer between 1 and 200');
    }

    const ctx = this.uow.getReadContext();
    const wallet = await ctx.wallets.findById(walletId);
    if (!wallet) {
      throw new EntityNotFoundError('Wallet', walletId);
    }

    const page = await ctx.ledger.listByWalletCursor(walletId, cursor, limit);
    return {
      walletId,
      items: page.items.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async getTransactionById(transactionId: string): Promise<WagerTransactionViewDto> {
    const ctx = this.uow.getReadContext();
    const tx = await ctx.transactions.findById(transactionId);
    if (!tx) {
      throw new EntityNotFoundError('WagerTransaction', transactionId);
    }
    return this.toTransactionDto(tx);
  }

  async getTransactionByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionViewDto> {
    const ctx = this.uow.getReadContext();
    const tx = await ctx.transactions.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new EntityNotFoundError(
        'WagerTransaction',
        `${providerId}:${externalTransactionId}`,
      );
    }
    return this.toTransactionDto(tx);
  }

  private toTransactionDto(
    tx: Awaited<ReturnType<ReturnType<UnitOfWorkPort['getReadContext']>['transactions']['findById']>> & object,
  ): WagerTransactionViewDto {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      money: tx.money.toJSON(),
      ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
      ...(tx.referenceExternalTransactionId
        ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
        : {}),
      ...(tx.referenceTransactionId
        ? { referenceTransactionId: tx.referenceTransactionId }
        : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      createdAt: tx.createdAt.toISOString(),
      ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
    };
  }
}
