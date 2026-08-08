import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { students } from "./students";

export const conversations = pgTable("conversations", {
  id:        serial("id").primaryKey(),
  sessionId: text("session_id"),            // anonymous browser session — may be null for legacy rows
  studentId: integer("student_id").references(() => students.id, { onDelete: "set null" }),
  title:     text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
