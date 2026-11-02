import { InboxMessage } from '../../domain/entities/inbox-message';
import { OutboxMessage } from '../../domain/entities/outbox-message';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { Wallet } from '../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';

export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  updateWithVersion(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findProcessedReversalForReference(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | null>;
  claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerPageResult {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface WalletLedgerRepositoryPort {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  listByWalletCursor(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPageResult>;
  getAllByWalletOrdered(walletId: string): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepositoryPort {
  findByConsumerAndMessageIdForUpdate(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<void>;
  update(message: InboxMessage): Promise<void>;
}

export interface OutboxRepositoryPort {
  insertMany(messages: OutboxMessage[]): Promise<void>;
  claimPendingBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): Promise<void>;
  countPendingLag(now: Date): Promise<number>;
}

export interface TransactionalContext {
  readonly wallets: WalletRepositoryPort;
  readonly transactions: WagerTransactionRepositoryPort;
  readonly ledger: WalletLedgerRepositoryPort;
  readonly inbox: InboxRepositoryPort;
  readonly outbox: OutboxRepositoryPort;
}

export const UNIT_OF_WORK_PORT = Symbol('UNIT_OF_WORK_PORT');

export interface UnitOfWorkPort {
  runInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
  getReadContext(): TransactionalContext;
}
export const UnitOfWorkPort = UNIT_OF_WORK_PORT;
