ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "student_id" integer;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_audits" ADD COLUMN IF NOT EXISTS "student_id" integer;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD COLUMN IF NOT EXISTS "student_id" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_audits" ADD CONSTRAINT "ai_audits_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
