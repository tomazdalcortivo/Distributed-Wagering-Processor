import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { QueryWageringUseCases } from '../../src/application/use-cases/query-wagering.use-cases';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction';
import { IdempotencyConflictError } from '../../src/domain/shared/domain-errors';
import { FailureCode } from '../../src/domain/shared/failure-code';
import { SqsWagerConsumerWorker } from '../../src/infrastructure/messaging/sqs-wager-consumer.worker';
import { TransactionalOutboxWorker } from '../../src/infrastructure/messaging/transactional-outbox.worker';
import {
  createRealInfraTestHarness,
  TestHarness,
} from '../helpers/real-infra-harness';

describe('Integration Tests — PostgreSQL & LocalStack SQS (Section 13)', () => {
  let harness: TestHarness;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;
  let queryWagering: QueryWageringUseCases;
  let sqsConsumer: SqsWagerConsumerWorker;
  let outboxWorker: TransactionalOutboxWorker;

  beforeAll(async () => {
    harness = await createRealInfraTestHarness();
    createWallet = harness.app.get(CreateWalletUseCase);
    processWager = harness.app.get(ProcessWagerTransactionUseCase);
    reconcileWallet = harness.app.get(ReconcileWalletUseCase);
    queryWagering = harness.app.get(QueryWageringUseCases);
    sqsConsumer = harness.app.get(SqsWagerConsumerWorker);
    outboxWorker = harness.app.get(TransactionalOutboxWorker);
  });

  beforeEach(async () => {
    await harness.resetDatabaseAndQueues();
  });

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  });

  it('enforces database-level ledger immutability and non-negative balance constraints', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '500.00', currency: 'BRL' },
    });

    const conn = harness.orm.em.getConnection();

    // 1. Direct SQL attempt to set negative balance must fail via chk_wallets_balance_non_negative
    await expect(
      conn.execute(`UPDATE wallets SET balance_amount = -1.00 WHERE id = ?`, [
        wallet.id,
      ]),
    ).rejects.toThrow();

    // 2. Direct SQL attempt to UPDATE or DELETE wallet_ledger_entries must fail via trigger
    await expect(
      conn.execute(
        `UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = ?`,
        [wallet.id],
      ),
    ).rejects.toThrow(/strictly append-only/);

    await expect(
      conn.execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [
        wallet.id,
      ]),
    ).rejects.toThrow(/strictly append-only/);
  });

  it('processes BET, WIN, LOSS, REFUND, and ROLLBACK while keeping wallet, ledger, and outbox consistent', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '200.00', currency: 'BRL' },
    });

    // 1. BET 50.00 -> balance 150.00
    const betRes = await processWager.execute({
      idempotencyKey: 'prov-1:bet-1',
      providerId: 'prov-1',
      externalTransactionId: 'bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);
    expect(betRes.balance.amount).toBe('150.00');
    expect(betRes.idempotentReplay).toBe(false);

    // 2. WIN 120.00 -> balance 270.00
    const winRes = await processWager.execute({
      idempotencyKey: 'prov-1:win-1',
      providerId: 'prov-1',
      externalTransactionId: 'win-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '120.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(winRes.status).toBe(WagerTransactionStatus.Processed);
    expect(winRes.balance.amount).toBe('270.00');

    // 3. LOSS 0.00 -> balance stays 270.00, no ledger entry created
    const lossRes = await processWager.execute({
      idempotencyKey: 'prov-1:loss-2',
      providerId: 'prov-1',
      externalTransactionId: 'loss-2',
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(lossRes.status).toBe(WagerTransactionStatus.Processed);
    expect(lossRes.balance.amount).toBe('270.00');

    // 4. Replaying the initial BET returns the historical observed balance (150.00) with idempotentReplay: true
    const betReplay = await processWager.execute({
      idempotencyKey: 'prov-1:bet-1',
      providerId: 'prov-1',
      externalTransactionId: 'bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(betReplay.idempotentReplay).toBe(true);
    expect(betReplay.balance.amount).toBe('150.00');

    // 5. Same idempotencyKey with different amount throws IdempotencyConflictError
    await expect(
      processWager.execute({
        idempotencyKey: 'prov-1:bet-1',
        providerId: 'prov-1',
        externalTransactionId: 'bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '55.00', currency: 'BRL' },
      }),
    ).rejects.toThrow(IdempotencyConflictError);

    // 6. REFUND of bet-1 (+50.00) -> balance 320.00
    const refundRes = await processWager.execute({
      idempotencyKey: 'prov-1:refund-1',
      providerId: 'prov-1',
      externalTransactionId: 'refund-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(refundRes.status).toBe(WagerTransactionStatus.Processed);
    expect(refundRes.balance.amount).toBe('320.00');

    // 7. Second REFUND of the same bet-1 is REJECTED with REFERENCE_ALREADY_REVERSED
    const duplicateRefund = await processWager.execute({
      idempotencyKey: 'prov-1:refund-duplicate',
      providerId: 'prov-1',
      externalTransactionId: 'refund-duplicate',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(duplicateRefund.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicateRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(duplicateRefund.balance.amount).toBe('320.00');

    // 8. Reconcile wallet & verify cursor pagination
    const reconciliation = await reconcileWallet.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('320.00');
    expect(reconciliation.calculatedBalance.amount).toBe('320.00');
    // Entries: OPENING (+200), BET (-50), WIN (+120), REFUND (+50) = 4 entries
    expect(reconciliation.checkedEntries).toBe(4);

    const page1 = await queryWagering.getWalletLedger(wallet.id, undefined, 2);
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await queryWagering.getWalletLedger(
      wallet.id,
      page1.nextCursor!,
      2,
    );
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeNull();
  });

  it('routes malformed SQS messages to DLQ and publishes outbox events to SQS', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // Send malformed message to SQS consumer handler -> must route to DLQ
    await sqsConsumer.handleSqsMessage({
      MessageId: 'bad-msg-1',
      Body: '{"invalid_envelope": true}',
    });

    const dlqUrl =
      process.env.SQS_WAGER_DLQ_URL ??
      'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
    const dlqMessages = await harness.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 5,
        MessageAttributeNames: ['All'],
      }),
    );
    expect((dlqMessages.Messages ?? []).length).toBeGreaterThanOrEqual(1);

    // Publish pending outbox events created by wallet opening
    const published = await outboxWorker.processPendingOutboxBatch(50);
    expect(published).toBeGreaterThanOrEqual(2);

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
  });
});
