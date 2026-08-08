CREATE TABLE IF NOT EXISTS "demo_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
