CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
"id" serial PRIMARY KEY NOT NULL,
"user_id" integer NOT NULL,
"token_hash" text NOT NULL,
"expires_at" timestamp with time zone NOT NULL,
"used_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
-- client_auth may already have been replaced by company_users (0007); skip if gone.
DO $$ BEGIN
  IF to_regclass('public.client_auth') IS NOT NULL THEN
    ALTER TABLE "client_auth" ADD COLUMN IF NOT EXISTS "force_password_change" boolean DEFAULT false NOT NULL;
    BEGIN
      ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_client_auth_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_auth"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
