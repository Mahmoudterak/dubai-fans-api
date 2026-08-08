import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const aibosLeads = pgTable("ai_business_os_leads", {
  id:           serial("id").primaryKey(),
  name:         text("name").notNull(),
  email:        text("email").notNull(),
  businessType: text("business_type").notNull(),
  city:         text("city").notNull().default(""),
  status:       text("status").notNull().default("new"), // new | contacted | interested | not_interested
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AibosLead       = typeof aibosLeads.$inferSelect;
export type InsertAibosLead = typeof aibosLeads.$inferInsert;
