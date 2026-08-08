import { pgTable, serial, text, timestamp, integer, doublePrecision, date, unique } from "drizzle-orm/pg-core";
import { students } from "./students";

/**
 * exams — quizzes/tests per course (created by admin)
 */
export const exams = pgTable("exams", {
  id:          serial("id").primaryKey(),
  courseSlug:  text("course_slug").notNull(),
  title:       text("title").notNull(),
  description: text("description").notNull().default(""),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * exam_attempts — student exam submissions
 */
export const examAttempts = pgTable("exam_attempts", {
  id:        serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  examId:    integer("exam_id").notNull().references(() => exams.id, { onDelete: "cascade" }),
  score:     doublePrecision("score").notNull().default(0),
  maxScore:  doublePrecision("max_score").notNull().default(100),
  takenAt:   timestamp("taken_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * assignments — tasks/homework per course (created by admin)
 */
export const assignments = pgTable("assignments", {
  id:          serial("id").primaryKey(),
  courseSlug:  text("course_slug").notNull(),
  title:       text("title").notNull(),
  description: text("description").notNull().default(""),
  dueDate:     date("due_date"),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * assignment_submissions — student file/link submissions for assignments.
 * Unique constraint on (student_id, assignment_id) enforces one submission
 * record per student per assignment (updates go through UPSERT).
 */
export const assignmentSubmissions = pgTable("assignment_submissions", {
  id:           serial("id").primaryKey(),
  studentId:    integer("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  assignmentId: integer("assignment_id").notNull().references(() => assignments.id, { onDelete: "cascade" }),
  fileUrl:      text("file_url").notNull().default(""),  // Google Drive link or similar
  notes:        text("notes").notNull().default(""),
  submittedAt:  timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
  grade:        doublePrecision("grade"),                // null until graded by admin
  feedback:     text("feedback").notNull().default(""),
}, (t) => ({
  uniqStudentAssignment: unique("assignment_submissions_student_assignment_unique")
    .on(t.studentId, t.assignmentId),
}));

/**
 * course_downloads — downloadable materials per course (uploaded by admin)
 */
export const courseDownloads = pgTable("course_downloads", {
  id:         serial("id").primaryKey(),
  courseSlug: text("course_slug").notNull(),
  title:      text("title").notNull(),
  fileUrl:    text("file_url").notNull(),
  fileSize:   text("file_size").notNull().default(""),   // human-readable e.g. "2.4 MB"
  fileType:   text("file_type").notNull().default("pdf"), // pdf | video | zip | etc.
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Exam                    = typeof exams.$inferSelect;
export type InsertExam              = typeof exams.$inferInsert;
export type ExamAttempt             = typeof examAttempts.$inferSelect;
export type InsertExamAttempt       = typeof examAttempts.$inferInsert;
export type Assignment              = typeof assignments.$inferSelect;
export type InsertAssignment        = typeof assignments.$inferInsert;
export type AssignmentSubmission    = typeof assignmentSubmissions.$inferSelect;
export type InsertAssignmentSubmission = typeof assignmentSubmissions.$inferInsert;
export type CourseDownload          = typeof courseDownloads.$inferSelect;
export type InsertCourseDownload    = typeof courseDownloads.$inferInsert;
