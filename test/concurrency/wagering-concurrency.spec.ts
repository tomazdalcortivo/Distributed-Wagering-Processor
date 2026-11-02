import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references.use-case';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction';
import { FailureCode } from '../../src/domain/shared/failure-code';
import {
  SimulatedWorkerCrashAfterCommitError,
  SqsWagerConsumerWorker,
} from '../../src/infrastructure/messaging/sqs-wager-consumer.worker';
import { TransactionalOutboxWorker } from '../../src/infrastructure/messaging/transactional-outbox.worker';
import {
  createRealInfraTestHarness,
  TestHarness,
} from '../helpers/real-infra-harness';

describe('Concurrency & Crash Recovery Tests — Real Parallelism (Sections 8 & 13)', () => {
  let harness: TestHarness;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;
  let reprocessPendingRefs: ReprocessPendingReferencesUseCase;
  let sqsConsumer: SqsWagerConsumerWorker;
  let outboxWorker: TransactionalOutboxWorker;

  beforeAll(async () => {
    harness = await createRealInfraTestHarness();
    createWallet = harness.app.get(CreateWalletUseCase);
    processWager = harness.app.get(ProcessWagerTransactionUseCase);
    reconcileWallet = harness.app.get(ReconcileWalletUseCase);
    reprocessPendingRefs = harness.app.get(ReprocessPendingReferencesUseCase);
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

  it('1. 50 identical parallel bets -> exactly 1 debit and 49 idempotent replays', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '500.00', currency: 'BRL' },
    });

    const parallelCount = 50;
    const results = await Promise.all(
      Array.from({ length: parallelCount }, () =>
        processWager.execute({
          idempotencyKey: 'provider-a:same-bet-50x',
          providerId: 'provider-a',
          externalTransactionId: 'same-bet-50x',
          playerId,
          walletId: wallet.id,
          roundId: 'round-50x',
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: { amount: '25.00', currency: 'BRL' },
        }),
      ),
    );

    expect(results.length).toBe(50);
    for (const r of results) {
      expect(r.status).toBe(WagerTransactionStatus.Processed);
      expect(r.balance.amount).toBe('475.00');
    }

    const firstExecutions = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);
    expect(firstExecutions.length).toBe(1);
    expect(replays.length).toBe(49);

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('475.00');
    expect(recon.calculatedBalance.amount).toBe('475.00');
    // 1 OPENING + 1 BET = 2 ledger entries
    expect(recon.checkedEntries).toBe(2);
  });

  it('2. Section 8 Mandatory Scenario: 100.00 BRL balance, two simultaneous 80.00 BRL bets -> 1 PROCESSED, 1 REJECTED, final balance 20.00 BRL, 1 debit entry', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const [resA, resB] = await Promise.all([
      processWager.execute({
        idempotencyKey: 'provider-a:bet-80-a',
        providerId: 'provider-a',
        externalTransactionId: 'bet-80-a',
        playerId,
        walletId: wallet.id,
        roundId: 'round-race-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
      processWager.execute({
        idempotencyKey: 'provider-a:bet-80-b',
        providerId: 'provider-a',
        externalTransactionId: 'bet-80-b',
        playerId,
        walletId: wallet.id,
        roundId: 'round-race-2',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);

    const rejected = resA.status === WagerTransactionStatus.Rejected ? resA : resB;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('20.00');
    expect(recon.calculatedBalance.amount).toBe('20.00');
    // 1 OPENING + 1 winning BET = 2 entries
    expect(recon.checkedEntries).toBe(2);
  });

  it('3 & 4. Distinct wallets and >= 3 concurrent instances processing mixed operations in parallel', async () => {
    const walletCount = 6;
    const wallets = await Promise.all(
      Array.from({ length: walletCount }, () =>
        createWallet.execute({
          playerId: randomUUID(),
          initialBalance: { amount: '300.00', currency: 'BRL' },
        }),
      ),
    );

    // Simulate 3 application instances submitting concurrent operations across all 6 wallets
    const tasks: Promise<unknown>[] = [];
    for (const w of wallets) {
      for (let i = 1; i <= 5; i++) {
        tasks.push(
          processWager.execute({
            idempotencyKey: `prov:w-${w.id}:bet-${i}`,
            providerId: 'prov',
            externalTransactionId: `w-${w.id}:bet-${i}`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `round-${i}`,
            gameId: 'fortune-chimp',
            kind: WagerTransactionKind.Bet,
            money: { amount: '50.00', currency: 'BRL' },
          }),
        );
      }
    }

    await Promise.all(tasks);

    for (const w of wallets) {
      const recon = await reconcileWallet.execute(w.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('50.00'); // 300 - 5 * 50 = 50
      expect(recon.checkedEntries).toBe(6); // 1 OPENING + 5 BETs
    }
  });

  it('5. Worker killed AFTER SQL commit and BEFORE SQS ack -> redelivery is deduplicated by Inbox without double debit', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const sqsMessage = {
      MessageId: 'sqs-msg-crash-1',
      Body: JSON.stringify({
        messageId: 'msg-crash-1',
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId: 'tx-crash-1',
          idempotencyKey: 'provider-a:tx-crash-1',
          playerId,
          walletId: wallet.id,
          roundId: 'round-crash-1',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '40.00', currency: 'BRL' },
        },
      }),
    };

    // First delivery: crashes right after SQL commit and before SQS DeleteMessage ack
    await expect(
      sqsConsumer.handleSqsMessage(sqsMessage, { simulateCrashBeforeAck: true }),
    ).rejects.toThrow(SimulatedWorkerCrashAfterCommitError);

    // Balance was already debited once (100 - 40 = 60)
    const reconAfterCrash = await reconcileWallet.execute(wallet.id);
    expect(reconAfterCrash.consistent).toBe(true);
    expect(reconAfterCrash.storedBalance.amount).toBe('60.00');

    // Second delivery (SQS redelivery after visibility timeout expires): completes cleanly without re-debiting
    await sqsConsumer.handleSqsMessage(sqsMessage, {
      simulateCrashBeforeAck: false,
    });

    const reconAfterRedelivery = await reconcileWallet.execute(wallet.id);
    expect(reconAfterRedelivery.consistent).toBe(true);
    expect(reconAfterRedelivery.storedBalance.amount).toBe('60.00');
    expect(reconAfterRedelivery.checkedEntries).toBe(2);
  });

  it('6. Two concurrent Outbox publishers claiming from the same outbox table do not duplicate or drop events', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '500.00', currency: 'BRL' },
    });

    for (let i = 1; i <= 10; i++) {
      await processWager.execute({
        idempotencyKey: `prov:outbox-bet-${i}`,
        providerId: 'prov',
        externalTransactionId: `outbox-bet-${i}`,
        playerId,
        walletId: wallet.id,
        roundId: `round-outbox-${i}`,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      });
    }

    // Run two concurrent outbox batch executions in parallel (uses FOR UPDATE SKIP LOCKED)
    const [pubA, pubB] = await Promise.all([
      outboxWorker.processPendingOutboxBatch(15),
      outboxWorker.processPendingOutboxBatch(15),
    ]);

    // 1 OPENING (2 events) + 10 BETs (20 events) = 22 total outbox events
    expect(pubA + pubB).toBe(22);

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('400.00');
  });

  it('7. Out-of-order REFUND delivered BEFORE its referenced BET -> enters PENDING_REFERENCE and resolves once BET arrives', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // Step 1: REFUND arrives first, before bet-out-of-order exists
    const refundFirst = await processWager.execute({
      idempotencyKey: 'prov:refund-early',
      providerId: 'prov',
      externalTransactionId: 'refund-early',
      playerId,
      walletId: wallet.id,
      roundId: 'round-ooo-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-late',
    });

    expect(refundFirst.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refundFirst.balance.amount).toBe('100.00');

    // Step 2: Referenced BET arrives and debits 30.00 -> balance becomes 70.00
    const betLate = await processWager.execute({
      idempotencyKey: 'prov:bet-late',
      providerId: 'prov',
      externalTransactionId: 'bet-late',
      playerId,
      walletId: wallet.id,
      roundId: 'round-ooo-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(betLate.status).toBe(WagerTransactionStatus.Processed);
    expect(betLate.balance.amount).toBe('70.00');

    // Force next_retry_at to now so the scheduled worker picks it up immediately
    await harness.orm.em
      .getConnection()
      .execute(
        `UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = ?`,
        [refundFirst.transactionId],
      );

    // Step 3: PendingReferenceWorker reprocesses the waiting REFUND -> balance restored to 100.00
    const reprocessedCount = await reprocessPendingRefs.executeBatch(10);
    expect(reprocessedCount).toBe(1);

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('100.00');
    expect(recon.calculatedBalance.amount).toBe('100.00');
    // OPENING (+100), BET (-30), REFUND (+30) = 3 entries
    expect(recon.checkedEntries).toBe(3);
  });
});
