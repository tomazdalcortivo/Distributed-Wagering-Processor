import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  ConcurrencyConflictError,
  CurrencyMismatchError,
  DomainError,
  DuplicateWalletError,
  EntityNotFoundError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionContractError,
  InvalidTransactionStateError,
  LedgerImbalanceError,
} from '../../../domain/shared/domain-errors';
import { StructuredLogger } from '../../../infrastructure/observability/structured-logger.service';

/**
 * Global Exception Filter that guarantees clear, consistent HTTP status codes across all endpoints (Section 9):
 * - 400 Bad Request: Invalid payload, invalid Money format, missing required headers/fields
 * - 404 Not Found: Wallet or Transaction not found
 * - 409 Conflict: Idempotency key reused with divergent payload, or duplicate wallet for (playerId, currency)
 * - 422 Unprocessable Entity: Domain business rule rejection
 * - 503 Service Unavailable: Transient infrastructure / lock contention error (safe for provider to retry)
 */
@Catch()
export class GlobalDomainExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: Record<string, unknown>) => void };
    }>();
    const request = ctx.getRequest<{
      url?: string;
      method?: string;
      headers?: Record<string, string | undefined>;
    }>();

    const correlationId =
      request?.headers?.['x-correlation-id'] ?? 'uncorrelated';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resBody = exception.getResponse();
      response.status(status).json({
        errorCode: 'HTTP_EXCEPTION',
        message:
          typeof resBody === 'string'
            ? resBody
            : (resBody as { message?: string }).message ?? exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof DomainError) {
      const status = this.mapDomainErrorToStatus(exception);
      response.status(status).json({
        errorCode: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    // Transient database connection / lock timeout errors -> 503 Service Unavailable
    if (this.isTransientDatabaseError(exception)) {
      this.logger.warn('Transient database error mapped to HTTP 503', {
        correlationId,
        path: request?.url,
        error: exception instanceof Error ? exception.message : String(exception),
      });
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        errorCode: 'TRANSIENT_INFRASTRUCTURE_ERROR',
        message: 'Temporary database contention or unavailability; safe to retry with same Idempotency-Key',
        correlationId,
      });
      return;
    }

    this.logger.error('Unhandled exception in HTTP layer', {
      correlationId,
      path: request?.url,
      method: request?.method,
      error: exception instanceof Error ? exception.message : String(exception),
    });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred',
      correlationId,
    });
  }

  private mapDomainErrorToStatus(error: DomainError): number {
    if (
      error instanceof InvalidMoneyError ||
      error instanceof InvalidTransactionContractError ||
      error instanceof InvalidTransactionStateError ||
      error instanceof LedgerImbalanceError
    ) {
      return HttpStatus.BAD_REQUEST;
    }

    if (error instanceof EntityNotFoundError) {
      return HttpStatus.NOT_FOUND;
    }

    if (
      error instanceof IdempotencyConflictError ||
      error instanceof DuplicateWalletError
    ) {
      return HttpStatus.CONFLICT;
    }

    if (
      error instanceof InsufficientFundsError ||
      error instanceof CurrencyMismatchError
    ) {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }

    if (error instanceof ConcurrencyConflictError) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }

    return HttpStatus.BAD_REQUEST;
  }

  private isTransientDatabaseError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: string }).code;
    // PostgreSQL deadlock_detected (40P01), serialization_failure (40001), lock_not_available (55P03), connection errors (08xxx)
    return (
      code === '40P01' ||
      code === '40001' ||
      code === '55P03' ||
      (typeof code === 'string' && code.startsWith('08'))
    );
  }
}
