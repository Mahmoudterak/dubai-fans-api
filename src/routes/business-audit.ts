/**
 * Public: AI Business Audit (المعالج متعدد الخطوات في /ai-business-audit)
 *
 *   POST /api/business-audit       — submit wizard answers, generate AI report, save lead
 *   GET  /api/business-audit       — list the caller's own audits (client portal)
 *   GET  /api/business-audit/:id   — fetch one owned audit + report
 *
 * CSRF: POST requires X-Requested-With: fetch.
 * Quota: atomic daily reservation (anon by IP, logged-in students by ID).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db, businessAudits } from "@workspace/db";
import { eq, and, desc, isNull } from "drizzle-orm";
import { resolveStudentId } from "./student-auth";
import { businessAuditLimiter } from "../middlewares/rate-limit";
import { sendBusinessAuditNotification } from "../lib/mailer";
import { reserveDailyQuota, releaseDailyQuota, todayBucket } from "../lib/ai-quota";

const router: IRouter = Router();

/* ── Daily quota ─────────────────────────────────────────── */
const ANON_DAILY_LIMIT    = 2;
const STUDENT_DAILY_LIMIT = 5;

function secondsUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

function quotaPrincipal(req: Request, studentId: number | null): string {
  if (studentId !== null) return `student:${studentId}`;
  // Use only the proxy-validated req.ip — raw X-Forwarded-For is spoofable
  // and would let callers mint a fresh anonymous quota per request.
  return `ip:${req.ip ?? "unknown"}`;
}

/** Validate/coerce the AI report so a malformed model response never persists. */
function normalizeReport(raw: any): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, 20) : [];

  const healthScore = num(raw.healthScore);
  if (healthScore === null) return null;

  const scores: Record<string, number> = {};
  if (raw.scores && typeof raw.scores === "object") {
    for (const k of ["marketing", "seo", "website", "socialMedia", "conversion", "brand"]) {
      const v = num(raw.scores[k]);
      if (v !== null) scores[k] = v;
    }
  }
  const problems = strArr(raw.problems);
  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations
        .filter((r: any) => r && typeof r === "object" && typeof r.title === "string" && typeof r.description === "string")
        .slice(0, 15)
        .map((r: any) => ({
          title:       r.title.slice(0, 200),
          priority:    ["high", "medium", "low"].includes(r.priority) ? r.priority : "medium",
          description: r.description.slice(0, 1000),
          ...(typeof r.impact === "string" ? { impact: r.impact.slice(0, 300) } : {}),
        }))
    : [];
  if (problems.length === 0 || recommendations.length === 0) return null;

  return {
    healthScore,
    scores,
    summary:  typeof raw.summary === "string" ? raw.summary.slice(0, 2000) : "",
    problems,
    opportunities: strArr(raw.opportunities),
    recommendations,
    plan30: strArr(raw.plan30),
    plan90: strArr(raw.plan90),
    growthPotentialPercent: num(raw.growthPotentialPercent) ?? 20,
  };
}

/* ── Anonymous session cookie (shared with AI Business OS) ── */
const SESSION_COOKIE = "aib_sid";
const COOKIE_TTL     = 365 * 24 * 60 * 60 * 1000;

function getOrCreateSession(req: Request, res: Response): string {
  const existing = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
  if (existing) return existing;
  const sid = randomUUID();
  res.cookie(SESSION_COOKIE, sid, {
    maxAge:   COOKIE_TTL,
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
  });
  return sid;
}

async function resolveOwner(req: Request, res: Response): Promise<{ sid: string; studentId: number | null }> {
  const sid = getOrCreateSession(req, res);
  const raw = resolveStudentId(req);
  const studentId = raw !== null && raw > 0 ? raw : null;
  if (studentId !== null) {
    // Claim anonymous rows so pre-login audits appear in the client portal.
    await db.update(businessAudits)
      .set({ studentId })
      .where(and(eq(businessAudits.sessionId, sid), isNull(businessAudits.studentId)));
  }
  return { sid, studentId };
}

/* ── Allowed wizard values ───────────────────────────────── */
const TARGET_LABELS: Record<string, string> = {
  website:         "الموقع الإلكتروني",
  instagram:       "Instagram",
  facebook:        "Facebook",
  tiktok:          "TikTok",
  snapchat:        "Snapchat",
  google_business: "Google Business",
  full_business:   "النشاط التجاري بالكامل",
};
const LINK_KEYS = ["website", "instagram", "facebook", "tiktok", "googleBusiness"] as const;

function badRequest(res: Response, error: string): void {
  res.status(400).json({ success: false, error });
}

/* ── POST /api/business-audit ────────────────────────────── */
router.post("/business-audit", businessAuditLimiter, async (req: Request, res: Response): Promise<void> => {
  if (req.headers["x-requested-with"] !== "fetch") {
    res.status(403).json({ success: false, error: "طلب غير مصرّح به" });
    return;
  }
  let quotaHolder: string | null = null;
  let reservedDay = "";
  try {
    const body = req.body ?? {};

    /* ── Validate everything BEFORE quota/OpenAI ── */
    const targets: unknown = body.targets;
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 7
        || !targets.every((t) => typeof t === "string" && t in TARGET_LABELS)) {
      badRequest(res, "اختر ما تريد تحليله أولاً");
      return;
    }
    const str = (v: unknown, max: number): string | null =>
      typeof v === "string" && v.trim().length <= max ? v.trim() : null;

    const businessType = str(body.businessType, 100);
    if (!businessType) { badRequest(res, "نوع النشاط مطلوب"); return; }
    const country = str(body.country ?? "", 100) ?? "";
    const city    = str(body.city ?? "", 100) ?? "";

    const rawLinks = body.links ?? {};
    const links: Record<string, string> = {};
    for (const k of LINK_KEYS) {
      const v = rawLinks[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string" || v.length > 500) { badRequest(res, "أحد الروابط غير صالح"); return; }
      links[k] = v.trim();
    }

    const rawExtra = body.extra ?? {};
    const extra = {
      employees:    str(rawExtra.employees ?? "", 50) ?? "",
      branches:     str(rawExtra.branches ?? "", 50) ?? "",
      budget:       str(rawExtra.budget ?? "", 100) ?? "",
      hasWebsite:   rawExtra.hasWebsite === true,
      hasCampaigns: rawExtra.hasCampaigns === true,
    };

    const name        = str(body.name, 100);
    const email       = str(body.email, 200);
    const phone       = str(body.phone, 30);
    const companyName = str(body.companyName, 150);
    if (!name || name.length < 2)                    { badRequest(res, "الاسم مطلوب"); return; }
    if (!email || !email.includes("@"))              { badRequest(res, "البريد الإلكتروني غير صحيح"); return; }
    if (!phone || phone.length < 7)                  { badRequest(res, "رقم الهاتف غير صحيح"); return; }
    if (!companyName || companyName.length < 2)      { badRequest(res, "اسم الشركة مطلوب"); return; }

    const { sid, studentId } = await resolveOwner(req, res);

    /* ── Reserve daily quota ── */
    quotaHolder = quotaPrincipal(req, studentId);
    reservedDay = todayBucket();
    const limit = studentId !== null ? STUDENT_DAILY_LIMIT : ANON_DAILY_LIMIT;
    const ok = await reserveDailyQuota(quotaHolder, "business_audit", limit);
    if (!ok) {
      quotaHolder = null;
      res.status(429).json({
        success: false,
        limitReached: true,
        error: "وصلت للحد اليومي المسموح لتحليل الأعمال — حاول مجدداً غداً",
        retryAfter: secondsUntilMidnight(),
      });
      return;
    }

    /* ── Build prompt ── */
    const targetLabels = (targets as string[]).map((t) => TARGET_LABELS[t]).join("، ");
    const linkLines = Object.entries(links).map(([k, v]) => `- ${k}: ${v}`).join("\n");
    const prompt = `أنت مستشار نمو أعمال وخبير تسويق رقمي متخصص في السوق الإماراتي والخليجي. حلّل النشاط التجاري التالي وأنشئ تقريراً احترافياً مخصصاً بالعربية:

اسم الشركة: ${companyName}
نوع النشاط: ${businessType}
الموقع: ${[city, country].filter(Boolean).join("، ") || "غير محدد"}
ما يريد تحليله: ${targetLabels}
${linkLines ? `الروابط:\n${linkLines}` : "لا توجد روابط"}
عدد الموظفين: ${extra.employees || "غير محدد"} | عدد الفروع: ${extra.branches || "غير محدد"}
الميزانية التسويقية الشهرية: ${extra.budget || "غير محددة"}
لديه موقع إلكتروني: ${extra.hasWebsite ? "نعم" : "لا"} | لديه حملات إعلانية حالياً: ${extra.hasCampaigns ? "نعم" : "لا"}

أرجع JSON بهذا الهيكل فقط (كل النصوص بالعربية ومخصصة لهذا النشاط تحديداً):
{
  "healthScore": 72,
  "scores": { "marketing": 68, "seo": 61, "website": 70, "socialMedia": 75, "conversion": 58, "brand": 66 },
  "summary": "ملخص من 3-4 جمل عن الوضع الحالي وأكبر الفرص",
  "problems": ["مشكلة محددة وعملية", "..."],
  "opportunities": ["فرصة نمو محددة", "..."],
  "recommendations": [
    { "title": "عنوان التوصية", "priority": "high", "description": "وصف عملي مفصل", "impact": "الأثر المتوقع" }
  ],
  "plan30": ["إجراء الأسبوع 1", "إجراء الأسبوع 2", "..."],
  "plan90": ["هدف الشهر الأول", "هدف الشهر الثاني", "..."],
  "growthPotentialPercent": 32
}

اجعل problems من 6-10 عناصر، opportunities من 4-6، recommendations من 6-10 (priority: high/medium/low)، plan30 من 4-6، plan90 من 4-6. الدرجات واقعية بناءً على المعطيات (نشاط بلا موقع أو حملات يستحق درجات أقل). أرجع JSON صحيح فقط.`;

    const response = await openai.chat.completions.create({
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: "أنت مستشار نمو أعمال. أرجع JSON صحيح فقط." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");
    const report = normalizeReport(JSON.parse(content));
    if (!report) throw new Error("AI response failed schema validation");

    const [saved] = await db.insert(businessAudits).values({
      sessionId:   sid,
      ...(studentId !== null && { studentId }),
      name, email: email.toLowerCase(), phone, companyName,
      targets, businessType, country, city, links, extra, report,
    }).returning();

    // Use ctx.waitUntil (attached to req by the CF adapter) so the Resend HTTP
    // fetch is not killed when the Worker response resolves.
    (req as any).waitUntil?.(
      sendBusinessAuditNotification({
        name, email, phone, companyName, businessType,
        city: [city, country].filter(Boolean).join("، "),
        targets: targetLabels,
        healthScore: report.healthScore as number,
      }).then((delivered) => {
        if (!delivered) {
          console.error(`[business-audit] admin notification NOT delivered for audit #${saved.id} — check the dashboard`);
        }
      }),
    );

    res.json({ success: true, id: saved.id, report });
  } catch (err) {
    console.error("[business-audit] submit error:", err);
    if (quotaHolder) await releaseDailyQuota(quotaHolder, "business_audit", reservedDay || undefined);
    res.status(500).json({ success: false, error: "فشل التحليل — يرجى المحاولة مجدداً" });
  }
});

/* ── GET /api/business-audit ─────────────────────────────── */
router.get("/business-audit", async (req: Request, res: Response): Promise<void> => {
  try {
    const { sid, studentId } = await resolveOwner(req, res);
    const rows = await db.select({
      id:           businessAudits.id,
      companyName:  businessAudits.companyName,
      businessType: businessAudits.businessType,
      createdAt:    businessAudits.createdAt,
    })
      .from(businessAudits)
      .where(studentId !== null ? eq(businessAudits.studentId, studentId) : eq(businessAudits.sessionId, sid))
      .orderBy(desc(businessAudits.createdAt))
      .limit(20);
    res.json({ success: true, audits: rows });
  } catch (err) {
    console.error("[business-audit] list error:", err);
    res.status(500).json({ success: false, audits: [] });
  }
});

/* ── GET /api/business-audit/:id ─────────────────────────── */
router.get("/business-audit/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { badRequest(res, "معرّف غير صالح"); return; }
    const { sid, studentId } = await resolveOwner(req, res);
    const [row] = await db.select()
      .from(businessAudits)
      .where(and(
        eq(businessAudits.id, id),
        studentId !== null ? eq(businessAudits.studentId, studentId) : eq(businessAudits.sessionId, sid),
      ))
      .limit(1);
    if (!row) { res.status(404).json({ success: false, error: "التقرير غير موجود" }); return; }
    res.json({ success: true, audit: row });
  } catch (err) {
    console.error("[business-audit] get error:", err);
    res.status(500).json({ success: false, error: "حدث خطأ" });
  }
});

export default router;
