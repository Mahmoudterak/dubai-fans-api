/**
 * Admin: website orders management (عرض 499 درهم)
 *
 * All routes require the admin session cookie (df_admin_session).
 *
 *   GET   /api/admin/website-orders       — list all orders (newest first)
 *   PATCH /api/admin/website-orders/:id   — update order status
 */
import { createHmac, timingSafeEqual } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, websiteOrders } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

// ── Admin session helpers (mirrors admin-aibos-leads.ts) ─────────────────────
const SESSION_COOKIE = "df_admin_session";

function validateToken(token: string, adminPassword: string): boolean {
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const expires = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (parseInt(expires, 16) < Date.now()) return false;
  const expected = createHmac("sha256", adminPassword).update(expires).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch { return false; }
}

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

// CSRF guard: admin cookie uses SameSite=None, so state-changing routes must
// require the X-Requested-With header.
function checkCsrf(req: Request, res: Response): boolean {
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ error: "طلب غير مصرّح به" });
    return false;
  }
  return true;
}

const VALID_STATUSES = ["new", "contacted", "in_progress", "delivered", "cancelled"] as const;

const router: IRouter = Router();

// ── GET /api/admin/website-orders ─────────────────────────────────────────────
router.get("/admin/website-orders", async (req: Request, res: Response): Promise<void> => {
  if (!checkAdminSession(req, res)) return;
  try {
    const orders = await db.select().from(websiteOrders).orderBy(desc(websiteOrders.createdAt));
    res.json({ orders });
  } catch (err) {
    logger.error({ err }, "[admin-website-orders] list error");
    res.status(500).json({ error: "حدث خطأ أثناء جلب الطلبات" });
  }
});

// ── PATCH /api/admin/website-orders/:id ───────────────────────────────────────
router.patch("/admin/website-orders/:id", async (req: Request, res: Response): Promise<void> => {
  if (!checkCsrf(req, res)) return;
  if (!checkAdminSession(req, res)) return;
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "معرّف غير صحيح" });
      return;
    }
    const { status } = req.body ?? {};
    if (typeof status !== "string" || !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      res.status(400).json({ error: "حالة غير صحيحة" });
      return;
    }
    const [updated] = await db.update(websiteOrders)
      .set({ status })
      .where(eq(websiteOrders.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }
    res.json({ order: updated });
  } catch (err) {
    logger.error({ err }, "[admin-website-orders] update error");
    res.status(500).json({ error: "حدث خطأ أثناء تحديث الطلب" });
  }
});

export default router;
