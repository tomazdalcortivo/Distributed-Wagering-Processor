import { EntitySchema } from '@mikro-orm/core';
import { DecimalStringType } from '../types/decimal-string.type';

export class WalletOrmRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletEntitySchema = new EntitySchema<WalletOrmRecord>({
  class: WalletOrmRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balanceAmount: { type: DecimalStringType, fieldName: 'balance_amount' },
    version: { type: 'integer', default: 1 },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});

export class WagerTransactionOrmRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  status!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  observedBalanceAmount?: string | null;
  failureCode?: string | null;
  retryCount!: number;
  nextRetryAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionEntitySchema = new EntitySchema<WagerTransactionOrmRecord>({
  class: WagerTransactionOrmRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id', length: 128 },
    externalTransactionId: {
      type: 'string',
      fieldName: 'external_transaction_id',
      length: 255,
    },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', length: 255 },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id', length: 255 },
    gameId: { type: 'string', fieldName: 'game_id', length: 255 },
    kind: { type: 'string', length: 32 },
    amount: { type: DecimalStringType },
    currency: { type: 'string', length: 3 },
    status: { type: 'string', length: 32 },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      type: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    observedBalanceAmount: {
      type: DecimalStringType,
      fieldName: 'observed_balance_amount',
      nullable: true,
    },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    retryCount: { type: 'integer', fieldName: 'retry_count', default: 0 },
    nextRetryAt: { type: 'Date', fieldName: 'next_retry_at', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
  },
});

export class WalletLedgerEntryOrmRecord {
  id!: string;
  sequenceNumber?: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntryEntitySchema = new EntitySchema<WalletLedgerEntryOrmRecord>({
  class: WalletLedgerEntryOrmRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    sequenceNumber: {
      type: 'bigint',
      fieldName: 'sequence_number',
      autoincrement: true,
      nullable: true,
    },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', length: 16 },
    amount: { type: DecimalStringType },
    currency: { type: 'string', length: 3 },
    balanceBefore: { type: DecimalStringType, fieldName: 'balance_before' },
    balanceAfter: { type: DecimalStringType, fieldName: 'balance_after' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
  },
});

export class InboxMessageOrmRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageEntitySchema = new EntitySchema<InboxMessageOrmRecord>({
  class: InboxMessageOrmRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    receivedAt: { type: 'Date', fieldName: 'received_at' },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
  },
});

export class OutboxMessageOrmRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageEntitySchema = new EntitySchema<OutboxMessageOrmRecord>({
  class: OutboxMessageOrmRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at' },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', nullable: true },
  },
});
