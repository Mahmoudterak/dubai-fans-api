/**
 * HTTP email sender — Resend API.
 *
 * Replaces nodemailer + SMTP. Cloudflare Workers compatible (no TCP socket).
 * All six send-functions preserve their original signatures exactly so every
 * caller (company-auth, admin-clients, course-register, website-orders,
 * business-audit, ai-business-os routes) is unchanged.
 *
 * Returns false / "not_configured" when RESEND_API_KEY is not set —
 * never throws. Safe for fire-and-forget callers.
 */
import { logger } from "./logger.js";

export type ReportEmailResult = "sent" | "failed" | "not_configured";

const RESEND_URL = "https://api.resend.com/emails";

interface ResendPayload {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
}

async function sendEmail(payload: ResendPayload): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body }, "Resend API error");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to call Resend API");
    return false;
  }
}

/** Best-effort app base URL. */
function appBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return "https://mtuaefans.com";
}

/** Escape a string for safe interpolation inside HTML. */
function escHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Strip CR/LF to prevent email-header injection in subject lines. */
function escSubject(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").trim();
}

// ── Send functions ─────────────────────────────────────────────────────────────

/**
 * Send a password-reset link to a client-portal user.
 * Returns true if the email was accepted by Resend, false otherwise.
 */
export async function sendPasswordResetEmail(params: {
  clientName: string;
  email: string;
  token: string;
}): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    logger.info("RESEND_API_KEY not set — skipping password-reset email");
    return false;
  }

  const { clientName, email, token } = params;
  const resetUrl = `${appBaseUrl()}/company/reset-password?token=${encodeURIComponent(token)}`;
  const senderAddress = process.env.SMTP_USER ?? "no-reply@mtuaefans.com";

  const html = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#7C3AED,#CC0000);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <div style="width:56px;height:56px;background:rgba(255,255,255,.15);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px;">
      <span style="font-size:28px;">🔒</span>
    </div>
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900;">إعادة تعيين كلمة المرور</h1>
    <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px;">بوابة العملاء — دبي فانز</p>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">مرحباً <strong>${escHtml(clientName)}</strong>،</p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#6B7280;">
      تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك في بوابة العملاء.
      اضغط على الزر أدناه لاختيار كلمة مرور جديدة. الرابط صالح لمدة <strong>ساعة واحدة</strong> فقط ويُستخدم مرة واحدة.
    </p>
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${resetUrl}"
         style="display:inline-block;background:linear-gradient(135deg,#7C3AED,#9333EA);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;letter-spacing:.3px;">
        إعادة تعيين كلمة المرور ←
      </a>
    </div>
    <p style="margin:0 0 8px;font-size:12px;color:#9CA3AF;text-align:center;">أو انسخ هذا الرابط في متصفحك:</p>
    <p style="margin:0 0 24px;font-size:12px;color:#7C3AED;text-align:center;word-break:break-all;" dir="ltr">${resetUrl}</p>
    <p style="margin:0 0 24px;font-size:12px;line-height:1.8;color:#9CA3AF;">
      إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة — كلمة مرورك الحالية ستبقى كما هي.
    </p>
    <div style="border-top:1px solid #F3F4F6;padding-top:18px;">
      <p style="margin:0;font-size:12px;color:#D1D5DB;text-align:center;">
        فريق دبي فانز للتسويق الرقمي · <a href="https://mtuaefans.com" style="color:#D1D5DB;">mtuaefans.com</a>
      </p>
    </div>
  </div>
</div>`;

  const ok = await sendEmail({
    from: `"دبي فانز — بوابة العملاء" <${senderAddress}>`,
    to: email,
    subject: "🔒 إعادة تعيين كلمة المرور — بوابة العملاء دبي فانز",
    html,
  });
  if (ok) logger.info({ to: email }, "Password-reset email sent");
  else logger.error({ to: email }, "Failed to send password-reset email");
  return ok;
}

/**
 * Notify the admin that a new AI website order was submitted.
 */
export async function sendWebsiteOrderNotification(params: {
  businessName: string;
  businessType: string;
  email: string;
  phone: string;
  siteType: string;
  details: string;
}): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    logger.info("RESEND_API_KEY not set — skipping website order notification");
    return false;
  }

  const businessName = escHtml(params.businessName);
  const businessType = escHtml(params.businessType);
  const email        = escHtml(params.email);
  const phone        = escHtml(params.phone);
  const isStore      = params.siteType === "store";
  const siteType     = isStore ? "متجر إلكتروني" : "موقع تعريفي";
  const price        = isStore ? "699" : "499";
  const details      = params.details ? escHtml(params.details).replace(/\n/g, "<br/>") : "—";
  const subjectName  = escSubject(params.businessName);

  const senderAddress = process.env.SMTP_USER ?? "no-reply@mtuaefans.com";
  const adminEmail    = process.env.ADMIN_EMAIL ?? senderAddress;
  const now = new Date().toLocaleString("ar-AE", { timeZone: "Asia/Dubai" });

  const html = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#CC0000,#D97706);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <div style="width:56px;height:56px;background:rgba(255,255,255,.15);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px;">
      <span style="font-size:28px;">⚡</span>
    </div>
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900;">طلب ${siteType} جديد — عرض ${price} درهم</h1>
    <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px;">التسليم خلال ساعة — دبي فانز</p>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;width:35%;">اسم النشاط</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;">${businessName}</td></tr>
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;">نوع النشاط</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;">${businessType}</td></tr>
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;">نوع الموقع</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;">${siteType}</td></tr>
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;">البريد الإلكتروني</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;" dir="ltr">${email}</td></tr>
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;">الهاتف</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;" dir="ltr">${phone}</td></tr>
      <tr><td style="padding:10px 0;font-size:13px;color:#9CA3AF;vertical-align:top;">تفاصيل الموقع</td><td style="padding:10px 0;font-size:14px;color:#111827;">${details}</td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:12px;color:#9CA3AF;">وقت الطلب: ${escHtml(now)} — العرض يتضمن التسليم خلال ساعة.</p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://mtuaefans.com/admin" style="display:inline-block;background:linear-gradient(135deg,#CC0000,#FF4444);color:#fff;text-decoration:none;padding:12px 32px;border-radius:10px;font-weight:700;font-size:14px;">فتح لوحة الإدارة ←</a>
    </div>
    <div style="border-top:1px solid #F3F4F6;padding-top:18px;">
      <p style="margin:0;font-size:12px;color:#D1D5DB;text-align:center;">دبي فانز — نظام إدارة الطلبات · <a href="https://mtuaefans.com" style="color:#D1D5DB;">mtuaefans.com</a></p>
    </div>
  </div>
</div>`;

  const ok = await sendEmail({
    from: `"دبي فانز — طلبات المواقع" <${senderAddress}>`,
    to: adminEmail,
    subject: `⚡ طلب ${siteType} جديد (${price} درهم) — ${subjectName}`,
    html,
  });
  if (ok) logger.info({ to: adminEmail, orderEmail: params.email }, "Website order notification sent");
  else logger.error({ orderEmail: params.email }, "Failed to send website order notification");
  return ok;
}

/**
 * Notify the admin that a new AI Business Audit was completed.
 */
export async function sendBusinessAuditNotification(params: {
  name: string;
  email: string;
  phone: string;
  companyName: string;
  businessType: string;
  city: string;
  targets: string;
  healthScore: number | null;
}): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    logger.info("RESEND_API_KEY not set — skipping business audit notification");
    return false;
  }

  const name         = escHtml(params.name);
  const email        = escHtml(params.email);
  const phone        = escHtml(params.phone);
  const companyName  = escHtml(params.companyName);
  const businessType = escHtml(params.businessType);
  const city         = params.city ? escHtml(params.city) : "—";
  const targets      = escHtml(params.targets);
  const score        = params.healthScore !== null ? `${params.healthScore}/100` : "—";

  const senderAddress = process.env.SMTP_USER ?? "no-reply@mtuaefans.com";
  const adminEmail    = process.env.ADMIN_EMAIL ?? senderAddress;
  const now = new Date().toLocaleString("ar-AE", { timeZone: "Asia/Dubai" });

  const row = (label: string, value: string, ltr = false) =>
    `<tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;width:35%;">${label}</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;"${ltr ? ' dir="ltr"' : ""}>${value}</td></tr>`;

  const html = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#CC0000,#D97706);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <span style="font-size:28px;">📊</span>
    <h1 style="color:#fff;margin:8px 0 0;font-size:22px;font-weight:900;">طلب تحليل نشاط تجاري جديد</h1>
    <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px;">AI Business Audit — دبي فانز</p>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
    <p style="margin:0 0 20px;font-size:15px;color:#374151;">اكتمل تحليل بالذكاء الاصطناعي وتم إنشاء Lead جديد:</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${row("الاسم", name)}
      ${row("الشركة", companyName)}
      ${row("نوع النشاط", businessType)}
      ${row("الموقع", city)}
      ${row("البريد الإلكتروني", email, true)}
      ${row("الهاتف", phone, true)}
      ${row("ما تم تحليله", targets)}
      ${row("Business Health Score", escHtml(score), true)}
    </table>
    <p style="margin:0 0 24px;font-size:12px;color:#9CA3AF;">وقت الطلب: ${escHtml(now)}</p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://mtuaefans.com/admin" style="display:inline-block;background:linear-gradient(135deg,#CC0000,#FF4444);color:#fff;text-decoration:none;padding:12px 32px;border-radius:10px;font-weight:700;font-size:14px;">فتح لوحة الإدارة ←</a>
    </div>
    <div style="border-top:1px solid #F3F4F6;padding-top:18px;">
      <p style="margin:0;font-size:12px;color:#D1D5DB;text-align:center;">دبي فانز — نظام إدارة العملاء المحتملين · <a href="https://mtuaefans.com" style="color:#D1D5DB;">mtuaefans.com</a></p>
    </div>
  </div>
</div>`;

  const ok = await sendEmail({
    from: `"دبي فانز — AI Business Audit" <${senderAddress}>`,
    to: adminEmail,
    subject: `📊 طلب تحليل جديد — ${escSubject(params.companyName)} (${escSubject(params.businessType)})`,
    html,
  });
  if (ok) logger.info({ to: adminEmail, leadEmail: email }, "Business audit notification sent");
  else logger.error({ leadEmail: email }, "Failed to send business audit notification");
  return ok;
}

/**
 * Notify the admin that a new AI Business OS Early Access lead was submitted.
 */
export async function sendAibosLeadNotification(params: {
  name: string;
  email: string;
  businessType: string;
  city: string;
}): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    logger.info("RESEND_API_KEY not set — skipping AIBOS lead notification");
    return;
  }

  const name         = escHtml(params.name);
  const email        = escHtml(params.email);
  const businessType = escHtml(params.businessType);
  const city         = params.city ? escHtml(params.city) : "—";
  const senderAddress = process.env.SMTP_USER ?? "no-reply@mtuaefans.com";
  const adminEmail    = process.env.ADMIN_EMAIL ?? senderAddress;
  const now = new Date().toLocaleString("ar-AE", { timeZone: "Asia/Dubai" });

  const html = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#CC0000,#D97706);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <span style="font-size:28px;">🚀</span>
    <h1 style="color:#fff;margin:8px 0 0;font-size:22px;font-weight:900;">طلب Early Access جديد</h1>
    <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px;">AI Business OS — دبي فانز</p>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
    <p style="margin:0 0 20px;font-size:15px;color:#374151;">تم استلام طلب وصول مبكر جديد لمنصة AI Business OS:</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;width:35%;">الاسم</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;">${name}</td></tr>
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;">البريد الإلكتروني</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;" dir="ltr">${email}</td></tr>
      <tr style="border-bottom:1px solid #F3F4F6;"><td style="padding:10px 0;font-size:13px;color:#9CA3AF;">نوع النشاط</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;">${businessType}</td></tr>
      <tr><td style="padding:10px 0;font-size:13px;color:#9CA3AF;">المدينة</td><td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;">${city}</td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:12px;color:#9CA3AF;">وقت الطلب: ${escHtml(now)}</p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://mtuaefans.com/ai-business-os" style="display:inline-block;background:linear-gradient(135deg,#CC0000,#FF4444);color:#fff;text-decoration:none;padding:12px 32px;border-radius:10px;font-weight:700;font-size:14px;">فتح صفحة AI Business OS ←</a>
    </div>
    <div style="border-top:1px solid #F3F4F6;padding-top:18px;">
      <p style="margin:0;font-size:12px;color:#D1D5DB;text-align:center;">دبي فانز — نظام إدارة العملاء المحتملين · <a href="https://mtuaefans.com" style="color:#D1D5DB;">mtuaefans.com</a></p>
    </div>
  </div>
</div>`;

  const ok = await sendEmail({
    from: `"دبي فانز — AI Business OS" <${senderAddress}>`,
    to: adminEmail,
    subject: `🚀 طلب Early Access جديد — ${escSubject(params.name)} (${escSubject(params.businessType)})`,
    html,
  });
  if (ok) logger.info({ to: adminEmail, leadEmail: email }, "AIBOS lead notification sent");
  else logger.error({ leadEmail: email }, "Failed to send AIBOS lead notification");
}

/**
 * Congratulate a student on completing a course.
 */
export async function sendCourseCompletedEmail(params: {
  studentName: string;
  studentEmail: string;
  courseName: string;
  certificateId: number;
}): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    logger.info("RESEND_API_KEY not set — skipping course-completed notification");
    return false;
  }

  const studentName = escHtml(params.studentName);
  const courseName  = escHtml(params.courseName);
  const { studentEmail, certificateId } = params;
  const certUrl   = `${appBaseUrl()}/api/student/certificates/${certificateId}/view`;
  const portalUrl = `${appBaseUrl()}/student/dashboard`;
  const senderAddress = process.env.SMTP_USER ?? "no-reply@mtuaefans.com";

  const html = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#CC0000,#1E1B4B);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <span style="font-size:28px;">🎓</span>
    <h1 style="color:#fff;margin:8px 0 0;font-size:22px;font-weight:900;">مبروك! أتممت الكورس بنجاح</h1>
    <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px;">أكاديمية دبي فانز</p>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">مرحباً <strong>${studentName}</strong>،</p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#6B7280;">
      يسعدنا تهنئتك بإتمام جميع دروس الكورس بنجاح! تم إصدار شهادتك تلقائياً وهي جاهزة الآن للعرض والطباعة.
    </p>
    <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-right:4px solid #CC0000;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:12px;color:#9CA3AF;font-weight:600;">الكورس المُكتمل</p>
      <p style="margin:0;font-size:16px;font-weight:900;color:#111827;">${courseName}</p>
    </div>
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${certUrl}" style="display:inline-block;background:linear-gradient(135deg,#CC0000,#B00000);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;">عرض شهادتي 🎓</a>
    </div>
    <p style="margin:0 0 8px;font-size:12px;color:#9CA3AF;text-align:center;">أو ادخل إلى بوابة الطالب — قسم الشهادات:</p>
    <p style="margin:0 0 24px;font-size:12px;color:#CC0000;text-align:center;word-break:break-all;" dir="ltr">${portalUrl}</p>
    <div style="border-top:1px solid #F3F4F6;padding-top:18px;">
      <p style="margin:0;font-size:12px;color:#D1D5DB;text-align:center;">أكاديمية دبي فانز للتسويق الرقمي · <a href="https://mtuaefans.com" style="color:#D1D5DB;">mtuaefans.com</a></p>
    </div>
  </div>
</div>`;

  const ok = await sendEmail({
    from: `"أكاديمية دبي فانز" <${senderAddress}>`,
    to: studentEmail,
    subject: `🎓 مبروك! أتممت كورس ${escSubject(params.courseName)} — شهادتك جاهزة`,
    html,
  });
  if (ok) logger.info({ to: studentEmail, certificateId }, "Course-completed email sent");
  else logger.error({ to: studentEmail, certificateId }, "Failed to send course-completed email");
  return ok;
}

/**
 * Notify a client that a new campaign report is ready to view.
 */
export async function sendReportPublishedEmail(params: {
  clientName: string;
  clientEmail: string;
  clientSlug: string;
  reportId: number;
  reportTitle: string;
  periodStart: string;
  periodEnd: string;
}): Promise<ReportEmailResult> {
  if (!process.env.RESEND_API_KEY) {
    logger.info("RESEND_API_KEY not set — skipping report-published notification");
    return "not_configured";
  }

  const { clientName, clientEmail, clientSlug, reportId, reportTitle, periodStart, periodEnd } = params;
  const reportUrl = `${appBaseUrl()}/company/${clientSlug}/report/${reportId}`;
  const senderAddress = process.env.SMTP_USER ?? "no-reply@mtuaefans.com";

  const html = `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#7C3AED,#CC0000);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <span style="font-size:28px;">📊</span>
    <h1 style="color:#fff;margin:8px 0 0;font-size:22px;font-weight:900;">تقرير أداء جديد متاح</h1>
    <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px;">بوابة العملاء — دبي فانز</p>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#374151;">مرحباً <strong>${escHtml(clientName)}</strong>،</p>
    <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#6B7280;">
      يسعدنا إبلاغك بأن تقرير أداء حملتك الإعلانية الجديد قد تم نشره وأصبح متاحاً الآن في بوابتك الخاصة.
    </p>
    <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-right:4px solid #7C3AED;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:12px;color:#9CA3AF;font-weight:600;">التقرير</p>
      <p style="margin:0 0 10px;font-size:16px;font-weight:900;color:#111827;">${escHtml(reportTitle)}</p>
      <p style="margin:0;font-size:13px;color:#6B7280;">الفترة:&nbsp;<strong style="color:#374151;">${escHtml(periodStart)}</strong>&nbsp;—&nbsp;<strong style="color:#374151;">${escHtml(periodEnd)}</strong></p>
    </div>
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${reportUrl}" style="display:inline-block;background:linear-gradient(135deg,#7C3AED,#9333EA);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;">عرض التقرير الآن ←</a>
    </div>
    <p style="margin:0 0 8px;font-size:12px;color:#9CA3AF;text-align:center;">أو انسخ هذا الرابط في متصفحك:</p>
    <p style="margin:0 0 24px;font-size:12px;color:#7C3AED;text-align:center;word-break:break-all;" dir="ltr">${reportUrl}</p>
    <div style="border-top:1px solid #F3F4F6;padding-top:18px;">
      <p style="margin:0;font-size:12px;color:#D1D5DB;text-align:center;">فريق دبي فانز للتسويق الرقمي · <a href="https://mtuaefans.com" style="color:#D1D5DB;">mtuaefans.com</a></p>
    </div>
  </div>
</div>`;

  const ok = await sendEmail({
    from: `"دبي فانز — تقارير الأداء" <${senderAddress}>`,
    to: clientEmail,
    subject: `📊 تقرير أداء جديد متاح — ${escSubject(reportTitle)}`,
    html,
  });
  if (ok) {
    logger.info({ to: clientEmail, reportId, slug: clientSlug }, "Report-published email sent");
    return "sent";
  }
  logger.error({ to: clientEmail, reportId }, "Failed to send report-published email");
  return "failed";
}
