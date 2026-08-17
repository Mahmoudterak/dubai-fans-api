-- Migration: portal_payments table
-- Tracks all Ziina payment intents for wallet top-ups and order payments.

CREATE TABLE IF NOT EXISTS portal_payments (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  order_id            INTEGER REFERENCES portal_orders(id) ON DELETE SET NULL,
  topup_request_id    INTEGER REFERENCES portal_topup_requests(id) ON DELETE SET NULL,
  provider            TEXT NOT NULL DEFAULT 'ziina',
  provider_payment_id TEXT UNIQUE,           -- Ziina's payment intent ID (set after API call)
  operation_id        TEXT UNIQUE NOT NULL,  -- Our internal idempotency key (UUID)
  amount              NUMERIC(12,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'AED',
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending|completed|failed|cancelled|refunded
  failure_reason      TEXT,
  metadata            JSONB,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portal_payments_user_id_idx ON portal_payments(user_id);
CREATE INDEX IF NOT EXISTS portal_payments_order_id_idx ON portal_payments(order_id);
CREATE INDEX IF NOT EXISTS portal_payments_status_idx  ON portal_payments(status);
