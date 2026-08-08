-- Multi-user company auth: company_users replaces client_auth.
-- Existing client_auth rows are migrated as active "owner" users that keep
-- their password (force_password_change=false) and session_version.
-- Fully idempotent: safe to re-run on databases in any intermediate state.
DO $$ BEGIN
  CREATE TYPE "company_role" AS ENUM ('owner', 'gm', 'marketing', 'doctor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_users" (
  "id" serial PRIMARY KEY NOT NULL,
  "client_id" integer NOT NULL,
  "email" text NOT NULL,
  "name" text DEFAULT '' NOT NULL,
  "password_hash" text NOT NULL,
  "role" "company_role" DEFAULT 'owner' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "force_password_change" boolean DEFAULT true NOT NULL,
  "session_version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "company_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_users" ADD CONSTRAINT "company_users_client_id_clients_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Migrate legacy client_auth rows (only when client_auth still exists),
-- re-point password_reset_tokens at company_users, then drop client_auth.
-- Old tokens referenced client_auth ids, which do not map 1:1 — purge them.
DO $$ BEGIN
  IF to_regclass('public.client_auth') IS NOT NULL THEN
    INSERT INTO "company_users" ("client_id", "email", "name", "password_hash", "role", "is_active", "force_password_change", "session_version", "created_at")
    SELECT "client_id", "email", '', "password_hash", 'owner', true, false, "session_version", "created_at"
    FROM "client_auth"
    ON CONFLICT ("email") DO NOTHING;
    ALTER TABLE "password_reset_tokens" DROP CONSTRAINT IF EXISTS "password_reset_tokens_user_id_client_auth_id_fk";
    DELETE FROM "password_reset_tokens";
    DROP TABLE "client_auth";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_company_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."company_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
