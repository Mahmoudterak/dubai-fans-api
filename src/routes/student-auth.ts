/**
 * Student Auth Routes
 * POST /api/student/register   — create account (email+password)
 * POST /api/student/login      — issue 30-day HttpOnly session cookie
 * POST /api/student/logout     — clear cookie
 * GET  /api/student/session    — 200 + student if valid, 401 otherwise
 * GET  /api/student/dashboard  — summary stub (protected)
 * GET  /api/student/courses    — enrolled courses (PII-filtered, protected)
 * GET  /api/student/profile    — student profile (protected)
 * PATCH /api/student/profile   — update profile (protected)
 *
 * NOTE: enrollment auto-linking is intentionally absent (see comment below).
 * Admins can link enrollments via PATCH /api/admin/course-enrollments/:id/link-student.
 */
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, students, courseEnrollments } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Protect auth endpoints from brute-force and account-creation spam.
// Limits are per-IP (using the trusted X-Forwarded-For via app.set("trust proxy",1)).
const isTest = process.env.NODE_ENV === "test";

// Lazy wrappers: defer rateLimit() (and its MemoryStore setInterval) to first
// request so it never runs in CF Workers global scope.
import type { RequestHandler } from "express";
function lazyLimit(factory: () => RequestHandler): RequestHandler {
  let h: RequestHandler | null = null;
  return (req, res, next) => { if (!h) h = factory(); h(req, res, next); };
}

const loginLimiter = lazyLimit(() => rateLimit({
  validate: { creationStack: false },
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: "عدد كبير من المحاولات — يرجى الانتظار 15 دقيقة ثم المحاولة مجدداً" },
  skipSuccessfulRequests: true, // reset counter after a successful login
  skip: () => isTest,        // no rate limiting in test environment
}));

const registerLimiter = lazyLimit(() => rateLimit({
  validate: { creationStack: false },
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 registrations per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: "حدّ إنشاء الحسابات — يرجى الانتظار ساعة ثم المحاولة مجدداً" },
  skip: () => isTest,        // no rate limiting in test environment
}));

// ── Cookie config ─────────────────────────────────────────────────────────────
const SESSION_COOKIE = "df_student_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (sliding — renewed on use)
// Re-issue the cookie when the token is older than this, so active students
// never expire while idle sessions die after 7 days.
const ROTATE_AFTER_MS = 60 * 60 * 1000; // 1 hour
const BCRYPT_ROUNDS  = 10;

// Signed token: `<studentId>.<sessionVersion_hex>.<expires_hex>.<hmac_hex>`
// The embedded sessionVersion is checked against students.session_version on
// every authenticated request — bumping the column invalidates all cookies.
// (Older 3-segment tokens fail to parse, forcing a clean re-login.)
// We don't import crypto at the top level to keep this self-contained.
import { createHmac, timingSafeEqual, randomBytes } from "crypto";

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

function issueStudentToken(studentId: number, sessionVersion: number): string {
  const expires = (Date.now() + SESSION_TTL_MS).toString(16);
  const payload = `${studentId}.${sessionVersion.toString(16)}.${expires}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

interface ParsedToken { id: number; version: number; expiresAt: number }

function parseStudentToken(token: string): ParsedToken | null {
  // format: <id>.<version_hex>.<expires_hex>.<sig>
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [idStr, versionHex, expires, sig] = parts;
  const expiresAt = parseInt(expires, 16);
  if (expiresAt < Date.now()) return null;
  const payload = `${idStr}.${versionHex}.${expires}`;
  const expected = createHmac("sha256", getSecret()).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch { return null; }
  const id = parseInt(idStr, 10);
  const version = parseInt(versionHex, 16);
  if (isNaN(id) || isNaN(version)) return null;
  return { id, version, expiresAt };
}

function setStudentCookie(res: Response, token: string) {
  const inReplit = !!process.env.REPL_ID;
  const isTest   = process.env.NODE_ENV === "test";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure must be false in test mode so supertest (HTTP) can read the cookie
    secure: !isTest && (inReplit || process.env.NODE_ENV === "production"),
    sameSite: inReplit ? "none" : "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

/** Non-throwing resolver — returns student id if a valid session cookie exists, else null.
 *  Signature-only check (no DB version lookup): used for quota keying in
 *  AI endpoints where identifying the student is enough — a revoked session
 *  still keys the same quota bucket, which is safe. Protected student routes
 *  must use requireStudent (which verifies session_version in the DB). */
export function resolveStudentId(req: Request): number | null {
  const token = (req.cookies as Record<string, string>)?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return parseStudentToken(token)?.id ?? null;
  } catch {
    return null;
  }
}

/** Express guard — resolves student from cookie, verifies the embedded session
 *  version against the DB (so password changes / logout-all revoke old cookies)
 *  and slides the cookie expiry forward on active use. */
export async function requireStudent(req: Request, res: Response): Promise<number | null> {
  const token = (req.cookies as Record<string, string>)?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ status: 401, error: "يرجى تسجيل الدخول أولاً" });
    return null;
  }
  try {
    const parsed = parseStudentToken(token);
    if (!parsed) {
      res.status(401).json({ status: 401, error: "الجلسة منتهية — يرجى إعادة تسجيل الدخول" });
      return null;
    }

    // Version check — invalidated when the student changes password or logs
    // out from all devices (students.session_version is bumped).
    const [row] = await db
      .select({ sessionVersion: students.sessionVersion })
      .from(students)
      .where(eq(students.id, parsed.id));
    if (!row || row.sessionVersion !== parsed.version) {
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.status(401).json({ status: 401, error: "الجلسة منتهية — يرجى إعادة تسجيل الدخول" });
      return null;
    }

    // Sliding expiry: re-issue the cookie once the token is >1h old so active
    // students stay logged in while idle sessions expire after 7 days.
    if (parsed.expiresAt - Date.now() < SESSION_TTL_MS - ROTATE_AFTER_MS) {
      setStudentCookie(res, issueStudentToken(parsed.id, parsed.version));
    }

    return parsed.id;
  } catch {
    res.status(401).json({ status: 401, error: "جلسة غير صالحة" });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSRF protection — two complementary techniques
//
// 1. Authenticated mutations (logout, profile PATCH, password PATCH):
//    Require X-Requested-With: fetch (custom request header technique).
//    Cross-site HTML forms cannot set custom headers.
//
// 2. Unauthenticated mutations (register, login):
//    Use Origin header validation to block login-CSRF attacks
//    (forcing a victim to authenticate as the attacker).
//    If Origin is present and not in the trusted-origin set, reject with 403.
//    Requests with no Origin header (server-to-server / curl) are permitted.
//
// SameSite=None is mandatory in Replit (cross-origin iframe); both techniques
// apply here. CORS already sets Access-Control-Allow-Origin for the same trusted
// set, so no double-maintenance required.
// ─────────────────────────────────────────────────────────────────────────────

/** Origins allowed to make credentialed requests to the student API. */
function getAllowedOrigins(): Set<string> {
  return new Set<string>([
    "https://mtuaefans.com",
    ...(process.env.REPLIT_DEV_DOMAIN
      ? [`https://${process.env.REPLIT_DEV_DOMAIN}`]
      : []),
  ]);
}

const PUBLIC_MUTATION_PATHS = new Set(["/student/register", "/student/login"]);

// Middleware applied to all student mutations on this router
router.use((req: Request, res: Response, next: import("express").NextFunction) => {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  if (safeMethods.has(req.method)) { next(); return; }
  if (process.env.NODE_ENV === "test") { next(); return; }

  // X-Requested-With: fetch is an adequate CSRF defence for all routes —
  // cross-site HTML forms and img/script tags cannot set custom headers.
  if (req.headers["x-requested-with"] === "fetch") { next(); return; }

  if (PUBLIC_MUTATION_PATHS.has(req.path)) {
    // For login/register also accept requests whose Origin is in the trusted set.
    const origin = req.headers.origin as string | undefined;
    if (!origin || getAllowedOrigins().has(origin)) { next(); return; }
    res.status(403).json({ error: "طلب غير مصرّح به — مصدر غير موثوق" });
    return;
  }

  res.status(403).json({ error: "طلب غير مصرّح به — يُشترط X-Requested-With: fetch" });
});

// NOTE: enrollment auto-linking by email is intentionally omitted.
// Linking enrollments solely based on a matching email address — without
// verified proof that the registrant owns that address — would allow any
// attacker to claim another person's enrollment records (phone, payment info,
// course history) by simply registering with their email. Safe linking
// requires email verification (out of scope for this task; planned as future
// work). Admins can manually link enrollments from the admin panel.

// ── POST /api/student/register ───────────────────────────────────────────────
router.post("/student/register", registerLimiter, async (req: Request, res: Response): Promise<void> => {
  const { fullName, email, password, phone, city } = req.body as {
    fullName?: string; email?: string; password?: string;
    phone?: string; city?: string;
  };

  if (!fullName?.trim() || !email?.trim() || !password) {
    res.status(400).json({ error: "الاسم والبريد الإلكتروني وكلمة المرور مطلوبة" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
    return;
  }

  const emailLower = email.trim().toLowerCase();

  // Check duplicate
  const existing = await db.select({ id: students.id }).from(students).where(eq(students.email, emailLower));
  if (existing.length > 0) {
    res.status(409).json({ error: "البريد الإلكتروني مسجّل مسبقاً" });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [student] = await db.insert(students).values({
      fullName: fullName.trim(),
      email: emailLower,
      passwordHash,
      phone: phone?.trim() ?? "",
      city: city?.trim() ?? "",
    }).returning();

    setStudentCookie(res, issueStudentToken(student.id, student.sessionVersion));

    logger.info({ id: student.id, email: emailLower }, "Student registered");
    res.json({ ok: true, student: { id: student.id, fullName: student.fullName, email: student.email } });
  } catch (err) {
    logger.error({ err }, "Failed to register student");
    res.status(500).json({ error: "حدث خطأ — يرجى المحاولة مجدداً" });
  }
});

// ── POST /api/student/login ──────────────────────────────────────────────────
router.post("/student/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    return;
  }

  const emailLower = email.trim().toLowerCase();
  const [student] = await db.select().from(students).where(eq(students.email, emailLower));

  if (!student) {
    res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    return;
  }

  if (!student.passwordHash) {
    // Google-only account — no password to compare against.
    res.status(401).json({ error: "هذا الحساب مسجّل عبر Google — استخدم زر «متابعة مع Google»" });
    return;
  }

  const valid = await bcrypt.compare(password, student.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    return;
  }

  setStudentCookie(res, issueStudentToken(student.id, student.sessionVersion));

  logger.info({ id: student.id }, "Student logged in");
  res.json({ ok: true, student: { id: student.id, fullName: student.fullName, email: student.email } });
});

// ── POST /api/student/logout ─────────────────────────────────────────────────
router.post("/student/logout", (_req: Request, res: Response): void => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ── POST /api/student/logout-all ─────────────────────────────────────────────
// "Logout from all devices": bumps session_version so every existing cookie
// becomes invalid, then re-issues a fresh cookie so THIS device stays signed in.
router.post("/student/logout-all", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const [updated] = await db
      .update(students)
      .set({ sessionVersion: sql`${students.sessionVersion} + 1` })
      .where(eq(students.id, studentId))
      .returning({ sessionVersion: students.sessionVersion });

    if (!updated) { res.status(404).json({ error: "الطالب غير موجود" }); return; }

    setStudentCookie(res, issueStudentToken(studentId, updated.sessionVersion));
    logger.info({ id: studentId }, "Student logged out from all other devices");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to logout from all devices");
    res.status(500).json({ error: "حدث خطأ — يرجى المحاولة مجدداً" });
  }
});

// ── GET /api/student/session ─────────────────────────────────────────────────
router.get("/student/session", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const [student] = await db
    .select({ id: students.id, fullName: students.fullName, email: students.email, phone: students.phone, city: students.city })
    .from(students)
    .where(eq(students.id, studentId));

  if (!student) {
    res.status(401).json({ error: "الطالب غير موجود" });
    return;
  }

  res.json({ ok: true, student });
});

// ── GET /api/student/dashboard ───────────────────────────────────────────────
router.get("/student/dashboard", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const enrollments = await db
    .select({
      courseSlug: courseEnrollments.courseSlug,
      courseName: courseEnrollments.courseName,
      status:     courseEnrollments.status,
      createdAt:  courseEnrollments.createdAt,
    })
    .from(courseEnrollments)
    .where(eq(courseEnrollments.studentId, studentId));

  res.json({
    ok: true,
    stats: {
      totalCourses:     enrollments.length,
      activeCourses:    enrollments.filter(e => e.status === "enrolled").length,
      completedCourses: 0,
      certificates:     0,
    },
    recentEnrollments: enrollments.slice(0, 5),
  });
});

// ── GET /api/student/courses ─────────────────────────────────────────────────
// Returns only the fields the student dashboard needs — no PII belonging to
// the enrollment record (phone, jobTitle, paymentMethod, howDidYouHear, questions
// are admin-only fields that should not be re-exposed to the student portal).
router.get("/student/courses", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const enrollments = await db
    .select({
      id:         courseEnrollments.id,
      courseSlug: courseEnrollments.courseSlug,
      courseName: courseEnrollments.courseName,
      status:     courseEnrollments.status,
      createdAt:  courseEnrollments.createdAt,
    })
    .from(courseEnrollments)
    .where(eq(courseEnrollments.studentId, studentId));

  res.json({ ok: true, courses: enrollments });
});

// ── GET /api/student/profile ─────────────────────────────────────────────────
router.get("/student/profile", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const [student] = await db
    .select({
      id: students.id, fullName: students.fullName, email: students.email,
      phone: students.phone, city: students.city, createdAt: students.createdAt,
      googleId: students.googleId, passwordHash: students.passwordHash,
    })
    .from(students)
    .where(eq(students.id, studentId));

  if (!student) { res.status(404).json({ error: "الطالب غير موجود" }); return; }
  const { googleId, passwordHash, ...rest } = student;
  res.json({ ok: true, student: { ...rest, hasGoogle: !!googleId, hasPassword: !!passwordHash } });
});

// ── PATCH /api/student/profile ───────────────────────────────────────────────
router.patch("/student/profile", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const { fullName, phone, city } = req.body as { fullName?: string; phone?: string; city?: string };
  const updates: Partial<{ fullName: string; phone: string; city: string }> = {};
  if (fullName?.trim()) updates.fullName = fullName.trim();
  if (phone !== undefined) updates.phone = phone.trim();
  if (city !== undefined) updates.city = city.trim();

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "لم يتم إرسال أي تعديلات" });
    return;
  }

  const [updated] = await db.update(students).set(updates).where(eq(students.id, studentId)).returning();
  res.json({ ok: true, student: { id: updated.id, fullName: updated.fullName, email: updated.email, phone: updated.phone, city: updated.city } });
});

// ── PATCH /api/student/profile/password ──────────────────────────────────────
router.patch("/student/profile/password", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "كلمة المرور الحالية والجديدة مطلوبتان" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
    return;
  }

  try {
    const [student] = await db.select({ id: students.id, passwordHash: students.passwordHash }).from(students).where(eq(students.id, studentId));
    if (!student) { res.status(404).json({ error: "الطالب غير موجود" }); return; }

    if (!student.passwordHash) {
      res.status(400).json({ error: "هذا الحساب مسجّل عبر Google ولا يملك كلمة مرور" });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, student.passwordHash);
    if (!valid) { res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" }); return; }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Bump session_version in the same write — this invalidates every existing
    // session cookie (all devices). Re-issue a fresh cookie for this device.
    const [updated] = await db
      .update(students)
      .set({ passwordHash: newHash, sessionVersion: sql`${students.sessionVersion} + 1` })
      .where(eq(students.id, studentId))
      .returning({ sessionVersion: students.sessionVersion });

    if (updated) setStudentCookie(res, issueStudentToken(studentId, updated.sessionVersion));

    logger.info({ id: studentId }, "Student password changed — other sessions invalidated");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to change student password");
    res.status(500).json({ error: "خطأ في تغيير كلمة المرور" });
  }
});

// ── DELETE /api/student/profile/google ───────────────────────────────────────
// Unlink Google from the current student account. Refused for Google-only
// accounts (no passwordHash) — unlinking would permanently lock them out.
router.delete("/student/profile/google", async (req: Request, res: Response): Promise<void> => {
  const studentId = await requireStudent(req, res);
  if (!studentId) return;

  try {
    const [student] = await db
      .select({ id: students.id, googleId: students.googleId, passwordHash: students.passwordHash })
      .from(students)
      .where(eq(students.id, studentId));
    if (!student) { res.status(404).json({ error: "الطالب غير موجود" }); return; }

    if (!student.googleId) {
      res.status(400).json({ error: "لا يوجد حساب Google مرتبط بهذا الحساب" });
      return;
    }

    if (!student.passwordHash) {
      res.status(400).json({
        error: "لا يمكن فصل حساب Google لأن حسابك لا يملك كلمة مرور — عيّن كلمة مرور أولاً حتى لا تفقد الوصول إلى حسابك",
      });
      return;
    }

    await db.update(students).set({ googleId: null }).where(eq(students.id, studentId)).returning();

    logger.info({ id: studentId }, "Student unlinked Google account");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to unlink Google account");
    res.status(500).json({ error: "حدث خطأ — يرجى المحاولة مجدداً" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth ("متابعة مع Google")
//
// GET /api/student/auth/google           → redirect to Google's consent screen
// GET /api/student/auth/google?link=1    → same, but links Google to the
//                                          currently-logged-in student account
// GET /api/student/auth/google/callback  → code exchange + login/link/create
//
// State is a random nonce carried both in the OAuth `state` param and in a
// short-lived signed HttpOnly cookie (double-submit) to block CSRF/code
// injection. The cookie also carries the flow mode (login vs link + studentId).
// ─────────────────────────────────────────────────────────────────────────────
import { OAuth2Client } from "google-auth-library";

const OAUTH_STATE_COOKIE = "df_google_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function googleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

/** Fixed production hosts — their redirect URIs are permanently registered in Google Console. */
const PRODUCTION_OAUTH_HOSTS = new Set(["mtuaefans.com", "www.mtuaefans.com"]);

/**
 * Dev hosts the developer has confirmed as registered in Google Console
 * (comma-separated env var GOOGLE_REGISTERED_DEV_HOSTS).
 *
 * Why: Google rejects any redirect_uri that is not pre-registered with an
 * opaque `redirect_uri_mismatch` page — before our callback ever runs. When
 * the Replit dev domain (REPLIT_DEV_DOMAIN) changes, blindly trusting it
 * would send students to that dead end. Requiring explicit confirmation here
 * lets us fail fast with an actionable message instead.
 */
function getRegisteredDevHosts(): Set<string> {
  return new Set(
    (process.env.GOOGLE_REGISTERED_DEV_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Hosts we are willing to build a redirect_uri for (must also be registered in Google Console). */
export function getAllowedHosts(): Set<string> {
  return new Set<string>([
    ...PRODUCTION_OAUTH_HOSTS,
    ...(process.env.REPLIT_DEV_DOMAIN ? [process.env.REPLIT_DEV_DOMAIN] : []),
  ]);
}

type RedirectUriResult =
  | { ok: true; uri: string }
  | { ok: false; error: "google_bad_host" | "google_redirect_unregistered" };

function getRedirectUri(req: Request): RedirectUriResult {
  const host = ((req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.get("host") ?? "").toLowerCase();

  if (!getAllowedHosts().has(host)) {
    logger.warn(
      { host, allowedHosts: [...getAllowedHosts()] },
      "Google OAuth rejected: request host is not in the allowed-hosts list.",
    );
    return { ok: false, error: "google_bad_host" };
  }

  // Preflight: a dev-domain host must be explicitly confirmed as registered in
  // Google Console, otherwise Google would reject the redirect with an opaque
  // `redirect_uri_mismatch` error page before our callback runs.
  const isDevHost = !PRODUCTION_OAUTH_HOSTS.has(host);
  if (isDevHost && !getRegisteredDevHosts().has(host)) {
    logger.warn(
      { host, registeredDevHosts: [...getRegisteredDevHosts()] },
      "Google OAuth blocked: dev host not confirmed as registered in Google Console. " +
      `Add https://${host}/api/student/auth/google/callback to Authorized redirect URIs ` +
      "in Google Cloud Console, then set GOOGLE_REGISTERED_DEV_HOSTS to include this host " +
      "(see replit.md → Google OAuth).",
    );
    return { ok: false, error: "google_redirect_unregistered" };
  }

  return { ok: true, uri: `https://${host}/api/student/auth/google/callback` };
}

/**
 * Startup preflight — called once from app bootstrap. Warns loudly (dev only)
 * when the current Replit dev domain is not confirmed as registered, so the
 * developer sees the exact URI to register before any student hits the error.
 */
export function warnIfGoogleRedirectUnregistered(): void {
  const dev = process.env.REPLIT_DEV_DOMAIN?.toLowerCase();
  if (!dev || process.env.NODE_ENV === "production" || !googleConfigured()) return;
  if (getRegisteredDevHosts().has(dev)) return;
  logger.warn(
    { devDomain: dev },
    "Google OAuth on the dev domain will fail with Google's redirect_uri_mismatch page. " +
    `Register https://${dev}/api/student/auth/google/callback under Authorized redirect URIs ` +
    "in Google Cloud Console, then set GOOGLE_REGISTERED_DEV_HOSTS=" + dev +
    " (see replit.md → Google OAuth). Production (mtuaefans.com) is unaffected.",
  );
}

function signOauthState(payload: string): string {
  const sig = createHmac("sha256", getSecret()).update(`oauth:${payload}`).digest("hex");
  return `${payload}.${sig}`;
}

function verifyOauthState(cookieVal: string): { nonce: string; linkStudentId: number | null; expires: number } | null {
  const idx = cookieVal.lastIndexOf(".");
  if (idx < 0) return null;
  const payload = cookieVal.slice(0, idx);
  const sig = cookieVal.slice(idx + 1);
  const expected = createHmac("sha256", getSecret()).update(`oauth:${payload}`).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch { return null; }
  // payload: <nonce>|<linkStudentId or ->|<expires_hex>
  const [nonce, linkStr, expHex] = payload.split("|");
  if (!nonce || !expHex) return null;
  const expires = parseInt(expHex, 16);
  if (isNaN(expires) || expires < Date.now()) return null;
  const linkStudentId = linkStr && linkStr !== "-" ? parseInt(linkStr, 10) : null;
  return { nonce, linkStudentId: isNaN(linkStudentId as number) ? null : linkStudentId, expires };
}

function loginRedirect(res: Response, errorCode: string): void {
  res.redirect(`/student/login?error=${encodeURIComponent(errorCode)}`);
}

/** DB-validated session resolver for OAuth link mode — parses the cookie AND
 *  verifies the embedded session version against students.session_version,
 *  so revoked cookies (password change / logout-all) cannot initiate or
 *  complete a Google link. Returns the student id or null. */
async function resolveVerifiedStudentId(req: Request): Promise<number | null> {
  const token = (req.cookies as Record<string, string>)?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    const parsed = parseStudentToken(token);
    if (!parsed) return null;
    const [row] = await db
      .select({ sessionVersion: students.sessionVersion })
      .from(students)
      .where(eq(students.id, parsed.id));
    if (!row || row.sessionVersion !== parsed.version) return null;
    return parsed.id;
  } catch {
    return null;
  }
}

// ── GET /api/student/auth/google ─────────────────────────────────────────────
router.get("/student/auth/google", async (req: Request, res: Response): Promise<void> => {
  if (!googleConfigured()) { loginRedirect(res, "google_not_configured"); return; }

  const redirect = getRedirectUri(req);
  if (!redirect.ok) { loginRedirect(res, redirect.error); return; }
  const redirectUri = redirect.uri;

  // Link mode requires an active session
  let linkStudentId: number | null = null;
  if (req.query.link === "1") {
    linkStudentId = await resolveVerifiedStudentId(req);
    if (!linkStudentId) { loginRedirect(res, "session_required"); return; }
  }

  const nonce = randomBytes(16).toString("hex");
  const expires = (Date.now() + OAUTH_STATE_TTL_MS).toString(16);
  const cookieVal = signOauthState(`${nonce}|${linkStudentId ?? "-"}|${expires}`);

  const inReplit = !!process.env.REPL_ID;
  res.cookie(OAUTH_STATE_COOKIE, cookieVal, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "test",
    sameSite: inReplit ? "none" : "lax",
    maxAge: OAUTH_STATE_TTL_MS,
    path: "/",
  });

  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
  const url = client.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state: nonce,
    prompt: "select_account",
  });
  res.redirect(url);
});

// ── GET /api/student/auth/google/callback ────────────────────────────────────
router.get("/student/auth/google/callback", async (req: Request, res: Response): Promise<void> => {
  if (!googleConfigured()) { loginRedirect(res, "google_not_configured"); return; }

  const redirect = getRedirectUri(req);
  if (!redirect.ok) { loginRedirect(res, redirect.error); return; }
  const redirectUri = redirect.uri;

  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

  if (error === "access_denied") { loginRedirect(res, "google_cancelled"); return; }
  if (!code || !state) { loginRedirect(res, "google_failed"); return; }

  // Validate state against the signed cookie (CSRF protection)
  const stateCookie = (req.cookies as Record<string, string>)?.[OAUTH_STATE_COOKIE];
  const parsed = stateCookie ? verifyOauthState(stateCookie) : null;
  if (!parsed || parsed.nonce !== state) { loginRedirect(res, "google_state_mismatch"); return; }

  // Link mode: the state cookie was minted while the session was valid, but
  // the session may have been revoked since (password change / logout-all).
  // Require a still-valid session for the SAME student before exchanging the
  // code or touching the DB.
  if (parsed.linkStudentId) {
    const currentStudentId = await resolveVerifiedStudentId(req);
    if (currentStudentId !== parsed.linkStudentId) {
      loginRedirect(res, "session_required");
      return;
    }
  }

  try {
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) { loginRedirect(res, "google_failed"); return; }

    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const googleSub = payload?.sub;
    const email = payload?.email?.toLowerCase();
    if (!googleSub || !email || payload?.email_verified !== true) {
      loginRedirect(res, "google_email_unverified");
      return;
    }

    // ── Link mode: attach googleId to the logged-in account ──────────────────
    if (parsed.linkStudentId) {
      const [taken] = await db.select({ id: students.id }).from(students).where(eq(students.googleId, googleSub));
      if (taken && taken.id !== parsed.linkStudentId) {
        res.redirect("/student/dashboard?google=already_linked");
        return;
      }
      await db.update(students).set({ googleId: googleSub }).where(eq(students.id, parsed.linkStudentId));
      logger.info({ id: parsed.linkStudentId }, "Student linked Google account");
      res.redirect("/student/dashboard?google=linked");
      return;
    }

    // ── Login/registration mode ───────────────────────────────────────────────
    // 1. Existing account already linked to this Google id
    const [byGoogle] = await db.select().from(students).where(eq(students.googleId, googleSub));
    if (byGoogle) {
      setStudentCookie(res, issueStudentToken(byGoogle.id, byGoogle.sessionVersion));
      logger.info({ id: byGoogle.id }, "Student logged in via Google");
      res.redirect("/student/dashboard");
      return;
    }

    // 2. Existing account with the same (Google-verified) email → auto-link
    const [byEmail] = await db.select().from(students).where(eq(students.email, email));
    if (byEmail) {
      await db.update(students).set({ googleId: googleSub }).where(eq(students.id, byEmail.id));
      setStudentCookie(res, issueStudentToken(byEmail.id, byEmail.sessionVersion ?? 1));
      logger.info({ id: byEmail.id }, "Student logged in via Google (auto-linked by verified email)");
      res.redirect("/student/dashboard");
      return;
    }

    // 3. New account — no password (Google-only)
    const [created] = await db.insert(students).values({
      fullName: payload?.name?.trim() || email,
      email,
      passwordHash: null,
      googleId: googleSub,
      phone: "",
      city: "",
    }).returning();

    setStudentCookie(res, issueStudentToken(created.id, created.sessionVersion));
    logger.info({ id: created.id, email }, "Student registered via Google");
    res.redirect("/student/dashboard");
  } catch (err) {
    logger.error({ err }, "Google OAuth callback failed");
    loginRedirect(res, "google_failed");
  }
});

export default router;
