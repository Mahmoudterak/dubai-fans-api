-- Keep website and mobile orders in the existing portal_orders table.
-- Existing rows and browser submissions remain website orders by default.
DO $$ BEGIN
  CREATE TYPE "portal_order_source" AS ENUM ('website', 'mobile_app');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "portal_orders"
  ADD COLUMN IF NOT EXISTS "source" "portal_order_source" NOT NULL DEFAULT 'website';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_orders_source_created_at_idx"
  ON "portal_orders" ("source", "created_at" DESC);