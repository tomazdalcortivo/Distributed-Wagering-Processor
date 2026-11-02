import { createHash } from 'crypto';

/**
 * Produces a deterministic RFC-8785 style canonical JSON string with lexicographically sorted keys.
 * Ensures that identical business payloads always yield the exact same SHA-256 hash regardless
 * of property key order in HTTP requests or SQS messages.
 */
export function toCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => toCanonicalJson(item)).join(',') + ']';
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${toCanonicalJson(record[key])}`,
  );

  return `{${entries.join(',')}}`;
}

/**
 * Computes the SHA-256 hex digest of the canonical JSON representation of the business fields
 * of a wagering transaction (Section 9 — Idempotency).
 * Transport metadata and headers are excluded from the hash.
 */
export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

export function computeWagerPayloadHash(payload: WagerBusinessPayload): string {
  const canonicalPayload: WagerBusinessPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    ...(payload.referenceExternalTransactionId !== undefined &&
    payload.referenceExternalTransactionId !== null
      ? { referenceExternalTransactionId: payload.referenceExternalTransactionId }
      : {}),
  };

  const canonical = toCanonicalJson(canonicalPayload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
