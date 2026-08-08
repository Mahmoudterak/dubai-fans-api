/**
 * Admin: AI Business OS leads management
 *
 * All routes require the admin session cookie (df_admin_session).
 *
 *   GET   /api/admin/aibos-leads       — list all leads (newest first)
 *   PATCH /api/admin/aibos-leads/:id   — update lead follow-up status
 */
import { createHmac, timingSafeEqual } from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, aibosLeads } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";

// ── Admin session helpers (mirrors course-register.ts) ────────────────────────
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
// require the X-Requested-With header (browsers can't attach it cross-site
// via a plain form POST).
function checkCsrf(req: Request, res: Response): boolean {
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ error: "طلب غير مصرّح به" });
    return false;
  }
  return true;
}

const router: IRouter = Router();

// ── GET /api/admin/aibos-leads ────────────────────────────────────────────────
router.get("/admin/aibos-leads", async (req: Request, res: Response): Promise<void> => {
  if (!checkAdminSession(req, res)) return;

  try {
    const list = await db
      .select()
      .from(aibosLeads)
      .orderBy(desc(aibosLeads.createdAt));

    res.json({ count: list.length, leads: list });
  } catch (err) {
    logger.error({ err }, "Failed to fetch AI Business OS leads (admin)");
    res.status(500).json({ error: "خطأ في جلب البيانات" });
  }
});

// ── PATCH /api/admin/aibos-leads/:id ──────────────────────────────────────────
export const VALID_LEAD_STATUSES = ["new", "contacted", "interested", "not_interested"] as const;

router.patch("/admin/aibos-leads/:id", async (req: Request, res: Response): Promise<void> => {
  if (!checkCsrf(req, res)) return;
  if (!checkAdminSession(req, res)) return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(rawId ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }

  const { status } = req.body as { status?: string };
  if (!status || !(VALID_LEAD_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: `الحالة يجب أن تكون إحدى: ${VALID_LEAD_STATUSES.join(", ")}` });
    return;
  }

  try {
    const [updated] = await db
      .update(aibosLeads)
      .set({ status })
      .where(eq(aibosLeads.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }

    logger.info({ leadId: id, status }, "AI Business OS lead status updated by admin");
    res.json({ ok: true, lead: updated });
  } catch (err) {
    logger.error({ err }, "Failed to update AI Business OS lead status");
    res.status(500).json({ error: "خطأ في تحديث الحالة" });
  }
});

export default router;
