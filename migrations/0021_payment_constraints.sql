-- Migration: add unique constraint on wallet transaction reference
-- Prevents duplicate credits from the same external payment event.
-- The partial index excludes NULL references (manual bank transfers have no reference).

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_ref_unique
  ON portal_wallet_transactions(reference)
  WHERE reference IS NOT NULL;
