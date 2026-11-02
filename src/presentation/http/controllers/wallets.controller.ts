import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateWalletResult,
  CreateWalletUseCase,
} from '../../../application/use-cases/create-wallet.use-case';
import {
  PaginatedLedgerViewDto,
  QueryWageringUseCases,
  WalletViewDto,
} from '../../../application/use-cases/query-wagering.use-cases';
import {
  ReconcileWalletResult,
  ReconcileWalletUseCase,
} from '../../../application/use-cases/reconcile-wallet.use-case';
import { InvalidTransactionContractError } from '../../../domain/shared/domain-errors';
import { MoneyProps } from '../../../domain/value-objects/money';

export class CreateWalletRequestBody {
  playerId: string;
  initialBalance: MoneyProps;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly queryUseCases: QueryWageringUseCases,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body() body: CreateWalletRequestBody,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<CreateWalletResult> {
    if (!body || typeof body !== 'object' || !body.playerId || !body.initialBalance) {
      throw new InvalidTransactionContractError(
        'Request body must include playerId and initialBalance { amount, currency }',
      );
    }

    return this.createWalletUseCase.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId,
    });
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string): Promise<WalletViewDto> {
    return this.queryUseCases.getWalletById(walletId);
  }

  @Get(':walletId/ledger')
  async getWalletLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
  ): Promise<PaginatedLedgerViewDto> {
    const limit = limitStr !== undefined ? Number(limitStr) : 50;
    return this.queryUseCases.getWalletLedger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ReconcileWalletResult> {
    return this.reconcileWalletUseCase.execute(walletId, correlationId);
  }
}
