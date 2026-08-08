import { pgTable, serial, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { students } from "./students";

/**
 * "AI Business Audit" requests from the /ai-business-audit wizard.
 * Each row is both a sales lead (contact info + status) and the container
 * for the AI-generated report (JSONB), owned by the anonymous aib_sid
 * session and claimable by a logged-in student account.
 */
export const businessAudits = pgTable("business_audits", {
  id:            serial("id").primaryKey(),
  sessionId:     text("session_id").notNull(),                // aib_sid anonymous cookie
  studentId:     integer("student_id").references(() => students.id, { onDelete: "set null" }),
  /* Contact / lead info */
  name:          text("name").notNull(),
  email:         text("email").notNull(),
  phone:         text("phone").notNull(),
  companyName:   text("company_name").notNull(),
  /* Wizard answers */
  targets:       jsonb("targets").notNull(),                  // ["website","instagram",...]
  businessType:  text("business_type").notNull(),
  country:       text("country").notNull().default(""),
  city:          text("city").notNull().default(""),
  links:         jsonb("links").notNull(),                    // { website, instagram, facebook, tiktok, googleBusiness }
  extra:         jsonb("extra").notNull(),                    // { employees, branches, budget, hasWebsite, hasCampaigns }
  /* AI output */
  report:        jsonb("report"),                             // null until generation succeeds
  /* Lead lifecycle in the admin dashboard */
  status:        text("status").notNull().default("new"),     // new | contacted | interested | not_interested
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BusinessAudit       = typeof businessAudits.$inferSelect;
export type InsertBusinessAudit = typeof businessAudits.$inferInsert;
