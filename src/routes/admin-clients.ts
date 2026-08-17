/**
 * Admin: Clients & Reports CRUD
 *
 * All routes require admin session cookie (df_admin_session).
 *
 * Clients:
 *   GET    /api/admin/clients             — list all clients (with report counts)
 *   POST   /api/admin/clients             — create client
 *   GET    /api/admin/clients/:id         — single client
 *   PATCH  /api/admin/clients/:id         — update client
 *   DELETE /api/admin/clients/:id         — delete client
 *   POST   /api/admin/clients/:id/auth    — set/reset client login credentials
 *
 * Reports:
 *   GET    /api/admin/reports             — list all reports (filterable by clientId)
 *   POST   /api/admin/reports             — create report
 *   GET    /api/admin/reports/:id         — single report (full detail)
 *   PATCH  /api/admin/reports/:id         — update report meta
 *   DELETE /api/admin/reports/:id         — delete report
 *   PUT    /api/admin/reports/:id/data    — upsert campaign_data rows (array)
 *   PATCH  /api/admin/reports/:id/publish — toggle publish status
 *   POST   /api/admin/reports/:id/generate — AI content generation
 */
import bcrypt from "bcryptjs";
import express, { Router, type IRouter, type Request, type Response } from "express";
import { db, clients, companyUsers, type CompanyRole, campaignReports, campaignData, reportContent } from "@workspace/db";
import { eq, desc, sql, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { openai } from "@workspace/integrations-openai-ai-server";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { sendReportPublishedEmail } from "../lib/mailer.js";
import { requirePortalAdmin } from "../lib/portalAuth.js";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();
const BCRYPT_ROUNDS = 10;

// Every route in this file is admin-only.
router.use(requirePortalAdmin);

// ── Helpers ───────────────────────────────────────────────────────────────────
function numId(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

// ═════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/clients
router.get("/admin/clients", async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db.select().from(clients).orderBy(desc(clients.createdAt));

    // Report counts per client
    const counts = await db
      .select({
        clientId: campaignReports.clientId,
        total: sql<number>`count(*)::int`,
      })
      .from(campaignReports)
      .groupBy(campaignReports.clientId);

    const countMap = Object.fromEntries(counts.map(c => [c.clientId, c.total]));

    // User counts + owner email per client
    const users = await db
      .select({ clientId: companyUsers.clientId, email: companyUsers.email, role: companyUsers.role })
      .from(companyUsers);
    const userCountMap: Record<number, number> = {};
    const ownerEmailMap: Record<number, string> = {};
    for (const u of users) {
      userCountMap[u.clientId] = (userCountMap[u.clientId] ?? 0) + 1;
      if (u.role === "owner" && !ownerEmailMap[u.clientId]) ownerEmailMap[u.clientId] = u.email;
    }

    res.json({
      clients: rows.map(c => ({
        ...c,
        reportCount: countMap[c.id] ?? 0,
        userCount: userCountMap[c.id] ?? 0,
        loginEmail: ownerEmailMap[c.id] ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list clients");
    res.status(500).json({ error: "فشل في جلب قائمة العملاء" });
  }
});

// POST /api/admin/clients
router.post("/admin/clients", async (req: Request, res: Response): Promise<void> => {
  const { slug, name, logoUrl, industry } = req.body as {
    slug?: string; name?: string; logoUrl?: string; industry?: string;
  };
  if (!slug?.trim() || !name?.trim()) {
    res.status(400).json({ error: "slug واسم العميل مطلوبان" });
    return;
  }
  try {
    const [client] = await db.insert(clients).values({
      slug: slug.trim().toLowerCase(),
      name: name.trim(),
      logoUrl: logoUrl?.trim() ?? "",
      industry: industry?.trim() ?? "",
    }).returning();
    res.status(201).json({ client });
  } catch (err: unknown) {
    if (String(err).includes("unique")) {
      res.status(409).json({ error: "هذا الـ slug مستخدم بالفعل" });
      return;
    }
    logger.error({ err }, "Failed to create client");
    res.status(500).json({ error: "فشل في إنشاء العميل" });
  }
});

// GET /api/admin/clients/:id
router.get("/admin/clients/:id", async (req: Request, res: Response): Promise<void> => {
  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [client] = await db.select().from(clients).where(eq(clients.id, id));
  if (!client) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  res.json({ client });
});

// PATCH /api/admin/clients/:id
router.patch("/admin/clients/:id", async (req: Request, res: Response): Promise<void> => {
  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { name, logoUrl, industry } = req.body as { name?: string; logoUrl?: string; industry?: string };
  const updates: Partial<{ name: string; logoUrl: string; industry: string }> = {};
  if (name?.trim()) updates.name = name.trim();
  if (logoUrl !== undefined) updates.logoUrl = logoUrl.trim();
  if (industry !== undefined) updates.industry = industry.trim();
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "لا توجد بيانات للتحديث" }); return; }
  const [updated] = await db.update(clients).set(updates).where(eq(clients.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  res.json({ client: updated });
});

// DELETE /api/admin/clients/:id
router.delete("/admin/clients/:id", async (req: Request, res: Response): Promise<void> => {
  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [deleted] = await db.delete(clients).where(eq(clients.id, id)).returning({ id: clients.id });
  if (!deleted) { res.status(404).json({ error: "العميل غير موجود" }); return; }
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// COMPANY USERS (multi-user per client)
// ═════════════════════════════════════════════════════════════════════════════

const COMPANY_ROLES = ["owner", "gm", "marketing", "doctor"] as const;

// Lazy so the table object is only dereferenced at request time (test-mock friendly)
const adminUserColumns = () => ({
  id:                  companyUsers.id,
  clientId:            companyUsers.clientId,
  email:               companyUsers.email,
  name:                companyUsers.name,
  role:                companyUsers.role,
  isActive:            companyUsers.isActive,
  forcePasswordChange: companyUsers.forcePasswordChange,
  createdAt:           companyUsers.createdAt,
});

function numUserId(req: Request): number | null {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

// GET /api/admin/clients/:id/users — list a client's users
router.get("/admin/clients/:id/users", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, id));
  if (!client) { res.status(404).json({ error: "العميل غير موجود" }); return; }

  const users = await db
    .select(adminUserColumns())
    .from(companyUsers)
    .where(eq(companyUsers.clientId, id))
    .orderBy(companyUsers.createdAt);
  res.json({ users });
});

// POST /api/admin/clients/:id/users — create a user with a role
router.post("/admin/clients/:id/users", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { email, name, password, role } = req.body as {
    email?: string; name?: string; password?: string; role?: string;
  };
  if (!email?.trim() || !password || password.length < 8) {
    res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور (8 أحرف على الأقل) مطلوبان" });
    return;
  }
  if (!role || !(COMPANY_ROLES as readonly string[]).includes(role)) {
    res.status(400).json({ error: "الدور مطلوب — owner أو gm أو marketing أو doctor" });
    return;
  }
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, id));
  if (!client) { res.status(404).json({ error: "العميل غير موجود" }); return; }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const [created] = await db.insert(companyUsers).values({
      clientId: id,
      email: email.trim().toLowerCase(),
      name: name?.trim() ?? "",
      passwordHash,
      role: role as CompanyRole,
      forcePasswordChange: true,
    }).returning(adminUserColumns());
    res.status(201).json({ user: created });
  } catch (err) {
    if (String(err).includes("unique")) {
      res.status(409).json({ error: "هذا البريد الإلكتروني مستخدم بالفعل" });
      return;
    }
    logger.error({ err }, "Failed to create company user (admin)");
    res.status(500).json({ error: "فشل في إنشاء المستخدم" });
  }
});

// PATCH /api/admin/clients/:id/users/:userId — role / activate-deactivate / reset password / name
router.patch("/admin/clients/:id/users/:userId", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  const userId = numUserId(req);
  if (!id || !userId) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [target] = await db
    .select({ id: companyUsers.id })
    .from(companyUsers)
    .where(and(eq(companyUsers.id, userId), eq(companyUsers.clientId, id)));
  if (!target) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }

  const { role, isActive, password, name } = req.body as {
    role?: string; isActive?: boolean; password?: string; name?: string;
  };

  const updates: Record<string, unknown> = {};
  if (role !== undefined) {
    if (!(COMPANY_ROLES as readonly string[]).includes(role)) { res.status(400).json({ error: "دور غير صالح" }); return; }
    updates.role = role;
  }
  if (isActive !== undefined) updates.isActive = !!isActive;
  if (password !== undefined) {
    if (typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
      return;
    }
    // Reset without knowing the old password; force the user to pick a new one
    updates.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    updates.forcePasswordChange = true;
  }
  if (name !== undefined) updates.name = String(name).trim();
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "لا توجد بيانات للتحديث" }); return; }

  // Any credential / role / status change invalidates existing sessions
  if (updates.passwordHash !== undefined || updates.role !== undefined || updates.isActive !== undefined) {
    updates.sessionVersion = sql`${companyUsers.sessionVersion} + 1`;
  }

  const [updated] = await db
    .update(companyUsers)
    .set(updates)
    .where(eq(companyUsers.id, userId))
    .returning(adminUserColumns());
  res.json({ user: updated });
});

// DELETE /api/admin/clients/:id/users/:userId — delete a user
router.delete("/admin/clients/:id/users/:userId", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  const userId = numUserId(req);
  if (!id || !userId) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [deleted] = await db
    .delete(companyUsers)
    .where(and(eq(companyUsers.id, userId), eq(companyUsers.clientId, id)))
    .returning({ id: companyUsers.id });
  if (!deleted) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/reports
router.get("/admin/reports", async (req: Request, res: Response): Promise<void> => {

  const clientIdFilter = req.query.clientId ? parseInt(req.query.clientId as string, 10) : null;
  try {
    const rows = clientIdFilter
      ? await db.select().from(campaignReports).where(eq(campaignReports.clientId, clientIdFilter)).orderBy(desc(campaignReports.createdAt))
      : await db.select().from(campaignReports).orderBy(desc(campaignReports.createdAt));
    res.json({ reports: rows });
  } catch (err) {
    logger.error({ err }, "Failed to list reports");
    res.status(500).json({ error: "فشل في جلب التقارير" });
  }
});

// POST /api/admin/reports
router.post("/admin/reports", async (req: Request, res: Response): Promise<void> => {

  const { clientId, title, periodStart, periodEnd } = req.body as {
    clientId?: number; title?: string; periodStart?: string; periodEnd?: string;
  };
  if (!clientId || !title?.trim() || !periodStart || !periodEnd) {
    res.status(400).json({ error: "clientId والعنوان وتواريخ الفترة مطلوبة" });
    return;
  }
  try {
    const [report] = await db.insert(campaignReports).values({
      clientId,
      title: title.trim(),
      periodStart,
      periodEnd,
      status: "draft",
    }).returning();
    res.status(201).json({ report });
  } catch (err) {
    logger.error({ err }, "Failed to create report");
    res.status(500).json({ error: "فشل في إنشاء التقرير" });
  }
});

// GET /api/admin/reports/:id
router.get("/admin/reports/:id", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [report] = await db.select().from(campaignReports).where(eq(campaignReports.id, id));
  if (!report) { res.status(404).json({ error: "التقرير غير موجود" }); return; }

  const data = await db.select().from(campaignData).where(eq(campaignData.reportId, id));
  const [content] = await db.select().from(reportContent).where(eq(reportContent.reportId, id));
  const [client] = await db.select({ id: clients.id, slug: clients.slug, name: clients.name }).from(clients).where(eq(clients.id, report.clientId));

  res.json({ report, campaignData: data, content: content ?? null, client: client ?? null });
});

// PATCH /api/admin/reports/:id
router.patch("/admin/reports/:id", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { title, periodStart, periodEnd } = req.body as { title?: string; periodStart?: string; periodEnd?: string };
  const updates: Partial<{ title: string; periodStart: string; periodEnd: string; updatedAt: Date }> = {};
  if (title?.trim()) updates.title = title.trim();
  if (periodStart) updates.periodStart = periodStart;
  if (periodEnd) updates.periodEnd = periodEnd;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "لا توجد بيانات للتحديث" }); return; }
  updates.updatedAt = new Date();
  const [updated] = await db.update(campaignReports).set(updates).where(eq(campaignReports.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "التقرير غير موجود" }); return; }
  res.json({ report: updated });
});

// DELETE /api/admin/reports/:id
router.delete("/admin/reports/:id", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const [deleted] = await db.delete(campaignReports).where(eq(campaignReports.id, id)).returning({ id: campaignReports.id });
  if (!deleted) { res.status(404).json({ error: "التقرير غير موجود" }); return; }
  res.json({ ok: true });
});

// PUT /api/admin/reports/:id/data — upsert campaign_data rows
router.put("/admin/reports/:id/data", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const rows = req.body as Array<{
    platform: string;
    spend?: number; impressions?: number; reach?: number; clicks?: number;
    messages?: number; calls?: number; leads?: number; bookings?: number;
    prevSpend?: number; prevImpressions?: number; prevReach?: number; prevClicks?: number;
    prevMessages?: number; prevCalls?: number; prevLeads?: number; prevBookings?: number;
  }>;

  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "يجب إرسال مصفوفة من بيانات الحملة" });
    return;
  }

  try {
    // Delete existing rows for this report then insert fresh
    await db.delete(campaignData).where(eq(campaignData.reportId, id));
    const inserted = await db.insert(campaignData).values(
      rows.map(r => ({
        reportId:       id,
        platform:       r.platform,
        spend:          String(r.spend ?? 0),
        impressions:    r.impressions ?? 0,
        reach:          r.reach ?? 0,
        clicks:         r.clicks ?? 0,
        messages:       r.messages ?? 0,
        calls:          r.calls ?? 0,
        leads:          r.leads ?? 0,
        bookings:       r.bookings ?? 0,
        prevSpend:      String(r.prevSpend ?? 0),
        prevImpressions: r.prevImpressions ?? 0,
        prevReach:      r.prevReach ?? 0,
        prevClicks:     r.prevClicks ?? 0,
        prevMessages:   r.prevMessages ?? 0,
        prevCalls:      r.prevCalls ?? 0,
        prevLeads:      r.prevLeads ?? 0,
        prevBookings:   r.prevBookings ?? 0,
      }))
    ).returning();

    // Touch report updatedAt
    await db.update(campaignReports).set({ updatedAt: new Date() }).where(eq(campaignReports.id, id));
    res.json({ ok: true, rows: inserted.length });
  } catch (err) {
    logger.error({ err }, "Failed to upsert campaign data");
    res.status(500).json({ error: "فشل في حفظ بيانات الحملة" });
  }
});

// PATCH /api/admin/reports/:id/publish
router.patch("/admin/reports/:id/publish", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { status } = req.body as { status?: "draft" | "published" };
  const newStatus = status === "draft" ? "draft" : "published";

  // Fetch previous status + full report info before updating
  const [existing] = await db
    .select({
      status:      campaignReports.status,
      title:       campaignReports.title,
      periodStart: campaignReports.periodStart,
      periodEnd:   campaignReports.periodEnd,
      clientId:    campaignReports.clientId,
    })
    .from(campaignReports)
    .where(eq(campaignReports.id, id));
  if (!existing) { res.status(404).json({ error: "التقرير غير موجود" }); return; }

  const [updated] = await db
    .update(campaignReports)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(campaignReports.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "التقرير غير موجود" }); return; }

  // Send email notification only when transitioning to "published"
  if (newStatus === "published" && existing.status !== "published") {
    // Fetch client slug + active users' emails in parallel
    const [clientRow, activeUsers] = await Promise.all([
      db.select({ slug: clients.slug, name: clients.name })
        .from(clients).where(eq(clients.id, existing.clientId)).then(r => r[0]),
      db.select({ email: companyUsers.email })
        .from(companyUsers)
        .where(and(eq(companyUsers.clientId, existing.clientId), eq(companyUsers.isActive, true))),
    ]);

    if (clientRow && activeUsers.length > 0) {
      // Background send — response is not delayed; the aggregate outcome is
      // persisted on the report so the admin UI can surface delivery failures.
      void (async () => {
        try {
          const results = await Promise.all(activeUsers.map(u =>
            sendReportPublishedEmail({
              clientName:  clientRow.name,
              clientEmail: u.email,
              clientSlug:  clientRow.slug,
              reportId:    id,
              reportTitle: existing.title,
              periodStart: existing.periodStart,
              periodEnd:   existing.periodEnd,
            })
          ));
          const status: string = results.includes("failed")
            ? "failed"
            : results.includes("sent") ? "sent" : "not_configured";
          await db.update(campaignReports)
            .set({ notificationStatus: status, notificationAt: new Date() })
            .where(eq(campaignReports.id, id));
        } catch (err) {
          logger.error({ err, reportId: id }, "Failed to record report-notification status");
        }
      })();
    } else {
      logger.info({ reportId: id, hasClient: !!clientRow, userCount: activeUsers.length }, "Report published — no active company users, skipping notification");
    }
  }

  res.json({ report: updated });
});

// POST /api/admin/reports/:id/notify — manually resend the published-report email
router.post("/admin/reports/:id/notify", async (req: Request, res: Response): Promise<void> => {
  // CSRF guard — cross-site HTML forms cannot set custom headers
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ error: "طلب غير مصرّح به — مصدر غير موثوق" });
    return;
  }

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  try {
    const [report] = await db
      .select({
        status:      campaignReports.status,
        title:       campaignReports.title,
        periodStart: campaignReports.periodStart,
        periodEnd:   campaignReports.periodEnd,
        clientId:    campaignReports.clientId,
      })
      .from(campaignReports)
      .where(eq(campaignReports.id, id));
    if (!report) { res.status(404).json({ error: "التقرير غير موجود" }); return; }
    if (report.status !== "published") {
      res.status(400).json({ error: "لا يمكن إرسال الإشعار — التقرير غير منشور" });
      return;
    }

    const [clientRow, activeUsers] = await Promise.all([
      db.select({ slug: clients.slug, name: clients.name })
        .from(clients).where(eq(clients.id, report.clientId)).then(r => r[0]),
      db.select({ email: companyUsers.email })
        .from(companyUsers)
        .where(and(eq(companyUsers.clientId, report.clientId), eq(companyUsers.isActive, true))),
    ]);

    if (!clientRow) { res.status(404).json({ error: "العميل غير موجود" }); return; }
    if (activeUsers.length === 0) {
      res.status(400).json({ error: "لا يوجد مستخدمون نشطون لهذا العميل لاستلام الإشعار" });
      return;
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      res.status(503).json({ error: "خدمة البريد غير مهيأة (SMTP)" });
      return;
    }

    const results = await Promise.all(activeUsers.map(u =>
      sendReportPublishedEmail({
        clientName:  clientRow.name,
        clientEmail: u.email,
        clientSlug:  clientRow.slug,
        reportId:    id,
        reportTitle: report.title,
        periodStart: report.periodStart,
        periodEnd:   report.periodEnd,
      })
    ));

    const sent = results.filter(r => r === "sent").length;
    const failed = results.length - sent;

    // Persist the outcome so the delivery badge in the admin UI stays accurate
    await db.update(campaignReports)
      .set({ notificationStatus: sent === 0 ? "failed" : "sent", notificationAt: new Date() })
      .where(eq(campaignReports.id, id));

    if (sent === 0) {
      logger.error({ reportId: id, failed }, "Manual report notification: all sends failed");
      res.status(502).json({ error: "تعذر إرسال الإشعار — فشل الاتصال بخادم البريد" });
      return;
    }

    logger.info({ reportId: id, sent, failed }, "Report notification manually resent");
    if (failed > 0) {
      res.json({ ok: true, sent, failed, warning: `أُرسل إلى ${sent} مستلم وفشل الإرسال إلى ${failed}` });
      return;
    }
    res.json({ ok: true, sent, failed: 0 });
  } catch (err) {
    logger.error({ err, reportId: id }, "Failed to resend report notification");
    res.status(500).json({ error: "فشل في إعادة إرسال الإشعار" });
  }
});

// ── Media upload ──────────────────────────────────────────────────────────────

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/avif",
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// POST /api/admin/reports/:id/upload-url — get a presigned PUT URL for one image
router.post("/admin/reports/:id/upload-url", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const { name, size, contentType } = req.body as {
    name?: string; size?: number; contentType?: string;
  };

  // Server-side validation — MIME type must be an image
  if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType.toLowerCase())) {
    res.status(400).json({ error: "نوع الملف غير مسموح — يُقبل JPEG وPNG وWEBP وGIF وAVIF فقط" });
    return;
  }
  // Server-side size cap — size is required and must be a positive number
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    res.status(400).json({ error: "حجم الملف (size) مطلوب ويجب أن يكون رقماً موجباً" });
    return;
  }
  if (size > MAX_UPLOAD_BYTES) {
    res.status(400).json({ error: "حجم الصورة يجب أن يكون أقل من 10 ميجابايت" });
    return;
  }

  const [report] = await db.select({ id: campaignReports.id }).from(campaignReports).where(eq(campaignReports.id, id));
  if (!report) { res.status(404).json({ error: "التقرير غير موجود" }); return; }

  try {
    const uploadURL = await objectStorage.getObjectEntityUploadURL();
    const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
  } catch (err) {
    logger.error({ err }, "Failed to generate upload URL");
    res.status(500).json({ error: "فشل في إنشاء رابط الرفع" });
  }
});

// PUT /api/admin/upload-slot/:uuid — proxy upload directly to R2 via Worker
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "application/pdf",
]);

router.put(
  "/admin/upload-slot/:uuid",
  express.raw({ type: "*/*", limit: "11mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const { uuid } = req.params as { uuid: string };
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(uuid)) {
      res.status(400).json({ error: "UUID غير صالح" });
      return;
    }

    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(contentType)) {
      res.status(415).json({ error: "نوع الملف غير مدعوم" });
      return;
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "الجسم فارغ" });
      return;
    }
    if (body.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: "حجم الملف يتجاوز الحد المسموح به (10 ميجابايت)" });
      return;
    }

    try {
      const objectPath = await objectStorage.storeEntityObject(uuid, contentType, body);
      res.json({ ok: true, objectPath });
    } catch (err) {
      logger.error({ err }, "Failed to store uploaded object");
      res.status(500).json({ error: "فشل في حفظ الملف" });
    }
  },
);

// PATCH /api/admin/reports/:id/media — save mediaUrls array to report_content
router.patch("/admin/reports/:id/media", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }
  const { mediaUrls } = req.body as { mediaUrls?: string[] };
  if (!Array.isArray(mediaUrls)) { res.status(400).json({ error: "mediaUrls يجب أن تكون مصفوفة" }); return; }
  const urls = mediaUrls.slice(0, 5); // cap at 5

  // Upsert report_content with mediaUrls only (keep other fields if they exist)
  await db
    .insert(reportContent)
    .values({
      reportId:         id,
      executiveSummary: "",
      mediaUrls:        urls,
    })
    .onConflictDoUpdate({
      target: reportContent.reportId,
      set: { mediaUrls: urls },
    });

  await db.update(campaignReports).set({ updatedAt: new Date() }).where(eq(campaignReports.id, id));
  res.json({ ok: true, mediaUrls: urls });
});

// DELETE /api/admin/reports/:id/media/:index — remove one image by index
router.delete("/admin/reports/:id/media/:index", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  const rawIdx = Array.isArray(req.params.index) ? req.params.index[0] : req.params.index;
  const idx = parseInt(rawIdx, 10);
  if (!id || isNaN(idx)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  const [existing] = await db.select({ mediaUrls: reportContent.mediaUrls }).from(reportContent).where(eq(reportContent.reportId, id));
  const urls: string[] = Array.isArray(existing?.mediaUrls) ? (existing.mediaUrls as string[]) : [];
  urls.splice(idx, 1);

  await db
    .insert(reportContent)
    .values({ reportId: id, executiveSummary: "", mediaUrls: urls })
    .onConflictDoUpdate({ target: reportContent.reportId, set: { mediaUrls: urls } });

  res.json({ ok: true, mediaUrls: urls });
});

// ── AI Generation ─────────────────────────────────────────────────────────────

// POST /api/admin/reports/:id/generate
router.post("/admin/reports/:id/generate", async (req: Request, res: Response): Promise<void> => {

  const id = numId(req);
  if (!id) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  // Load report + campaign data
  const [report] = await db.select().from(campaignReports).where(eq(campaignReports.id, id));
  if (!report) { res.status(404).json({ error: "التقرير غير موجود" }); return; }
  const data = await db.select().from(campaignData).where(eq(campaignData.reportId, id));
  if (data.length === 0) { res.status(400).json({ error: "أدخل بيانات الحملة أولاً" }); return; }
  const [client] = await db.select({ name: clients.name, industry: clients.industry }).from(clients).where(eq(clients.id, report.clientId));

  // Build totals
  const totals = data.reduce(
    (acc, r) => ({
      spend: acc.spend + parseFloat(r.spend ?? "0"),
      impressions: acc.impressions + r.impressions,
      reach: acc.reach + r.reach,
      clicks: acc.clicks + r.clicks,
      messages: acc.messages + r.messages,
      calls: acc.calls + r.calls,
      leads: acc.leads + r.leads,
      bookings: acc.bookings + r.bookings,
    }),
    { spend: 0, impressions: 0, reach: 0, clicks: 0, messages: 0, calls: 0, leads: 0, bookings: 0 }
  );
  const ctr = totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(2) : "0";
  const cpl = totals.leads > 0 ? (totals.spend / totals.leads).toFixed(2) : "N/A";

  const platformSummary = data
    .map(r => `${r.platform}: إنفاق ${r.spend} د.إ، وصول ${r.reach.toLocaleString()}، نقرات ${r.clicks}، رسائل ${r.messages}، مكالمات ${r.calls}، عملاء محتملون ${r.leads}، حجوزات ${r.bookings}`)
    .join("\n");

  const prompt = `أنت خبير تسويق رقمي محترف. قم بتحليل نتائج حملة الإعلانات التالية للعميل وأنشئ تقريراً شاملاً بالعربية الفصحى.

العميل: ${client?.name ?? "غير محدد"}
القطاع: ${client?.industry ?? "غير محدد"}
الفترة: ${report.periodStart} إلى ${report.periodEnd}

الإجماليات الكلية:
- إجمالي الإنفاق: ${totals.spend.toFixed(2)} د.إ
- مجموع الوصول: ${totals.reach.toLocaleString()} شخص
- مجموع المشاهدات: ${totals.impressions.toLocaleString()}
- نسبة النقر (CTR): ${ctr}%
- عدد العملاء المحتملين: ${totals.leads}
- تكلفة العميل المحتمل: ${cpl} د.إ
- عدد المكالمات: ${totals.calls}
- عدد الحجوزات: ${totals.bookings}

تفاصيل المنصات:
${platformSummary}

أرجع JSON فقط بهذا الشكل بالضبط (بدون أي نص إضافي):
{
  "executiveSummary": "فقرة واحدة كافية تلخص الأداء العام وأبرز النتائج (200-300 كلمة)",
  "aiAnalysis": {
    "bestPlatform": "اسم المنصة الأفضل أداءً مع السبب",
    "bestAd": "نوع الإعلان الأكثر فاعلية بناءً على البيانات",
    "bestAudience": "الجمهور المستهدف الأمثل",
    "bestTime": "أفضل وقت للإعلان بناءً على القطاع",
    "strengths": ["نقطة قوة 1", "نقطة قوة 2", "نقطة قوة 3"],
    "weaknesses": ["نقطة ضعف 1", "نقطة ضعف 2"]
  },
  "recommendations": [
    { "title": "عنوان التوصية", "description": "تفاصيل التوصية والخطوات التطبيقية", "impact": "high" },
    { "title": "عنوان التوصية", "description": "تفاصيل التوصية والخطوات التطبيقية", "impact": "medium" },
    { "title": "عنوان التوصية", "description": "تفاصيل التوصية والخطوات التطبيقية", "impact": "medium" },
    { "title": "عنوان التوصية", "description": "تفاصيل التوصية والخطوات التطبيقية", "impact": "low" }
  ],
  "nextMonthPlan": [
    { "week": "الأسبوع الأول", "focus": "التركيز الرئيسي", "budget": "النسبة من الميزانية", "channels": ["قناة 1", "قناة 2"] },
    { "week": "الأسبوع الثاني", "focus": "التركيز الرئيسي", "budget": "النسبة من الميزانية", "channels": ["قناة 1"] },
    { "week": "الأسبوع الثالث", "focus": "التركيز الرئيسي", "budget": "النسبة من الميزانية", "channels": ["قناة 1", "قناة 2"] },
    { "week": "الأسبوع الرابع", "focus": "التركيز الرئيسي", "budget": "النسبة من الميزانية", "channels": ["قناة 1"] }
  ],
  "weeklyTimeline": [
    { "week": "الأسبوع الأول", "notes": "ملاحظات الأداء" },
    { "week": "الأسبوع الثاني", "notes": "ملاحظات الأداء" },
    { "week": "الأسبوع الثالث", "notes": "ملاحظات الأداء" },
    { "week": "الأسبوع الرابع", "notes": "ملاحظات الأداء" }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      executiveSummary?: string;
      aiAnalysis?: unknown;
      recommendations?: unknown;
      nextMonthPlan?: unknown;
      weeklyTimeline?: unknown;
    };

    // Upsert report_content
    await db
      .insert(reportContent)
      .values({
        reportId:         id,
        executiveSummary: parsed.executiveSummary ?? "",
        aiAnalysis:       parsed.aiAnalysis ?? null,
        recommendations:  parsed.recommendations ?? null,
        nextMonthPlan:    parsed.nextMonthPlan ?? null,
        weeklyTimeline:   parsed.weeklyTimeline ?? null,
        generatedAt:      new Date(),
      })
      .onConflictDoUpdate({
        target: reportContent.reportId,
        set: {
          executiveSummary: parsed.executiveSummary ?? "",
          aiAnalysis:       parsed.aiAnalysis ?? null,
          recommendations:  parsed.recommendations ?? null,
          nextMonthPlan:    parsed.nextMonthPlan ?? null,
          weeklyTimeline:   parsed.weeklyTimeline ?? null,
          generatedAt:      new Date(),
        },
      });

    logger.info({ reportId: id }, "AI report content generated");
    res.json({ ok: true, content: parsed });
  } catch (err) {
    logger.error({ err }, "AI generation failed");
    res.status(500).json({ error: "فشل في توليد المحتوى بالذكاء الاصطناعي" });
  }
});

export default router;
