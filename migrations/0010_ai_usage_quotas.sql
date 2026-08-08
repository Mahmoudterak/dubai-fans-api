CREATE TABLE IF NOT EXISTS "ai_usage_quotas" (
	"id" serial PRIMARY KEY NOT NULL,
	"principal" text NOT NULL,
	"kind" text NOT NULL,
	"day" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_usage_quotas_principal_kind_day_uq" ON "ai_usage_quotas" USING btree ("principal","kind","day");