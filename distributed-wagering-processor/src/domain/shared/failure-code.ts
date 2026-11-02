/**
 * Machine-readable taxonomy of failure codes (Section 7.2).
 * Allows game providers to unambiguously distinguish between:
 *  - Business rejections (do not retry with same state)
 *  - Validation / contract rejections (fix payload)
 *  - Permanent infrastructure failures (audit / alert)
 */
export enum FailureCode {
  /** BET rejected because wallet balance < bet amount */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',

  /** REFUND or ROLLBACK rejected because reversing the credit would yield a negative wallet balance (Rule 7.9) */
  ReversalWouldCauseNegativeBalance = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',

  /** PENDING_REFERENCE exceeded retry limit / TTL without finding the referenced transaction (Section 7.1) */
  ReferenceNotFoundTimeout = 'REFERENCE_NOT_FOUND_TIMEOUT',

  /** Referenced transaction exists but is REJECTED, FAILED, or PENDING instead of PROCESSED */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',

  /** REFUND targeted a non-BET transaction, or ROLLBACK targeted an unsupported kind (Rule 7.3) */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',

  /** Referenced transaction belongs to a different player, wallet, currency, provider, or round (Rule 7.2) */
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',

  /** Referenced transaction was already reversed by a processed REFUND or ROLLBACK (Rule 7.4) */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',

  /** REFUND or ROLLBACK amount does not equal the referenced transaction amount (Rule 7.5) */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',

  /** Operation currency does not match the target wallet currency */
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  /** Target wallet does not belong to the specified playerId */
  WalletOwnershipMismatch = 'WALLET_OWNERSHIP_MISMATCH',

  /** Permanent unrecoverable processing failure */
  PermanentProcessingFailure = 'PERMANENT_PROCESSING_FAILURE',
}
