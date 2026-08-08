ALTER TABLE "campaign_reports" ADD COLUMN IF NOT EXISTS "notification_status" text;--> statement-breakpoint
ALTER TABLE "campaign_reports" ADD COLUMN IF NOT EXISTS "notification_at" timestamp with time zone;
