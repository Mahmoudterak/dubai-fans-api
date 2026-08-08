/**
 * Student Dashboard Routes — 9 sections
 *
 * GET  /api/student/dashboard/summary     — overview stats
 * GET  /api/student/progress/:courseSlug  — lesson list with completion state (enrollment-gated)
 * POST /api/student/progress              — mark a lesson complete/incomplete (enrollment + lesson-id validated)
 * GET  /api/student/certificates          — list earned certificates (own only)
 * GET  /api/student/certificates/:id/view — styled HTML certificate (print-friendly, HTML-escaped)
 * POST /api/student/certificates/issue    — issue certificate (requires enrollment + all lessons done)
 * GET  /api/student/exams                 — exams for enrolled courses (admin-created; delivery deferred)
 * GET  /api/student/assignments           — assignments for enrolled courses
 * POST /api/student/assignments/:id/submit — submit assignment (enrollment-gated)
 * GET  /api/student/downloads             — course materials (enrollment-gated)
 * GET  /api/student/tickets               — support tickets (own only)
 * POST /api/student/tickets               — open support ticket
 * GET  /api/student/tickets/:id           — single ticket + replies (own only)
 * POST /api/student/tickets/:id/reply     — student reply (own only)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  students,
  courseEnrollments,
  courseProgress,
  certificates,
  exams,
  examAttempts,
  assignments,
  assignmentSubmissions,
  courseDownloads,
  supportTickets,
  ticketReplies,
} from "@workspace/db";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { requireStudent } from "./student-auth";
import { logger } from "../lib/logger";
import { sendCourseCompletedEmail } from "../lib/mailer.js";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// CSRF protection — "custom request header" technique
// All state-changing student endpoints require X-Requested-With: fetch.
// A cross-site HTML form cannot set custom headers, so this prevents CSRF
// even when SameSite=None is required (Replit iframe cookie constraint).
// GET requests are exempt (they are safe/idempotent).
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: using router.use(fn) without a path so req.path stays as the full
// router-relative path (e.g. "/student/progress"). No exempt endpoints here —
// all dashboard mutations require authentication, which means an attacker could
// exploit CSRF on any of them.
router.use((req, res, next) => {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  if (safeMethods.has(req.method)) { next(); return; }
  if (req.headers["x-requested-with"] === "fetch") { next(); return; }
  // Allow in test environment where tests are focused on logic, not transport
  if (process.env.NODE_ENV === "test") { next(); return; }
  res.status(403).json({ error: "طلب غير مصرّح به — يُشترط X-Requested-With: fetch" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared: server-authoritative lesson map
// These are the ONLY valid lessons per course slug.
// Progress can only be recorded for lesson IDs present in this map.
// ─────────────────────────────────────────────────────────────────────────────
const LESSON_MAP: Record<string, { id: string; title: string }[]> = {
  default: [
    { id: "intro",    title: "مقدمة الكورس" },
    { id: "l2",       title: "الأساسيات والمفاهيم" },
    { id: "l3",       title: "التطبيق العملي" },
    { id: "l4",       title: "دراسة حالة" },
    { id: "l5",       title: "التمارين والتطبيقات" },
    { id: "l6",       title: "الاختبار النهائي" },
    { id: "outro",    title: "خلاصة وتوصيات" },
  ],
  "meta-ads": [
    { id: "intro",    title: "مقدمة إعلانات Meta" },
    { id: "bm",       title: "إعداد Business Manager" },
    { id: "campaigns",title: "هيكل الحملات" },
    { id: "targeting",title: "الاستهداف والجماهير" },
    { id: "creative", title: "إبداع الإعلان وتصميمه" },
    { id: "budget",   title: "الميزانية والعطاءات" },
    { id: "retarget", title: "إعادة الاستهداف" },
    { id: "analytics",title: "قراءة التقارير وتحسين الأداء" },
  ],
  "google-ads": [
    { id: "intro",    title: "مقدمة إعلانات Google" },
    { id: "search",   title: "حملات البحث" },
    { id: "display",  title: "حملات الديسبلاي" },
    { id: "shopping", title: "Shopping Ads" },
    { id: "video",    title: "إعلانات يوتيوب" },
    { id: "pmax",     title: "Performance Max" },
    { id: "tracking", title: "التتبع والقياس" },
    { id: "optimize", title: "التحسين المستمر" },
  ],
  "seo": [
    { id: "intro",     title: "مقدمة في السيو" },
    { id: "keyword",   title: "بحث الكلمات المفتاحية" },
    { id: "onpage",    title: "السيو الداخلي On-Page" },
    { id: "technical", title: "السيو التقني" },
    { id: "content",   title: "السيو الخارجي Off-Page" },
    { id: "local",     title: "السيو المحلي" },
    { id: "analytics", title: "قياس النتائج" },
  ],
  "social-media": [
    { id: "intro",     title: "مقدمة إدارة السوشيال ميديا" },
    { id: "strategy",  title: "استراتيجية المحتوى" },
    { id: "instagram", title: "إنستغرام: النمو والتفاعل" },
    { id: "facebook",  title: "فيسبوك: المجتمع والإعلانات" },
    { id: "tiktok",    title: "تيك توك: الفيديو القصير" },
    { id: "analytics", title: "تحليل البيانات والنتائج" },
    { id: "outro",     title: "خلاصة وخطة العمل" },
  ],
};

/** Return the canonical lesson list for a given slug */
function getLessons(courseSlug: string): { id: string; title: string }[] {
  return LESSON_MAP[courseSlug] ?? LESSON_MAP.default!;
}

/** Return valid lesson IDs as a Set for O(1) lookup */
function getLessonIdSet(courseSlug: string): Set<string> {
  return new Set(getLessons(courseSlug).map(l => l.id));
}

/** Minimal HTML-entity escaping for user-controlled strings embedded in HTML */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Check that a student is enrolled (status = "enrolled") in a given course */
async function isEnrolled(studentId: number, courseSlug: string): Promise<boolean> {
  const rows = await db
    .select({ id: courseEnrollments.id })
    .from(courseEnrollments)
    .where(and(
      eq(courseEnrollments.studentId, studentId),
      eq(courseEnrollments.courseSlug, courseSlug),
      eq(courseEnrollments.status, "enrolled"),
    ));
  return rows.length > 0;
}

/**
 * Idempotently issue a certificate for (studentId, courseSlug).
 * Assumes enrollment + full completion were already verified by the caller.
 * Returns the certificate id and whether it was newly created in this call.
 * When newly created, fires a congratulation email (fire-and-forget).
 */
async function issueCertificateIdempotent(
  studentId: number,
  courseSlug: string,
  courseName: string,
): Promise<{ id: number; newlyIssued: boolean }> {
  const inserted = await db
    .insert(certificates)
    .values({ studentId, courseSlug, courseName })
    .onConflictDoNothing({
      target: [certificates.studentId, certificates.courseSlug],
    })
    .returning({ id: certificates.id });

  const newlyIssued = inserted.length > 0;
  let certId = inserted[0]?.id;
  if (certId === undefined) {
    const [existing] = await db
      .select({ id: certificates.id })
      .from(certificates)
      .where(and(
        eq(certificates.studentId, studentId),
        eq(certificates.courseSlug, courseSlug),
      ));
    certId = existing!.id;
  }

  if (newlyIssued) {
    logger.info({ studentId, courseSlug, certId }, "Certificate issued");
    // Fire-and-forget congratulation email — never blocks the HTTP response.
    void (async () => {
      const [student] = await db
        .select({ fullName: students.fullName, email: students.email })
        .from(students)
        .where(eq(students.id, studentId));
      if (!student) return;
      const delivered = await sendCourseCompletedEmail({
        studentName: student.fullName,
        studentEmail: student.email,
        courseName,
        certificateId: certId!,
      });
      if (!delivered) {
        logger.warn({ studentId, courseSlug, certId }, "Course-completed email not delivered");
      }
    })().catch(err => {
      logger.error({ err, studentId, courseSlug }, "Course-completed email task failed");
    });
  }

  return { id: certId!, newlyIssued };
}

// ── GET /api/student/dashboard/summary ───────────────────────────────────────
router.get("/student/dashboard/summary", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const [student] = await db
      .select({ id: students.id, fullName: students.fullName, email: students.email })
      .from(students).where(eq(students.id, studentId));
    if (!student) { res.status(404).json({ error: "الطالب غير موجود" }); return; }

    const enrolledRows = await db
      .select({ courseSlug: courseEnrollments.courseSlug, courseName: courseEnrollments.courseName })
      .from(courseEnrollments)
      .where(and(eq(courseEnrollments.studentId, studentId), eq(courseEnrollments.status, "enrolled")));

    const certs = await db
      .select({
        id: certificates.id,
        courseSlug: certificates.courseSlug,
        courseName: certificates.courseName,
        issuedAt: certificates.issuedAt,
      })
      .from(certificates)
      .where(eq(certificates.studentId, studentId))
      .orderBy(desc(certificates.issuedAt));

    const openTickets = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(and(eq(supportTickets.studentId, studentId), eq(supportTickets.status, "open")));

    // Only count lessons that belong to an enrolled course (prevents inflated totals
    // from orphaned progress rows if enrollment is later revoked).
    const enrolledSlugs = new Set(enrolledRows.map(e => e.courseSlug));
    const allProgress = await db
      .select({ courseSlug: courseProgress.courseSlug, lessonId: courseProgress.lessonId })
      .from(courseProgress)
      .where(eq(courseProgress.studentId, studentId));
    const completedLessons = allProgress.filter(p => enrolledSlugs.has(p.courseSlug)).length;

    // Derive the authoritative total lesson count from the server-side LESSON_MAP
    // so progress % is never inflated (e.g. meta-ads has 8 lessons, not the default 7).
    const totalLessons = enrolledRows.reduce(
      (sum, e) => sum + getLessons(e.courseSlug).length, 0
    );

    res.json({
      student,
      enrolledCourses: enrolledRows.length,
      certificates: certs.length,
      openTickets: openTickets.length,
      completedLessons,
      totalLessons,
      courses: enrolledRows,
      // Recent achievements — latest issued certificates for the dashboard feed
      recentAchievements: certs.slice(0, 5).map(c => ({
        certificateId: c.id,
        courseSlug: c.courseSlug,
        courseName: c.courseName,
        issuedAt: c.issuedAt,
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch student dashboard summary");
    res.status(500).json({ error: "خطأ في جلب البيانات" });
  }
});

// ── GET /api/student/progress/:courseSlug ─────────────────────────────────────
// Enrollment-gated: returns 403 if student is not enrolled in this course.
router.get("/student/progress/:courseSlug", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const courseSlug = Array.isArray(req.params.courseSlug)
    ? req.params.courseSlug[0]!
    : req.params.courseSlug!;

  try {
    if (!(await isEnrolled(studentId, courseSlug))) {
      res.status(403).json({ error: "أنت غير مسجّل في هذا الكورس" });
      return;
    }

    const completedRows = await db
      .select({ lessonId: courseProgress.lessonId })
      .from(courseProgress)
      .where(and(
        eq(courseProgress.studentId, studentId),
        eq(courseProgress.courseSlug, courseSlug),
      ));

    const completedSet = new Set(completedRows.map(r => r.lessonId));
    const lessons = getLessons(courseSlug);

    res.json({
      courseSlug,
      lessons: lessons.map(l => ({ ...l, completed: completedSet.has(l.id) })),
      completedCount: completedSet.size,
      totalCount: lessons.length,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch course progress");
    res.status(500).json({ error: "خطأ في جلب بيانات التقدم" });
  }
});

// ── POST /api/student/progress ────────────────────────────────────────────────
// Validates: (1) student enrolled in courseSlug, (2) lessonId is a server-known lesson.
router.post("/student/progress", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const { courseSlug, lessonId, completed } = req.body as {
    courseSlug?: string; lessonId?: string; completed?: boolean;
  };

  if (!courseSlug || !lessonId) {
    res.status(400).json({ error: "courseSlug و lessonId مطلوبان" });
    return;
  }

  // 1. Enrollment check
  if (!(await isEnrolled(studentId, courseSlug))) {
    res.status(403).json({ error: "أنت غير مسجّل في هذا الكورس" });
    return;
  }

  // 2. Lesson validity check — only server-defined lesson IDs are accepted
  const validIds = getLessonIdSet(courseSlug);
  if (!validIds.has(lessonId)) {
    res.status(400).json({ error: "معرّف الدرس غير معروف" });
    return;
  }

  // 3. Derive the canonical title from the server map (ignore client-supplied title)
  const lessonDef = getLessons(courseSlug).find(l => l.id === lessonId);
  const lessonTitle = lessonDef?.title ?? lessonId;

  try {
    if (completed === false) {
      await db.delete(courseProgress).where(
        and(
          eq(courseProgress.studentId, studentId),
          eq(courseProgress.courseSlug, courseSlug),
          eq(courseProgress.lessonId, lessonId),
        ),
      );
    } else {
      // onConflictDoNothing uses the DB unique constraint to handle concurrent
      // requests atomically — concurrent inserts for the same (student, course,
      // lesson) silently succeed without creating duplicate rows or returning 500.
      await db
        .insert(courseProgress)
        .values({ studentId, courseSlug, lessonId, lessonTitle })
        .onConflictDoNothing({
          target: [courseProgress.studentId, courseProgress.courseSlug, courseProgress.lessonId],
        });

      // ── Auto-issue certificate when this completion finishes the course ──
      const completedRows = await db
        .select({ lessonId: courseProgress.lessonId })
        .from(courseProgress)
        .where(and(
          eq(courseProgress.studentId, studentId),
          eq(courseProgress.courseSlug, courseSlug),
        ));
      const completedIds = new Set(completedRows.map(r => r.lessonId));
      const allDone = [...validIds].every(id => completedIds.has(id));

      if (allDone) {
        const [enrollment] = await db
          .select({ courseName: courseEnrollments.courseName })
          .from(courseEnrollments)
          .where(and(
            eq(courseEnrollments.studentId, studentId),
            eq(courseEnrollments.courseSlug, courseSlug),
            eq(courseEnrollments.status, "enrolled"),
          ));
        if (enrollment) {
          const cert = await issueCertificateIdempotent(studentId, courseSlug, enrollment.courseName);
          res.json({
            ok: true,
            courseCompleted: true,
            certificateId: cert.id,
            newlyIssued: cert.newlyIssued,
            courseName: enrollment.courseName,
          });
          return;
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to update course progress");
    res.status(500).json({ error: "خطأ في تحديث التقدم" });
  }
});

// ── GET /api/student/certificates ─────────────────────────────────────────────
router.get("/student/certificates", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const certs = await db
      .select()
      .from(certificates)
      .where(eq(certificates.studentId, studentId))
      .orderBy(desc(certificates.issuedAt));
    res.json({ certificates: certs });
  } catch (err) {
    logger.error({ err }, "Failed to fetch certificates");
    res.status(500).json({ error: "خطأ في جلب الشهادات" });
  }
});

// ── POST /api/student/certificates/issue ─────────────────────────────────────
// Authorization:
//   1. Student must be enrolled in the course.
//   2. Student must have completed EVERY lesson in the server-authoritative lesson map.
// The course name is read from the enrollment record — not from the client payload —
// to prevent the student from forging names on their own certificate.
router.post("/student/certificates/issue", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const { courseSlug } = req.body as { courseSlug?: string };
  if (!courseSlug) {
    res.status(400).json({ error: "courseSlug مطلوب" });
    return;
  }

  try {
    // 1. Verify enrollment and fetch the authoritative course name
    const [enrollment] = await db
      .select({ courseName: courseEnrollments.courseName })
      .from(courseEnrollments)
      .where(and(
        eq(courseEnrollments.studentId, studentId),
        eq(courseEnrollments.courseSlug, courseSlug),
        eq(courseEnrollments.status, "enrolled"),
      ));
    if (!enrollment) {
      res.status(403).json({ error: "أنت غير مسجّل في هذا الكورس" });
      return;
    }

    // 2. Verify all lessons are completed
    const requiredLessons = getLessons(courseSlug);
    const requiredIds = new Set(requiredLessons.map(l => l.id));
    const completedRows = await db
      .select({ lessonId: courseProgress.lessonId })
      .from(courseProgress)
      .where(and(
        eq(courseProgress.studentId, studentId),
        eq(courseProgress.courseSlug, courseSlug),
      ));
    const completedIds = new Set(completedRows.map(r => r.lessonId));
    const allDone = [...requiredIds].every(id => completedIds.has(id));

    if (!allDone) {
      const remaining = requiredLessons.filter(l => !completedIds.has(l.id)).length;
      res.status(422).json({
        error: `لم تكتمل جميع دروس الكورس بعد — تبقّى ${remaining} درس`,
      });
      return;
    }

    // 3. Idempotent issue via the shared helper (also sends the congratulation
    //    email the first time). Safe under concurrent requests.
    const cert = await issueCertificateIdempotent(studentId, courseSlug, enrollment.courseName);
    res.json({ ok: true, id: cert.id, newlyIssued: cert.newlyIssued });
  } catch (err) {
    logger.error({ err }, "Failed to issue certificate");
    res.status(500).json({ error: "خطأ في إصدار الشهادة" });
  }
});

// ── GET /api/student/certificates/:id/view ────────────────────────────────────
// All dynamic content is HTML-escaped before interpolation.
router.get("/student/certificates/:id/view", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const certId = parseInt(rawId ?? "", 10);
  if (isNaN(certId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  try {
    const [cert] = await db
      .select({
        id: certificates.id,
        courseSlug: certificates.courseSlug,
        courseName: certificates.courseName,
        issuedAt: certificates.issuedAt,
      })
      .from(certificates)
      .where(and(eq(certificates.id, certId), eq(certificates.studentId, studentId)));

    if (!cert) { res.status(404).json({ error: "الشهادة غير موجودة" }); return; }

    const [student] = await db
      .select({ fullName: students.fullName })
      .from(students)
      .where(eq(students.id, studentId));

    // Escape all student-controlled values before embedding in HTML
    const safeName       = esc(student?.fullName ?? "");
    const safeCourseName = esc(cert.courseName);
    const safeDate       = esc(new Date(cert.issuedAt).toLocaleDateString("ar-AE", {
      year: "numeric", month: "long", day: "numeric",
    }));

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<title>شهادة إتمام — ${safeCourseName}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Cairo", sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .cert {
    width: 900px; height: 636px; background: #fff;
    position: relative; overflow: hidden;
    border: 1px solid #E5E7EB;
    box-shadow: 0 20px 60px rgba(0,0,0,.12);
  }
  .border-top { position: absolute; top: 0; left: 0; right: 0; height: 8px; background: linear-gradient(90deg, #CC0000, #1E1B4B, #CC0000); }
  .border-bottom { position: absolute; bottom: 0; left: 0; right: 0; height: 8px; background: linear-gradient(90deg, #1E1B4B, #CC0000, #1E1B4B); }
  .content { padding: 50px 80px; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .logo { width: 64px; height: 64px; background: linear-gradient(135deg, #CC0000, #B00000); border-radius: 16px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 28px; font-weight: 900; }
  .academy { font-size: 14px; color: #6B7280; letter-spacing: 3px; text-transform: uppercase; }
  .title { font-size: 38px; font-weight: 900; color: #1E1B4B; }
  .subtitle { font-size: 15px; color: #6B7280; }
  .name { font-size: 32px; font-weight: 700; color: #CC0000; border-bottom: 2px solid #CC0000; padding-bottom: 6px; }
  .course-label { font-size: 14px; color: #6B7280; }
  .course { font-size: 22px; font-weight: 700; color: #111827; }
  .date { font-size: 14px; color: #9CA3AF; }
  .seal { position: absolute; left: 60px; bottom: 40px; width: 80px; height: 80px; border: 3px solid #CC0000; border-radius: 50%; display: flex; align-items: center; justify-content: center; text-align: center; color: #CC0000; font-size: 10px; font-weight: 700; }
  @media print {
    body { background: white; }
    .cert { box-shadow: none; width: 100%; height: auto; }
  }
</style>
</head>
<body>
<div class="cert">
  <div class="border-top"></div>
  <div class="content">
    <div class="logo">د</div>
    <div class="academy">أكاديمية دبي فانز · DUBAI FANS ACADEMY</div>
    <div class="title">شهادة إتمام</div>
    <div class="subtitle">تُشهد أكاديمية دبي فانز بأن</div>
    <div class="name">${safeName}</div>
    <div class="course-label">قد أتمّ/أتمّت بنجاح دورة</div>
    <div class="course">${safeCourseName}</div>
    <div class="date">بتاريخ ${safeDate}</div>
  </div>
  <div class="seal">دبي<br>فانز</div>
  <div class="border-bottom"></div>
</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    logger.error({ err }, "Failed to generate certificate");
    res.status(500).json({ error: "خطأ في إنشاء الشهادة" });
  }
});

// ── GET /api/student/exams ────────────────────────────────────────────────────
router.get("/student/exams", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const enrolled = await db
      .select({ courseSlug: courseEnrollments.courseSlug })
      .from(courseEnrollments)
      .where(and(eq(courseEnrollments.studentId, studentId), eq(courseEnrollments.status, "enrolled")));

    if (enrolled.length === 0) { res.json({ exams: [] }); return; }

    const slugs = enrolled.map(e => e.courseSlug);
    const examList = await db
      .select()
      .from(exams)
      .where(inArray(exams.courseSlug, slugs))
      .orderBy(desc(exams.createdAt));

    const examIds = examList.map(e => e.id);
    const attempts = examIds.length > 0
      ? await db
          .select()
          .from(examAttempts)
          .where(and(eq(examAttempts.studentId, studentId), inArray(examAttempts.examId, examIds)))
          .orderBy(desc(examAttempts.takenAt))
      : [];

    res.json({
      exams: examList.map(ex => ({
        ...ex,
        attempts: attempts.filter(a => a.examId === ex.id),
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch exams");
    res.status(500).json({ error: "خطأ في جلب الاختبارات" });
  }
});

// ── POST /api/student/exams/:id/attempt ───────────────────────────────────────
// Records an exam attempt (score 0-100). The exam must belong to a course
// the student is enrolled in.
router.post("/student/exams/:id/attempt", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const examId = parseInt(req.params.id as string, 10);
  if (isNaN(examId)) { res.status(400).json({ error: "معرّف الاختبار غير صالح" }); return; }

  const { score } = req.body as { score?: number };
  if (score === undefined || typeof score !== "number" || score < 0 || score > 100) {
    res.status(400).json({ error: "الدرجة يجب أن تكون رقماً بين 0 و 100" });
    return;
  }

  try {
    // Verify the exam belongs to a course the student is enrolled in
    const [exam] = await db.select().from(exams).where(eq(exams.id, examId));
    if (!exam) { res.status(404).json({ error: "الاختبار غير موجود" }); return; }

    const [enrollment] = await db
      .select({ id: courseEnrollments.id })
      .from(courseEnrollments)
      .where(and(
        eq(courseEnrollments.studentId, studentId),
        eq(courseEnrollments.courseSlug, exam.courseSlug),
        eq(courseEnrollments.status, "enrolled"),
      ));
    if (!enrollment) { res.status(403).json({ error: "يجب الالتحاق بالكورس أولاً" }); return; }

    const [attempt] = await db.insert(examAttempts).values({
      studentId,
      examId,
      score,
      maxScore: 100,
    }).returning();

    logger.info({ studentId, examId, score }, "Exam attempt recorded");
    res.json({ ok: true, attempt });
  } catch (err) {
    logger.error({ err }, "Failed to record exam attempt");
    res.status(500).json({ error: "خطأ في تسجيل محاولة الاختبار" });
  }
});

// ── GET /api/student/assignments ──────────────────────────────────────────────
router.get("/student/assignments", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const enrolled = await db
      .select({ courseSlug: courseEnrollments.courseSlug })
      .from(courseEnrollments)
      .where(and(eq(courseEnrollments.studentId, studentId), eq(courseEnrollments.status, "enrolled")));

    if (enrolled.length === 0) { res.json({ assignments: [] }); return; }

    const slugs = enrolled.map(e => e.courseSlug);
    const assignmentList = await db
      .select()
      .from(assignments)
      .where(inArray(assignments.courseSlug, slugs))
      .orderBy(desc(assignments.createdAt));

    const assignmentIds = assignmentList.map(a => a.id);
    const submissions = assignmentIds.length > 0
      ? await db
          .select()
          .from(assignmentSubmissions)
          .where(and(
            eq(assignmentSubmissions.studentId, studentId),
            inArray(assignmentSubmissions.assignmentId, assignmentIds),
          ))
          .orderBy(desc(assignmentSubmissions.submittedAt))
      : [];

    res.json({
      assignments: assignmentList.map(a => ({
        ...a,
        submission: submissions.find(s => s.assignmentId === a.id) ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch assignments");
    res.status(500).json({ error: "خطأ في جلب الواجبات" });
  }
});

// ── POST /api/student/assignments/:id/submit ──────────────────────────────────
// Authorization: student must be enrolled in the assignment's course.
router.post("/student/assignments/:id/submit", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const assignmentId = parseInt(rawId ?? "", 10);
  if (isNaN(assignmentId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const { fileUrl, notes } = req.body as { fileUrl?: string; notes?: string };
  if (!fileUrl?.trim()) {
    res.status(400).json({ error: "رابط الملف مطلوب" });
    return;
  }

  try {
    // 1. Fetch assignment to get its courseSlug
    const [assignment] = await db
      .select({ id: assignments.id, courseSlug: assignments.courseSlug })
      .from(assignments)
      .where(eq(assignments.id, assignmentId));
    if (!assignment) { res.status(404).json({ error: "الواجب غير موجود" }); return; }

    // 2. Verify enrollment in that course
    if (!(await isEnrolled(studentId, assignment.courseSlug))) {
      res.status(403).json({ error: "أنت غير مسجّل في كورس هذا الواجب" });
      return;
    }

    // 3. Atomic upsert — onConflictDoUpdate handles concurrent first-submit requests
    //    so they never collide on the unique (student_id, assignment_id) constraint.
    //    Resubmissions update the file URL and reset the timestamp.
    await db
      .insert(assignmentSubmissions)
      .values({
        studentId, assignmentId,
        fileUrl: fileUrl.trim(),
        notes: notes ?? "",
      })
      .onConflictDoUpdate({
        target: [assignmentSubmissions.studentId, assignmentSubmissions.assignmentId],
        set: {
          fileUrl: fileUrl.trim(),
          notes: notes ?? "",
          submittedAt: new Date(),
        },
      });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to submit assignment");
    res.status(500).json({ error: "خطأ في تسليم الواجب" });
  }
});

// ── GET /api/student/downloads ────────────────────────────────────────────────
// Enrollment-gated: only materials for courses the student is enrolled in.
router.get("/student/downloads", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const enrolled = await db
      .select({ courseSlug: courseEnrollments.courseSlug, courseName: courseEnrollments.courseName })
      .from(courseEnrollments)
      .where(and(eq(courseEnrollments.studentId, studentId), eq(courseEnrollments.status, "enrolled")));

    if (enrolled.length === 0) { res.json({ downloads: [] }); return; }

    const slugs = enrolled.map(e => e.courseSlug);
    const downloads = await db
      .select()
      .from(courseDownloads)
      .where(inArray(courseDownloads.courseSlug, slugs))
      .orderBy(desc(courseDownloads.createdAt));

    const courseMap = Object.fromEntries(enrolled.map(e => [e.courseSlug, e.courseName]));
    res.json({
      downloads: downloads.map(d => ({ ...d, courseName: courseMap[d.courseSlug] ?? d.courseSlug })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch downloads");
    res.status(500).json({ error: "خطأ في جلب المواد" });
  }
});

// ── GET /api/student/tickets ──────────────────────────────────────────────────
router.get("/student/tickets", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const tickets = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.studentId, studentId))
      .orderBy(desc(supportTickets.createdAt));
    res.json({ tickets });
  } catch (err) {
    logger.error({ err }, "Failed to fetch support tickets");
    res.status(500).json({ error: "خطأ في جلب التذاكر" });
  }
});

// ── POST /api/student/tickets ─────────────────────────────────────────────────
router.post("/student/tickets", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const { subject, body } = req.body as { subject?: string; body?: string };
  if (!subject?.trim() || !body?.trim()) {
    res.status(400).json({ error: "العنوان والرسالة مطلوبان" });
    return;
  }

  try {
    const [ticket] = await db
      .insert(supportTickets)
      .values({ studentId, subject: subject.trim(), body: body.trim() })
      .returning();
    res.json({ ok: true, ticket });
  } catch (err) {
    logger.error({ err }, "Failed to create support ticket");
    res.status(500).json({ error: "خطأ في إنشاء التذكرة" });
  }
});

// ── GET /api/student/tickets/:id ─────────────────────────────────────────────
// Ownership check: 404 if the ticket doesn't belong to this student.
router.get("/student/tickets/:id", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const ticketId = parseInt(rawId ?? "", 10);
  if (isNaN(ticketId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  try {
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.studentId, studentId)));
    if (!ticket) { res.status(404).json({ error: "التذكرة غير موجودة" }); return; }

    const replies = await db
      .select()
      .from(ticketReplies)
      .where(eq(ticketReplies.ticketId, ticketId))
      .orderBy(ticketReplies.createdAt);

    res.json({ ticket, replies });
  } catch (err) {
    logger.error({ err }, "Failed to fetch ticket");
    res.status(500).json({ error: "خطأ في جلب التذكرة" });
  }
});

// ── POST /api/student/tickets/:id/reply ──────────────────────────────────────
// Ownership check: 404 if the ticket doesn't belong to this student.
router.post("/student/tickets/:id/reply", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const ticketId = parseInt(rawId ?? "", 10);
  if (isNaN(ticketId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const { body } = req.body as { body?: string };
  if (!body?.trim()) { res.status(400).json({ error: "الرسالة مطلوبة" }); return; }

  try {
    const [ticket] = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.studentId, studentId)));
    if (!ticket) { res.status(404).json({ error: "التذكرة غير موجودة" }); return; }

    const [reply] = await db
      .insert(ticketReplies)
      .values({ ticketId, body: body.trim(), isAdmin: false })
      .returning();
    res.json({ ok: true, reply });
  } catch (err) {
    logger.error({ err }, "Failed to add ticket reply");
    res.status(500).json({ error: "خطأ في إرسال الرد" });
  }
});

export default router;
