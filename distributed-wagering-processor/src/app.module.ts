import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EVENT_PUBLISHER_PORT } from './application/ports/event-publisher.port';
import { METRICS_PORT } from './application/ports/metrics.port';
import { PROVIDER_IDENTITY_PORT } from './application/ports/provider-identity.port';
import { UNIT_OF_WORK_PORT } from './application/ports/unit-of-work.port';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { QueryWageringUseCases } from './application/use-cases/query-wagering.use-cases';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { ReprocessPendingReferencesUseCase } from './application/use-cases/reprocess-pending-references.use-case';
import { ConfigurableProviderIdentityAdapter } from './infrastructure/auth/provider-identity.adapter';
import { buildMikroOrmConfig } from './infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/database/mikro-orm-unit-of-work';
import { PendingReferenceWorker } from './infrastructure/messaging/pending-reference.worker';
import {
  createSqsClient,
  SQS_CLIENT_TOKEN,
} from './infrastructure/messaging/sqs-client.factory';
import { SqsEventPublisherAdapter } from './infrastructure/messaging/sqs-event-publisher.adapter';
import { SqsWagerConsumerWorker } from './infrastructure/messaging/sqs-wager-consumer.worker';
import { TransactionalOutboxWorker } from './infrastructure/messaging/transactional-outbox.worker';
import { MetricsService } from './infrastructure/observability/metrics.service';
import { StructuredLogger } from './infrastructure/observability/structured-logger.service';
import { HealthController } from './presentation/http/controllers/health.controller';
import { WageringController } from './presentation/http/controllers/wagering.controller';
import { WalletsController } from './presentation/http/controllers/wallets.controller';
import { GlobalDomainExceptionFilter } from './presentation/http/filters/domain-exception.filter';
import { ProviderAuthGuard } from './presentation/http/guards/provider-auth.guard';

@Module({
  imports: [MikroOrmModule.forRoot(buildMikroOrmConfig())],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    StructuredLogger,
    {
      provide: METRICS_PORT,
      useClass: MetricsService,
    },
    {
      provide: UNIT_OF_WORK_PORT,
      useClass: MikroOrmUnitOfWork,
    },
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: ConfigurableProviderIdentityAdapter,
    },
    {
      provide: SQS_CLIENT_TOKEN,
      useFactory: createSqsClient,
    },
    {
      provide: EVENT_PUBLISHER_PORT,
      useClass: SqsEventPublisherAdapter,
    },
    {
      provide: APP_GUARD,
      useClass: ProviderAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalDomainExceptionFilter,
    },
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReprocessPendingReferencesUseCase,
    ReconcileWalletUseCase,
    QueryWageringUseCases,
    SqsWagerConsumerWorker,
    TransactionalOutboxWorker,
    PendingReferenceWorker,
  ],
  exports: [
    UNIT_OF_WORK_PORT,
    METRICS_PORT,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReprocessPendingReferencesUseCase,
    ReconcileWalletUseCase,
    QueryWageringUseCases,
    SqsWagerConsumerWorker,
    TransactionalOutboxWorker,
    PendingReferenceWorker,
  ],
})
export class AppModule {}
