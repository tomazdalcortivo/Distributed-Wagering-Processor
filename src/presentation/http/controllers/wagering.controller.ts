import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../../../application/use-cases/process-wager-transaction.use-case';
import {
  QueryWageringUseCases,
  WagerTransactionViewDto,
} from '../../../application/use-cases/query-wagering.use-cases';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import { InvalidTransactionContractError } from '../../../domain/shared/domain-errors';
import { MoneyProps } from '../../../domain/value-objects/money';

export class SubmitWagerTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly queryUseCases: QueryWageringUseCases,
  ) {}

  /**
   * POST /wagering/transactions
   *
   * Status code mapping (Section 9):
   * - `200 OK`: `PROCESSED` transaction (or idempotent replay of a `PROCESSED` transaction)
   * - `202 Accepted`: `PENDING_REFERENCE` transaction accepted and queued for background reference resolution
   * - `422 Unprocessable Entity`: `REJECTED` transaction due to a domain business rule violation
   *   (returns structured `{ transactionId, status: "REJECTED", failureCode, balance, idempotentReplay }`)
   * - `409 Conflict`: Same `Idempotency-Key` with different business payload
   * - `400 Bad Request`: Missing `Idempotency-Key` or malformed contract/money
   */
  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: SubmitWagerTransactionBody,
    @Res({ passthrough: true })
    res: { status: (code: number) => void },
  ): Promise<ProcessWagerTransactionResult> {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new InvalidTransactionContractError(
        'Header "Idempotency-Key" is mandatory and is the source of truth for idempotency',
      );
    }

    if (!body || typeof body !== 'object') {
      throw new InvalidTransactionContractError('Request body must be a valid JSON object');
    }

    const result = await this.processWagerUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId,
    });

    if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else {
      res.status(HttpStatus.OK);
    }

    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async getTransactionById(
    @Param('transactionId') transactionId: string,
  ): Promise<WagerTransactionViewDto> {
    return this.queryUseCases.getTransactionById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionViewDto> {
    return this.queryUseCases.getTransactionByProviderExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
