/**
 * Dubai Fans Client Portal 2.0 — Database Schema
 * All tables prefixed with "portal_" to avoid conflicts with existing schema.
 * Financial amounts stored as NUMERIC(12,2) — never float.
 */
import {
  pgTable, serial, text, timestamp, integer,
  boolean, numeric, jsonb, pgEnum, uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Enums ──────────────────────────────────────────────────────────────────────
export const portalOrderStatusEnum = pgEnum("portal_order_status", [
  "new", "under_review", "waiting_customer", "ready_to_start",
  "in_progress", "waiting_approval", "active", "completed", "cancelled",
]);

export const portalWalletTxTypeEnum = pgEnum("portal_wallet_tx_type", [
  "credit", "debit", "refund", "adjustment",
]);

export const portalTopupStatusEnum = pgEnum("portal_topup_status", [
  "pending", "approved", "rejected",
]);

export const portalTicketStatusEnum = pgEnum("portal_ticket_status", [
  "open", "in_progress", "waiting_customer", "resolved", "closed",
]);

export const portalAdminRoleEnum = pgEnum("portal_admin_role", [
  "super_admin", "manager", "marketing", "support", "finance",
]);

export const portalBillingTypeEnum = pgEnum("portal_billing_type", [
  "one_time", "monthly", "yearly",
]);

// ── Customer users ─────────────────────────────────────────────────────────────
export const portalUsers = pgTable("portal_users", {
  id:             serial("id").primaryKey(),
  fullName:       text("full_name").notNull(),
  email:          text("email").notNull().unique(),
  passwordHash:   text("password_hash"),   // nullable: Google-only accounts have no password
  mobile:         text("mobile"),
  country:        text("country"),
  isActive:       boolean("is_active").notNull().default(true),
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalUser       = typeof portalUsers.$inferSelect;
export type InsertPortalUser = typeof portalUsers.$inferInsert;

// ── Customer profiles ──────────────────────────────────────────────────────────
export const portalProfiles = pgTable("portal_profiles", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }).unique(),
  companyName:  text("company_name"),
  phone:        text("phone"),
  whatsapp:     text("whatsapp"),
  country:      text("country"),
  city:         text("city"),
  businessType: text("business_type"),
  website:      text("website"),
  instagram:    text("instagram"),
  facebook:     text("facebook"),
  tiktok:       text("tiktok"),
  googleBiz:    text("google_biz"),
  snapchat:     text("snapchat"),
  linkedin:     text("linkedin"),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalProfile = typeof portalProfiles.$inferSelect;

// ── Services ───────────────────────────────────────────────────────────────────
export const portalServices = pgTable("portal_services", {
  id:            serial("id").primaryKey(),
  nameAr:        text("name_ar").notNull(),
  nameEn:        text("name_en").notNull(),
  descriptionAr: text("description_ar").notNull().default(""),
  descriptionEn: text("description_en").notNull().default(""),
  icon:          text("icon").notNull().default("briefcase"),
  category:      text("category").notNull().default("general"),
  isActive:      boolean("is_active").notNull().default(true),
  sortOrder:     integer("sort_order").notNull().default(0),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalService = typeof portalServices.$inferSelect;

// ── Service packages ───────────────────────────────────────────────────────────
export const portalPackages = pgTable("portal_packages", {
  id:            serial("id").primaryKey(),
  serviceId:     integer("service_id").notNull().references(() => portalServices.id, { onDelete: "cascade" }),
  nameAr:        text("name_ar").notNull(),
  nameEn:        text("name_en").notNull(),
  descriptionAr: text("description_ar").notNull().default(""),
  descriptionEn: text("description_en").notNull().default(""),
  price:         numeric("price", { precision: 12, scale: 2 }).notNull(),
  currency:      text("currency").notNull().default("AED"),
  billingType:   portalBillingTypeEnum("billing_type").notNull().default("one_time"),
  duration:      text("duration"),
  features:      jsonb("features").notNull().default([]),
  isActive:      boolean("is_active").notNull().default(true),
  sortOrder:     integer("sort_order").notNull().default(0),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalPackage = typeof portalPackages.$inferSelect;

// ── Wallets ────────────────────────────────────────────────────────────────────
export const portalWallets = pgTable("portal_wallets", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }).unique(),
  balance:   numeric("balance", { precision: 12, scale: 2 }).notNull().default("0.00"),
  currency:  text("currency").notNull().default("AED"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalWallet = typeof portalWallets.$inferSelect;

// ── Wallet transactions ────────────────────────────────────────────────────────
export const portalWalletTransactions = pgTable("portal_wallet_transactions", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  walletId:    integer("wallet_id").notNull().references(() => portalWallets.id),
  amount:      numeric("amount", { precision: 12, scale: 2 }).notNull(),
  type:        portalWalletTxTypeEnum("type").notNull(),
  description: text("description").notNull().default(""),
  reference:   text("reference"),
  orderId:     integer("order_id"),
  status:      text("status").notNull().default("completed"),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalWalletTransaction = typeof portalWalletTransactions.$inferSelect;

// ── Top-up requests ────────────────────────────────────────────────────────────
export const portalTopupRequests = pgTable("portal_topup_requests", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  amount:        numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull().default("bank_transfer"),
  reference:     text("reference"),
  proofFileUrl:  text("proof_file_url"),
  status:        portalTopupStatusEnum("status").notNull().default("pending"),
  adminNote:     text("admin_note"),
  reviewedBy:    integer("reviewed_by"),
  reviewedAt:    timestamp("reviewed_at", { withTimezone: true }),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalTopupRequest = typeof portalTopupRequests.$inferSelect;

// ── Orders ─────────────────────────────────────────────────────────────────────
export const portalOrders = pgTable("portal_orders", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  serviceId:     integer("service_id").references(() => portalServices.id),
  packageId:     integer("package_id").references(() => portalPackages.id),
  status:        portalOrderStatusEnum("status").notNull().default("new"),
  subtotal:      numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
  vatRate:       numeric("vat_rate", { precision: 5, scale: 2 }).notNull().default("0.00"),
  vatAmount:     numeric("vat_amount", { precision: 12, scale: 2 }).notNull().default("0.00"),
  total:         numeric("total", { precision: 12, scale: 2 }).notNull(),
  currency:      text("currency").notNull().default("AED"),
  notes:         text("notes"),
  internalNotes: text("internal_notes"),
  assignedTo:    integer("assigned_to"),
  walletTxId:    integer("wallet_tx_id"),
  serviceData:   jsonb("service_data"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalOrder = typeof portalOrders.$inferSelect;

// ── Order timeline (status history) ───────────────────────────────────────────
export const portalOrderTimeline = pgTable("portal_order_timeline", {
  id:        serial("id").primaryKey(),
  orderId:   integer("order_id").notNull().references(() => portalOrders.id, { onDelete: "cascade" }),
  status:    text("status").notNull(),
  note:      text("note"),
  createdBy: text("created_by").notNull().default("system"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Campaigns ─────────────────────────────────────────────────────────────────
export const portalCampaigns = pgTable("portal_campaigns", {
  id:               serial("id").primaryKey(),
  orderId:          integer("order_id").notNull().references(() => portalOrders.id, { onDelete: "cascade" }).unique(),
  userId:           integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  platforms:        jsonb("platforms").notNull().default([]),
  businessName:     text("business_name"),
  businessCategory: text("business_category"),
  country:          text("country"),
  city:             text("city"),
  targetAudience:   text("target_audience"),
  ageRangeMin:      integer("age_range_min"),
  ageRangeMax:      integer("age_range_max"),
  gender:           text("gender"),
  objective:        text("objective"),
  platformDetails:  jsonb("platform_details"),
  adHeadline:       text("ad_headline"),
  adPrimaryText:    text("ad_primary_text"),
  adCta:            text("ad_cta"),
  landingPageUrl:   text("landing_page_url"),
  waCountry:        text("wa_country"),
  waNumber:         text("wa_number"),
  durationDays:     integer("duration_days"),
  startDate:        timestamp("start_date", { withTimezone: true }),
  endDate:          timestamp("end_date", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalCampaign = typeof portalCampaigns.$inferSelect;

// ── Campaign reports / metrics ─────────────────────────────────────────────────
export const portalCampaignReports = pgTable("portal_campaign_reports", {
  id:          serial("id").primaryKey(),
  campaignId:  integer("campaign_id").notNull().references(() => portalCampaigns.id, { onDelete: "cascade" }),
  orderId:     integer("order_id").notNull().references(() => portalOrders.id, { onDelete: "cascade" }),
  userId:      integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  periodStart: text("period_start"),
  periodEnd:   text("period_end"),
  reach:       integer("reach").notNull().default(0),
  impressions: integer("impressions").notNull().default(0),
  clicks:      integer("clicks").notNull().default(0),
  messages:    integer("messages").notNull().default(0),
  leads:       integer("leads").notNull().default(0),
  spend:       numeric("spend", { precision: 12, scale: 2 }).notNull().default("0"),
  cpm:         numeric("cpm", { precision: 10, scale: 2 }),
  cpl:         numeric("cpl", { precision: 10, scale: 2 }),
  ctr:         numeric("ctr", { precision: 6, scale: 4 }),
  roas:        numeric("roas", { precision: 8, scale: 2 }),
  notes:       text("notes"),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalCampaignReport = typeof portalCampaignReports.$inferSelect;

// ── Files ──────────────────────────────────────────────────────────────────────
export const portalFiles = pgTable("portal_files", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  orderId:     integer("order_id").references(() => portalOrders.id, { onDelete: "set null" }),
  filename:    text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes:   integer("size_bytes"),
  objectPath:  text("object_path").notNull(),
  uploadUrl:   text("upload_url"),
  category:    text("category").notNull().default("general"),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalFile = typeof portalFiles.$inferSelect;

// ── Notifications ──────────────────────────────────────────────────────────────
export const portalNotifications = pgTable("portal_notifications", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  orderId:   integer("order_id"),
  title:     text("title").notNull(),
  body:      text("body").notNull(),
  type:      text("type").notNull().default("info"),
  isRead:    boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalNotification = typeof portalNotifications.$inferSelect;

// ── Support tickets ────────────────────────────────────────────────────────────
export const portalSupportTickets = pgTable("portal_support_tickets", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  orderId:    integer("order_id"),
  subject:    text("subject").notNull(),
  status:     portalTicketStatusEnum("status").notNull().default("open"),
  assignedTo: integer("assigned_to"),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalSupportTicket = typeof portalSupportTickets.$inferSelect;

// ── Support messages ───────────────────────────────────────────────────────────
export const portalSupportMessages = pgTable("portal_support_messages", {
  id:         serial("id").primaryKey(),
  ticketId:   integer("ticket_id").notNull().references(() => portalSupportTickets.id, { onDelete: "cascade" }),
  senderType: text("sender_type").notNull(),
  senderId:   integer("sender_id").notNull(),
  body:       text("body").notNull(),
  fileUrl:    text("file_url"),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalSupportMessage = typeof portalSupportMessages.$inferSelect;

// ── Admin users ────────────────────────────────────────────────────────────────
export const portalAdminUsers = pgTable("portal_admin_users", {
  id:             serial("id").primaryKey(),
  fullName:       text("full_name").notNull(),
  email:          text("email").notNull().unique(),
  passwordHash:   text("password_hash").notNull(),
  role:           portalAdminRoleEnum("role").notNull().default("support"),
  isActive:       boolean("is_active").notNull().default(true),
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalAdminUser = typeof portalAdminUsers.$inferSelect;

// ── Settings ───────────────────────────────────────────────────────────────────
export const portalSettings = pgTable("portal_settings", {
  id:        serial("id").primaryKey(),
  key:       text("key").notNull().unique(),
  value:     text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Audit log ──────────────────────────────────────────────────────────────────
export const portalAuditLogs = pgTable("portal_audit_logs", {
  id:          serial("id").primaryKey(),
  adminId:     integer("admin_id"),
  adminEmail:  text("admin_email"),
  action:      text("action").notNull(),
  entity:      text("entity").notNull(),
  entityId:    integer("entity_id"),
  description: text("description").notNull(),
  metadata:    jsonb("metadata"),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type PortalAuditLog = typeof portalAuditLogs.$inferSelect;

// ── User identities (OAuth) ────────────────────────────────────────────────────
// Stores third-party OAuth identities linked to portal_users.
// Designed for Google now; add Apple and others by inserting new provider values.
// Unique constraint on (provider, provider_subject) prevents duplicate identities.
export const userIdentities = pgTable("user_identities", {
  id:              serial("id").primaryKey(),
  userId:          integer("user_id").notNull().references(() => portalUsers.id, { onDelete: "cascade" }),
  provider:        text("provider").notNull(),          // 'google' | 'apple'
  providerSubject: text("provider_subject").notNull(),  // stable opaque ID from the provider
  email:           text("email"),                       // email as reported by provider
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("user_identities_provider_subject_idx").on(t.provider, t.providerSubject),
]);
export type UserIdentity = typeof userIdentities.$inferSelect;
