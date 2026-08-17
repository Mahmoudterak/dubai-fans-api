CREATE TYPE "public"."portal_admin_role" AS ENUM('super_admin', 'manager', 'marketing', 'support', 'finance');--> statement-breakpoint
CREATE TYPE "public"."portal_billing_type" AS ENUM('one_time', 'monthly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."portal_order_status" AS ENUM('new', 'under_review', 'waiting_customer', 'ready_to_start', 'in_progress', 'waiting_approval', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."portal_ticket_status" AS ENUM('open', 'in_progress', 'waiting_customer', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."portal_topup_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."portal_wallet_tx_type" AS ENUM('credit', 'debit', 'refund', 'adjustment');--> statement-breakpoint
CREATE TABLE "portal_admin_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "portal_admin_role" DEFAULT 'support' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "portal_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"admin_id" integer,
	"admin_email" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" integer,
	"description" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_campaign_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"period_start" text,
	"period_end" text,
	"reach" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"leads" integer DEFAULT 0 NOT NULL,
	"spend" numeric(12, 2) DEFAULT '0' NOT NULL,
	"cpm" numeric(10, 2),
	"cpl" numeric(10, 2),
	"ctr" numeric(6, 4),
	"roas" numeric(8, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_name" text,
	"business_category" text,
	"country" text,
	"city" text,
	"target_audience" text,
	"age_range_min" integer,
	"age_range_max" integer,
	"gender" text,
	"objective" text,
	"platform_details" jsonb,
	"ad_headline" text,
	"ad_primary_text" text,
	"ad_cta" text,
	"landing_page_url" text,
	"wa_country" text,
	"wa_number" text,
	"duration_days" integer,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_campaigns_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "portal_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"order_id" integer,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer,
	"object_path" text NOT NULL,
	"upload_url" text,
	"category" text DEFAULT 'general' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"order_id" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"type" text DEFAULT 'info' NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_order_timeline" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"service_id" integer,
	"package_id" integer,
	"status" "portal_order_status" DEFAULT 'new' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"vat_rate" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"vat_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'AED' NOT NULL,
	"notes" text,
	"internal_notes" text,
	"assigned_to" integer,
	"wallet_tx_id" integer,
	"service_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"description_ar" text DEFAULT '' NOT NULL,
	"description_en" text DEFAULT '' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'AED' NOT NULL,
	"billing_type" "portal_billing_type" DEFAULT 'one_time' NOT NULL,
	"duration" text,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"company_name" text,
	"phone" text,
	"whatsapp" text,
	"country" text,
	"city" text,
	"business_type" text,
	"website" text,
	"instagram" text,
	"facebook" text,
	"tiktok" text,
	"google_biz" text,
	"snapchat" text,
	"linkedin" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "portal_services" (
	"id" serial PRIMARY KEY NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"description_ar" text DEFAULT '' NOT NULL,
	"description_en" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'briefcase' NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "portal_support_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" integer NOT NULL,
	"body" text NOT NULL,
	"file_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"order_id" integer,
	"subject" text NOT NULL,
	"status" "portal_ticket_status" DEFAULT 'open' NOT NULL,
	"assigned_to" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_topup_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"payment_method" text DEFAULT 'bank_transfer' NOT NULL,
	"reference" text,
	"proof_file_url" text,
	"status" "portal_topup_status" DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"mobile" text,
	"country" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "portal_wallet_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"type" "portal_wallet_tx_type" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"reference" text,
	"order_id" integer,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"balance" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"currency" text DEFAULT 'AED' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_wallets_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "portal_campaign_reports" ADD CONSTRAINT "portal_campaign_reports_campaign_id_portal_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."portal_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_campaign_reports" ADD CONSTRAINT "portal_campaign_reports_order_id_portal_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."portal_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_campaign_reports" ADD CONSTRAINT "portal_campaign_reports_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_campaigns" ADD CONSTRAINT "portal_campaigns_order_id_portal_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."portal_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_campaigns" ADD CONSTRAINT "portal_campaigns_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_files" ADD CONSTRAINT "portal_files_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_files" ADD CONSTRAINT "portal_files_order_id_portal_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."portal_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_notifications" ADD CONSTRAINT "portal_notifications_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_order_timeline" ADD CONSTRAINT "portal_order_timeline_order_id_portal_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."portal_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_orders" ADD CONSTRAINT "portal_orders_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_orders" ADD CONSTRAINT "portal_orders_service_id_portal_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."portal_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_orders" ADD CONSTRAINT "portal_orders_package_id_portal_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."portal_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_packages" ADD CONSTRAINT "portal_packages_service_id_portal_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."portal_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_profiles" ADD CONSTRAINT "portal_profiles_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_support_messages" ADD CONSTRAINT "portal_support_messages_ticket_id_portal_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."portal_support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_support_tickets" ADD CONSTRAINT "portal_support_tickets_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_topup_requests" ADD CONSTRAINT "portal_topup_requests_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_wallet_transactions" ADD CONSTRAINT "portal_wallet_transactions_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_wallet_transactions" ADD CONSTRAINT "portal_wallet_transactions_wallet_id_portal_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."portal_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_wallets" ADD CONSTRAINT "portal_wallets_user_id_portal_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."portal_users"("id") ON DELETE cascade ON UPDATE no action;