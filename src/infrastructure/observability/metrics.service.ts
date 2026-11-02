import { Injectable } from '@nestjs/common';
import { MetricsPort } from '../../application/ports/metrics.port';

/**
 * In-memory & Prometheus-compatible Metrics Collector (Section 12).
 *
 * Tracks all required metrics:
 * - Transactions by status & kind
 * - Duplicates detected (HTTP, SQS Inbox, Idempotency Key)
 * - Retries by worker
 * - Messages sent to DLQ
 * - Lock / concurrency conflicts
 * - Reconciliation discrepancies
 * - Outbox lag
 * - Processing latency percentiles (p50, p95, p99)
 */
@Injectable()
export class MetricsService implements MetricsPort {
  private readonly transactionsByStatus = new Map<string, number>();
  private readonly duplicatesBySource = new Map<string, number>();
  private readonly retriesByWorker = new Map<string, number>();
  private readonly dlqByReason = new Map<string, number>();
  private readonly lockConflicts = new Map<string, number>();
  private reconciliationDiscrepancies = 0;
  private outboxLag = 0;
  private readonly latenciesByOperation = new Map<string, number[]>();

  incrementTransactionStatus(status: string, kind: string): void {
    const key = `${status}:${kind}`;
    this.transactionsByStatus.set(key, (this.transactionsByStatus.get(key) ?? 0) + 1);
  }

  incrementDuplicateDetected(source: 'http' | 'sqs_inbox' | 'idempotency_key'): void {
    this.duplicatesBySource.set(source, (this.duplicatesBySource.get(source) ?? 0) + 1);
  }

  incrementRetry(worker: 'sqs_consumer' | 'outbox_publisher' | 'pending_reference'): void {
    this.retriesByWorker.set(worker, (this.retriesByWorker.get(worker) ?? 0) + 1);
  }

  incrementDlqMessages(reason: string): void {
    this.dlqByReason.set(reason, (this.dlqByReason.get(reason) ?? 0) + 1);
  }

  incrementLockConflict(resource: string): void {
    this.lockConflicts.set(resource, (this.lockConflicts.get(resource) ?? 0) + 1);
  }

  incrementReconciliationDiscrepancy(_walletId: string): void {
    this.reconciliationDiscrepancies += 1;
  }

  setOutboxLag(pendingCount: number): void {
    this.outboxLag = pendingCount;
  }

  observeProcessingLatencyMs(operation: string, durationMs: number): void {
    let bucket = this.latenciesByOperation.get(operation);
    if (!bucket) {
      bucket = [];
      this.latenciesByOperation.set(operation, bucket);
    }
    if (bucket.length >= 10_000) {
      bucket.shift();
    }
    bucket.push(durationMs);
  }

  getSnapshot(): Record<string, unknown> {
    const latencySummary: Record<
      string,
      { count: number; p50Ms: number; p95Ms: number; p99Ms: number }
    > = {};

    for (const [op, samples] of this.latenciesByOperation.entries()) {
      const sorted = [...samples].sort((a, b) => a - b);
      latencySummary[op] = {
        count: sorted.length,
        p50Ms: this.percentile(sorted, 0.5),
        p95Ms: this.percentile(sorted, 0.95),
        p99Ms: this.percentile(sorted, 0.99),
      };
    }

    return {
      transactionsByStatus: Object.fromEntries(this.transactionsByStatus),
      duplicatesDetected: Object.fromEntries(this.duplicatesBySource),
      retriesByWorker: Object.fromEntries(this.retriesByWorker),
      dlqMessagesByReason: Object.fromEntries(this.dlqByReason),
      lockConflicts: Object.fromEntries(this.lockConflicts),
      reconciliationDiscrepancies: this.reconciliationDiscrepancies,
      outboxLag: this.outboxLag,
      processingLatencyMs: latencySummary,
    };
  }

  private percentile(sorted: number[], q: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return Number((sorted[idx] ?? 0).toFixed(2));
  }
}
