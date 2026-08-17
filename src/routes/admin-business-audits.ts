/**
 * Admin: AI Business Audit requests (طلبات تحليل النشاط التجاري)
 *
 * All routes require the admin session cookie (df_admin_session).
 *
 *   GET   /api/admin/business-audits       — list all audit leads (newest first)
 *   GET   /api/admin/business-audits/:id   — full row including the AI report
 *   PATCH /api/admin/business-audits/:id   — update lead status
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, businessAudits } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { requirePortalAdmin } from "../lib/portalAuth.js";

function checkCsrf(req: Request, res: Response): boolean {
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ error: "طلب غير مصرّح به" });
    return false;
  }
  return true;
}

const VALID_STATUSES = ["new", "contacted", "interested", "not_interested"] as const;

const router: IRouter = Router();

// ── GET /api/admin/business-audits ────────────────────────────────────────────
router.get("/admin/business-audits", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const audits = await db.select({
      id:           businessAudits.id,
      name:         businessAudits.name,
      email:        businessAudits.email,
      phone:        businessAudits.phone,
      companyName:  businessAudits.companyName,
      businessType: businessAudits.businessType,
      country:      businessAudits.country,
      city:         businessAudits.city,
      targets:      businessAudits.targets,
      status:       businessAudits.status,
      createdAt:    businessAudits.createdAt,
    }).from(businessAudits).orderBy(desc(businessAudits.createdAt));
    res.json({ audits });
  } catch (err) {
    logger.error({ err }, "[admin-business-audits] list error");
    res.status(500).json({ error: "حدث خطأ أثناء جلب الطلبات" });
  }
});

// ── GET /api/admin/business-audits/:id ────────────────────────────────────────
router.get("/admin/business-audits/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "معرّف غير صحيح" });
      return;
    }
    const [audit] = await db.select().from(businessAudits).where(eq(businessAudits.id, id)).limit(1);
    if (!audit) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }
    res.json({ audit });
  } catch (err) {
    logger.error({ err }, "[admin-business-audits] get error");
    res.status(500).json({ error: "حدث خطأ أثناء جلب الطلب" });
  }
});

// ── PATCH /api/admin/business-audits/:id ──────────────────────────────────────
router.patch("/admin/business-audits/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  if (!checkCsrf(req, res)) return;
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
    const [updated] = await db.update(businessAudits)
      .set({ status })
      .where(eq(businessAudits.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }
    res.json({ audit: updated });
  } catch (err) {
    logger.error({ err }, "[admin-business-audits] update error");
    res.status(500).json({ error: "حدث خطأ أثناء تحديث الطلب" });
  }
});

export default router;
