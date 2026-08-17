/**
 * Dubai Fans Portal — Admin API
 * All routes require portal admin session.
 * Prefix: /api/portal/admin/...
 */
import bcrypt from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { eq, desc, asc, and, sql, ne } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  portalUsers, portalProfiles, portalOrders, portalOrderTimeline,
  portalCampaigns, portalWallets, portalWalletTransactions,
  portalTopupRequests, portalNotifications, portalSupportTickets,
  portalSupportMessages, portalServices, portalPackages,
  portalSettings, portalAuditLogs, portalAdminUsers,
  portalFiles, portalCampaignReports,
} from "../vendor/db/schema/portal.js";
import {
  requirePortalAdmin, issueAdminToken, setAdminCookie,
  PORTAL_ADMIN_SESSION_COOKIE,
} from "../lib/portalAuth.js";
import { requireRole } from "../middleware/roleCheck.js";
import { notifyUser } from "../lib/portalNotify.js";
import { auditLog } from "../lib/portalAudit.js";
import { logger } from "../lib/logger.js";
import rateLimit from "express-rate-limit";

const router = Router();
const BCRYPT_ROUNDS = 10;

const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === "test",
});

function admin(req: Request) { return (req as any).portalAdmin; }
function numId(req: Request, param = "id") {
  const n = parseInt(req.params[param], 10);
  return isNaN(n) ? null : n;
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/portal/admin/auth/login
router.post("/portal/admin/auth/login", adminAuthLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({ email: z.email(), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const { email, password } = parsed.data;
  try {
    const [adm] = await db.select().from(portalAdminUsers)
      .where(eq(portalAdminUsers.email, email.toLowerCase())).limit(1);
    if (!adm || !adm.isActive) {
      res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
      return;
    }
    const valid = await bcrypt.compare(password, adm.passwordHash);
    if (!valid) {
      res.status(401).json({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
      return;
    }
    const [updated] = await db.update(portalAdminUsers)
      .set({ sessionVersion: adm.sessionVersion + 1, updatedAt: new Date() })
      .where(eq(portalAdminUsers.id, adm.id)).returning();
    const token = issueAdminToken(adm.id, updated.sessionVersion);
    setAdminCookie(res, token);
    res.json({ success: true, data: { id: adm.id, fullName: adm.fullName, email: adm.email, role: adm.role } });
  } catch (err) {
    logger.error({ err }, "portal admin login error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// POST /api/portal/admin/auth/logout
router.post("/portal/admin/auth/logout", async (req: Request, res: Response): Promise<void> => {
  res.clearCookie(PORTAL_ADMIN_SESSION_COOKIE, { path: "/" });
  res.json({ success: true });
});

// GET /api/portal/admin/auth/me
router.get("/portal/admin/auth/me", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const adm = admin(req);
  res.json({ success: true, data: { id: adm.id, fullName: adm.fullName, email: adm.email, role: adm.role } });
});

// ══════════════════════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/stats", requirePortalAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const [
      [{ totalCustomers }], [{ activeOrders }], [{ pendingTopups }],
      [{ totalWallet }], [{ newCustomers }],
    ] = await Promise.all([
      db.select({ totalCustomers: sql<number>`count(*)::int` }).from(portalUsers),
      db.select({ activeOrders: sql<number>`count(*)::int` }).from(portalOrders)
        .where(ne(portalOrders.status, "completed")),
      db.select({ pendingTopups: sql<number>`count(*)::int` }).from(portalTopupRequests)
        .where(eq(portalTopupRequests.status, "pending")),
      db.select({ totalWallet: sql<string>`coalesce(sum(balance)::text,'0')` }).from(portalWallets),
      db.select({ newCustomers: sql<number>`count(*)::int` }).from(portalUsers)
        .where(sql`created_at >= now() - interval '7 days'`),
    ]);
    res.json({ success: true, data: { totalCustomers, activeOrders, pendingTopups, totalWallet, newCustomers } });
  } catch (err) {
    logger.error({ err }, "portal admin stats error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/customers", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(req.query.page as string || "1", 10));
  const limit = Math.min(100, parseInt(req.query.limit as string || "20", 10));
  const offset = (page - 1) * limit;
  try {
    const [customers, [{ total }]] = await Promise.all([
      db.select({ id: portalUsers.id, fullName: portalUsers.fullName, email: portalUsers.email,
        mobile: portalUsers.mobile, country: portalUsers.country, isActive: portalUsers.isActive,
        createdAt: portalUsers.createdAt })
        .from(portalUsers).orderBy(desc(portalUsers.createdAt)).limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(portalUsers),
    ]);
    res.json({ success: true, data: customers, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error({ err }, "portal admin customers error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

router.get("/portal/admin/customers/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req);
  if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  try {
    const [[user], [profile], [wallet], orders] = await Promise.all([
      db.select().from(portalUsers).where(eq(portalUsers.id, id)).limit(1),
      db.select().from(portalProfiles).where(eq(portalProfiles.userId, id)).limit(1),
      db.select().from(portalWallets).where(eq(portalWallets.userId, id)).limit(1),
      db.select().from(portalOrders).where(eq(portalOrders.userId, id))
        .orderBy(desc(portalOrders.createdAt)).limit(20),
    ]);
    if (!user) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }
    res.json({ success: true, data: { user: { ...user, passwordHash: undefined }, profile: profile ?? null, wallet: wallet ?? null, orders } });
  } catch (err) {
    logger.error({ err }, "portal admin customer detail error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/orders", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const page   = Math.max(1, parseInt(req.query.page as string || "1", 10));
  const limit  = Math.min(100, parseInt(req.query.limit as string || "20", 10));
  const offset = (page - 1) * limit;
  try {
    const [orders, [{ total }]] = await Promise.all([
      db.select().from(portalOrders).orderBy(desc(portalOrders.createdAt)).limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(portalOrders),
    ]);
    res.json({ success: true, data: orders, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error({ err }, "portal admin orders error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

router.get("/portal/admin/orders/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req);
  if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  try {
    const [[order], timeline, [campaign], files] = await Promise.all([
      db.select().from(portalOrders).where(eq(portalOrders.id, id)).limit(1),
      db.select().from(portalOrderTimeline).where(eq(portalOrderTimeline.orderId, id))
        .orderBy(asc(portalOrderTimeline.createdAt)),
      db.select().from(portalCampaigns).where(eq(portalCampaigns.orderId, id)).limit(1),
      db.select().from(portalFiles).where(eq(portalFiles.orderId, id))
        .orderBy(desc(portalFiles.createdAt)),
    ]);
    if (!order) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }
    res.json({ success: true, data: { ...order, timeline, campaign: campaign ?? null, files } });
  } catch (err) {
    logger.error({ err }, "portal admin order detail error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// PATCH /api/portal/admin/orders/:id/status
router.patch("/portal/admin/orders/:id/status", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id  = numId(req);
  if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  const parsed = z.object({
    status: z.enum(["new","under_review","waiting_customer","ready_to_start","in_progress","waiting_approval","active","completed","cancelled"]),
    note:   z.string().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    const [order] = await db.select().from(portalOrders).where(eq(portalOrders.id, id)).limit(1);
    if (!order) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }

    await db.update(portalOrders).set({ status: parsed.data.status, updatedAt: new Date() })
      .where(eq(portalOrders.id, id));

    await db.insert(portalOrderTimeline).values({
      orderId: id, status: parsed.data.status, note: parsed.data.note, createdBy: adm.email,
    });

    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "order.status_changed",
      entity: "order", entityId: id,
      description: `Order #${id} status changed to ${parsed.data.status}`,
      metadata: { from: order.status, to: parsed.data.status } });

    const statusLabels: Record<string, string> = {
      under_review: "جاري مراجعة طلبك",
      ready_to_start: "طلبك جاهز للتنفيذ",
      in_progress: "بدأ فريقنا تنفيذ طلبك",
      active: "تم إطلاق خدمتك",
      completed: "تم اكتمال طلبك",
      cancelled: "تم إلغاء الطلب",
    };
    const label = statusLabels[parsed.data.status];
    if (label) {
      await notifyUser({ userId: order.userId, title: label,
        body: parsed.data.note ?? `تم تحديث حالة طلبك #${id} إلى: ${label}`,
        type: parsed.data.status === "completed" ? "success" : "info", orderId: id });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "portal admin order status error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// PATCH /api/portal/admin/orders/:id/note
router.patch("/portal/admin/orders/:id/note", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req);
  if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  const parsed = z.object({ internalNotes: z.string().max(5000) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  try {
    await db.update(portalOrders).set({ internalNotes: parsed.data.internalNotes, updatedAt: new Date() })
      .where(eq(portalOrders.id, id));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "portal admin order note error");
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SERVICES & PACKAGES CRUD
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/services", requirePortalAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const services = await db.select().from(portalServices).orderBy(asc(portalServices.sortOrder));
    res.json({ success: true, data: services });
  } catch (err) {
    logger.error({ err }, "admin services list"); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
  }
});

const ServiceSchema = z.object({
  nameAr: z.string().min(1).max(200), nameEn: z.string().min(1).max(200),
  descriptionAr: z.string().max(2000).optional(), descriptionEn: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(), category: z.string().max(100).optional(),
  isActive: z.boolean().optional(), sortOrder: z.number().int().optional(),
});

router.post("/portal/admin/services", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = ServiceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    const [svc] = await db.insert(portalServices).values(parsed.data).returning();
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "service.created", entity: "service", entityId: svc.id, description: `Service created: ${svc.nameEn}` });
    res.status(201).json({ success: true, data: svc });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

router.put("/portal/admin/services/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req); if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  const parsed = ServiceSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    await db.update(portalServices).set(parsed.data).where(eq(portalServices.id, id));
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "service.updated", entity: "service", entityId: id, description: `Service #${id} updated` });
    res.json({ success: true });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

router.get("/portal/admin/packages", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const serviceId = req.query.serviceId ? parseInt(req.query.serviceId as string, 10) : undefined;
  try {
    const query = db.select().from(portalPackages).orderBy(asc(portalPackages.sortOrder));
    const packages = serviceId
      ? await db.select().from(portalPackages).where(eq(portalPackages.serviceId, serviceId)).orderBy(asc(portalPackages.sortOrder))
      : await query;
    res.json({ success: true, data: packages });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

const PackageSchema = z.object({
  serviceId: z.number().int().positive(),
  nameAr: z.string().min(1).max(200), nameEn: z.string().min(1).max(200),
  descriptionAr: z.string().max(2000).optional(), descriptionEn: z.string().max(2000).optional(),
  price: z.number().min(0), currency: z.string().max(10).optional(),
  billingType: z.enum(["one_time","monthly","yearly"]).optional(),
  duration: z.string().max(100).optional(),
  features: z.array(z.string()).optional(),
  isActive: z.boolean().optional(), sortOrder: z.number().int().optional(),
});

router.post("/portal/admin/packages", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = PackageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message } }); return; }
  const adm = admin(req);
  try {
    const { price, features, ...rest } = parsed.data;
    const [pkg] = await db.insert(portalPackages).values({ ...rest, price: price.toFixed(2), features: features ?? [] }).returning();
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "package.created", entity: "package", entityId: pkg.id, description: `Package created: ${pkg.nameEn} (${pkg.price} AED)` });
    res.status(201).json({ success: true, data: pkg });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

router.put("/portal/admin/packages/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req); if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  const parsed = PackageSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message } }); return; }
  const adm = admin(req);
  try {
    const [old] = await db.select({ price: portalPackages.price }).from(portalPackages).where(eq(portalPackages.id, id)).limit(1);
    const { price, features, ...rest } = parsed.data;
    const updateData: Record<string, unknown> = { ...rest };
    if (price !== undefined) updateData.price = price.toFixed(2);
    if (features !== undefined) updateData.features = features;
    await db.update(portalPackages).set(updateData).where(eq(portalPackages.id, id));
    if (price !== undefined && old && old.price !== price.toFixed(2)) {
      await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "package.price_changed", entity: "package", entityId: id,
        description: `Package #${id} price changed from ${old.price} to ${price.toFixed(2)} AED`,
        metadata: { oldPrice: old.price, newPrice: price.toFixed(2) } });
    }
    res.json({ success: true });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// WALLETS & TOP-UPS
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/wallets", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(req.query.page as string || "1", 10));
  const limit = Math.min(100, parseInt(req.query.limit as string || "20", 10));
  const offset = (page - 1) * limit;
  try {
    const wallets = await db.select({
      id: portalWallets.id, userId: portalWallets.userId, balance: portalWallets.balance,
      currency: portalWallets.currency, updatedAt: portalWallets.updatedAt,
      userName: portalUsers.fullName, userEmail: portalUsers.email,
    }).from(portalWallets)
      .leftJoin(portalUsers, eq(portalWallets.userId, portalUsers.id))
      .orderBy(desc(portalWallets.updatedAt)).limit(limit).offset(offset);
    res.json({ success: true, data: wallets });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// Manual wallet adjustment
router.post("/portal/admin/wallets/:userId/adjust", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const userId = numId(req, "userId"); if (!userId) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  const parsed = z.object({
    amount: z.number().positive(),
    type: z.enum(["credit","debit","adjustment","refund"]),
    description: z.string().min(5).max(500),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message } }); return; }
  const adm = admin(req);
  try {
    const [wallet] = await db.select().from(portalWallets).where(eq(portalWallets.userId, userId)).limit(1);
    if (!wallet) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }
    const { amount, type, description } = parsed.data;
    const current = parseFloat(wallet.balance);
    const isDebit = type === "debit";
    if (isDebit && current < amount) {
      res.status(400).json({ success: false, error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance for debit." } });
      return;
    }
    const newBalance = isDebit ? current - amount : current + amount;
    await db.update(portalWallets).set({ balance: newBalance.toFixed(2), updatedAt: new Date() })
      .where(eq(portalWallets.id, wallet.id));
    await db.insert(portalWalletTransactions).values({
      userId, walletId: wallet.id, amount: amount.toFixed(2), type, description, reference: `admin_adj_${Date.now()}`,
    });
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: `wallet.${type}`, entity: "wallet", entityId: wallet.id,
      description: `Wallet ${type}: ${amount} AED — ${description}`,
      metadata: { userId, oldBalance: current, newBalance } });
    res.json({ success: true, data: { newBalance } });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// List top-up requests
router.get("/portal/admin/topups", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const status = req.query.status as string | undefined;
  try {
    const topups = await db.select({
      id: portalTopupRequests.id, userId: portalTopupRequests.userId,
      amount: portalTopupRequests.amount, paymentMethod: portalTopupRequests.paymentMethod,
      reference: portalTopupRequests.reference, proofFileUrl: portalTopupRequests.proofFileUrl,
      status: portalTopupRequests.status, adminNote: portalTopupRequests.adminNote,
      createdAt: portalTopupRequests.createdAt,
      userName: portalUsers.fullName, userEmail: portalUsers.email,
    }).from(portalTopupRequests)
      .leftJoin(portalUsers, eq(portalTopupRequests.userId, portalUsers.id))
      .where(status ? eq(portalTopupRequests.status, status as any) : sql`true`)
      .orderBy(desc(portalTopupRequests.createdAt)).limit(100);
    res.json({ success: true, data: topups });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// Approve / reject top-up
router.patch("/portal/admin/topups/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req); if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  const parsed = z.object({
    action: z.enum(["approve","reject"]),
    adminNote: z.string().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    const [topup] = await db.select().from(portalTopupRequests)
      .where(and(eq(portalTopupRequests.id, id), eq(portalTopupRequests.status, "pending"))).limit(1);
    if (!topup) { res.status(404).json({ success: false, error: { code: "NOT_FOUND_OR_ALREADY_PROCESSED" } }); return; }

    const newStatus = parsed.data.action === "approve" ? "approved" : "rejected";
    await db.update(portalTopupRequests).set({
      status: newStatus, adminNote: parsed.data.adminNote, reviewedBy: adm.id, reviewedAt: new Date(),
    }).where(eq(portalTopupRequests.id, id));

    if (parsed.data.action === "approve") {
      const [wallet] = await db.select().from(portalWallets)
        .where(eq(portalWallets.userId, topup.userId)).limit(1);
      if (wallet) {
        const newBalance = (parseFloat(wallet.balance) + parseFloat(topup.amount)).toFixed(2);
        await db.update(portalWallets).set({ balance: newBalance, updatedAt: new Date() })
          .where(eq(portalWallets.id, wallet.id));
        await db.insert(portalWalletTransactions).values({
          userId: topup.userId, walletId: wallet.id, amount: topup.amount,
          type: "credit", description: "شحن رصيد معتمد", reference: `topup_${id}`,
        });
        await notifyUser({ userId: topup.userId, title: "تم اعتماد شحن رصيدك",
          body: `تمت إضافة ${topup.amount} درهم إلى محفظتك بنجاح.`, type: "success" });
      }
    } else {
      await notifyUser({ userId: topup.userId, title: "طلب شحن الرصيد",
        body: parsed.data.adminNote ? `تم رفض طلب الشحن: ${parsed.data.adminNote}` : "تم رفض طلب شحن الرصيد.",
        type: "warning" });
    }

    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: `topup.${newStatus}`, entity: "topup", entityId: id,
      description: `Top-up #${id} ${newStatus}: ${topup.amount} AED`, metadata: { userId: topup.userId } });
    res.json({ success: true });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS (admin broadcast)
// ══════════════════════════════════════════════════════════════════════════════

router.post("/portal/admin/notifications/send", requirePortalAdmin, requireRole("super_admin", "manager"), async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({
    userId: z.number().int().positive().optional(), // omit for broadcast
    title:  z.string().min(1).max(200),
    body:   z.string().min(1).max(2000),
    type:   z.enum(["info","success","warning","action_required"]).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    if (parsed.data.userId) {
      await notifyUser({ userId: parsed.data.userId, title: parsed.data.title, body: parsed.data.body, type: parsed.data.type });
      res.json({ success: true, data: { sent: 1 } });
    } else {
      // Broadcast to all active customers
      const users = await db.select({ id: portalUsers.id }).from(portalUsers)
        .where(eq(portalUsers.isActive, true));
      await Promise.all(users.map(u => notifyUser({ userId: u.id, title: parsed.data.title, body: parsed.data.body, type: parsed.data.type })));
      res.json({ success: true, data: { sent: users.length } });
    }
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "notification.sent", entity: "notification",
      description: `Notification sent: ${parsed.data.title}`, metadata: { userId: parsed.data.userId } });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPPORT TICKETS (admin)
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/support/tickets", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const status = req.query.status as string | undefined;
  try {
    const tickets = await db.select({
      id: portalSupportTickets.id, subject: portalSupportTickets.subject,
      status: portalSupportTickets.status, orderId: portalSupportTickets.orderId,
      userId: portalSupportTickets.userId, createdAt: portalSupportTickets.createdAt,
      userName: portalUsers.fullName, userEmail: portalUsers.email,
    }).from(portalSupportTickets)
      .leftJoin(portalUsers, eq(portalSupportTickets.userId, portalUsers.id))
      .where(status ? eq(portalSupportTickets.status, status as any) : sql`true`)
      .orderBy(desc(portalSupportTickets.createdAt)).limit(100);
    res.json({ success: true, data: tickets });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

router.get("/portal/admin/support/tickets/:id", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req); if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  try {
    const [[ticket], messages] = await Promise.all([
      db.select().from(portalSupportTickets).where(eq(portalSupportTickets.id, id)).limit(1),
      db.select().from(portalSupportMessages).where(eq(portalSupportMessages.ticketId, id))
        .orderBy(asc(portalSupportMessages.createdAt)),
    ]);
    if (!ticket) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }
    res.json({ success: true, data: { ...ticket, messages } });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

router.post("/portal/admin/support/tickets/:id/reply", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const id = numId(req); if (!id) { res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return; }
  const parsed = z.object({ body: z.string().min(1).max(5000), status: z.enum(["in_progress","waiting_customer","resolved","closed"]).optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    const [ticket] = await db.select().from(portalSupportTickets).where(eq(portalSupportTickets.id, id)).limit(1);
    if (!ticket) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }
    await db.insert(portalSupportMessages).values({ ticketId: id, senderType: "admin", senderId: adm.id, body: parsed.data.body });
    if (parsed.data.status) {
      await db.update(portalSupportTickets).set({ status: parsed.data.status, updatedAt: new Date() }).where(eq(portalSupportTickets.id, id));
    }
    await notifyUser({ userId: ticket.userId, title: "رد جديد على تذكرتك", body: `رد فريق الدعم على تذكرتك: ${ticket.subject}`, type: "info" });
    res.json({ success: true });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// CAMPAIGN REPORTS (admin enters metrics)
// ══════════════════════════════════════════════════════════════════════════════

router.post("/portal/admin/campaign-reports", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({
    campaignId: z.number().int().positive(), orderId: z.number().int().positive(), userId: z.number().int().positive(),
    periodStart: z.string().optional(), periodEnd: z.string().optional(),
    reach: z.number().int().optional(), impressions: z.number().int().optional(),
    clicks: z.number().int().optional(), messages: z.number().int().optional(), leads: z.number().int().optional(),
    spend: z.number().optional(), cpm: z.number().optional(), cpl: z.number().optional(),
    ctr: z.number().optional(), roas: z.number().optional(), notes: z.string().max(5000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    const { spend, cpm, cpl, ctr, roas, ...rest } = parsed.data;
    const [report] = await db.insert(portalCampaignReports).values({
      ...rest,
      spend: spend?.toFixed(2), cpm: cpm?.toFixed(2), cpl: cpl?.toFixed(2),
      ctr: ctr?.toFixed(4), roas: roas?.toFixed(2),
    }).returning();
    await notifyUser({ userId: parsed.data.userId, title: "تم تحديث تقرير حملتك",
      body: "تم نشر تقرير الأداء الجديد لحملتك الإعلانية. راجع التقرير من طلباتك.",
      type: "info", orderId: parsed.data.orderId });
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "campaign_report.created", entity: "campaign_report", entityId: report.id,
      description: `Campaign report created for order #${parsed.data.orderId}` });
    res.status(201).json({ success: true, data: report });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/settings", requirePortalAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db.select().from(portalSettings);
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({ success: true, data: map });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

router.put("/portal/admin/settings", requirePortalAdmin, requireRole("super_admin", "manager"), async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({
    vat_enabled: z.boolean().optional(),
    vat_rate:    z.number().min(0).max(100).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR" } }); return; }
  const adm = admin(req);
  try {
    const updates: Array<{ key: string; value: string }> = [];
    if (parsed.data.vat_enabled !== undefined)
      updates.push({ key: "vat_enabled", value: String(parsed.data.vat_enabled) });
    if (parsed.data.vat_rate !== undefined)
      updates.push({ key: "vat_rate", value: parsed.data.vat_rate.toFixed(2) });
    for (const u of updates) {
      await db.insert(portalSettings).values({ key: u.key, value: u.value })
        .onConflictDoUpdate({ target: portalSettings.key, set: { value: u.value, updatedAt: new Date() } });
    }
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "settings.updated", entity: "settings",
      description: "Portal settings updated", metadata: parsed.data as Record<string, unknown> });
    res.json({ success: true });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/audit-log", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const page   = Math.max(1, parseInt(req.query.page as string || "1", 10));
  const limit  = Math.min(100, parseInt(req.query.limit as string || "20", 10));
  const offset = (page - 1) * limit;
  try {
    const [logs, [{ total }]] = await Promise.all([
      db.select().from(portalAuditLogs).orderBy(desc(portalAuditLogs.createdAt)).limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(portalAuditLogs),
    ]);
    res.json({ success: true, data: logs, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN USER MANAGEMENT (super_admin only)
// ══════════════════════════════════════════════════════════════════════════════

router.get("/portal/admin/admins", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const adm = admin(req);
  if (adm.role !== "super_admin" && adm.role !== "manager") {
    res.status(403).json({ success: false, error: { code: "FORBIDDEN" } }); return;
  }
  try {
    const admins = await db.select({ id: portalAdminUsers.id, fullName: portalAdminUsers.fullName,
      email: portalAdminUsers.email, role: portalAdminUsers.role, isActive: portalAdminUsers.isActive,
      createdAt: portalAdminUsers.createdAt }).from(portalAdminUsers)
      .orderBy(asc(portalAdminUsers.createdAt));
    res.json({ success: true, data: admins });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

router.post("/portal/admin/admins", requirePortalAdmin, async (req: Request, res: Response): Promise<void> => {
  const adm = admin(req);
  if (adm.role !== "super_admin") { res.status(403).json({ success: false, error: { code: "FORBIDDEN" } }); return; }
  const parsed = z.object({
    fullName: z.string().min(2).max(100),
    email:    z.email(),
    password: z.string().min(8).max(128),
    role:     z.enum(["super_admin","manager","marketing","support","finance"]),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message } }); return; }
  try {
    const [existing] = await db.select({ id: portalAdminUsers.id }).from(portalAdminUsers)
      .where(eq(portalAdminUsers.email, parsed.data.email.toLowerCase())).limit(1);
    if (existing) { res.status(409).json({ success: false, error: { code: "EMAIL_TAKEN" } }); return; }
    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    const [newAdmin] = await db.insert(portalAdminUsers).values({
      ...parsed.data, email: parsed.data.email.toLowerCase(), passwordHash,
    }).returning({ id: portalAdminUsers.id, email: portalAdminUsers.email, role: portalAdminUsers.role });
    await auditLog({ adminId: adm.id, adminEmail: adm.email, action: "admin.created", entity: "admin_user", entityId: newAdmin.id,
      description: `Admin user created: ${newAdmin.email} (${newAdmin.role})` });
    res.status(201).json({ success: true, data: newAdmin });
  } catch (err) { logger.error({ err }); res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } }); }
});

export default router;
