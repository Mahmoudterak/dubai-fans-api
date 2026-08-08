import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export const seoLeads = pgTable("seo_leads", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  country: text("country").notNull().default("United Arab Emirates"),
  websiteUrl: text("website_url").notNull(),
  auditScore: integer("audit_score"),
  auditResult: jsonb("audit_result"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type SeoLead = typeof seoLeads.$inferSelect;
export type InsertSeoLead = typeof seoLeads.$inferInsert;
