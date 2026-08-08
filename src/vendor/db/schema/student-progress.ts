import { pgTable, serial, text, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { students } from "./students";

/**
 * course_progress — tracks which lessons a student has marked complete.
 * Unique constraint on (student_id, course_slug, lesson_id) ensures a lesson
 * can only be marked once per student, preventing duplicate progress records
 * from concurrent requests.
 */
export const courseProgress = pgTable("course_progress", {
  id:           serial("id").primaryKey(),
  studentId:    integer("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  courseSlug:   text("course_slug").notNull(),
  lessonId:     text("lesson_id").notNull(),
  lessonTitle:  text("lesson_title").notNull().default(""),
  completedAt:  timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqStudentCourseLesson: unique("course_progress_student_course_lesson_unique")
    .on(t.studentId, t.courseSlug, t.lessonId),
}));

/**
 * certificates — issued when a student completes all lessons in a course.
 * Unique constraint on (student_id, course_slug) ensures at most one certificate
 * per student per course, preventing duplicate issuance from concurrent requests.
 */
export const certificates = pgTable("certificates", {
  id:          serial("id").primaryKey(),
  studentId:   integer("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  courseSlug:  text("course_slug").notNull(),
  courseName:  text("course_name").notNull(),
  issuedAt:    timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqStudentCourse: unique("certificates_student_course_unique")
    .on(t.studentId, t.courseSlug),
}));

export type CourseProgress       = typeof courseProgress.$inferSelect;
export type InsertCourseProgress = typeof courseProgress.$inferInsert;
export type Certificate          = typeof certificates.$inferSelect;
export type InsertCertificate    = typeof certificates.$inferInsert;
