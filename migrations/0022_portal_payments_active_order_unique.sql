-- Migration: partial unique index to prevent concurrent duplicate order payments
--
-- Enforces at the database level that only one payment per order can be in an
-- active state (pending, processing, or completed) at any moment. Two
-- concurrent INSERT attempts for the same order_id will race at this index;
-- exactly one succeeds and the other receives a unique-constraint violation
-- (PG error code 23505) which the application layer converts to HTTP 409.
--
-- Rows where order_id IS NULL (wallet top-ups) are excluded from the constraint.
-- Rows with status = 'failed', 'cancelled', or 'refunded' are also excluded so
-- a customer can retry after a failed/cancelled payment.

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_payments_order_active
  ON portal_payments(order_id)
  WHERE order_id IS NOT NULL
    AND status IN ('pending', 'processing', 'completed');
