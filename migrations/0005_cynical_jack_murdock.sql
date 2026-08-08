-- client_auth may already have been replaced by company_users (0007); skip if gone.
DO $$ BEGIN
  IF to_regclass('public.client_auth') IS NOT NULL THEN
    ALTER TABLE "client_auth" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;
  END IF;
END $$;
