import { Injectable } from '@nestjs/common';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

/**
 * Structured JSON Logger (Section 12).
 *
 * Guarantees:
 * - Emits single-line JSON records containing `timestamp`, `level`, `message`, `instanceId`,
 *   and correlation keys (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`).
 * - Redacts sensitive fields (`password`, `secret`, `authorization`, `token`, `rawPayload`)
 *   and never dumps full financial request payloads.
 */
@Injectable()
export class StructuredLogger {
  private static readonly REDACTED_KEYS = new Set([
    'password',
    'secret',
    'authorization',
    'token',
    'access_token',
    'refresh_token',
    'rawpayload',
    'creditcard',
  ]);

  private readonly instanceId = process.env.INSTANCE_ID ?? 'instance-local';
  private readonly silent = process.env.LOG_SILENT === 'true';

  info(message: string, context: LogContext = {}): void {
    this.write('INFO', message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.write('WARN', message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.write('ERROR', message, context);
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', message: string, context: LogContext): void {
    if (this.silent) {
      return;
    }

    const sanitized = this.sanitize(context);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      instanceId: this.instanceId,
      message,
      ...sanitized,
    };

    const serialized = JSON.stringify(entry);
    if (level === 'ERROR') {
      process.stderr.write(serialized + '\n');
    } else {
      process.stdout.write(serialized + '\n');
    }
  }

  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      if (StructuredLogger.REDACTED_KEYS.has(key.toLowerCase())) {
        clean[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        clean[key] = this.sanitize(value as Record<string, unknown>);
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }
}
