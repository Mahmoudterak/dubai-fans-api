import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { students } from "./students";

export const aiPlans = pgTable("ai_plans", {
  id:           serial("id").primaryKey(),
  sessionId:    text("session_id").notNull(),
  studentId:    integer("student_id").references(() => students.id, { onDelete: "set null" }),
  businessName: text("business_name").notNull().default(""),
  duration:     integer("duration").notNull().default(30),
  plan:         jsonb("plan").notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertAiPlanSchema = createInsertSchema(aiPlans).omit({
  id:        true,
  createdAt: true,
});

export type AiPlan       = typeof aiPlans.$inferSelect;
export type InsertAiPlan = z.infer<typeof insertAiPlanSchema>;
