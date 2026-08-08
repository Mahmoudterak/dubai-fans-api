import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";

/**
 * students — registered student accounts for the Dubai Fans Academy portal
 */
export const students = pgTable("students", {
  id:           serial("id").primaryKey(),
  fullName:     text("full_name").notNull(),
  email:        text("email").notNull().unique(),
  // Nullable: students who sign up via Google OAuth have no password.
  passwordHash: text("password_hash"),
  // Google OAuth subject id ("sub") — set when the account is created via
  // Google or linked to a Google account from the profile page.
  googleId:     text("google_id").unique(),
  phone:        text("phone").notNull().default(""),
  city:         text("city").notNull().default(""),
  /** Bumped on password change / "logout all devices" — session cookies embed
   *  this version and become invalid when it no longer matches. */
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Student       = typeof students.$inferSelect;
export type InsertStudent = typeof students.$inferInsert;
