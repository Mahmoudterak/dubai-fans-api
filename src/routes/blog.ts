/**
 * Blog post routes.
 *
 * Public:
 *   GET  /api/blog/posts            — list all posts (newest first)
 *   GET  /api/blog/posts/:id        — single post by slug id
 *
 * Admin UI (cookie-based session, never exposes ADMIN_PASSWORD to the client):
 *   POST   /api/admin/verify         — validates password, issues HttpOnly session cookie
 *   GET    /api/admin/session        — returns 200 if the session cookie is valid, else 401
 *   POST   /api/admin/logout         — clears the session cookie
 *   POST   /api/admin/blog/posts     — create / upsert a post  (requires session cookie)
 *   DELETE /api/admin/blog/posts/:id — delete a post           (requires session cookie)
 *
 * Server-to-server (protected by SESSION_SECRET, never touches the browser):
 *   POST /api/blog/posts             — create / upsert a post (webhook / CI use)
 */
import { createHmac, timingSafeEqual } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { blogPosts, insertBlogPostSchema } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { rebuildSitemap } from "../lib/sitemap.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const SESSION_COOKIE = "df_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ── Session token helpers ──────────────────────────────────────────────────────

function issueToken(adminPassword: string): string {
  const expires = (Date.now() + SESSION_TTL_MS).toString(16);
  const sig = createHmac("sha256", adminPassword).update(expires).digest("hex");
  return `${expires}.${sig}`;
}

function validateToken(token: string, adminPassword: string): boolean {
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const expires = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (parseInt(expires, 16) < Date.now()) return false;
  const expected = createHmac("sha256", adminPassword).update(expires).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function setSessionCookie(res: Response, token: string) {
  // In Replit, the preview pane is an iframe hosted on replit.com while the
  // app lives on *.replit.dev — browsers treat this as cross-site, so
  // SameSite=Strict/Lax cookies are silently dropped. Use SameSite=None
  // (requires Secure) whenever running inside a Replit environment.
  // Exception: test mode uses HTTP (supertest) so Secure must be false.
  const inReplit = !!process.env.REPL_ID;
  const isTest   = process.env.NODE_ENV === "test";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: !isTest && (inReplit || process.env.NODE_ENV === "production"),
    sameSite: inReplit ? "none" : "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

// ── Auth middleware helpers ────────────────────────────────────────────────────

function checkAdminSession(req: Request, res: Response): boolean {
  const pwd = process.env.ADMIN_PASSWORD;
  if (!pwd) {
    res.status(503).json({ error: "ADMIN_PASSWORD not configured on the server" });
    return false;
  }
  const token: string | undefined = (req.cookies as Record<string, string>)?.[SESSION_COOKIE];
  if (!token || !validateToken(token, pwd)) {
    res.status(401).json({ status: 401, error: "جلسة منتهية — يرجى تسجيل الدخول من جديد" });
    return false;
  }
  return true;
}

function checkSessionSecret(req: Request, res: Response): boolean {
  const secret = process.env.SESSION_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ status: 401, error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── POST /api/admin/verify ─────────────────────────────────────────────────────
// Validates ADMIN_PASSWORD, issues a short-lived HttpOnly session cookie.
// The raw password never leaves the server after this point.
router.post("/admin/verify", (req: Request, res: Response): void => {
  const pwd = process.env.ADMIN_PASSWORD;
  if (!pwd) {
    res.status(503).json({ error: "ADMIN_PASSWORD not configured on the server" });
    return;
  }
  const { password } = req.body as { password?: string };
  if (!password || password !== pwd) {
    res.status(401).json({ status: 401, error: "كلمة المرور غير صحيحة" });
    return;
  }
  setSessionCookie(res, issueToken(pwd));
  res.json({ ok: true });
});

// ── GET /api/admin/session ─────────────────────────────────────────────────────
// Non-mutating — lets the client re-check an existing session on page load.
router.get("/admin/session", (req: Request, res: Response): void => {
  if (!checkAdminSession(req, res)) return;
  res.json({ ok: true });
});

// ── POST /api/admin/logout ─────────────────────────────────────────────────────
router.post("/admin/logout", (_req: Request, res: Response): void => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// ── GET /api/blog/posts ────────────────────────────────────────────────────────
router.get("/blog/posts", async (_req: Request, res: Response): Promise<void> => {
  try {
    const posts = await db
      .select()
      .from(blogPosts)
      .orderBy(desc(blogPosts.dateISO));
    res.json({ posts });
  } catch (err) {
    logger.error({ err }, "Failed to fetch blog posts");
    res.status(500).json({ error: "فشل في جلب المقالات" });
  }
});

// ── GET /api/blog/posts/:id ────────────────────────────────────────────────────
router.get("/blog/posts/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [post] = await db
      .select()
      .from(blogPosts)
      .where(eq(blogPosts.id, id))
      .limit(1);

    if (!post) {
      res.status(404).json({ error: "المقال غير موجود" });
      return;
    }
    res.json({ post });
  } catch (err) {
    logger.error({ err }, "Failed to fetch blog post");
    res.status(500).json({ error: "فشل في جلب المقال" });
  }
});

// ── POST /api/admin/blog/posts — admin UI ──────────────────────────────────────
// Protected by HttpOnly session cookie (not raw ADMIN_PASSWORD).
router.post("/admin/blog/posts", async (req: Request, res: Response): Promise<void> => {
  if (!checkAdminSession(req, res)) return;

  const parsed = insertBlogPostSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.issues });
    return;
  }

  try {
    const [created] = await db
      .insert(blogPosts)
      .values(parsed.data)
      .onConflictDoUpdate({
        target: blogPosts.id,
        set: {
          category: parsed.data.category,
          image: parsed.data.image,
          title: parsed.data.title,
          excerpt: parsed.data.excerpt,
          date: parsed.data.date,
          dateISO: parsed.data.dateISO,
          readTime: parsed.data.readTime,
          content: parsed.data.content,
        },
      })
      .returning();

    await rebuildSitemap();
    logger.info({ id: created.id }, "Blog post created/updated via admin UI, sitemap rebuilt");
    res.status(201).json({ post: created });
  } catch (err) {
    logger.error({ err }, "Failed to create blog post (admin)");
    res.status(500).json({ error: "فشل في حفظ المقال" });
  }
});

// ── PATCH /api/admin/blog/posts/:id — admin UI ────────────────────────────────
// Update an existing post's content without changing its slug/id.
router.patch("/admin/blog/posts/:id", async (req: Request, res: Response): Promise<void> => {
  if (!checkAdminSession(req, res)) return;

  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Omit `id` so callers cannot mutate the primary-key slug via PATCH.
    const patchSchema = insertBlogPostSchema.omit({ id: true }).partial();
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.issues });
      return;
    }

    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "لا توجد بيانات للتحديث" });
      return;
    }

    const [updated] = await db
      .update(blogPosts)
      .set(updates)
      .where(eq(blogPosts.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "المقال غير موجود" });
      return;
    }

    await rebuildSitemap();
    logger.info({ id }, "Blog post updated via admin UI, sitemap rebuilt");
    res.json({ post: updated });
  } catch (err) {
    logger.error({ err }, "Failed to update blog post (admin)");
    res.status(500).json({ error: "فشل في تحديث المقال" });
  }
});

// ── DELETE /api/admin/blog/posts/:id — admin UI ────────────────────────────────
router.delete("/admin/blog/posts/:id", async (req: Request, res: Response): Promise<void> => {
  if (!checkAdminSession(req, res)) return;

  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [deleted] = await db
      .delete(blogPosts)
      .where(eq(blogPosts.id, id))
      .returning({ id: blogPosts.id });

    if (!deleted) {
      res.status(404).json({ error: "المقال غير موجود" });
      return;
    }

    await rebuildSitemap();
    logger.info({ id }, "Blog post deleted via admin UI, sitemap rebuilt");
    res.json({ status: "deleted", id });
  } catch (err) {
    logger.error({ err }, "Failed to delete blog post");
    res.status(500).json({ error: "فشل في حذف المقال" });
  }
});

// ── POST /api/blog/posts — server-to-server ────────────────────────────────────
// Protected by SESSION_SECRET (never sent to the browser).
router.post("/blog/posts", async (req: Request, res: Response): Promise<void> => {
  if (!checkSessionSecret(req, res)) return;

  const parsed = insertBlogPostSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error.issues });
    return;
  }

  try {
    const [created] = await db
      .insert(blogPosts)
      .values(parsed.data)
      .onConflictDoUpdate({
        target: blogPosts.id,
        set: {
          category: parsed.data.category,
          image: parsed.data.image,
          title: parsed.data.title,
          excerpt: parsed.data.excerpt,
          date: parsed.data.date,
          dateISO: parsed.data.dateISO,
          readTime: parsed.data.readTime,
          content: parsed.data.content,
        },
      })
      .returning();

    await rebuildSitemap();
    logger.info({ id: created.id }, "Blog post created/updated, sitemap rebuilt");
    res.status(201).json({ post: created });
  } catch (err) {
    logger.error({ err }, "Failed to create blog post");
    res.status(500).json({ error: "فشل في حفظ المقال" });
  }
});

export default router;
