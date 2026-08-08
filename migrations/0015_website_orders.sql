CREATE TABLE IF NOT EXISTS "website_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "business_name" text NOT NULL,
  "business_type" text NOT NULL,
  "email" text NOT NULL,
  "phone" text NOT NULL,
  "site_type" text DEFAULT 'website' NOT NULL,
  "details" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'new' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
