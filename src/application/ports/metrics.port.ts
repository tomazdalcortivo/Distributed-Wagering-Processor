export const METRICS_PORT = Symbol('METRICS_PORT');

export interface MetricsPort {
  incrementTransactionStatus(status: string, kind: string): void;
  incrementDuplicateDetected(source: 'http' | 'sqs_inbox' | 'idempotency_key'): void;
  incrementRetry(worker: 'sqs_consumer' | 'outbox_publisher' | 'pending_reference'): void;
  incrementDlqMessages(reason: string): void;
  incrementLockConflict(resource: string): void;
  incrementReconciliationDiscrepancy(walletId: string): void;
  setOutboxLag(pendingCount: number): void;
  observeProcessingLatencyMs(operation: string, durationMs: number): void;
  getSnapshot(): Record<string, unknown>;
}
export const MetricsPort = METRICS_PORT;
