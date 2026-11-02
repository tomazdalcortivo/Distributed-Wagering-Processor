import { Migration } from '@mikro-orm/migrations';

/**
 * Versioned and fully reversible initial schema migration.
 * Enforces all Section 5 & Section 6 domain invariants directly in PostgreSQL:
 *  - Exact numeric(20,2) money storage (zero floating point)
 *  - Non-negative wallet balance (CHECK balance_amount >= 0)
 *  - Unique wallet per (player_id, currency)
 *  - Unique idempotency_key and (provider_id, external_transaction_id)
 *  - Partial unique index preventing double reversal of the same referenced transaction
 *  - Arithmetic balance invariant on ledger entries (balance_after = balance_before +/- amount)
 *  - Database-level immutability triggers blocking UPDATE/DELETE on wallet_ledger_entries
 *  - Database-level terminal state trigger blocking transitions out of PROCESSED/REJECTED/FAILED
 */
export class Migration20261101000001_InitialWageringSchema extends Migration {
  override async up(): Promise<void> {
    // 1. Wallets Table
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount NUMERIC(20, 2) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0.00),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT chk_wallets_currency_iso CHECK (char_length(currency) = 3 AND currency = upper(currency))
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wallets_player_id ON wallets (player_id);
    `);

    // 2. Wager Transactions Table
    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(128) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        player_id UUID NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        status VARCHAR(32) NOT NULL,
        reference_external_transaction_id VARCHAR(255) NULL,
        reference_transaction_id UUID NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        observed_balance_amount NUMERIC(20, 2) NULL,
        failure_code VARCHAR(64) NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external_id UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_tx_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_wager_tx_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT chk_wager_tx_amount_non_negative CHECK (amount >= 0.00),
        CONSTRAINT chk_wager_tx_retry_non_negative CHECK (retry_count >= 0),
        CONSTRAINT chk_wager_tx_reference_required CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind NOT IN ('REFUND', 'ROLLBACK'))
        ),
        CONSTRAINT chk_wager_tx_failure_code_when_rejected CHECK (
          (status IN ('REJECTED', 'FAILED') AND failure_code IS NOT NULL)
          OR (status NOT IN ('REJECTED', 'FAILED'))
        )
      );
    `);

    // Partial unique index: a referenced transaction cannot be reversed twice once PROCESSED
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_processed_reversal_per_kind
      ON wager_transactions (reference_transaction_id, kind)
      WHERE status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK')
        AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_processed_reversal_any
      ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED'
        AND kind IN ('REFUND', 'ROLLBACK')
        AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_wallet_id ON wager_transactions (wallet_id, created_at DESC);
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_pending_reference_due
      ON wager_transactions (next_retry_at, created_at)
      WHERE status = 'PENDING_REFERENCE';
    `);

    // Trigger enforcing terminal status immutability on wager_transactions
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_prevent_terminal_wager_tx_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'Terminal wager transaction (%) in status % cannot be modified or deleted', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Wager transactions are audit records and cannot be deleted (id: %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_wager_transactions_terminal_immutable
      BEFORE UPDATE OR DELETE ON wager_transactions
      FOR EACH ROW
      EXECUTE FUNCTION fn_prevent_terminal_wager_tx_mutation();
    `);

    // 3. Wallet Ledger Entries Table (Strictly Append-Only / Immutable)
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        sequence_number BIGSERIAL NOT NULL UNIQUE,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        direction VARCHAR(16) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(20, 2) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0.00),
        CONSTRAINT chk_ledger_balances_non_negative CHECK (balance_before >= 0.00 AND balance_after >= 0.00),
        CONSTRAINT chk_ledger_arithmetic_balance CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_cursor
      ON wallet_ledger_entries (wallet_id, sequence_number DESC);
    `);

    // Trigger enforcing strict immutability (no UPDATE, no DELETE) on wallet_ledger_entries
    this.addSql(`
      CREATE OR REPLACE FUNCTION fn_prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is strictly append-only; % operation is prohibited (entry id: %)', TG_OP, OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION fn_prevent_ledger_mutation();
    `);

    // 4. Inbox Messages Table (Persistent SQS Deduplication)
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(128) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ NULL,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 5. Outbox Messages Table (Transactional Outbox Pattern)
    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL,
        CONSTRAINT chk_outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_pending_due
      ON outbox_messages (COALESCE(next_attempt_at, occurred_at), occurred_at)
      WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages CASCADE;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_ledger_entries_immutable ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_prevent_ledger_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wager_transactions_terminal_immutable ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_prevent_terminal_wager_tx_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallets CASCADE;`);
  }
}
