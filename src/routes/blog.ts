/**
 * Blog post routes.
 *
 * Public:
 *   GET  /api/blog/posts            — list all posts (newest first)
 *   GET  /api/blog/posts/:id        — single post by slug id
 *
 * Admin UI (portal_admin_session cookie, via requirePortalAdmin):
 *   POST   /api/admin/blog/posts     — create / upsert a post  (requires portal admin session)
 *   PATCH  /api/admin/blog/posts/:id — update a post           (requires portal admin session)
 *   DELETE /api/admin/blog/posts/:id — delete a post           (requires portal admin session)
 *
 * Server-to-server (protected by SESSION_SECRET, never touches the browser):
 *   POST /api/blog/posts             — create / upsert a post (webhook / CI use)
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { blogPosts, insertBlogPostSchema } from "@workspace/db/schema";
import { requirePortalAdmin } from "../lib/portalAuth.js";
import { eq, desc } from "drizzle-orm";
import { rebuildSitemap } from "../lib/sitemap.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

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
// Protected by portal_admin_session cookie.
router.post("/admin/blog/posts", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
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
router.patch("/admin/blog/posts/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
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
router.delete("/admin/blog/posts/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
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
  const secret = process.env.SESSION_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ status: 401, error: "Unauthorized" });
    return;
  }

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
