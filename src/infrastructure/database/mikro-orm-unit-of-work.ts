import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  type InboxRepositoryPort,
  type LedgerPageResult,
  type OutboxRepositoryPort,
  type TransactionalContext,
  type UnitOfWorkPort,
  type WagerTransactionRepositoryPort,
  type WalletLedgerRepositoryPort,
  type WalletRepositoryPort,
} from '../../application/ports/unit-of-work.port';
import { InboxMessage } from '../../domain/entities/inbox-message';
import { OutboxMessage } from '../../domain/entities/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { Wallet } from '../../domain/entities/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import {
  ConcurrencyConflictError,
  InvalidTransactionContractError,
} from '../../domain/shared/domain-errors';
import { FailureCode } from '../../domain/shared/failure-code';
import { Money } from '../../domain/value-objects/money';

function execSql<T = Record<string, unknown>[]>(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
  method: 'all' | 'get' | 'run' = 'all',
): Promise<T> {
  return em
    .getConnection()
    .execute(sql, params, method, em.getTransactionContext()) as Promise<T>;
}

class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wallets WHERE id = ? LIMIT 1`,
      [id],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wallets WHERE id = ? LIMIT 1 FOR UPDATE`,
      [id],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wallets WHERE player_id = ? AND currency = ? LIMIT 1`,
      [playerId, currency],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await execSql(
      this.em,
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
      'run',
    );
  }

  async updateWithVersion(wallet: Wallet, expectedVersion: number): Promise<void> {
    const res = await execSql<{ affectedRows?: number }>(
      this.em,
      `UPDATE wallets
       SET balance_amount = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
      [
        wallet.balance.amount,
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        expectedVersion,
      ],
      'run',
    );

    if ((res.affectedRows ?? 0) !== 1) {
      throw new ConcurrencyConflictError(wallet.id);
    }
  }

  private rawRowToDomain(raw: Record<string, unknown>): Wallet {
    const currency = String(raw.currency);
    return Wallet.rehydrate({
      id: String(raw.id),
      playerId: String(raw.player_id),
      currency,
      balance: Money.rehydrate({
        amount: String(raw.balance_amount),
        currency,
      }),
      version: Number(raw.version),
      createdAt: new Date(raw.created_at as string | Date),
      updatedAt: new Date(raw.updated_at as string | Date),
    });
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wager_transactions WHERE id = ? LIMIT 1`,
      [id],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wager_transactions WHERE id = ? LIMIT 1 FOR UPDATE`,
      [id],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wager_transactions WHERE idempotency_key = ? LIMIT 1`,
      [idempotencyKey],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ? LIMIT 1`,
      [providerId, externalTransactionId],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async findProcessedReversalForReference(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT *
       FROM wager_transactions
       WHERE reference_transaction_id = ?
         AND status = 'PROCESSED'
         AND kind IN ('REFUND', 'ROLLBACK')
       LIMIT 1`,
      [referenceTransactionId],
      'all',
    );
    if (!rows || rows.length === 0) return null;
    return this.rawRowToDomain(rows[0]!);
  }

  async claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT *
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY COALESCE(next_retry_at, created_at) ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
      'all',
    );
    return (rows ?? []).map((r) => this.rawRowToDomain(r));
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await execSql(
      this.em,
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
        reference_external_transaction_id, reference_transaction_id,
        observed_balance_amount, failure_code, retry_count, next_retry_at,
        created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        tx.status,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.observedBalance ? tx.observedBalance.amount : null,
        tx.failureCode ?? null,
        tx.retryCount,
        tx.nextRetryAt ?? null,
        tx.createdAt,
        tx.processedAt ?? null,
      ],
      'run',
    );
  }

  async update(tx: WagerTransaction): Promise<void> {
    await execSql(
      this.em,
      `UPDATE wager_transactions
       SET status = ?,
           reference_transaction_id = ?,
           observed_balance_amount = ?,
           failure_code = ?,
           retry_count = ?,
           next_retry_at = ?,
           processed_at = ?
       WHERE id = ?`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.observedBalance ? tx.observedBalance.amount : null,
        tx.failureCode ?? null,
        tx.retryCount,
        tx.nextRetryAt ?? null,
        tx.processedAt ?? null,
        tx.id,
      ],
      'run',
    );
  }

  private rawRowToDomain(raw: Record<string, unknown>): WagerTransaction {
    const currency = String(raw.currency);
    const amount = String(raw.amount);
    const observedRaw = raw.observed_balance_amount;

    return WagerTransaction.rehydrate({
      id: String(raw.id),
      providerId: String(raw.provider_id),
      externalTransactionId: String(raw.external_transaction_id),
      idempotencyKey: String(raw.idempotency_key),
      payloadHash: String(raw.payload_hash),
      walletId: String(raw.wallet_id),
      playerId: String(raw.player_id),
      roundId: String(raw.round_id),
      gameId: String(raw.game_id),
      kind: String(raw.kind) as WagerTransactionKind,
      money: Money.rehydrate({ amount, currency }),
      referenceExternalTransactionId: raw.reference_external_transaction_id
        ? String(raw.reference_external_transaction_id)
        : undefined,
      createdAt: new Date(raw.created_at as string | Date),
      status: String(raw.status) as WagerTransactionStatus,
      referenceTransactionId: raw.reference_transaction_id
        ? String(raw.reference_transaction_id)
        : undefined,
      observedBalance:
        observedRaw !== null && observedRaw !== undefined
          ? Money.rehydrate({ amount: String(observedRaw), currency })
          : undefined,
      failureCode: raw.failure_code ? (String(raw.failure_code) as FailureCode) : undefined,
      processedAt: raw.processed_at ? new Date(raw.processed_at as string | Date) : undefined,
      retryCount: Number(raw.retry_count ?? 0),
      nextRetryAt: raw.next_retry_at ? new Date(raw.next_retry_at as string | Date) : undefined,
    });
  }
}

class MikroOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await execSql(
      this.em,
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.amount,
        entry.money.currency,
        entry.balanceBefore.amount,
        entry.balanceAfter.amount,
        entry.createdAt,
      ],
      'run',
    );
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT * FROM wallet_ledger_entries WHERE transaction_id = ? LIMIT 1`,
      [transactionId],
      'all',
    );
    return rows && rows.length > 0 ? this.rawRowToDomain(rows[0]!) : null;
  }

  async listByWalletCursor(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPageResult> {
    let beforeSequence: bigint | undefined;
    if (cursor) {
      beforeSequence = this.decodeCursor(cursor);
    }

    const fetchLimit = limit + 1;
    const rows = beforeSequence
      ? await execSql<Record<string, unknown>[]>(
          this.em,
          `SELECT *
           FROM wallet_ledger_entries
           WHERE wallet_id = ? AND sequence_number < ?
           ORDER BY sequence_number DESC
           LIMIT ?`,
          [walletId, beforeSequence.toString(), fetchLimit],
          'all',
        )
      : await execSql<Record<string, unknown>[]>(
          this.em,
          `SELECT *
           FROM wallet_ledger_entries
           WHERE wallet_id = ?
           ORDER BY sequence_number DESC
           LIMIT ?`,
          [walletId, fetchLimit],
          'all',
        );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const items = slice.map((r) => this.rawRowToDomain(r));
    const lastItem = items[items.length - 1];
    const nextCursor =
      hasMore && lastItem?.sequenceNumber !== undefined
        ? this.encodeCursor(lastItem.sequenceNumber)
        : null;

    return { items, nextCursor };
  }

  async getAllByWalletOrdered(walletId: string): Promise<WalletLedgerEntry[]> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT *
       FROM wallet_ledger_entries
       WHERE wallet_id = ?
       ORDER BY sequence_number ASC`,
      [walletId],
      'all',
    );
    return (rows ?? []).map((r) => this.rawRowToDomain(r));
  }

  private encodeCursor(sequenceNumber: bigint): string {
    return Buffer.from(`seq:${sequenceNumber.toString()}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): bigint {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      if (!decoded.startsWith('seq:')) {
        throw new Error('Malformed cursor prefix');
      }
      return BigInt(decoded.slice(4));
    } catch {
      throw new InvalidTransactionContractError(`Invalid pagination cursor "${cursor}"`);
    }
  }

  private rawRowToDomain(raw: Record<string, unknown>): WalletLedgerEntry {
    const currency = String(raw.currency);
    return WalletLedgerEntry.rehydrate({
      id: String(raw.id),
      walletId: String(raw.wallet_id),
      transactionId: String(raw.transaction_id),
      direction: String(raw.direction) as LedgerDirection,
      money: Money.rehydrate({ amount: String(raw.amount), currency }),
      balanceBefore: Money.rehydrate({
        amount: String(raw.balance_before),
        currency,
      }),
      balanceAfter: Money.rehydrate({
        amount: String(raw.balance_after),
        currency,
      }),
      createdAt: new Date(raw.created_at as string | Date),
      sequenceNumber:
        raw.sequence_number !== undefined && raw.sequence_number !== null
          ? BigInt(String(raw.sequence_number))
          : undefined,
    });
  }
}

class MikroOrmInboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findByConsumerAndMessageIdForUpdate(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT *
       FROM inbox_messages
       WHERE consumer_name = ? AND message_id = ?
       LIMIT 1
       FOR UPDATE`,
      [consumerName, messageId],
      'all',
    );
    if (!rows || rows.length === 0) return null;
    const raw = rows[0]!;
    return InboxMessage.rehydrate({
      consumerName: String(raw.consumer_name),
      messageId: String(raw.message_id),
      payloadHash: String(raw.payload_hash),
      receivedAt: new Date(raw.received_at as string | Date),
      processedAt: raw.processed_at ? new Date(raw.processed_at as string | Date) : undefined,
    });
  }

  async insert(message: InboxMessage): Promise<void> {
    await execSql(
      this.em,
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
      'run',
    );
  }

  async update(message: InboxMessage): Promise<void> {
    await execSql(
      this.em,
      `UPDATE inbox_messages
       SET processed_at = ?
       WHERE consumer_name = ? AND message_id = ?`,
      [message.processedAt ?? null, message.consumerName, message.messageId],
      'run',
    );
  }
}

class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insertMany(messages: OutboxMessage[]): Promise<void> {
    for (const msg of messages) {
      await execSql(
        this.em,
        `INSERT INTO outbox_messages (
          id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
        ) VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
        [
          msg.id,
          msg.aggregateId,
          msg.eventType,
          JSON.stringify(msg.payload),
          msg.occurredAt,
          msg.attempts,
          msg.nextAttemptAt ?? null,
          msg.publishedAt ?? null,
        ],
        'run',
      );
    }
  }

  async claimPendingBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await execSql<Record<string, unknown>[]>(
      this.em,
      `SELECT *
       FROM outbox_messages
       WHERE published_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY COALESCE(next_attempt_at, occurred_at) ASC, occurred_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
      'all',
    );

    return (rows ?? []).map((raw) =>
      OutboxMessage.rehydrate({
        id: String(raw.id),
        aggregateId: String(raw.aggregate_id),
        eventType: String(raw.event_type),
        payload:
          typeof raw.payload === 'string'
            ? (JSON.parse(raw.payload) as Record<string, unknown>)
            : (raw.payload as Record<string, unknown>),
        occurredAt: new Date(raw.occurred_at as string | Date),
        attempts: Number(raw.attempts ?? 0),
        nextAttemptAt: raw.next_attempt_at
          ? new Date(raw.next_attempt_at as string | Date)
          : undefined,
        publishedAt: raw.published_at
          ? new Date(raw.published_at as string | Date)
          : undefined,
      }),
    );
  }

  async update(message: OutboxMessage): Promise<void> {
    await execSql(
      this.em,
      `UPDATE outbox_messages
       SET attempts = ?, next_attempt_at = ?, published_at = ?
       WHERE id = ?`,
      [
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
        message.id,
      ],
      'run',
    );
  }

  async countPendingLag(_now: Date): Promise<number> {
    const rows = await execSql<{ count: string }[]>(
      this.em,
      `SELECT COUNT(*)::text AS count
       FROM outbox_messages
       WHERE published_at IS NULL`,
      [],
      'all',
    );
    return Number(rows?.[0]?.count ?? 0);
  }
}

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly em: EntityManager) {}

  async runInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.em.fork().transactional(async (txEm) => {
      const ctx = this.createContext(txEm);
      return work(ctx);
    });
  }

  getReadContext(): TransactionalContext {
    return this.createContext(this.em.fork());
  }

  private createContext(scopedEm: EntityManager): TransactionalContext {
    return {
      wallets: new MikroOrmWalletRepository(scopedEm),
      transactions: new MikroOrmWagerTransactionRepository(scopedEm),
      ledger: new MikroOrmWalletLedgerRepository(scopedEm),
      inbox: new MikroOrmInboxRepository(scopedEm),
      outbox: new MikroOrmOutboxRepository(scopedEm),
    };
  }
}
