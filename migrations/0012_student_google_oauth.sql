-- Add Google OAuth support to students table:
-- 1. Drop NOT NULL on password_hash (Google-only students have no password)
-- 2. Add unique nullable google_id column
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'password_hash') THEN
    ALTER TABLE "students" ALTER COLUMN "password_hash" DROP NOT NULL;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "google_id" text UNIQUE;
