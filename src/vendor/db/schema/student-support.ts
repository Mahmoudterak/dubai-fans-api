import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { students } from "./students";

/**
 * support_tickets — student support requests
 * status: "open" | "in_review" | "resolved"
 */
export const supportTickets = pgTable("support_tickets", {
  id:        serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  subject:   text("subject").notNull(),
  body:      text("body").notNull(),
  status:    text("status").notNull().default("open"),  // open | in_review | resolved
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * ticket_replies — replies to support tickets (from admin or student)
 */
export const ticketReplies = pgTable("ticket_replies", {
  id:        serial("id").primaryKey(),
  ticketId:  integer("ticket_id").notNull().references(() => supportTickets.id, { onDelete: "cascade" }),
  body:      text("body").notNull(),
  isAdmin:   boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SupportTicket       = typeof supportTickets.$inferSelect;
export type InsertSupportTicket = typeof supportTickets.$inferInsert;
export type TicketReply         = typeof ticketReplies.$inferSelect;
export type InsertTicketReply   = typeof ticketReplies.$inferInsert;
