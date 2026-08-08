/**
 * Client-facing (company) report routes.
 * All routes require a valid df_client_session cookie and enforce slug ownership.
 *
 * GET /api/company/:slug/reports      — list published reports for this client
 * GET /api/company/:slug/reports/:id  — single report with full data + content
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, clients, campaignReports, campaignData, reportContent } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireClient, type CompanySession } from "./company-auth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// Helper: resolve & guard slug ownership.
// requireClient() already verifies the user exists, is_active and the session
// version matches — inactive accounts are rejected with 401.
async function resolveClient(
  req: Request,
  res: Response
): Promise<CompanySession | null> {
  const session = await requireClient(req, res);
  if (!session) return null;

  const { slug } = req.params as { slug: string };
  if (session.slug !== slug) {
    res.status(403).json({ error: "غير مصرّح بالوصول إلى هذا الحساب" });
    return null;
  }
  return session;
}

// GET /api/company/:slug/reports
router.get("/company/:slug/reports", async (req: Request, res: Response): Promise<void> => {
  const session = await resolveClient(req, res);
  if (!session) return;

  try {
    const reports = await db
      .select({
        id:          campaignReports.id,
        title:       campaignReports.title,
        periodStart: campaignReports.periodStart,
        periodEnd:   campaignReports.periodEnd,
        status:      campaignReports.status,
        createdAt:   campaignReports.createdAt,
        updatedAt:   campaignReports.updatedAt,
      })
      .from(campaignReports)
      .where(
        and(
          eq(campaignReports.clientId, session.clientId),
          eq(campaignReports.status, "published")
        )
      )
      .orderBy(campaignReports.createdAt);

    // Attach client info
    const [client] = await db
      .select({ id: clients.id, slug: clients.slug, name: clients.name, logoUrl: clients.logoUrl, industry: clients.industry })
      .from(clients)
      .where(eq(clients.id, session.clientId));

    res.json({
      ok: true,
      client: client ?? null,
      reports,
      user: { id: session.userId, email: session.email, name: session.name, role: session.role },
    });
  } catch (err) {
    logger.error({ err }, "Failed to list client reports");
    res.status(500).json({ error: "فشل في جلب التقارير" });
  }
});

// GET /api/company/:slug/reports/:id
router.get("/company/:slug/reports/:id", async (req: Request, res: Response): Promise<void> => {
  const session = await resolveClient(req, res);
  if (!session) return;

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const reportId = parseInt(rawId, 10);
  if (isNaN(reportId)) { res.status(400).json({ error: "معرّف غير صالح" }); return; }

  try {
    const [report] = await db
      .select()
      .from(campaignReports)
      .where(
        and(
          eq(campaignReports.id, reportId),
          eq(campaignReports.clientId, session.clientId),
          eq(campaignReports.status, "published")
        )
      );

    if (!report) {
      res.status(404).json({ error: "التقرير غير موجود أو غير منشور" });
      return;
    }

    const data    = await db.select().from(campaignData).where(eq(campaignData.reportId, reportId));
    const [content] = await db.select().from(reportContent).where(eq(reportContent.reportId, reportId));
    const [client] = await db
      .select({ id: clients.id, slug: clients.slug, name: clients.name, logoUrl: clients.logoUrl, industry: clients.industry })
      .from(clients)
      .where(eq(clients.id, session.clientId));

    // Compute aggregate totals
    const totals = data.reduce(
      (acc, r) => ({
        spend:       acc.spend + parseFloat(r.spend ?? "0"),
        impressions: acc.impressions + r.impressions,
        reach:       acc.reach + r.reach,
        clicks:      acc.clicks + r.clicks,
        messages:    acc.messages + r.messages,
        calls:       acc.calls + r.calls,
        leads:       acc.leads + r.leads,
        bookings:    acc.bookings + r.bookings,
        prevSpend:       acc.prevSpend + parseFloat(r.prevSpend ?? "0"),
        prevImpressions: acc.prevImpressions + r.prevImpressions,
        prevReach:       acc.prevReach + r.prevReach,
        prevClicks:      acc.prevClicks + r.prevClicks,
        prevMessages:    acc.prevMessages + r.prevMessages,
        prevCalls:       acc.prevCalls + r.prevCalls,
        prevLeads:       acc.prevLeads + r.prevLeads,
        prevBookings:    acc.prevBookings + r.prevBookings,
      }),
      {
        spend: 0, impressions: 0, reach: 0, clicks: 0, messages: 0, calls: 0, leads: 0, bookings: 0,
        prevSpend: 0, prevImpressions: 0, prevReach: 0, prevClicks: 0, prevMessages: 0, prevCalls: 0, prevLeads: 0, prevBookings: 0,
      }
    );

    res.json({
      ok: true,
      client: client ?? null,
      user: { id: session.userId, email: session.email, name: session.name, role: session.role },
      report,
      campaignData: data,
      totals,
      content: content ?? null,
      mediaUrls: Array.isArray(content?.mediaUrls) ? content.mediaUrls : [],
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch client report");
    res.status(500).json({ error: "فشل في جلب التقرير" });
  }
});

export default router;
