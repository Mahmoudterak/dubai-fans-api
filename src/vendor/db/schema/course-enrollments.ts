import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { students } from "./students";

/**
 * course_enrollments — stores registration requests from /courses/:slug/register
 * Status values: "new" | "contacted" | "enrolled" | "cancelled"
 */
export const courseEnrollments = pgTable("course_enrollments", {
  id:            serial("id").primaryKey(),
  courseSlug:    text("course_slug").notNull(),
  courseName:    text("course_name").notNull(),
  fullName:      text("full_name").notNull(),
  phone:         text("phone").notNull(),
  email:         text("email").notNull(),
  jobTitle:      text("job_title").notNull().default(""),
  city:          text("city").notNull().default(""),
  paymentMethod: text("payment_method").notNull().default(""),
  howDidYouHear: text("how_did_you_hear").notNull().default(""),
  questions:     text("questions").notNull().default(""),
  status:        text("status").notNull().default("new"),  // new | contacted | enrolled | cancelled
  studentId:     integer("student_id").references(() => students.id, { onDelete: "set null" }),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CourseEnrollment    = typeof courseEnrollments.$inferSelect;
export type InsertCourseEnrollment = typeof courseEnrollments.$inferInsert;
