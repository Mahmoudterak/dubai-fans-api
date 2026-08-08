/**
 * Company (multi-user) Auth Routes
 * POST /api/company/auth/login            — email+password → HttpOnly session cookie
 * POST /api/company/auth/logout           — clear cookie
 * GET  /api/company/auth/session          — 200 + client & user info if valid, else 401
 * POST /api/company/auth/change-password  — change own password (clears force_password_change)
 *
 * Company-side user management (owner/gm only):
 * GET    /api/company/:slug/users
 * POST   /api/company/:slug/users
 * PATCH  /api/company/:slug/users/:userId
 * DELETE /api/company/:slug/users/:userId
 *
 * Session security model
 * ─────────────────────
 * Tokens are HMAC-signed cookies bound to a company_users row and its
 * per-user `sessionVersion`.  On every login the server increments the stored
 * version and embeds the new value in the issued token.  requireClient() does
 * a cheap DB lookup to compare the token's version against the stored one and
 * to verify the account is still active, so logging in on any device (or an
 * admin deactivating the account) immediately invalidates old tokens.
 *
 * Token format: `<userId>.<clientId>.<slug>.<sessionVersion_hex>.<expires_hex>.<hmac>`
 *
 * Existing tokens issued with the old 5-segment (single-user) format will fail
 * to parse and be rejected, forcing re-login — desired migration behaviour.
 */
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, clients, companyUsers, passwordResetTokens, type CompanyRole } from "@workspace/db";
import { eq, and, asc, sql, isNull, gt, lt, or, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { sendPasswordResetEmail } from "../lib/mailer.js";

const router: IRouter = Router();

// ── Constants ─────────────────────────────────────────────────────────────────
const SESSION_COOKIE = "df_client_session";
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;          // 1-year — no practical expiry
const SESSION_REFRESH_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // refresh when < 30 days left
const BCRYPT_ROUNDS = 10;

export const COMPANY_ROLES = ["owner", "gm", "marketing", "doctor"] as const;
/** Roles allowed to manage the users of their own company. */
const USER_MANAGER_ROLES: ReadonlySet<CompanyRole> = new Set(["owner", "gm"]);

const isTest = process.env.NODE_ENV === "test";

// Lazy wrapper: defer rateLimit() (and its MemoryStore setInterval) to first
// request so it never runs in CF Workers global scope.
import type { RequestHandler } from "express";
function lazyLimit(factory: () => RequestHandler): RequestHandler {
  let h: RequestHandler | null = null;
  return (req, res, next) => { if (!h) h = factory(); h(req, res, next); };
}

const loginLimiter = lazyLimit(() => rateLimit({
  validate: { creationStack: false },
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: "عدد كبير من المحاولات — يرجى الانتظار 15 دقيقة" },
  skipSuccessfulRequests: true,
  skip: () => isTest,
}));

// ── Token helpers ─────────────────────────────────────────────────────────────
function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

/**
 * Issue a signed token bound to a specific company user, embedding the user's
 * sessionVersion so a subsequent login (which bumps the DB version) renders
 * this token invalid.
 */
function issueClientToken(userId: number, clientId: number, slug: string, sessionVersion: number): string {
  const verHex  = sessionVersion.toString(16);
  const expires = (Date.now() + SESSION_TTL_MS).toString(16);
  const payload = `${userId}.${clientId}.${slug}.${verHex}.${expires}`;
  const sig     = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Parse and cryptographically verify a token.
 * Returns null if the token is malformed, the HMAC is wrong, or it has expired.
 * The returned sessionVersion must still be checked against the DB.
 */
export function parseClientToken(
  token: string,
): { userId: number; clientId: number; slug: string; sessionVersion: number; expiresMs: number } | null {
  // Format: <userId>.<clientId>.<slug>.<verHex>.<expiresHex>.<sig>
  // Peel from the right (sig, expires, version), then split the remainder from
  // the left (userId, clientId, slug).  Slugs are [a-z0-9-] so no dots.

  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return null;
  const sig  = token.slice(lastDot + 1);
  const rest = token.slice(0, lastDot); // <userId>.<clientId>.<slug>.<verHex>.<expiresHex>

  const expDot = rest.lastIndexOf(".");
  if (expDot === -1) return null;
  const expiresHex = rest.slice(expDot + 1);
  const rest2      = rest.slice(0, expDot); // <userId>.<clientId>.<slug>.<verHex>

  const verDot  = rest2.lastIndexOf(".");
  if (verDot === -1) return null;
  const verHex  = rest2.slice(verDot + 1);
  const before  = rest2.slice(0, verDot); // <userId>.<clientId>.<slug>

  const expiresMs      = parseInt(expiresHex, 16);
  const sessionVersion = parseInt(verHex, 16);
  if (isNaN(expiresMs) || isNaN(sessionVersion)) return null;
  if (expiresMs < Date.now()) return null;

  // Verify HMAC over the payload (everything before the last dot)
  const expected = createHmac("sha256", getSecret()).update(rest).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch { return null; }

  // Split "<userId>.<clientId>.<slug>" from the left
  const firstDot = before.indexOf(".");
  if (firstDot === -1) return null;
  const userId    = parseInt(before.slice(0, firstDot), 10);
  const remainder = before.slice(firstDot + 1);
  const secondDot = remainder.indexOf(".");
  if (secondDot === -1) return null;
  const clientId = parseInt(remainder.slice(0, secondDot), 10);
  const slug     = remainder.slice(secondDot + 1);
  if (isNaN(userId) || isNaN(clientId) || !slug) return null;

  return { userId, clientId, slug, sessionVersion, expiresMs };
}

function setClientCookie(res: Response, token: string): void {
  const inReplit  = !!process.env.REPL_ID;
  const isTestEnv = process.env.NODE_ENV === "test";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   !isTestEnv && (inReplit || process.env.NODE_ENV === "production"),
    sameSite: inReplit ? "none" : "strict",
    maxAge:   SESSION_TTL_MS,
    path:     "/",
  });
}

export interface CompanySession {
  userId: number;
  clientId: number;
  slug: string;
  role: CompanyRole;
  email: string;
  name: string;
  forcePasswordChange: boolean;
}

/**
 * Async middleware — validates the session cookie including a DB check on the
 * bound company_users row: it must exist, be active, belong to the same
 * company, and its sessionVersion must match the token's.
 */
export async function requireClient(
  req: Request,
  res: Response,
  opts?: { allowForcePasswordChange?: boolean },
): Promise<CompanySession | null> {
  const token = (req.cookies as Record<string, string>)?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ status: 401, error: "يرجى تسجيل الدخول أولاً" });
    return null;
  }

  const parsed = parseClientToken(token);
  if (!parsed) {
    res.status(401).json({ status: 401, error: "الجلسة منتهية — يرجى إعادة تسجيل الدخول" });
    return null;
  }

  const [user] = await db
    .select({
      id:                  companyUsers.id,
      clientId:            companyUsers.clientId,
      role:                companyUsers.role,
      email:               companyUsers.email,
      name:                companyUsers.name,
      isActive:            companyUsers.isActive,
      forcePasswordChange: companyUsers.forcePasswordChange,
      sessionVersion:      companyUsers.sessionVersion,
    })
    .from(companyUsers)
    .where(eq(companyUsers.id, parsed.userId));

  if (
    !user ||
    !user.isActive ||
    user.clientId !== parsed.clientId ||
    user.sessionVersion !== parsed.sessionVersion
  ) {
    res.status(401).json({ status: 401, error: "الجلسة منتهية — يرجى إعادة تسجيل الدخول" });
    return null;
  }

  // Force-password-change gate: block all protected routes (except the
  // change-password endpoint itself) until the user sets a new password.
  if (user.forcePasswordChange && !opts?.allowForcePasswordChange) {
    res.status(403).json({ ok: false, forcePasswordChange: true, error: "يجب تغيير كلمة المرور أولاً" });
    return null;
  }

  // Sliding window: refresh cookie if close to expiry
  if (parsed.expiresMs - Date.now() < SESSION_REFRESH_THRESHOLD_MS) {
    setClientCookie(res, issueClientToken(user.id, parsed.clientId, parsed.slug, user.sessionVersion));
  }

  return {
    userId: user.id,
    clientId: parsed.clientId,
    slug: parsed.slug,
    role: user.role,
    email: user.email,
    name: user.name,
    forcePasswordChange: user.forcePasswordChange,
  };
}

function publicUser(s: CompanySession) {
  return { id: s.userId, email: s.email, name: s.name, role: s.role, forcePasswordChange: s.forcePasswordChange };
}

// ── CSRF protection ───────────────────────────────────────────────────────────
function getAllowedOrigins(): Set<string> {
  return new Set<string>([
    "https://mtuaefans.com",
    ...(process.env.REPLIT_DEV_DOMAIN
      ? [`https://${process.env.REPLIT_DEV_DOMAIN}`]
      : []),
  ]);
}

router.use((req: Request, res: Response, next: import("express").NextFunction) => {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  if (safeMethods.has(req.method)) { next(); return; }
  if (process.env.NODE_ENV === "test") { next(); return; }

  // X-Requested-With: fetch is an adequate CSRF defence for all routes —
  // cross-site HTML forms and img/script tags cannot set custom headers.
  if (req.headers["x-requested-with"] === "fetch") { next(); return; }

  if (req.path === "/company/auth/login") {
    // For login we also accept requests whose Origin is in the trusted set
    // (browsers always send Origin on cross-origin POSTs).
    const origin = req.headers.origin as string | undefined;
    if (!origin || getAllowedOrigins().has(origin)) { next(); return; }
    res.status(403).json({ error: "طلب غير مصرّح به — مصدر غير موثوق" });
    return;
  }

  res.status(403).json({ error: "طلب غير مصرّح به — يُشترط X-Requested-With: fetch" });
});

// ── POST /api/company/auth/login ──────────────────────────────────────────────
router.post("/company/auth/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور مطلوبان" });
    return;
  }

  const emailLower = email.trim().toLowerCase();

  const [user] = await db.select().from(companyUsers).where(eq(companyUsers.email, emailLower));
  if (!user) {
    res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
    return;
  }

  if (!user.isActive) {
    res.status(403).json({ error: "تم إيقاف هذا الحساب — تواصل مع مدير شركتك" });
    return;
  }

  const [client] = await db
    .select({ id: clients.id, slug: clients.slug, name: clients.name, logoUrl: clients.logoUrl, industry: clients.industry })
    .from(clients)
    .where(eq(clients.id, user.clientId));

  if (!client) {
    res.status(401).json({ error: "الحساب غير موجود" });
    return;
  }

  // Increment sessionVersion to invalidate all tokens issued before this login
  const [updated] = await db
    .update(companyUsers)
    .set({ sessionVersion: sql`${companyUsers.sessionVersion} + 1` })
    .where(eq(companyUsers.id, user.id))
    .returning({ sessionVersion: companyUsers.sessionVersion });

  const newVersion = updated?.sessionVersion ?? 1;

  setClientCookie(res, issueClientToken(user.id, client.id, client.slug, newVersion));
  logger.info({ userId: user.id, clientId: client.id, slug: client.slug, role: user.role }, "Company user logged in");
  res.json({
    ok: true,
    client: { id: client.id, slug: client.slug, name: client.name, logoUrl: client.logoUrl },
    user: { id: user.id, email: user.email, name: user.name, role: user.role, forcePasswordChange: user.forcePasswordChange },
  });
});

// ── Password reset / change ───────────────────────────────────────────────────
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_PASSWORD_LENGTH = 8;

const forgotLimiter = lazyLimit(() => rateLimit({
  validate: { creationStack: false },
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: "عدد كبير من المحاولات — يرجى الانتظار 15 دقيقة" },
  skip: () => isTest,
}));

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Delete reset tokens that expired (or were used) more than 24h ago.
// Runs opportunistically on each forgot-password request; fire-and-forget.
const RESET_TOKEN_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
export async function cleanupExpiredResetTokens(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RESET_TOKEN_CLEANUP_GRACE_MS);
    const deleted = await db
      .delete(passwordResetTokens)
      .where(or(
        lt(passwordResetTokens.expiresAt, cutoff),
        and(isNotNull(passwordResetTokens.usedAt), lt(passwordResetTokens.usedAt, cutoff)),
      ))
      .returning({ id: passwordResetTokens.id });
    if (deleted.length > 0) {
      logger.info({ count: deleted.length }, "Cleaned up expired password-reset tokens");
    }
  } catch (err) {
    logger.error({ err }, "Password-reset token cleanup failed");
  }
}

/**
 * Scheduled cleanup: run cleanupExpiredResetTokens once at startup and then
 * daily, so stale tokens are purged even when nobody triggers the
 * forgot-password flow (which only cleans opportunistically).
 * The timer is unref'd so it never keeps the process alive.
 */
export const RESET_TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
export function scheduleResetTokenCleanup(): NodeJS.Timeout {
  void cleanupExpiredResetTokens();
  const timer = setInterval(() => {
    void cleanupExpiredResetTokens();
  }, RESET_TOKEN_CLEANUP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// POST /api/company/auth/forgot-password — always responds ok (no user enumeration)
router.post("/company/auth/forgot-password", forgotLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body as { email?: string };
  if (!email?.trim()) {
    res.status(400).json({ error: "البريد الإلكتروني مطلوب" });
    return;
  }
  const emailLower = email.trim().toLowerCase();
  const genericResponse = { ok: true, message: "إذا كان البريد مسجلاً لدينا فستصلك رسالة تحتوي رابط إعادة التعيين" };

  // Opportunistic cleanup of stale reset tokens (fire-and-forget)
  void cleanupExpiredResetTokens();

  const [auth] = await db
    .select({ id: companyUsers.id, clientId: companyUsers.clientId })
    .from(companyUsers)
    .where(and(eq(companyUsers.email, emailLower), eq(companyUsers.isActive, true)));

  if (auth) {
    const [client] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, auth.clientId));

    const token = randomBytes(32).toString("hex");
    await db.insert(passwordResetTokens).values({
      userId: auth.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    });

    // Use ctx.waitUntil (attached to req by the CF adapter) so the Resend HTTP
    // fetch is not killed when the Worker response resolves.
    (req as any).waitUntil?.(
      sendPasswordResetEmail({
        clientName: client?.name ?? "عميلنا العزيز",
        email: emailLower,
        token,
      }),
    );
    logger.info({ authId: auth.id }, "Password-reset token issued");
  }

  res.json(genericResponse);
});

// POST /api/company/auth/reset-password — token + new_password
router.post("/company/auth/reset-password", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { token?: string; new_password?: string; newPassword?: string };
  const token = body.token;
  const newPassword = body.new_password ?? body.newPassword;

  if (!token || !newPassword) {
    res.status(400).json({ error: "الرمز وكلمة المرور الجديدة مطلوبان" });
    return;
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
    return;
  }

  const [row] = await db
    .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId })
    .from(passwordResetTokens)
    .where(and(
      eq(passwordResetTokens.tokenHash, hashToken(token)),
      isNull(passwordResetTokens.usedAt),
      gt(passwordResetTokens.expiresAt, new Date()),
    ));

  if (!row) {
    res.status(400).json({ error: "الرابط غير صالح أو منتهي الصلاحية — اطلب رابطاً جديداً" });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  // Mark token used atomically-ish before updating the password
  const [used] = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id });

  if (!used) {
    res.status(400).json({ error: "الرابط غير صالح أو منتهي الصلاحية — اطلب رابطاً جديداً" });
    return;
  }

  // Update password, clear the force flag, and invalidate all existing sessions
  await db
    .update(companyUsers)
    .set({
      passwordHash,
      forcePasswordChange: false,
      sessionVersion: sql`${companyUsers.sessionVersion} + 1`,
    })
    .where(eq(companyUsers.id, row.userId));

  logger.info({ authId: row.userId }, "Password reset via email token");
  res.json({ ok: true, message: "تم تعيين كلمة المرور الجديدة — يمكنك تسجيل الدخول الآن" });
});

// ── POST /api/company/auth/logout ─────────────────────────────────────────────
router.post("/company/auth/logout", (_req: Request, res: Response): void => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ── GET /api/company/auth/session ─────────────────────────────────────────────
router.get("/company/auth/session", async (req: Request, res: Response): Promise<void> => {
  const session = await requireClient(req, res);
  if (!session) return;

  const [client] = await db
    .select({ id: clients.id, slug: clients.slug, name: clients.name, logoUrl: clients.logoUrl, industry: clients.industry })
    .from(clients)
    .where(eq(clients.id, session.clientId));

  if (!client) {
    res.status(401).json({ error: "العميل غير موجود" });
    return;
  }

  res.json({ ok: true, client, user: publicUser(session) });
});

// ── POST /api/company/auth/change-password ────────────────────────────────────
// Authenticated; also works while the force-password-change gate is active.
router.post("/company/auth/change-password", async (req: Request, res: Response): Promise<void> => {
  const session = await requireClient(req, res, { allowForcePasswordChange: true });
  if (!session) return;

  const body = req.body as {
    current_password?: string; currentPassword?: string;
    new_password?: string; newPassword?: string;
  };
  const currentPassword = body.current_password ?? body.currentPassword;
  const newPassword = body.new_password ?? body.newPassword;
  if (!currentPassword || !newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: "كلمة المرور الحالية والجديدة (8 أحرف على الأقل) مطلوبتان" });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تختلف عن الحالية" });
    return;
  }

  const [user] = await db.select().from(companyUsers).where(eq(companyUsers.id, session.userId));
  if (!user) { res.status(401).json({ error: "الحساب غير موجود" }); return; }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) { res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" }); return; }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const [updated] = await db
    .update(companyUsers)
    .set({ passwordHash, forcePasswordChange: false, sessionVersion: sql`${companyUsers.sessionVersion} + 1` })
    .where(eq(companyUsers.id, user.id))
    .returning({ sessionVersion: companyUsers.sessionVersion });

  // Re-issue the cookie so this session survives the version bump
  setClientCookie(res, issueClientToken(user.id, session.clientId, session.slug, updated?.sessionVersion ?? 0));
  logger.info({ userId: user.id }, "Company user changed password");
  res.json({ ok: true, message: "تم تغيير كلمة المرور بنجاح" });
});

// ═════════════════════════════════════════════════════════════════════════════
// Company-side user management (owner/gm)
// ═════════════════════════════════════════════════════════════════════════════

/** Resolve session, verify slug ownership and that the role can manage users. */
async function requireUserManager(req: Request, res: Response): Promise<CompanySession | null> {
  const session = await requireClient(req, res);
  if (!session) return null;
  const { slug } = req.params as { slug: string };
  if (session.slug !== slug) {
    res.status(403).json({ error: "غير مصرّح بالوصول إلى هذا الحساب" });
    return null;
  }
  if (!USER_MANAGER_ROLES.has(session.role)) {
    res.status(403).json({ error: "صلاحياتك لا تسمح بإدارة المستخدمين" });
    return null;
  }
  return session;
}

// Lazy so the table object is only dereferenced at request time (test-mock friendly)
const userColumns = () => ({
  id:                  companyUsers.id,
  email:               companyUsers.email,
  name:                companyUsers.name,
  role:                companyUsers.role,
  isActive:            companyUsers.isActive,
  forcePasswordChange: companyUsers.forcePasswordChange,
  createdAt:           companyUsers.createdAt,
});

// GET /api/company/:slug/users
router.get("/company/:slug/users", async (req: Request, res: Response): Promise<void> => {
  const session = await requireUserManager(req, res);
  if (!session) return;
  const users = await db
    .select(userColumns())
    .from(companyUsers)
    .where(eq(companyUsers.clientId, session.clientId))
    .orderBy(asc(companyUsers.createdAt));
  res.json({ ok: true, users });
});

// POST /api/company/:slug/users
router.post("/company/:slug/users", async (req: Request, res: Response): Promise<void> => {
  const session = await requireUserManager(req, res);
  if (!session) return;

  const { email, name, password, role } = req.body as {
    email?: string; name?: string; password?: string; role?: string;
  };
  if (!email?.trim() || !password || password.length < 8 || !role || !(COMPANY_ROLES as readonly string[]).includes(role)) {
    res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور (8 أحرف على الأقل) والدور مطلوبة" });
    return;
  }
  // Strict hierarchy: only an owner can create owner/gm accounts.
  // A gm can only create marketing/doctor accounts (prevents gm→gm→owner escalation).
  if (session.role !== "owner" && (role === "owner" || role === "gm")) {
    res.status(403).json({ error: role === "owner" ? "فقط المالك يمكنه إنشاء حساب مالك آخر" : "فقط المالك يمكنه إنشاء حساب مدير عام" });
    return;
  }

  const emailLower = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const [created] = await db.insert(companyUsers).values({
      clientId: session.clientId,
      email: emailLower,
      name: name?.trim() ?? "",
      passwordHash,
      role: role as CompanyRole,
      forcePasswordChange: true,
    }).returning(userColumns());
    res.status(201).json({ ok: true, user: created });
  } catch (err) {
    if (String(err).includes("unique")) {
      res.status(409).json({ error: "هذا البريد الإلكتروني مستخدم بالفعل" });
      return;
    }
    logger.error({ err }, "Failed to create company user");
    res.status(500).json({ error: "فشل في إنشاء المستخدم" });
  }
});

/** Load a target user of the same company; enforce gm-cannot-touch-owner. */
async function loadTargetUser(session: CompanySession, req: Request, res: Response) {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const userId = parseInt(raw, 10);
  if (isNaN(userId)) { res.status(400).json({ error: "معرّف غير صالح" }); return null; }

  const [target] = await db
    .select()
    .from(companyUsers)
    .where(and(eq(companyUsers.id, userId), eq(companyUsers.clientId, session.clientId)));
  if (!target) { res.status(404).json({ error: "المستخدم غير موجود" }); return null; }

  // Strict hierarchy: a gm may only manage marketing/doctor accounts.
  // Owners and other gm accounts are off-limits (prevents gm↔gm privilege games).
  if (session.role === "gm" && (target.role === "owner" || target.role === "gm")) {
    res.status(403).json({
      error: target.role === "owner" ? "لا يمكن للمدير العام تعديل حساب المالك" : "لا يمكن للمدير العام تعديل حساب مدير عام آخر",
    });
    return null;
  }
  return target;
}

// PATCH /api/company/:slug/users/:userId — role / isActive / password reset / name
router.patch("/company/:slug/users/:userId", async (req: Request, res: Response): Promise<void> => {
  const session = await requireUserManager(req, res);
  if (!session) return;
  const target = await loadTargetUser(session, req, res);
  if (!target) return;

  const { role, isActive, password, name } = req.body as {
    role?: string; isActive?: boolean; password?: string; name?: string;
  };

  const updates: Record<string, unknown> = {};
  if (role !== undefined) {
    if (!(COMPANY_ROLES as readonly string[]).includes(role)) { res.status(400).json({ error: "دور غير صالح" }); return; }
    // Strict hierarchy: only an owner can grant owner or gm roles.
    if (session.role !== "owner" && (role === "owner" || role === "gm")) {
      res.status(403).json({ error: role === "owner" ? "فقط المالك يمكنه منح دور المالك" : "فقط المالك يمكنه منح دور المدير العام" });
      return;
    }
    if (target.id === session.userId && role !== session.role) {
      res.status(400).json({ error: "لا يمكنك تغيير دورك الخاص" });
      return;
    }
    updates.role = role;
  }
  if (isActive !== undefined) {
    if (target.id === session.userId && isActive === false) {
      res.status(400).json({ error: "لا يمكنك تعطيل حسابك الخاص" });
      return;
    }
    updates.isActive = !!isActive;
  }
  if (password !== undefined) {
    if (typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
      return;
    }
    updates.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    updates.forcePasswordChange = true;
    updates.sessionVersion = sql`${companyUsers.sessionVersion} + 1`;
  }
  if (name !== undefined) updates.name = String(name).trim();

  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "لا توجد بيانات للتحديث" }); return; }

  // Any status or role change invalidates existing sessions — including
  // reactivation, so cookies issued before deactivation stay dead.
  if (updates.isActive !== undefined || updates.role !== undefined) {
    updates.sessionVersion = sql`${companyUsers.sessionVersion} + 1`;
  }

  const [updated] = await db
    .update(companyUsers)
    .set(updates)
    .where(eq(companyUsers.id, target.id))
    .returning(userColumns());
  res.json({ ok: true, user: updated });
});

// DELETE /api/company/:slug/users/:userId
router.delete("/company/:slug/users/:userId", async (req: Request, res: Response): Promise<void> => {
  const session = await requireUserManager(req, res);
  if (!session) return;
  const target = await loadTargetUser(session, req, res);
  if (!target) return;

  if (target.id === session.userId) {
    res.status(400).json({ error: "لا يمكنك حذف حسابك الخاص" });
    return;
  }

  await db.delete(companyUsers).where(eq(companyUsers.id, target.id));
  res.json({ ok: true });
});

export default router;
