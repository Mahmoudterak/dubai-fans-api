CREATE TABLE IF NOT EXISTS "ai_business_os_leads" (
  "id"            serial PRIMARY KEY NOT NULL,
  "name"          text NOT NULL,
  "email"         text NOT NULL,
  "business_type" text NOT NULL,
  "city"          text NOT NULL DEFAULT '',
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL
);
