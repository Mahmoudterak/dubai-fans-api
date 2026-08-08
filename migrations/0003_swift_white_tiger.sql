DO $$ BEGIN
  CREATE TYPE "public"."report_status" AS ENUM('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_data" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"platform" text NOT NULL,
	"spend" numeric(12, 2) DEFAULT '0' NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"reach" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"leads" integer DEFAULT 0 NOT NULL,
	"bookings" integer DEFAULT 0 NOT NULL,
	"prev_spend" numeric(12, 2) DEFAULT '0' NOT NULL,
	"prev_impressions" integer DEFAULT 0 NOT NULL,
	"prev_reach" integer DEFAULT 0 NOT NULL,
	"prev_clicks" integer DEFAULT 0 NOT NULL,
	"prev_messages" integer DEFAULT 0 NOT NULL,
	"prev_calls" integer DEFAULT 0 NOT NULL,
	"prev_leads" integer DEFAULT 0 NOT NULL,
	"prev_bookings" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "campaign_data_report_platform" UNIQUE("report_id","platform")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"title" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"status" "report_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_auth" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_auth_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"logo_url" text DEFAULT '' NOT NULL,
	"industry" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_content" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"executive_summary" text DEFAULT '' NOT NULL,
	"ai_analysis" jsonb,
	"recommendations" jsonb,
	"next_month_plan" jsonb,
	"weekly_timeline" jsonb,
	"generated_at" timestamp with time zone,
	CONSTRAINT "report_content_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "campaign_data" ADD CONSTRAINT "campaign_data_report_id_campaign_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."campaign_reports"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "campaign_reports" ADD CONSTRAINT "campaign_reports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "client_auth" ADD CONSTRAINT "client_auth_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "report_content" ADD CONSTRAINT "report_content_report_id_campaign_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."campaign_reports"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;