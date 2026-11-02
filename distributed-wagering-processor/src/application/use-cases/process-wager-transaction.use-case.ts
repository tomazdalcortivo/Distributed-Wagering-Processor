import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InboxMessage } from '../../domain/entities/inbox-message';
import { OutboxMessage } from '../../domain/entities/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { Wallet } from '../../domain/entities/wallet';
import { LedgerDirection } from '../../domain/entities/wallet-ledger-entry';
import {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/integration-event';
import { computeWagerPayloadHash } from '../../domain/shared/canonical-json';
import {
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidTransactionContractError,
} from '../../domain/shared/domain-errors';
import { FailureCode } from '../../domain/shared/failure-code';
import { Money, MoneyProps } from '../../domain/value-objects/money';
import { StructuredLogger } from '../../infrastructure/observability/structured-logger.service';
import { METRICS_PORT, MetricsPort } from '../ports/metrics.port';
import {
  TransactionalContext,
  UNIT_OF_WORK_PORT,
  UnitOfWorkPort,
} from '../ports/unit-of-work.port';

export interface InboxExecutionContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: InboxExecutionContext;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
}

/**
 * Core Financial Wagering Processor Use Case (Sections 6, 7, 8, 9, 10, 11).
 *
 * Shared between HTTP (`POST /wagering/transactions`) and SQS (`wager-transactions.fifo`).
 *
 * Guarantees:
 * 1. Persistent idempotency via `idempotency_key` and `(provider_id, external_transaction_id)`.
 *    - Identical payload -> returns original result (`idempotentReplay: true`) with observed balance.
 *    - Divergent payload -> throws `IdempotencyConflictError` (HTTP 409).
 * 2. Persistent SQS Inbox deduplication by `(consumerName, messageId)` in the same SQL transaction.
 * 3. Per-wallet concurrency control via pessimistic row lock (`SELECT ... FOR UPDATE` on `wallets.id`)
 *    combined with optimistic version check (`UPDATE wallets ... WHERE id = $1 AND version = $2`).
 * 4. Atomic SQL transaction across Inbox, Wallet, WagerTransaction, WalletLedgerEntry, and Outbox.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
    @Inject(METRICS_PORT)
    private readonly metrics: MetricsPort,
    private readonly logger: StructuredLogger,
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const startTime = Date.now();
    const correlationId = command.correlationId ?? randomUUID();

    this.validateCommandContract(command);

    const money = Money.from(command.money);
    const payloadHash = computeWagerPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      const result = await this.executeTransactionalWithRaceRecovery(
        command,
        money,
        payloadHash,
        correlationId,
      );

      this.metrics.observeProcessingLatencyMs(
        `process_wager_${command.kind.toLowerCase()}`,
        Date.now() - startTime,
      );

      return result;
    } catch (err) {
      this.metrics.observeProcessingLatencyMs(
        `process_wager_error`,
        Date.now() - startTime,
      );
      throw err;
    }
  }

  private async executeTransactionalWithRaceRecovery(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    correlationId: string,
  ): Promise<ProcessWagerTransactionResult> {
    try {
      return await this.uow.runInTransaction(async (ctx) => {
        return this.processInsideTransaction(
          ctx,
          command,
          money,
          payloadHash,
          correlationId,
        );
      });
    } catch (err) {
      // If two concurrent requests with the exact same idempotencyKey raced to INSERT,
      // PostgreSQL aborts one transaction with 23505 unique_violation.
      // We recover deterministically in a fresh transaction and return the idempotent replay
      // (or throw IdempotencyConflictError if the payload hashes differ).
      if (this.isIdempotencyUniqueViolation(err)) {
        this.metrics.incrementLockConflict('idempotency_key_race');
        return await this.uow.runInTransaction(async (ctx) => {
          return this.processInsideTransaction(
            ctx,
            command,
            money,
            payloadHash,
            correlationId,
          );
        });
      }
      throw err;
    }
  }

  private async processInsideTransaction(
    ctx: TransactionalContext,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    correlationId: string,
  ): Promise<ProcessWagerTransactionResult> {
    const now = new Date();

    // 1. If triggered via SQS consumer, check/register persistent Inbox inside the SQL transaction
    let inboxRecord: InboxMessage | null = null;
    if (command.inboxContext) {
      inboxRecord = await ctx.inbox.findByConsumerAndMessageIdForUpdate(
        command.inboxContext.consumerName,
        command.inboxContext.messageId,
      );

      if (inboxRecord && inboxRecord.isProcessed()) {
        this.metrics.incrementDuplicateDetected('sqs_inbox');
        const existingTx = await this.findExistingTransaction(ctx, command);
        if (existingTx) {
          return this.buildReplayResult(ctx, existingTx, payloadHash);
        }
      }

      if (!inboxRecord) {
        inboxRecord = InboxMessage.receive({
          consumerName: command.inboxContext.consumerName,
          messageId: command.inboxContext.messageId,
          payloadHash: command.inboxContext.payloadHash,
          receivedAt: now,
        });
        await ctx.inbox.insert(inboxRecord);
      }
    }

    // 2. Check persistent idempotency key & (providerId, externalTransactionId)
    const existingByIdempotency = await this.findExistingTransaction(ctx, command);
    if (existingByIdempotency) {
      this.metrics.incrementDuplicateDetected('idempotency_key');
      const replay = await this.buildReplayResult(ctx, existingByIdempotency, payloadHash);
      if (inboxRecord && !inboxRecord.isProcessed()) {
        inboxRecord.markProcessed(now);
        await ctx.inbox.update(inboxRecord);
      }
      return replay;
    }

    // 3. Acquire pessimistic row-level lock on the target Wallet (`SELECT ... FOR UPDATE`).
    // This serializes concurrent operations on the same walletId across all instances
    // while allowing distinct wallets to execute in full parallelism.
    const wallet = await ctx.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) {
      throw new EntityNotFoundError('Wallet', command.walletId);
    }

    // Re-check idempotency after acquiring the wallet lock in case a sibling transaction
    // for the same wallet committed while we were waiting on the wallet lock.
    const existingAfterLock = await this.findExistingTransaction(ctx, command);
    if (existingAfterLock) {
      this.metrics.incrementDuplicateDetected('idempotency_key');
      const replay = await this.buildReplayResult(ctx, existingAfterLock, payloadHash);
      if (inboxRecord && !inboxRecord.isProcessed()) {
        inboxRecord.markProcessed(now);
        await ctx.inbox.update(inboxRecord);
      }
      return replay;
    }

    // 4. Instantiate WagerTransaction in PENDING status
    const tx = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    // 5. Apply domain & business rules (Section 7)
    const outboxEvents: IntegrationEvent<unknown>[] = [];

    // 5a. Validate wallet ownership and currency match
    if (wallet.playerId !== command.playerId) {
      tx.reject(FailureCode.WalletOwnershipMismatch, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      await this.persistFinalState(ctx, tx, inboxRecord, outboxEvents, now);
      return this.buildResultFromTransaction(tx, wallet.balance, false);
    }

    if (wallet.currency !== money.currency) {
      tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      await this.persistFinalState(ctx, tx, inboxRecord, outboxEvents, now);
      return this.buildResultFromTransaction(tx, wallet.balance, false);
    }

    // 5b. Execute operation-specific rules
    await this.applyOperationRules(
      ctx,
      wallet,
      tx,
      outboxEvents,
      correlationId,
      now,
    );

    await this.persistFinalState(ctx, tx, inboxRecord, outboxEvents, now);

    this.logger.info('Wager transaction processed', {
      correlationId,
      messageId: command.inboxContext?.messageId,
      transactionId: tx.id,
      walletId: wallet.id,
      providerId: tx.providerId,
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode,
    });

    return this.buildResultFromTransaction(tx, wallet.balance, false);
  }

  /**
   * Applies the domain rules for `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
   * Also reused by `ReprocessPendingReferencesUseCase` when a referenced transaction arrives.
   */
  public async applyOperationRules(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    outboxEvents: IntegrationEvent<unknown>[],
    correlationId: string,
    now: Date,
    isExistingPendingRef = false,
  ): Promise<void> {
    switch (tx.kind) {
      case WagerTransactionKind.Bet: {
        if (wallet.balance.isLessThan(tx.money)) {
          tx.reject(FailureCode.InsufficientFunds, now, wallet.balance);
          outboxEvents.push(
            WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
          );
          return;
        }

        const expectedVersion = wallet.version;
        const ledgerEntry = wallet.debit({
          ledgerEntryId: randomUUID(),
          transactionId: tx.id,
          amount: tx.money,
          at: now,
        });

        tx.markProcessed(undefined, now, wallet.balance);
        await ctx.wallets.updateWithVersion(wallet, expectedVersion);
        await this.saveOrUpdateTransaction(ctx, tx, isExistingPendingRef);
        await ctx.ledger.insert(ledgerEntry);

        outboxEvents.push(
          WalletBalanceChanged.from(wallet, ledgerEntry, {
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          }),
          WagerTransactionProcessed.from(tx, wallet.balance.toJSON(), {
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          }),
        );
        return;
      }

      case WagerTransactionKind.Win: {
        let resolvedBetId: string | undefined;
        if (tx.referenceExternalTransactionId) {
          const refBet = await ctx.transactions.findByProviderAndExternalId(
            tx.providerId,
            tx.referenceExternalTransactionId,
          );
          if (refBet) {
            if (
              refBet.walletId !== tx.walletId ||
              refBet.playerId !== tx.playerId ||
              refBet.roundId !== tx.roundId ||
              refBet.kind !== WagerTransactionKind.Bet
            ) {
              tx.reject(FailureCode.ReferenceContextMismatch, now, wallet.balance);
              outboxEvents.push(
                WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
              );
              return;
            }
            resolvedBetId = refBet.id;
          }
        }

        const expectedVersion = wallet.version;
        const ledgerEntry = wallet.credit({
          ledgerEntryId: randomUUID(),
          transactionId: tx.id,
          amount: tx.money,
          at: now,
        });

        tx.markProcessed(resolvedBetId, now, wallet.balance);
        await ctx.wallets.updateWithVersion(wallet, expectedVersion);
        await this.saveOrUpdateTransaction(ctx, tx, isExistingPendingRef);
        await ctx.ledger.insert(ledgerEntry);

        outboxEvents.push(
          WalletBalanceChanged.from(wallet, ledgerEntry, {
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          }),
          WagerTransactionProcessed.from(tx, wallet.balance.toJSON(), {
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          }),
        );
        return;
      }

      case WagerTransactionKind.Loss: {
        // LOSS records the round outcome without altering wallet balance or creating a ledger entry.
        // Wallet version is NOT incremented (Section 6.2 & Section 7).
        tx.markProcessed(undefined, now, wallet.balance);
        await this.saveOrUpdateTransaction(ctx, tx, isExistingPendingRef);

        outboxEvents.push(
          WagerTransactionProcessed.from(tx, wallet.balance.toJSON(), {
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          }),
        );
        return;
      }

      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback: {
        await this.applyReversalOperation(
          ctx,
          wallet,
          tx,
          outboxEvents,
          correlationId,
          now,
          isExistingPendingRef,
        );
        return;
      }

      default:
        throw new InvalidTransactionContractError(
          `Unsupported external transaction kind: "${String(tx.kind)}"`,
        );
    }
  }

  private async applyReversalOperation(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    outboxEvents: IntegrationEvent<unknown>[],
    correlationId: string,
    now: Date,
    isExistingPendingRef: boolean,
  ): Promise<void> {
    const refExternalId = tx.referenceExternalTransactionId!;
    const refTx = await ctx.transactions.findByProviderAndExternalId(
      tx.providerId,
      refExternalId,
    );

    // Rule 7.8 & 7.1: Missing reference or still-pending reference -> PENDING_REFERENCE
    if (
      !refTx ||
      refTx.status === WagerTransactionStatus.Pending ||
      refTx.status === WagerTransactionStatus.PendingReference
    ) {
      tx.schedulePendingReferenceRetry(now);
      outboxEvents.push(
        WagerTransactionPendingReference.from(tx, {
          correlationId,
          causationId: tx.id,
          occurredAt: now,
        }),
      );
      return;
    }

    // Rule 7.2: Reference must belong to the exact same provider, player, wallet, currency, and round
    if (
      refTx.providerId !== tx.providerId ||
      refTx.playerId !== tx.playerId ||
      refTx.walletId !== tx.walletId ||
      refTx.money.currency !== tx.money.currency ||
      refTx.roundId !== tx.roundId
    ) {
      tx.reject(FailureCode.ReferenceContextMismatch, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      return;
    }

    // Rule 7.3: REFUND only references BET. ROLLBACK references BET, WIN, or REFUND.
    const validRefKind =
      tx.kind === WagerTransactionKind.Refund
        ? refTx.kind === WagerTransactionKind.Bet
        : refTx.kind === WagerTransactionKind.Bet ||
          refTx.kind === WagerTransactionKind.Win ||
          refTx.kind === WagerTransactionKind.Refund;

    if (!validRefKind) {
      tx.reject(FailureCode.InvalidReferenceKind, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      return;
    }

    // Referenced transaction must be PROCESSED
    if (refTx.status !== WagerTransactionStatus.Processed) {
      tx.reject(FailureCode.ReferenceNotProcessed, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      return;
    }

    // Rule 7.5: Amount of REFUND/ROLLBACK must equal the referenced transaction amount
    if (!tx.money.equals(refTx.money)) {
      tx.reject(FailureCode.ReferenceAmountMismatch, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      return;
    }

    // Rule 7.4: Referenced transaction cannot be reversed twice
    const existingReversal = await ctx.transactions.findProcessedReversalForReference(
      refTx.id,
    );
    if (existingReversal && existingReversal.id !== tx.id) {
      tx.reject(FailureCode.ReferenceAlreadyReversed, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      return;
    }

    // Determine ledger direction for this reversal
    const direction = tx.ledgerDirectionFor(refTx);

    // Rule 7.9: Reversal that would produce a negative balance is explicitly rejected
    // with a distinct failureCode (`REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` != `INSUFFICIENT_FUNDS`).
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
      tx.reject(FailureCode.ReversalWouldCauseNegativeBalance, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { correlationId, occurredAt: now }),
      );
      return;
    }

    const expectedVersion = wallet.version;
    const ledgerEntry =
      direction === LedgerDirection.Credit
        ? wallet.credit({
            ledgerEntryId: randomUUID(),
            transactionId: tx.id,
            amount: tx.money,
            at: now,
          })
        : wallet.debit({
            ledgerEntryId: randomUUID(),
            transactionId: tx.id,
            amount: tx.money,
            at: now,
          });

    tx.markProcessed(refTx.id, now, wallet.balance);
    await ctx.wallets.updateWithVersion(wallet, expectedVersion);
    await this.saveOrUpdateTransaction(ctx, tx, isExistingPendingRef);
    await ctx.ledger.insert(ledgerEntry);

    outboxEvents.push(
      WalletBalanceChanged.from(wallet, ledgerEntry, {
        correlationId,
        causationId: tx.id,
        occurredAt: now,
      }),
      WagerTransactionProcessed.from(tx, wallet.balance.toJSON(), {
        correlationId,
        causationId: tx.id,
        occurredAt: now,
      }),
    );
  }

  private async saveOrUpdateTransaction(
    ctx: TransactionalContext,
    tx: WagerTransaction,
    isExistingPendingRef: boolean,
  ): Promise<void> {
    if (isExistingPendingRef) {
      await ctx.transactions.update(tx);
    } else {
      await ctx.transactions.insert(tx);
    }
  }

  private async persistFinalState(
    ctx: TransactionalContext,
    tx: WagerTransaction,
    inboxRecord: InboxMessage | null,
    outboxEvents: IntegrationEvent<unknown>[],
    now: Date,
  ): Promise<void> {
    // Note: when tx is PROCESSED and affects balance (or is LOSS), saveOrUpdateTransaction was already
    // executed prior to ledger insertion so the foreign key `wallet_ledger_entries.transaction_id` is satisfied.
    if (
      tx.status === WagerTransactionStatus.Rejected ||
      tx.status === WagerTransactionStatus.Failed ||
      tx.status === WagerTransactionStatus.PendingReference
    ) {
      await ctx.transactions.insert(tx);
    }

    if (inboxRecord) {
      inboxRecord.markProcessed(now);
      await ctx.inbox.update(inboxRecord);
    }

    if (outboxEvents.length > 0) {
      await ctx.outbox.insertMany(outboxEvents.map((e) => OutboxMessage.enqueue(e)));
    }

    this.metrics.incrementTransactionStatus(tx.status, tx.kind);
  }

  private async findExistingTransaction(
    ctx: TransactionalContext,
    command: ProcessWagerTransactionCommand,
  ): Promise<WagerTransaction | null> {
    const byKey = await ctx.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (byKey) {
      return byKey;
    }
    return ctx.transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );
  }

  private async buildReplayResult(
    ctx: TransactionalContext,
    existingTx: WagerTransaction,
    incomingPayloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    // Section 6.3 & Section 9: same idempotencyKey (or provider+externalId) with different payload -> conflict!
    if (
      !existingTx.matchesPayload(incomingPayloadHash) ||
      existingTx.idempotencyKey !== existingTx.idempotencyKey
    ) {
      throw new IdempotencyConflictError(existingTx.idempotencyKey);
    }

    // Rule 7.7: Replaying an already processed operation returns the original result,
    // including the balance observed at that moment.
    let observedBalance = existingTx.observedBalance;
    if (!observedBalance) {
      const ledgerEntry = await ctx.ledger.findByTransactionId(existingTx.id);
      if (ledgerEntry) {
        observedBalance = ledgerEntry.balanceAfter;
      } else {
        const wallet = await ctx.wallets.findById(existingTx.walletId);
        observedBalance = wallet ? wallet.balance : Money.zero(existingTx.money.currency);
      }
    }

    return this.buildResultFromTransaction(existingTx, observedBalance, true);
  }

  private buildResultFromTransaction(
    tx: WagerTransaction,
    observedBalance: Money,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: (tx.observedBalance ?? observedBalance).toJSON(),
      idempotentReplay,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      ...(tx.referenceTransactionId
        ? { referenceTransactionId: tx.referenceTransactionId }
        : {}),
    };
  }

  private validateCommandContract(command: ProcessWagerTransactionCommand): void {
    if (!command.idempotencyKey || !command.idempotencyKey.trim()) {
      throw new InvalidTransactionContractError('Idempotency-Key header is required');
    }
    if (!command.providerId || !command.providerId.trim()) {
      throw new InvalidTransactionContractError('providerId is required');
    }
    if (!command.externalTransactionId || !command.externalTransactionId.trim()) {
      throw new InvalidTransactionContractError('externalTransactionId is required');
    }
    if (!command.playerId || !command.playerId.trim()) {
      throw new InvalidTransactionContractError('playerId is required');
    }
    if (!command.walletId || !command.walletId.trim()) {
      throw new InvalidTransactionContractError('walletId is required');
    }
    if (!command.roundId || !command.roundId.trim()) {
      throw new InvalidTransactionContractError('roundId is required');
    }
    if (!command.gameId || !command.gameId.trim()) {
      throw new InvalidTransactionContractError('gameId is required');
    }
    const allowedExternalKinds: string[] = [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ];
    if (!allowedExternalKinds.includes(command.kind)) {
      throw new InvalidTransactionContractError(
        `Invalid transaction kind "${String(command.kind)}": must be one of BET, WIN, LOSS, REFUND, ROLLBACK`,
      );
    }
  }

  private isIdempotencyUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? '';
    return (
      code === '23505' &&
      (message.includes('uq_wager_tx_idempotency_key') ||
        message.includes('uq_wager_tx_provider_external_id'))
    );
  }
}
