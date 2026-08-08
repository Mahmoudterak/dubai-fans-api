import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Demo requests from the Products section — visitors request a live demo
 * of AI Business OS, Clinic OS, or AMLAK OS.
 */
export const demoRequests = pgTable("demo_requests", {
  id:        serial("id").primaryKey(),
  product:   text("product").notNull(),             // ai-os | clinic-os | amlak-os
  name:      text("name").notNull(),
  email:     text("email").notNull(),
  message:   text("message").notNull().default(""),
  status:    text("status").notNull().default("new"), // new | contacted | closed
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type DemoRequest       = typeof demoRequests.$inferSelect;
export type InsertDemoRequest = typeof demoRequests.$inferInsert;
