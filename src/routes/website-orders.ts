/**
 * Public: AI website orders (عرض "أنشئ موقعك بالذكاء الاصطناعي" — 499 درهم)
 *
 *   POST /api/website-orders — submit a new order from /website-templates
 *
 * CSRF: requires X-Requested-With: fetch (custom request header technique).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, websiteOrders } from "@workspace/db";
import { websiteOrdersLimiter } from "../middlewares/rate-limit";
import { sendWebsiteOrderNotification } from "../lib/mailer";

const router: IRouter = Router();

router.post("/website-orders", websiteOrdersLimiter, async (req: Request, res: Response): Promise<void> => {
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ success: false, error: "طلب غير مصرّح به" });
    return;
  }
  try {
    const { businessName, businessType, email, phone, siteType = "website", details = "" } = req.body ?? {};

    if (!businessName || typeof businessName !== "string" || businessName.trim().length < 2 || businessName.trim().length > 100) {
      res.status(400).json({ success: false, error: "اسم النشاط مطلوب (2–100 حرف)" });
      return;
    }
    if (!businessType || typeof businessType !== "string" || businessType.trim().length < 2 || businessType.trim().length > 100) {
      res.status(400).json({ success: false, error: "نوع النشاط مطلوب" });
      return;
    }
    if (!email || typeof email !== "string" || !email.includes("@") || email.length > 200) {
      res.status(400).json({ success: false, error: "البريد الإلكتروني غير صحيح" });
      return;
    }
    if (!phone || typeof phone !== "string" || phone.trim().length < 7 || phone.trim().length > 30) {
      res.status(400).json({ success: false, error: "رقم الهاتف غير صحيح" });
      return;
    }
    if (siteType !== "website" && siteType !== "store") {
      res.status(400).json({ success: false, error: "نوع الموقع غير صحيح" });
      return;
    }
    if (typeof details !== "string" || details.length > 3000) {
      res.status(400).json({ success: false, error: "تفاصيل الموقع طويلة جداً (الحد 3000 حرف)" });
      return;
    }

    const [saved] = await db.insert(websiteOrders).values({
      businessName: businessName.trim(),
      businessType: businessType.trim(),
      email:        email.trim().toLowerCase(),
      phone:        phone.trim(),
      siteType,
      details:      details.trim(),
    }).returning();

    // Use ctx.waitUntil (attached to req by the CF adapter) so the Resend HTTP
    // fetch is not killed when the Worker response resolves.
    (req as any).waitUntil?.(
      sendWebsiteOrderNotification({
        businessName: saved.businessName,
        businessType: saved.businessType,
        email:        saved.email,
        phone:        saved.phone,
        siteType:     saved.siteType,
        details:      saved.details,
      }).then((delivered) => {
        if (!delivered) {
          console.error(`[website-orders] admin notification NOT delivered for order #${saved.id} — check the dashboard`);
        }
      }),
    );

    res.json({ success: true, id: saved.id });
  } catch (err) {
    console.error("[website-orders] submit error:", err);
    res.status(500).json({ success: false, error: "حدث خطأ — يرجى المحاولة مجدداً" });
  }
});

export default router;
