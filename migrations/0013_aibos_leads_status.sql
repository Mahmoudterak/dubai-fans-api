ALTER TABLE "ai_business_os_leads" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'new' NOT NULL;
