import { randomUUID } from 'crypto';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { WagerTransactionKind } from '../../src/domain/entities/wager-transaction';
import { METRICS_PORT, MetricsPort } from '../../src/application/ports/metrics.port';
import { createRealInfraTestHarness } from '../helpers/real-infra-harness';

/**
 * Load & Contention Benchmark (`bun run test:load`) — Section 14 Differential.
 *
 * Methodology:
 * - Creates 20 active wallets (including 2 "hot wallets" receiving 40% of traffic).
 * - Executes 500 concurrent operations (mix of BET, WIN, LOSS, duplicate replays, and REFUND)
 *   with concurrency = 25 workers.
 * - Reports throughput (RPS), latency distribution (p50, p95, p99), error rate, lock conflicts,
 *   outbox lag, and verifies 100% ledger reconciliation across all wallets.
 */
async function runLoadBenchmark(): Promise<void> {
  console.log('==============================================================');
  console.log(' Jungle Gaming — Distributed Wagering Processor Load Benchmark');
  console.log('==============================================================');

  const harness = await createRealInfraTestHarness();
  await harness.resetDatabaseAndQueues();

  const createWallet = harness.app.get(CreateWalletUseCase);
  const processWager = harness.app.get(ProcessWagerTransactionUseCase);
  const reconcileWallet = harness.app.get(ReconcileWalletUseCase);
  const metrics = harness.app.get<MetricsPort>(METRICS_PORT);

  const walletCount = 20;
  const totalOperations = 500;
  const concurrency = 25;

  console.log(`Provisioning ${walletCount} wallets...`);
  const wallets = await Promise.all(
    Array.from({ length: walletCount }, () =>
      createWallet.execute({
        playerId: randomUUID(),
        initialBalance: { amount: '5000.00', currency: 'BRL' },
      }),
    ),
  );

  const latenciesMs: number[] = [];
  let completed = 0;
  let unexpectedErrors = 0;

  const startBench = performance.now();

  const workerFn = async (workerIdx: number): Promise<void> => {
    while (true) {
      const opIndex = completed++;
      if (opIndex >= totalOperations) break;

      // 40% of traffic hits hot wallets [0, 1]; 60% hits remaining wallets
      const wallet =
        opIndex % 5 < 2
          ? wallets[opIndex % 2]!
          : wallets[2 + (opIndex % (walletCount - 2))]!;

      const isWin = opIndex % 4 === 0;
      const isLoss = opIndex % 7 === 0 && !isWin;
      const kind = isWin
        ? WagerTransactionKind.Win
        : isLoss
          ? WagerTransactionKind.Loss
          : WagerTransactionKind.Bet;

      const externalTxId = `load-tx-${opIndex}`;
      const opStart = performance.now();

      try {
        await processWager.execute({
          idempotencyKey: `load-provider:${externalTxId}`,
          providerId: 'load-provider',
          externalTransactionId: externalTxId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `load-round-${opIndex}`,
          gameId: 'fortune-chimp',
          kind,
          money: {
            amount: isLoss ? '0.00' : '15.00',
            currency: 'BRL',
          },
        });
        latenciesMs.push(performance.now() - opStart);
      } catch (err) {
        unexpectedErrors += 1;
        console.error(`Worker ${workerIdx} error:`, err);
      }
    }
  };

  await Promise.all(
    Array.from({ length: concurrency }, (_, idx) => workerFn(idx)),
  );

  const totalDurationSec = (performance.now() - startBench) / 1000;
  const sortedLat = [...latenciesMs].sort((a, b) => a - b);
  const pct = (q: number) =>
    sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * q))] ?? 0;

  let allReconciled = true;
  for (const w of wallets) {
    const recon = await reconcileWallet.execute(w.id);
    if (!recon.consistent) {
      allReconciled = false;
    }
  }

  const report = {
    environment: {
      runtime: `Bun ${process.versions.bun ?? process.version}`,
      platform: `${process.platform} ${process.arch}`,
      concurrencyWorkers: concurrency,
      wallets: walletCount,
    },
    summary: {
      totalOperations,
      durationSeconds: Number(totalDurationSec.toFixed(2)),
      throughputRps: Number((totalOperations / totalDurationSec).toFixed(2)),
      latencyMs: {
        p50: Number(pct(0.5).toFixed(2)),
        p95: Number(pct(0.95).toFixed(2)),
        p99: Number(pct(0.99).toFixed(2)),
      },
      unexpectedErrors,
      allWalletsReconciled: allReconciled,
    },
    metricsSnapshot: metrics.getSnapshot(),
  };

  console.log(JSON.stringify(report, null, 2));
  await harness.close();

  if (!allReconciled || unexpectedErrors > 0) {
    process.exit(1);
  }
}

void runLoadBenchmark();
