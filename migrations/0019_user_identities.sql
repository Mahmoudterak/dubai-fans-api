-- Migration: user_identities + make password_hash nullable for OAuth accounts
-- user_identities stores third-party OAuth identities linked to portal_users.
-- The unique constraint on (provider, provider_subject) prevents duplicate identities.
-- password_hash is made nullable so Google-only accounts never need a sentinel value.

ALTER TABLE "portal_users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE "user_identities" (
  "id"               serial PRIMARY KEY NOT NULL,
  "user_id"          integer NOT NULL,
  "provider"         text NOT NULL,
  "provider_subject" text NOT NULL,
  "email"            text,
  "created_at"       timestamptz DEFAULT now() NOT NULL,
  "updated_at"       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "user_identities_provider_subject_unique" UNIQUE ("provider", "provider_subject")
);
--> statement-breakpoint
ALTER TABLE "user_identities"
  ADD CONSTRAINT "user_identities_user_id_portal_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;
