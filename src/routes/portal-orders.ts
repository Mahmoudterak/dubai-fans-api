/**
 * Dubai Fans Portal — Orders
 * POST /api/portal/orders
 * GET  /api/portal/orders
 * GET  /api/portal/orders/:id
 * POST /api/portal/campaigns (campaign wizard)
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { eq, desc, and, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  portalOrders, portalOrderTimeline, portalCampaigns,
  portalPackages, portalWallets, portalWalletTransactions,
  portalSettings, portalServices,
} from "../vendor/db/schema/portal.js";
import { requirePortalUser } from "../lib/portalAuth.js";
import { notifyUser } from "../lib/portalNotify.js";
import { logger } from "../lib/logger.js";
import { validateCampaignPlatforms } from "../lib/campaignPlatformRules.js";

const router = Router();

// ── POST /api/portal/orders — create order + deduct wallet ───────────────────
const OrderSchema = z.object({
  packageId:   z.number().int().positive(),
  notes:       z.string().max(2000).optional(),
  serviceData: z.record(z.string(), z.unknown()).optional(),
  source:      z.enum(["website", "mobile_app"]).optional().default("website"),
});

router.post("/portal/orders", requirePortalUser, async (req: Request, res: Response): Promise<void> => {
  const parsed = OrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "بيانات غير صالحة." } });
    return;
  }
  const user = (req as any).portalUser;
  const { packageId, notes, serviceData, source } = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const [packageRecord] = await tx.select({
        pkg: portalPackages,
        serviceCategory: portalServices.category,
      }).from(portalPackages)
        .innerJoin(portalServices, eq(portalServices.id, portalPackages.serviceId))
        .where(and(
          eq(portalPackages.id, packageId),
          eq(portalPackages.isActive, true),
          eq(portalServices.isActive, true),
        )).limit(1);
      if (!packageRecord) return { type: "package_not_found" as const };
      const { pkg, serviceCategory } = packageRecord;

      if (serviceCategory === "advertising") {
        const validationError = validateCampaignPlatforms(pkg.price, serviceData?.platforms);
        if (validationError) return { type: "invalid_campaign_platforms" as const, message: validationError };
      }

      const settingsRows = await tx.select().from(portalSettings);
      const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
      const vatEnabled = settings["vat_enabled"] === "true";
      const vatRate = parseFloat(settings["vat_rate"] ?? "5.00");
      const subtotal = parseFloat(pkg.price);
      const vatAmount = vatEnabled ? Math.round(subtotal * vatRate / 100 * 100) / 100 : 0;
      const total = subtotal + vatAmount;

      // Lock the wallet row for this user until the order and debit commit.
      const [wallet] = await tx.select().from(portalWallets)
        .where(eq(portalWallets.userId, user.id)).for("update").limit(1);
      if (!wallet) return { type: "no_wallet" as const };

      const balance = parseFloat(wallet.balance);
      if (balance < total) {
        return { type: "insufficient_balance" as const, balance, total };
      }

      const [order] = await tx.insert(portalOrders).values({
        userId: user.id,
        serviceId: pkg.serviceId,
        packageId: pkg.id,
        status: "new",
        subtotal: subtotal.toFixed(2),
        vatRate: (vatEnabled ? vatRate : 0).toFixed(2),
        vatAmount: vatAmount.toFixed(2),
        total: total.toFixed(2),
        notes,
        serviceData,
        source,
      }).returning();

      const [walletTx] = await tx.insert(portalWalletTransactions).values({
        userId: user.id,
        walletId: wallet.id,
        amount: total.toFixed(2),
        type: "debit",
        description: `طلب #${order.id}`,
        orderId: order.id,
        reference: `order_${order.id}`,
      }).returning();

      const balanceAfter = balance - total;
      await tx.update(portalWallets)
        .set({ balance: balanceAfter.toFixed(2), updatedAt: new Date() })
        .where(eq(portalWallets.id, wallet.id));
      await tx.update(portalOrders).set({ walletTxId: walletTx.id, updatedAt: new Date() })
        .where(eq(portalOrders.id, order.id));
      await tx.insert(portalOrderTimeline).values({
        orderId: order.id, status: "new", note: "تم استلام الطلب", createdBy: "system",
      });

      return { type: "created" as const, order, total, balanceAfter };
    });

    if (result.type === "package_not_found") {
      res.status(404).json({ success: false, error: { code: "PACKAGE_NOT_FOUND", message: "الباقة غير موجودة." } });
      return;
    }
    if (result.type === "no_wallet") {
      res.status(400).json({ success: false, error: { code: "NO_WALLET", message: "المحفظة غير موجودة." } });
      return;
    }
    if (result.type === "invalid_campaign_platforms") {
      res.status(400).json({ success: false, error: { code: "INVALID_CAMPAIGN_PLATFORMS", message: result.message } });
      return;
    }
    if (result.type === "insufficient_balance") {
      res.status(402).json({
        success: false,
        error: {
          code: "INSUFFICIENT_BALANCE",
          message: `رصيد المحفظة غير كافٍ. الرصيد الحالي: ${result.balance.toFixed(2)} درهم، المطلوب: ${result.total.toFixed(2)} درهم.`,
          data: { balance: result.balance, required: result.total },
        },
      });
      return;
    }

    try {
      await notifyUser({
        userId: user.id,
        title: "تم استلام طلبك",
        body: `تم استلام طلبك #${result.order.id} بنجاح. سيقوم فريقنا بمراجعته قريباً.`,
        type: "success",
        orderId: result.order.id,
      });
    } catch (notificationError) {
      logger.error({ err: notificationError, orderId: result.order.id }, "portal order notification error");
    }

    res.status(201).json({ success: true, data: { orderId: result.order.id, total: result.total, balance: result.balanceAfter } });
  } catch (err) {
    logger.error({ err }, "portal create order error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "فشل إنشاء الطلب." } });
  }
});

// ── GET /api/portal/orders — paginated list ──────────────────────────────────
router.get("/portal/orders", requirePortalUser, async (req: Request, res: Response): Promise<void> => {
  const user   = (req as any).portalUser;
  const page   = Math.max(1, parseInt(req.query.page as string || "1", 10));
  const limit  = Math.min(50, parseInt(req.query.limit as string || "20", 10));
  const offset = (page - 1) * limit;

  try {
    const [orders, [{ count }]] = await Promise.all([
      db.select().from(portalOrders)
        .where(eq(portalOrders.userId, user.id))
        .orderBy(desc(portalOrders.createdAt))
        .limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(portalOrders)
        .where(eq(portalOrders.userId, user.id)),
    ]);
    res.json({ success: true, data: orders, meta: { page, limit, total: count, pages: Math.ceil(count / limit) } });
  } catch (err) {
    logger.error({ err }, "portal orders list error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// ── GET /api/portal/orders/:id — detail with timeline ────────────────────────
router.get("/portal/orders/:id", requirePortalUser, async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).portalUser;
  const id   = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }

  try {
    const [order] = await db.select().from(portalOrders)
      .where(and(eq(portalOrders.id, id), eq(portalOrders.userId, user.id))).limit(1);
    if (!order) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }

    const [timeline, campaign] = await Promise.all([
      db.select().from(portalOrderTimeline).where(eq(portalOrderTimeline.orderId, id))
        .orderBy(desc(portalOrderTimeline.createdAt)),
      db.select().from(portalCampaigns).where(eq(portalCampaigns.orderId, id)).limit(1),
    ]);

    res.json({ success: true, data: { ...order, timeline, campaign: campaign[0] ?? null } });
  } catch (err) {
    logger.error({ err }, "portal order detail error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// ── POST /api/portal/campaigns — save campaign wizard data ───────────────────
const CampaignSchema = z.object({
  orderId:          z.number().int().positive(),
  platforms:        z.array(z.string()).min(1).max(5),
  businessName:     z.string().max(200).optional(),
  businessCategory: z.string().max(100).optional(),
  country:          z.string().max(60).optional(),
  city:             z.string().max(100).optional(),
  targetAudience:   z.string().max(500).optional(),
  ageRangeMin:      z.number().int().min(13).max(65).optional(),
  ageRangeMax:      z.number().int().min(13).max(65).optional(),
  gender:           z.enum(["all", "male", "female"]).optional(),
  objective:        z.string().optional(),
  platformDetails:  z.record(z.unknown()).optional(),
  adHeadline:       z.string().max(255).optional(),
  adPrimaryText:    z.string().max(2000).optional(),
  adCta:            z.string().max(100).optional(),
  landingPageUrl:   z.string().max(500).optional(),
  waCountry:        z.string().max(10).optional(),
  waNumber:         z.string().max(20).optional(),
  durationDays:     z.number().int().min(1).optional(),
  startDate:        z.string().optional(),
  endDate:          z.string().optional(),
});

router.post("/portal/campaigns", requirePortalUser, async (req: Request, res: Response): Promise<void> => {
  const parsed = CampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "بيانات غير صالحة." } });
    return;
  }
  const user = (req as any).portalUser;
  const { orderId, startDate, endDate, ...rest } = parsed.data;

  // Verify order belongs to this user
  const [order] = await db.select({
    id: portalOrders.id,
    packagePrice: portalPackages.price,
    serviceCategory: portalServices.category,
  }).from(portalOrders)
    .innerJoin(portalPackages, eq(portalPackages.id, portalOrders.packageId))
    .innerJoin(portalServices, eq(portalServices.id, portalPackages.serviceId))
    .where(and(eq(portalOrders.id, orderId), eq(portalOrders.userId, user.id))).limit(1);
  if (!order) {
    res.status(404).json({ success: false, error: { code: "ORDER_NOT_FOUND" } });
    return;
  }
  if (order.serviceCategory === "advertising") {
    const validationError = validateCampaignPlatforms(order.packagePrice, rest.platforms);
    if (validationError) {
      res.status(400).json({ success: false, error: { code: "INVALID_CAMPAIGN_PLATFORMS", message: validationError } });
      return;
    }
  }

  try {
    const [campaign] = await db.insert(portalCampaigns).values({
      orderId,
      userId:    user.id,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate:   endDate   ? new Date(endDate)   : undefined,
      ...rest,
    }).onConflictDoUpdate({
      target: portalCampaigns.orderId,
      set:    { ...rest, startDate: startDate ? new Date(startDate) : undefined, endDate: endDate ? new Date(endDate) : undefined, updatedAt: new Date() },
    }).returning();

    res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    logger.error({ err }, "portal save campaign error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "فشل حفظ بيانات الحملة." } });
  }
});

export default router;
