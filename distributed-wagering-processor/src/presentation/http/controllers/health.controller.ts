import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Res,
} from '@nestjs/common';
import { METRICS_PORT, MetricsPort } from '../../../application/ports/metrics.port';
import { SQS_CLIENT_TOKEN } from '../../../infrastructure/messaging/sqs-client.factory';
import { Public } from '../guards/provider-auth.guard';

@Controller()
export class HealthController {
  private readonly wagerQueueUrl: string;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT_TOKEN)
    private readonly sqsClient: SQSClient,
    @Inject(METRICS_PORT)
    private readonly metrics: MetricsPort,
  ) {
    this.wagerQueueUrl =
      process.env.SQS_WAGER_QUEUE_URL ??
      'http://localhost:4566/000000000000/wager-transactions.fifo';
  }

  @Public()
  @Get('health/live')
  live(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('health/ready')
  async ready(
    @Res({ passthrough: true }) res: { status: (code: number) => void },
  ): Promise<{
    status: string;
    checks: { postgres: string; sqs: string };
    timestamp: string;
  }> {
    let pgStatus = 'up';
    let sqsStatus = 'up';

    try {
      await this.em.getConnection().execute('SELECT 1');
    } catch {
      pgStatus = 'down';
    }

    try {
      await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.wagerQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
    } catch {
      sqsStatus = 'down';
    }

    const allHealthy = pgStatus === 'up' && sqsStatus === 'up';
    res.status(allHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: allHealthy ? 'ready' : 'degraded',
      checks: {
        postgres: pgStatus,
        sqs: sqsStatus,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('metrics')
  getMetrics(): Record<string, unknown> {
    return this.metrics.getSnapshot();
  }
}
