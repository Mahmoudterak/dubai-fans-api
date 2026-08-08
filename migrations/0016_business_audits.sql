CREATE TABLE IF NOT EXISTS "business_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"student_id" integer,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"company_name" text NOT NULL,
	"targets" jsonb NOT NULL,
	"business_type" text NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"links" jsonb NOT NULL,
	"extra" jsonb NOT NULL,
	"report" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_audits" ADD CONSTRAINT "business_audits_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
