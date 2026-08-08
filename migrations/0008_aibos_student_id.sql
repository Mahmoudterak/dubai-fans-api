-- Add optional student_id FK to AI Business OS tables so logged-in students
-- retain their analyses, plans, and conversations across devices/browsers.
ALTER TABLE "ai_audits" ADD COLUMN IF NOT EXISTS "student_id" integer;
--> statement-breakpoint
ALTER TABLE "ai_plans" ADD COLUMN IF NOT EXISTS "student_id" integer;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "student_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_audits" ADD CONSTRAINT "ai_audits_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
