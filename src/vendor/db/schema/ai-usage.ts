import { integer, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Daily usage quotas for AI Business OS tools.
 * One row per (principal, kind, day). `used` is incremented atomically
 * via a conditional upsert, so concurrent requests cannot exceed the cap.
 *
 * principal: "student:<id>" for logged-in students, "session:<sid>" for anonymous sessions
 * kind:      "audit" | "plan" | "chat"
 * day:       "YYYY-MM-DD" (server-local day bucket)
 */
export const aiUsageQuotas = pgTable("ai_usage_quotas", {
  id:        serial("id").primaryKey(),
  principal: text("principal").notNull(),
  kind:      text("kind").notNull(),
  day:       text("day").notNull(),
  used:      integer("used").notNull().default(0),
}, (t) => [
  uniqueIndex("ai_usage_quotas_principal_kind_day_uq").on(t.principal, t.kind, t.day),
]);

export type AiUsageQuota = typeof aiUsageQuotas.$inferSelect;
