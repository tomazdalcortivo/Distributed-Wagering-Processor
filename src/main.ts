import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { StructuredLogger } from './infrastructure/observability/structured-logger.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  // Enable graceful shutdown hooks for SIGTERM / SIGINT (Section 10)
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  const logger = app.get(StructuredLogger);
  logger.info('Distributed Wagering Processor listening', {
    port,
    instanceId: process.env.INSTANCE_ID ?? 'instance-local',
  });
}

void bootstrap();
