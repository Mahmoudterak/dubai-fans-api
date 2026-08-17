import { Router, type IRouter, type Request, type Response } from "express";
import { db, courseEnrollments } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { requirePortalAdmin } from "../lib/portalAuth.js";

const router: IRouter = Router();

// ── Email notification ────────────────────────────────────────────────────────
const PAYMENT_LABELS: Record<string, string> = {
  online:          "دفع أون لاين",
  bank:            "تحويل بنكي",
  paypal:          "تحويل باي بال",
  "western-union": "تحويل ويسترن يونيون",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strip CR/LF to prevent SMTP header injection in subjects
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RESEND_URL = "https://api.resend.com/emails";
const SENDER_FROM = '"أكاديمية دبي فانز" <no-reply@mtuaefans.com>';

/**
 * Send one email via the Resend HTTP API.
 * Returns true on HTTP 2xx, false on any error (never throws).
 */
async function sendViaResend(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: SENDER_FROM, to, subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body }, "Resend API error (course-register)");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to call Resend API (course-register)");
    return false;
  }
}

async function trySendEmail(reg: {
  id: number;
  courseName: string;
  courseSlug: string;
  fullName: string;
  phone: string;
  jobTitle: string;
  email: string;
  city: string;
  paymentMethod: string;
  howDidYouHear: string;
  questions: string;
  createdAt: Date;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.info("RESEND_API_KEY not configured — registration saved to DB only");
    return;
  }

  const payLabel = escapeHtml(PAYMENT_LABELS[reg.paymentMethod] ?? reg.paymentMethod);
  const safe = {
    courseName: escapeHtml(reg.courseName),
    fullName:   escapeHtml(reg.fullName),
    phone:      escapeHtml(reg.phone),
    jobTitle:   escapeHtml(reg.jobTitle),
    email:      escapeHtml(reg.email),
    city:       escapeHtml(reg.city),
    howDidYouHear: escapeHtml(reg.howDidYouHear),
    questions:  escapeHtml(reg.questions),
  };

  const html = `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
    <div style="background:linear-gradient(135deg,#CC0000,#1E1B4B);padding:28px 24px;border-radius:12px 12px 0 0;">
      <h1 style="color:#fff;margin:0;font-size:20px;">📩 طلب تسجيل جديد في الأكاديمية</h1>
      <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:14px;">${safe.courseName}</p>
    </div>
    <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#6B7280;width:40%;">رقم الطلب</td><td style="padding:8px 0;font-weight:700;">#${reg.id}</td></tr>
        <tr style="background:#F9FAFB;"><td style="padding:8px 6px;color:#6B7280;">الاسم الكامل</td><td style="padding:8px 6px;font-weight:700;">${safe.fullName}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;">رقم الهاتف</td><td style="padding:8px 0;font-weight:700;" dir="ltr">${safe.phone}</td></tr>
        <tr style="background:#F9FAFB;"><td style="padding:8px 6px;color:#6B7280;">المسمى الوظيفي</td><td style="padding:8px 6px;font-weight:700;">${safe.jobTitle}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;">البريد الإلكتروني</td><td style="padding:8px 0;font-weight:700;" dir="ltr">${safe.email}</td></tr>
        <tr style="background:#F9FAFB;"><td style="padding:8px 6px;color:#6B7280;">المدينة</td><td style="padding:8px 6px;font-weight:700;">${safe.city}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;">طريقة الدفع</td><td style="padding:8px 0;font-weight:700;">${payLabel}</td></tr>
        <tr style="background:#F9FAFB;"><td style="padding:8px 6px;color:#6B7280;">كيف تعرّف علينا</td><td style="padding:8px 6px;">${safe.howDidYouHear}</td></tr>
        ${reg.questions ? `<tr><td style="padding:8px 0;color:#6B7280;vertical-align:top;">أسئلة واستفسارات</td><td style="padding:8px 0;">${safe.questions}</td></tr>` : ""}
      </table>
      <div style="margin-top:16px;padding:12px;background:#F0FDF4;border-radius:8px;font-size:12px;color:#166534;">
        ✅ تم حفظ الطلب في قاعدة البيانات بتاريخ ${reg.createdAt.toLocaleString("ar-AE")}
      </div>
      <div style="margin-top:12px;padding:12px;background:#EFF6FF;border-radius:8px;font-size:12px;color:#1E40AF;">
        🔗 لمراجعة جميع الطلبات: GET /api/course-register (مع رأس x-admin-secret)
      </div>
    </div>
  </div>`;

  // ── Confirmation email to the student ──
  const whatsappUrl = "https://wa.me/971542861215";
  const studentHtml = `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
    <div style="background:linear-gradient(135deg,#CC0000,#1E1B4B);padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">🎉 تم استلام طلب تسجيلك بنجاح!</h1>
      <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:15px;">أكاديمية دبي فانز</p>
    </div>
    <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
      <p style="font-size:15px;margin:0 0 16px;">مرحباً <strong>${safe.fullName}</strong>،</p>
      <p style="font-size:14px;color:#374151;margin:0 0 20px;line-height:1.7;">
        شكراً لتسجيلك معنا! تم استلام طلبك في كورس <strong>«${safe.courseName}»</strong> بنجاح، وهذه تفاصيل التسجيل:
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
        <tr style="background:#F9FAFB;"><td style="padding:10px 8px;color:#6B7280;width:40%;">رقم الطلب</td><td style="padding:10px 8px;font-weight:700;color:#CC0000;">#${reg.id}</td></tr>
        <tr><td style="padding:10px 8px;color:#6B7280;">الكورس</td><td style="padding:10px 8px;font-weight:700;">${safe.courseName}</td></tr>
        <tr style="background:#F9FAFB;"><td style="padding:10px 8px;color:#6B7280;">الاسم</td><td style="padding:10px 8px;font-weight:700;">${safe.fullName}</td></tr>
        <tr><td style="padding:10px 8px;color:#6B7280;">رقم الهاتف</td><td style="padding:10px 8px;font-weight:700;" dir="ltr">${safe.phone}</td></tr>
        ${reg.paymentMethod ? `<tr style="background:#F9FAFB;"><td style="padding:10px 8px;color:#6B7280;">طريقة الدفع</td><td style="padding:10px 8px;font-weight:700;">${payLabel}</td></tr>` : ""}
        <tr><td style="padding:10px 8px;color:#6B7280;">تاريخ الطلب</td><td style="padding:10px 8px;">${reg.createdAt.toLocaleString("ar-AE")}</td></tr>
      </table>
      <div style="padding:14px 16px;background:#FEF3C7;border-radius:8px;font-size:14px;color:#92400E;margin-bottom:20px;line-height:1.7;">
        ⏰ سيتواصل معك فريقنا خلال <strong>24 ساعة</strong> لتأكيد التسجيل وإكمال باقي الخطوات.
      </div>
      <div style="text-align:center;margin-bottom:20px;">
        <a href="${whatsappUrl}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 28px;border-radius:8px;">
          💬 تواصل معنا مباشرة عبر واتساب
        </a>
      </div>
      <p style="font-size:12px;color:#9CA3AF;text-align:center;margin:0;">
        إذا لم تقم بهذا التسجيل، يمكنك تجاهل هذه الرسالة.
      </p>
    </div>
  </div>`;

  // Send both emails independently — a failure of one must not suppress the other.
  const sends: Promise<void>[] = [
    sendViaResend(
      apiKey,
      "info@mtuaefans.com",
      headerSafe(`🎓 طلب تسجيل جديد — ${reg.courseName} (${reg.fullName}) #${reg.id}`),
      html,
    ).then((ok) => {
      if (ok) logger.info({ to: "info@mtuaefans.com", course: reg.courseSlug, id: reg.id }, "Registration email sent");
      else     logger.error({ id: reg.id }, "Failed to send admin registration email");
    }),
  ];

  if (EMAIL_RE.test(reg.email)) {
    sends.push(
      sendViaResend(
        apiKey,
        reg.email,
        headerSafe(`✅ تأكيد استلام طلب التسجيل — ${reg.courseName} #${reg.id}`),
        studentHtml,
      ).then((ok) => {
        if (ok) logger.info({ to: reg.email, course: reg.courseSlug, id: reg.id }, "Student confirmation email sent");
        else     logger.error({ id: reg.id }, "Failed to send student confirmation email");
      }),
    );
  } else {
    logger.warn({ id: reg.id }, "Student email invalid — confirmation email skipped");
  }

  await Promise.all(sends);
}

// ── CSRF guard ────────────────────────────────────────────────────────────────
// Cross-site HTML forms cannot set custom headers, so requiring
// X-Requested-With: fetch is an adequate CSRF defence for this route.
router.use("/course-register", (req, res, next) => {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  if (safeMethods.has(req.method)) { next(); return; }
  if (process.env.NODE_ENV === "test") { next(); return; }
  if (req.headers["x-requested-with"] === "fetch") { next(); return; }
  res.status(403).json({ error: "طلب غير مصرّح به — مصدر غير موثوق" });
});

// ── POST /api/course-register ─────────────────────────────────────────────────
router.post("/course-register", async (req, res): Promise<void> => {
  type Body = {
    fullName?: string; phone?: string; jobTitle?: string; email?: string;
    city?: string; paymentMethod?: string; howDidYouHear?: string;
    questions?: string; courseName?: string; courseSlug?: string;
  };
  const body = req.body as Body;

  const required = ["fullName", "phone", "email", "courseName", "courseSlug"] as const;
  const missing = required.filter(f => !body[f]);
  if (missing.length) {
    res.status(400).json({ error: `الحقول التالية مطلوبة: ${missing.join(", ")}` });
    return;
  }

  if (!EMAIL_RE.test(body.email!.trim())) {
    res.status(400).json({ error: "البريد الإلكتروني غير صالح" });
    return;
  }
  body.email = body.email!.trim();

  try {
    const [inserted] = await db
      .insert(courseEnrollments)
      .values({
        courseSlug:    body.courseSlug!,
        courseName:    body.courseName!,
        fullName:      body.fullName!,
        phone:         body.phone!,
        email:         body.email!,
        jobTitle:      body.jobTitle    ?? "",
        city:          body.city        ?? "",
        paymentMethod: body.paymentMethod ?? "",
        howDidYouHear: body.howDidYouHear ?? "",
        questions:     body.questions   ?? "",
        status:        "new",
      })
      .returning();

    logger.info({ id: inserted.id, course: inserted.courseSlug, name: inserted.fullName }, "Course enrollment saved to DB");

    // Send email asynchronously — don't block the response
    trySendEmail(inserted).catch(err => {
      logger.error({ err }, "Failed to send enrollment email");
    });

    res.json({ success: true, id: inserted.id });
  } catch (err) {
    logger.error({ err }, "Failed to save course enrollment");
    res.status(500).json({ error: "حدث خطأ في الحفظ، يرجى المحاولة مجدداً." });
  }
});

// ── GET /api/course-register (legacy — x-admin-secret header) ────────────────
router.get("/course-register", async (req, res): Promise<void> => {
  const adminSecret = process.env.ADMIN_PASSWORD;
  const provided    = req.headers["x-admin-secret"];
  if (adminSecret && provided !== adminSecret) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }

  try {
    const list = await db
      .select()
      .from(courseEnrollments)
      .orderBy(desc(courseEnrollments.createdAt));

    res.json({ count: list.length, enrollments: list });
  } catch (err) {
    logger.error({ err }, "Failed to fetch enrollments");
    res.status(500).json({ error: "خطأ في جلب البيانات" });
  }
});

// ── GET /api/admin/course-enrollments (portal admin protected) ────────────────
router.get("/admin/course-enrollments", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {

  try {
    const list = await db
      .select()
      .from(courseEnrollments)
      .orderBy(desc(courseEnrollments.createdAt));

    res.json({ count: list.length, enrollments: list });
  } catch (err) {
    logger.error({ err }, "Failed to fetch enrollments (admin)");
    res.status(500).json({ error: "خطأ في جلب البيانات" });
  }
});

// ── PATCH /api/admin/course-enrollments/:id/link-student (portal admin) ───────
// Allows an admin to explicitly link (or unlink) an enrollment to a student
// account. This is the only safe way to associate enrollments with students —
// no automatic email-based linking is performed by the student auth routes.
router.patch("/admin/course-enrollments/:id/link-student", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  // CSRF guard — cross-site HTML forms cannot set custom headers
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ error: "طلب غير مصرّح به — مصدر غير موثوق" });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }

  const { studentId } = req.body as { studentId?: number | null };
  // studentId === null means unlink; must be a positive integer or null
  if (studentId !== null && (typeof studentId !== "number" || !Number.isInteger(studentId) || studentId < 1)) {
    res.status(400).json({ error: "studentId يجب أن يكون رقماً صحيحاً موجباً أو null" });
    return;
  }

  try {
    const [updated] = await db
      .update(courseEnrollments)
      .set({ studentId: studentId ?? null })
      .where(eq(courseEnrollments.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }

    logger.info({ enrollmentId: id, studentId }, "Enrollment student link updated by admin");
    res.json({ ok: true, enrollment: updated });
  } catch (err) {
    logger.error({ err }, "Failed to update enrollment student link");
    res.status(500).json({ error: "خطأ في تحديث الربط" });
  }
});

// ── PATCH /api/admin/course-enrollments/:id (portal admin protected) ──────────
const VALID_STATUSES = ["new", "contacted", "enrolled", "cancelled"] as const;

router.patch("/admin/course-enrollments/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  // CSRF guard — cross-site HTML forms cannot set custom headers
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ error: "طلب غير مصرّح به — مصدر غير موثوق" });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }

  const { status } = req.body as { status?: string };
  if (!status || !(VALID_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: `الحالة يجب أن تكون إحدى: ${VALID_STATUSES.join(", ")}` });
    return;
  }

  try {
    const [updated] = await db
      .update(courseEnrollments)
      .set({ status })
      .where(eq(courseEnrollments.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }

    logger.info({ id, status }, "Enrollment status updated");
    res.json({ ok: true, enrollment: updated });
  } catch (err) {
    logger.error({ err }, "Failed to update enrollment status");
    res.status(500).json({ error: "خطأ في تحديث الحالة" });
  }
});

export default router;
