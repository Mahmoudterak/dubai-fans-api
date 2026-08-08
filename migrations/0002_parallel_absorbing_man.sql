CREATE TABLE IF NOT EXISTS "ai_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"business_name" text DEFAULT '' NOT NULL,
	"analysis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"business_name" text DEFAULT '' NOT NULL,
	"duration" integer DEFAULT 30 NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "session_id" text;