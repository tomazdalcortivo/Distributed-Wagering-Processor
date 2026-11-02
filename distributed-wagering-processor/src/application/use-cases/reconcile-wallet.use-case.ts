import { Inject, Injectable } from '@nestjs/common';
import { LedgerDirection } from '../../domain/entities/wallet-ledger-entry';
import { EntityNotFoundError } from '../../domain/shared/domain-errors';
import { Money, MoneyProps } from '../../domain/value-objects/money';
import { StructuredLogger } from '../../infrastructure/observability/structured-logger.service';
import { METRICS_PORT, MetricsPort } from '../ports/metrics.port';
import { UNIT_OF_WORK_PORT, UnitOfWorkPort } from '../ports/unit-of-work.port';

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Reconciles a Wallet's materialized balance against its full immutable ledger history (Section 9).
 *
 * Discrepancies are NEVER silently auto-corrected: they are logged at ERROR level,
 * counted in observability metrics, and returned in the response payload.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly uow: UnitOfWorkPort,
    @Inject(METRICS_PORT)
    private readonly metrics: MetricsPort,
    private readonly logger: StructuredLogger,
  ) {}

  async execute(walletId: string, correlationId?: string): Promise<ReconcileWalletResult> {
    return this.uow.runInTransaction(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new EntityNotFoundError('Wallet', walletId);
      }

      const entries = await ctx.ledger.getAllByWalletOrdered(walletId);
      let calculated = Money.zero(wallet.currency);
      let chainConsistent = true;

      for (const entry of entries) {
        if (!entry.balanceBefore.equals(calculated) || !entry.isBalanced()) {
          chainConsistent = false;
        }
        calculated =
          entry.direction === LedgerDirection.Credit
            ? calculated.add(entry.money)
            : calculated.subtract(entry.money);
      }

      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero() && chainConsistent;

      if (!consistent) {
        this.metrics.incrementReconciliationDiscrepancy(walletId);
        this.logger.error('Wallet reconciliation discrepancy detected', {
          correlationId,
          walletId,
          storedBalance: wallet.balance.amount,
          calculatedBalance: calculated.amount,
          difference: difference.amount,
          checkedEntries: entries.length,
          chainConsistent,
        });
      }

      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });
  }
}
