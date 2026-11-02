import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ReprocessPendingReferencesUseCase } from '../../application/use-cases/reprocess-pending-references.use-case';
import { StructuredLogger } from '../observability/structured-logger.service';

/**
 * Scheduled Worker that reprocesses `PENDING_REFERENCE` transactions with exponential backoff (Section 7.1).
 */
@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly pollIntervalMs: number;
  private readonly enabled: boolean;
  private timer?: ReturnType<typeof setInterval>;
  private isRunning = false;

  constructor(
    private readonly reprocessUseCase: ReprocessPendingReferencesUseCase,
    private readonly logger: StructuredLogger,
  ) {
    this.pollIntervalMs = Number(process.env.PENDING_REF_POLL_INTERVAL_MS ?? 1000);
    this.enabled = process.env.DISABLE_BACKGROUND_WORKERS !== 'true';
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async tick(): Promise<number> {
    if (this.isRunning) return 0;
    this.isRunning = true;
    try {
      return await this.reprocessUseCase.executeBatch(25);
    } catch (err) {
      this.logger.warn('PendingReferenceWorker tick error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.isRunning = false;
    }
  }
}
