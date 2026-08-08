/**
 * Public: Product demo requests from the Products section.
 *
 *   POST /api/demo-requests — submit a demo request for a product
 *
 * CSRF: requires X-Requested-With: fetch (custom request header technique).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, demoRequests } from "@workspace/db";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();

// Lazy wrapper: defer rateLimit() (and its MemoryStore setInterval) to first
// request so it never runs in CF Workers global scope.
import type { RequestHandler } from "express";
function lazyLimit(factory: () => RequestHandler): RequestHandler {
  let h: RequestHandler | null = null;
  return (req, res, next) => { if (!h) h = factory(); h(req, res, next); };
}

const demoRequestsLimiter = lazyLimit(() => rateLimit({
  validate: { creationStack: false },
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: "لقد تجاوزت الحد المسموح به للطلبات. يرجى المحاولة بعد ساعة.",
      retryAfter: 3600,
    });
  },
}));

const VALID_PRODUCTS = ["ai-os", "clinic-os", "amlak-os"] as const;

router.post("/demo-requests", demoRequestsLimiter, async (req: Request, res: Response): Promise<void> => {
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ success: false, error: "طلب غير مصرّح به" });
    return;
  }

  try {
    const { product, name, email, message = "" } = req.body ?? {};

    if (!product || !VALID_PRODUCTS.includes(product)) {
      res.status(400).json({ success: false, error: "المنتج غير صحيح" });
      return;
    }
    if (!name || typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100) {
      res.status(400).json({ success: false, error: "الاسم مطلوب (2–100 حرف)" });
      return;
    }
    if (!email || typeof email !== "string" || !email.includes("@") || email.length > 200) {
      res.status(400).json({ success: false, error: "البريد الإلكتروني غير صحيح" });
      return;
    }
    if (typeof message !== "string" || message.length > 2000) {
      res.status(400).json({ success: false, error: "الرسالة طويلة جداً (الحد 2000 حرف)" });
      return;
    }

    const [saved] = await db.insert(demoRequests).values({
      product,
      name:    name.trim(),
      email:   email.trim().toLowerCase(),
      message: message.trim(),
    }).returning();

    res.json({ success: true, id: saved.id });
  } catch (err) {
    console.error("[demo-requests] submit error:", err);
    res.status(500).json({ success: false, error: "حدث خطأ — يرجى المحاولة مجدداً" });
  }
});

export default router;
