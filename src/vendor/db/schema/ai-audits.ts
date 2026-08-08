import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { students } from "./students";

export const aiAudits = pgTable("ai_audits", {
  id:           serial("id").primaryKey(),
  sessionId:    text("session_id").notNull(),
  studentId:    integer("student_id").references(() => students.id, { onDelete: "set null" }),
  type:         text("type").notNull(),
  url:          text("url").notNull().default(""),
  businessName: text("business_name").notNull().default(""),
  analysis:     jsonb("analysis").notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertAiAuditSchema = createInsertSchema(aiAudits).omit({
  id:        true,
  createdAt: true,
});

export type AiAudit       = typeof aiAudits.$inferSelect;
export type InsertAiAudit = z.infer<typeof insertAiAuditSchema>;
