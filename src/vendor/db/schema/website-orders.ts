import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Orders from the "أنشئ موقعك بالذكاء الاصطناعي" offer on /website-templates.
 * The visitor describes the website they want; the team builds and delivers it.
 */
export const websiteOrders = pgTable("website_orders", {
  id:           serial("id").primaryKey(),
  businessName: text("business_name").notNull(),
  businessType: text("business_type").notNull(),
  email:        text("email").notNull(),
  phone:        text("phone").notNull(),
  siteType:     text("site_type").notNull().default("website"), // website | store
  details:      text("details").notNull().default(""),          // pages, content, colors…
  status:       text("status").notNull().default("new"),        // new | contacted | in_progress | delivered | cancelled
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WebsiteOrder       = typeof websiteOrders.$inferSelect;
export type InsertWebsiteOrder = typeof websiteOrders.$inferInsert;
