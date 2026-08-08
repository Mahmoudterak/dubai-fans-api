import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Enums ──────────────────────────────────────────────────────────────────────
export const reportStatusEnum = pgEnum("report_status", ["draft", "published"]);

export const companyRoleEnum  = pgEnum("company_role", ["owner", "gm", "marketing", "doctor"]);
export const clients = pgTable("clients", {
  id:        serial("id").primaryKey(),
  slug:      text("slug").notNull().unique(),
  name:      text("name").notNull(),
  logoUrl:   text("logo_url").notNull().default(""),
  industry:  text("industry").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertClientSchema = createInsertSchema(clients).omit({ id: true, createdAt: true });
export type Client       = typeof clients.$inferSelect;
export type InsertClient = z.infer<typeof insertClientSchema>;

export const companyUsers = pgTable("company_users", {
  id:                  serial("id").primaryKey(),
  clientId:            integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  email:               text("email").notNull().unique(),
  name:                text("name").notNull().default(""),
  passwordHash:        text("password_hash").notNull(),
  role:                companyRoleEnum("role").notNull().default("owner"),
  isActive:            boolean("is_active").notNull().default(true),
  forcePasswordChange: boolean("force_password_change").notNull().default(true),
  sessionVersion:      integer("session_version").notNull().default(0),
  createdAt:           timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
// ── password_reset_tokens ─────────────────────────────────────────────────────
// One-time tokens for client-portal password reset (SHA-256 hash stored, 1h TTL).
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => companyUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt:    timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// ── campaign_reports ──────────────────────────────────────────────────────────
export const campaignReports = pgTable("campaign_reports", {
  id:          serial("id").primaryKey(),
  clientId:    integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  title:       text("title").notNull(),
  periodStart: text("period_start").notNull(), // ISO date string YYYY-MM-DD
  periodEnd:   text("period_end").notNull(),
  status:      reportStatusEnum("status").notNull().default("draft"),
  // Result of the last report-published email notification:
  // "sent" | "failed" | "not_configured" | null (never attempted / draft)
  notificationStatus: text("notification_status"),
  notificationAt:     timestamp("notification_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertCampaignReportSchema = createInsertSchema(campaignReports).omit({ id: true, createdAt: true, updatedAt: true });
export type CampaignReport       = typeof campaignReports.$inferSelect;
export type InsertCampaignReport = z.infer<typeof insertCampaignReportSchema>;

// ── campaign_data ─────────────────────────────────────────────────────────────
// One row per platform per report. previous_* are last-period values for MoM delta.
export const campaignData = pgTable("campaign_data", {
  id:                serial("id").primaryKey(),
  reportId:          integer("report_id").notNull().references(() => campaignReports.id, { onDelete: "cascade" }),
  platform:          text("platform").notNull(), // e.g. "meta", "google", "tiktok", "snapchat"

  // Current period
  spend:             numeric("spend", { precision: 12, scale: 2 }).notNull().default("0"),
  impressions:       integer("impressions").notNull().default(0),
  reach:             integer("reach").notNull().default(0),
  clicks:            integer("clicks").notNull().default(0),
  messages:          integer("messages").notNull().default(0),
  calls:             integer("calls").notNull().default(0),
  leads:             integer("leads").notNull().default(0),
  bookings:          integer("bookings").notNull().default(0),

  // Previous period (for MoM delta)
  prevSpend:         numeric("prev_spend", { precision: 12, scale: 2 }).notNull().default("0"),
  prevImpressions:   integer("prev_impressions").notNull().default(0),
  prevReach:         integer("prev_reach").notNull().default(0),
  prevClicks:        integer("prev_clicks").notNull().default(0),
  prevMessages:      integer("prev_messages").notNull().default(0),
  prevCalls:         integer("prev_calls").notNull().default(0),
  prevLeads:         integer("prev_leads").notNull().default(0),
  prevBookings:      integer("prev_bookings").notNull().default(0),
}, (t) => [unique("campaign_data_report_platform").on(t.reportId, t.platform)]);

export const insertCampaignDataSchema = createInsertSchema(campaignData).omit({ id: true });
export type CampaignData       = typeof campaignData.$inferSelect;
export type InsertCampaignData = z.infer<typeof insertCampaignDataSchema>;

// ── report_content ────────────────────────────────────────────────────────────
// AI-generated narrative content — one row per report.
export const reportContent = pgTable("report_content", {
  id:               serial("id").primaryKey(),
  reportId:         integer("report_id").notNull().references(() => campaignReports.id, { onDelete: "cascade" }).unique(),
  executiveSummary: text("executive_summary").notNull().default(""),
  aiAnalysis:       jsonb("ai_analysis"),    // { bestPlatform, bestAd, bestAudience, bestTime, strengths[], weaknesses[] }
  recommendations:  jsonb("recommendations"), // [{ title, description, impact: "high"|"medium"|"low" }]
  nextMonthPlan:    jsonb("next_month_plan"), // [{ week, focus, budget, channels[] }]
  weeklyTimeline:   jsonb("weekly_timeline"), // [{ week, notes }]
  mediaUrls:        jsonb("media_urls"),       // string[] — object paths like /objects/uploads/<uuid>
  generatedAt:      timestamp("generated_at", { withTimezone: true }),
});

export type ReportContent       = typeof reportContent.$inferSelect;

export type CompanyUser = typeof companyUsers.$inferSelect;

export type CompanyRole = CompanyUser["role"];
