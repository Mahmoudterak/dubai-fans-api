import { Router }                                    from "express";
import { randomUUID }                               from "crypto";
import { resolveStudentId }                         from "./student-auth";
import { openai }                                   from "@workspace/integrations-openai-ai-server";
import { db, aiAudits, aiPlans, conversations, messages, aibosLeads } from "@workspace/db";
import { eq, and, desc, isNull }                    from "drizzle-orm";
import { sendAibosLeadNotification }                from "../lib/mailer.js";
import { aibosLeadsLimiter }                        from "../middlewares/rate-limit.js";
import { reserveDailyQuota, releaseDailyQuota }     from "../lib/ai-quota.js";
import type { QuotaKind }                           from "../lib/ai-quota.js";

const router = Router();

/* ── Daily AI quotas ─────────────────────────────────────── */
const AUDIT_LIMIT_ANON    = 3;   // audits per day for anonymous users (IP-keyed)
const PLAN_LIMIT_ANON     = 3;   // plans per day for anonymous users (IP-keyed)
const CHAT_LIMIT_ANON     = 20;  // chat messages per day for anonymous users
const STUDENT_DAILY_LIMIT = 10;  // audits/plans per day for logged-in students

/** Seconds remaining until local midnight (when daily quotas reset). */
function secondsUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

/** Quota principal: student ID when logged in, client IP otherwise. */
function quotaPrincipal(req: any, studentId: number | null): string {
  if (studentId !== null) return `student:${studentId}`;
  // Use only the proxy-validated req.ip — raw X-Forwarded-For is spoofable.
  // Express (with `trust proxy = 1`) derives req.ip from the RIGHTMOST
  // X-Forwarded-For entry, which the trusted reverse proxy appends and which
  // a client cannot forge.  Reading the header directly and taking the
  // LEFTMOST entry lets any caller prepend an arbitrary IP and mint a fresh
  // anonymous quota per request.
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * Atomically reserve one unit of today's quota for the caller.
 * Returns the principal on success; sends a 429 with `retryAfter` and
 * returns null when the daily cap is reached.
 */
async function reserveOrReject(
  req: any,
  res: any,
  studentId: number | null,
  kind: QuotaKind,
  anonLimit: number,
): Promise<string | null> {
  const principal = quotaPrincipal(req, studentId);
  const limit = studentId !== null ? STUDENT_DAILY_LIMIT : anonLimit;
  const ok = await reserveDailyQuota(principal, kind, limit);
  if (!ok) {
    const error =
      studentId === null && kind === "chat"
        ? "وصلت للحد اليومي المسموح للمحادثة — سجّل الدخول للحصول على حد أعلى أو حاول مجدداً غداً"
        : "وصلت للحد اليومي المسموح — حاول مجدداً غداً";
    res.status(429).json({
      success:      false,
      limitReached: true,
      error,
      retryAfter:   secondsUntilMidnight(),
    });
    return null;
  }
  return principal;
}

/* ── Anonymous session cookie ────────────────────────────── */
const SESSION_COOKIE     = "aib_sid";
const COOKIE_TTL         = 365 * 24 * 60 * 60 * 1000;   // 1 year
const STUDENT_COOKIE     = "df_student_session";

function getOrCreateSession(req: any, res: any): string {
  const existing = req.cookies?.[SESSION_COOKIE] as string | undefined;
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

/**
 * Reads the student session cookie without enforcing auth.
 * Returns the numeric student ID if the token is valid, otherwise null.
 */
function getOptionalStudentId(req: any): number | null {
  // Delegates to student-auth's resolveStudentId so the signed-token format
  // (versioned 4-segment tokens) stays defined in one place.
  const id = resolveStudentId(req);
  return id !== null && id > 0 ? id : null;
}

/**
 * Claims all anonymous session rows for a logged-in student.
 * Runs on every authenticated AI-OS request so data accumulated before login
 * is immediately associated with the student account.
 */
async function claimSession(sid: string, studentId: number): Promise<void> {
  await Promise.all([
    db.update(aiAudits)
      .set({ studentId })
      .where(and(eq(aiAudits.sessionId, sid), isNull(aiAudits.studentId))),
    db.update(aiPlans)
      .set({ studentId })
      .where(and(eq(aiPlans.sessionId, sid), isNull(aiPlans.studentId))),
    db.update(conversations)
      .set({ studentId })
      .where(and(eq(conversations.sessionId, sid), isNull(conversations.studentId))),
  ]);
}

/**
 * Resolves both the anonymous session ID and the optional student ID.
 * When a student is logged in, claims any unclaimed session data first.
 */
async function resolveOwner(req: any, res: any): Promise<{ sid: string; studentId: number | null }> {
  const sid       = getOrCreateSession(req, res);
  const studentId = getOptionalStudentId(req);
  if (studentId !== null) {
    await claimSession(sid, studentId);
  }
  return { sid, studentId };
}

/* ── Audit input validation ──────────────────────────────── */
const AUDIT_TYPE_LABELS: Record<string, string> = {
  website:        "الموقع الإلكتروني",
  instagram:      "حساب Instagram",
  facebook:       "صفحة Facebook",
  tiktok:         "حساب TikTok",
  google_business:"Google Business Profile",
  business:       "النشاط التجاري بالكامل",
  competitors:    "تحليل المنافسين",
};

/* ── POST /api/ai-business-os/audit ──────────────────────── */
router.post("/ai-business-os/audit", async (req, res) => {
  let quotaHolder: string | null = null;
  try {
    const body = req.body ?? {};
    const { type } = body;

    /* ── Validate inputs BEFORE reserving quota or calling OpenAI ── */
    if (!type || typeof type !== "string") {
      res.status(400).json({ success: false, error: "نوع التحليل مطلوب — اختر ما تريد تحليله أولاً" });
      return;
    }
    if (!(type in AUDIT_TYPE_LABELS)) {
      res.status(400).json({ success: false, error: "نوع التحليل غير معروف — اختر نوعاً من القائمة المتاحة" });
      return;
    }
    if (body.url !== undefined && (typeof body.url !== "string" || body.url.length > 500)) {
      res.status(400).json({ success: false, error: "الرابط غير صالح — يجب أن يكون نصاً لا يتجاوز 500 حرف" });
      return;
    }
    if (body.businessName !== undefined && (typeof body.businessName !== "string" || body.businessName.length > 150)) {
      res.status(400).json({ success: false, error: "اسم النشاط غير صالح — يجب أن يكون نصاً لا يتجاوز 150 حرفاً" });
      return;
    }
    const url          = (body.url ?? "").trim();
    const businessName = (body.businessName ?? "").trim() || "نشاطي التجاري";

    const { sid, studentId } = await resolveOwner(req, res);

    quotaHolder = await reserveOrReject(req, res, studentId, "audit", AUDIT_LIMIT_ANON);
    if (quotaHolder === null) return;

    const typeLabel = AUDIT_TYPE_LABELS[type];

    const prompt = `أنت خبير تسويق رقمي متخصص في السوق الإماراتي والعربي. قم بإجراء تحليل احترافي ومفصل لـ:

النشاط التجاري: ${businessName}
نوع التحليل: ${typeLabel}
${url ? `الرابط/المعرّف: ${url}` : ""}

أرجع JSON بهذا الهيكل فقط:
{
  "overallScore": 78,
  "grade": "B+",
  "scores": {
    "seo": 82,
    "content": 74,
    "performance": 88,
    "socialPresence": 71,
    "branding": 85,
    "engagement": 69
  },
  "strengths": [
    "نقطة قوة مفصلة باللغة العربية",
    "نقطة قوة ثانية",
    "نقطة قوة ثالثة"
  ],
  "issues": [
    "مشكلة مفصلة باللغة العربية",
    "مشكلة ثانية",
    "مشكلة ثالثة"
  ],
  "recommendations": [
    {
      "title": "عنوان التوصية",
      "priority": "high",
      "description": "وصف تفصيلي ومفيد للتوصية بالعربية",
      "impact": "التأثير المتوقع على الأعمال",
      "timeframe": "1-2 أسابيع"
    },
    {
      "title": "توصية ثانية",
      "priority": "medium",
      "description": "وصف التوصية الثانية",
      "impact": "التأثير المتوقع",
      "timeframe": "شهر واحد"
    },
    {
      "title": "توصية ثالثة",
      "priority": "low",
      "description": "وصف التوصية الثالثة",
      "impact": "تحسين طويل المدى",
      "timeframe": "2-3 أشهر"
    }
  ],
  "quickWins": ["إجراء سريع 1", "إجراء سريع 2", "إجراء سريع 3"],
  "summary": "ملخص التحليل في جملتين أو ثلاث يوضح الوضع الحالي وأهم الفرص",
  "industryBenchmark": 72
}

أرجع JSON صحيح فقط. اجعل المحتوى مخصصاً للسوق الإماراتي وباللغة العربية.`;

    const response = await openai.chat.completions.create({
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      max_completion_tokens: 2500,
      messages: [
        { role: "system", content: "أنت خبير تسويق رقمي. أرجع JSON صحيح فقط." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");

    const analysis = JSON.parse(content);

    /* ── Persist to DB ── */
    const [saved] = await db.insert(aiAudits).values({
      sessionId:    sid,
      ...(studentId !== null && { studentId }),
      type,
      url,
      businessName,
      analysis,
    }).returning();

    res.json({ success: true, analysis, type, url, businessName, id: saved.id });
  } catch (err) {
    console.error("[ai-business-os] audit error:", err);
    if (quotaHolder) await releaseDailyQuota(quotaHolder, "audit");
    res.status(500).json({ success: false, error: "فشل التحليل — يرجى المحاولة مجدداً" });
  }
});

/* ── GET /api/ai-business-os/audits ──────────────────────── */
router.get("/ai-business-os/audits", async (req, res) => {
  try {
    const { sid, studentId } = await resolveOwner(req, res);
    const rows = await db.select()
      .from(aiAudits)
      .where(
        studentId !== null
          ? eq(aiAudits.studentId, studentId)
          : eq(aiAudits.sessionId, sid),
      )
      .orderBy(desc(aiAudits.createdAt))
      .limit(20);
    res.json({ success: true, audits: rows });
  } catch (err) {
    console.error("[ai-business-os] audits list error:", err);
    res.status(500).json({ success: false, audits: [] });
  }
});

/* ── POST /api/ai-business-os/chat (SSE streaming) ────────── */
router.post("/ai-business-os/chat", async (req, res) => {
  let quotaHolder: string | null = null;
  try {
    const body = req.body ?? {};
    const { message, history = [], businessContext = "", conversationId } = body;

    /* ── Validate inputs BEFORE reserving quota or calling OpenAI ── */
    if (typeof message !== "string" || message.trim().length === 0) {
      res.status(400).json({ success: false, error: "الرسالة مطلوبة — اكتب رسالتك أولاً" });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ success: false, error: "الرسالة طويلة جداً — الحد الأقصى 4000 حرف" });
      return;
    }
    if (
      !Array.isArray(history) ||
      history.some(
        (m: unknown) =>
          typeof m !== "object" || m === null ||
          typeof (m as { role?: unknown }).role !== "string" ||
          !["user", "assistant"].includes((m as { role: string }).role) ||
          typeof (m as { content?: unknown }).content !== "string",
      )
    ) {
      res.status(400).json({ success: false, error: "سجل المحادثة غير صالح — يجب أن يكون قائمة رسائل نصية" });
      return;
    }
    if (typeof businessContext !== "string" || businessContext.length > 2000) {
      res.status(400).json({ success: false, error: "سياق النشاط غير صالح — يجب أن يكون نصاً لا يتجاوز 2000 حرف" });
      return;
    }
    if (
      conversationId !== undefined &&
      conversationId !== null &&
      (!Number.isInteger(Number(conversationId)) || Number(conversationId) <= 0)
    ) {
      res.status(400).json({ success: false, error: "رقم المحادثة غير صالح — يجب أن يكون رقماً صحيحاً موجباً" });
      return;
    }

    const { sid, studentId } = await resolveOwner(req, res);

    // Anonymous chat quota (headers not yet sent, so a JSON 429 is still possible)
    if (studentId === null) {
      quotaHolder = await reserveOrReject(req, res, studentId, "chat", CHAT_LIMIT_ANON);
      if (quotaHolder === null) return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    /* ── Find or create conversation in DB ── */
    let convId: number;
    if (conversationId) {
      // Verify ownership — accept if conversation belongs to this student OR session
      const [existing] = await db.select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, Number(conversationId)),
            studentId !== null
              ? eq(conversations.studentId, studentId)
              : eq(conversations.sessionId, sid),
          ),
        );
      if (!existing) {
        res.status(403).json({ success: false, error: "غير مصرح" });
        return;
      }
      convId = existing.id;
    } else {
      const title = message.slice(0, 60);
      const [newConv] = await db.insert(conversations)
        .values({
          sessionId: sid,
          ...(studentId !== null && { studentId }),
          title,
        })
        .returning();
      convId = newConv.id;
    }

    /* ── Save user message ── */
    await db.insert(messages).values({ conversationId: convId, role: "user", content: message });

    /* ── Emit conversation ID as metadata first ── */
    res.write(`data: ${JSON.stringify({ meta: { conversationId: convId } })}\n\n`);

    const systemPrompt = `أنت مستشار أعمال ذكي متخصص في التسويق الرقمي والأعمال التجارية في الإمارات والعالم العربي.
اسمك "AI Consultant" — جزء من منصة AI Business OS بدبي فانز.
${businessContext ? `سياق النشاط التجاري: ${businessContext}` : ""}
قواعدك:
- أجب دائماً بالعربية الفصيحة السهلة
- قدم نصائح عملية وقابلة للتطبيق فوراً
- استخدم أمثلة حقيقية من السوق الإماراتي والخليجي
- أذكر أرقاماً وإحصاءات واقعية عند الإمكان
- إذا سألك أحد عمّن أنت، قل أنك مستشار أعمال AI من AI Business OS
- لا تذكر OpenAI أو أي شركة تقنية أخرى
- ابقَ إيجابياً وداعماً ومشجعاً`;

    const chatMessages = [
      { role: "system" as const, content: systemPrompt },
      ...(history as { role: string; content: string }[])
        .slice(-12)
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      { role: "user" as const, content: message },
    ];

    const stream = await openai.chat.completions.create({
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      max_completion_tokens: 1500,
      messages: chatMessages,
      stream: true,
    });

    let fullResponse = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullResponse += delta;
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }

    /* ── Save assistant response ── */
    if (fullResponse) {
      await db.insert(messages).values({
        conversationId: convId,
        role:    "assistant",
        content: fullResponse,
      });
    }

    /* ── Update conversation title if first message ── */
    if (!conversationId) {
      await db.update(conversations)
        .set({ title: message.slice(0, 60) })
        .where(eq(conversations.id, convId));
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error("[ai-business-os] chat error:", err);
    if (quotaHolder) await releaseDailyQuota(quotaHolder, "chat");
    res.write(`data: ${JSON.stringify({ error: "فشل الاتصال — يرجى المحاولة مجدداً" })}\n\n`);
    res.end();
  }
});

/* ── GET /api/ai-business-os/conversations ───────────────── */
router.get("/ai-business-os/conversations", async (req, res) => {
  try {
    const { sid, studentId } = await resolveOwner(req, res);
    const rows = await db.select()
      .from(conversations)
      .where(
        studentId !== null
          ? eq(conversations.studentId, studentId)
          : eq(conversations.sessionId, sid),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(30);
    res.json({ success: true, conversations: rows });
  } catch (err) {
    console.error("[ai-business-os] conversations list error:", err);
    res.status(500).json({ success: false, conversations: [] });
  }
});

/* ── GET /api/ai-business-os/conversations/:id ───────────── */
router.get("/ai-business-os/conversations/:id", async (req, res) => {
  try {
    const convId = Number(req.params.id);
    if (!Number.isInteger(convId) || convId <= 0) {
      res.status(400).json({ success: false, error: "رقم المحادثة غير صالح — يجب أن يكون رقماً صحيحاً موجباً" });
      return;
    }

    const { sid, studentId } = await resolveOwner(req, res);

    const [conv] = await db.select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, convId),
          studentId !== null
            ? eq(conversations.studentId, studentId)
            : eq(conversations.sessionId, sid),
        ),
      );

    if (!conv) {
      res.status(404).json({ success: false, error: "محادثة غير موجودة" });
      return;
    }

    const msgs = await db.select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);

    res.json({ success: true, conversation: conv, messages: msgs });
  } catch (err) {
    console.error("[ai-business-os] conversation detail error:", err);
    res.status(500).json({ success: false, error: "خطأ في الخادم" });
  }
});

/* ── POST /api/ai-business-os/plan ───────────────────────── */
router.post("/ai-business-os/plan", async (req, res) => {
  let quotaHolder: string | null = null;
  try {
    const body = req.body ?? {};

    /* ── Validate inputs BEFORE reserving quota or calling OpenAI ── */
    if (body.businessName !== undefined && (typeof body.businessName !== "string" || body.businessName.length > 150)) {
      res.status(400).json({ success: false, error: "اسم النشاط غير صالح — يجب أن يكون نصاً لا يتجاوز 150 حرفاً" });
      return;
    }
    if (body.businessType !== undefined && (typeof body.businessType !== "string" || body.businessType.length > 100)) {
      res.status(400).json({ success: false, error: "نوع النشاط غير صالح — يجب أن يكون نصاً لا يتجاوز 100 حرف" });
      return;
    }
    if (
      body.goals !== undefined &&
      !(typeof body.goals === "string" && body.goals.length <= 500) &&
      !(Array.isArray(body.goals) && body.goals.length <= 20 && body.goals.every((g: unknown) => typeof g === "string" && g.length <= 100))
    ) {
      res.status(400).json({ success: false, error: "الأهداف غير صالحة — أرسل قائمة نصية قصيرة بالأهداف" });
      return;
    }
    if (body.targetAudience !== undefined && (typeof body.targetAudience !== "string" || body.targetAudience.length > 300)) {
      res.status(400).json({ success: false, error: "وصف الجمهور المستهدف غير صالح — نص لا يتجاوز 300 حرف" });
      return;
    }

    const { sid, studentId } = await resolveOwner(req, res);

    quotaHolder = await reserveOrReject(req, res, studentId, "plan", PLAN_LIMIT_ANON);
    if (quotaHolder === null) return;

    const {
      businessName = "نشاطي التجاري",
      businessType = "خدمات",
      goals = [],
      duration = 30,
      budget = 0,
      targetAudience = "",
    } = body;

    // Coerce duration to a safe positive integer (default 30 days)
    const durationDays = Math.max(1, Math.min(365, Math.round(Number(duration)) || 30));

    const goalsText    = Array.isArray(goals) ? goals.join("، ") : String(goals);
    const durationLabel= durationDays === 30 ? "30 يوماً" : durationDays === 90 ? "90 يوماً" : `${durationDays} يوماً`;
    const weeksCount   = Math.min(Math.ceil(durationDays / 7), 4);

    const prompt = `أنت خبير استراتيجيات تسويق رقمي في الإمارات. أنشئ خطة تسويق احترافية ومفصلة:

النشاط: ${businessName}
القطاع: ${businessType}
الأهداف: ${goalsText}
المدة: ${durationLabel}
الميزانية: ${budget ? `${budget} درهم` : "لم تحدد"}
الجمهور: ${targetAudience || "عام"}

أرجع JSON فقط بهذا الهيكل:
{
  "overview": "نظرة عامة استراتيجية على الخطة (4-5 جمل مفيدة)",
  "channels": [
    {
      "name": "Instagram",
      "budgetPercentage": 35,
      "strategy": "استراتيجية المنصة",
      "frequency": "يومياً — منشور + ريلز",
      "kpi": "مؤشر الأداء الرئيسي",
      "color": "#E1306C"
    }
  ],
  "weeklyPlan": [
    {
      "week": 1,
      "theme": "موضوع الأسبوع الأول",
      "tasks": ["مهمة 1", "مهمة 2", "مهمة 3", "مهمة 4"],
      "contentIdeas": ["فكرة محتوى 1", "فكرة محتوى 2", "فكرة محتوى 3"]
    }
  ],
  "kpis": [
    { "name": "اسم المؤشر", "target": "الهدف الرقمي", "current": "الوضع الحالي" }
  ],
  "contentIdeas": [
    { "platform": "Instagram", "type": "ريلز", "idea": "فكرة مبتكرة", "cta": "دعوة للتصرف" }
  ],
  "tips": ["نصيحة استراتيجية مهمة 1", "نصيحة 2", "نصيحة 3"]
}

${weeksCount > 1 ? `مهم: أرجع ${weeksCount} أسابيع في weeklyPlan.` : ""}
أرجع JSON صحيح فقط. اجعل كل المحتوى مخصصاً للسوق الإماراتي.`;

    const response = await openai.chat.completions.create({
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      max_completion_tokens: 8000,
      messages: [
        { role: "system", content: "أنت خبير تسويق. أرجع JSON صحيح فقط." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");

    const plan = JSON.parse(content);

    /* ── Persist to DB ── */
    const [saved] = await db.insert(aiPlans).values({
      sessionId:    sid,
      ...(studentId !== null && { studentId }),
      businessName,
      duration:     durationDays,
      plan,
    }).returning();

    res.json({ success: true, plan, businessName, duration: durationDays, id: saved.id });
  } catch (err) {
    console.error("[ai-business-os] plan error:", err);
    if (quotaHolder) await releaseDailyQuota(quotaHolder, "plan");
    res.status(500).json({ success: false, error: "فشل إنشاء الخطة — يرجى المحاولة مجدداً" });
  }
});

/* ── GET /api/ai-business-os/plans ───────────────────────── */
router.get("/ai-business-os/plans", async (req, res) => {
  try {
    const { sid, studentId } = await resolveOwner(req, res);
    const rows = await db.select()
      .from(aiPlans)
      .where(
        studentId !== null
          ? eq(aiPlans.studentId, studentId)
          : eq(aiPlans.sessionId, sid),
      )
      .orderBy(desc(aiPlans.createdAt))
      .limit(10);
    res.json({ success: true, plans: rows });
  } catch (err) {
    console.error("[ai-business-os] plans list error:", err);
    res.status(500).json({ success: false, plans: [] });
  }
});

/* ── POST /api/ai-business-os/leads ──────────────────────── */
router.post("/ai-business-os/leads", aibosLeadsLimiter, async (req, res) => {
  try {
    const { name, email, businessType, city = "" } = req.body;

    // Basic validation + length limits
    if (!name || typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100) {
      res.status(400).json({ success: false, error: "الاسم مطلوب (2–100 حرف)" });
      return;
    }
    if (!email || typeof email !== "string" || !email.includes("@") || email.length > 200) {
      res.status(400).json({ success: false, error: "البريد الإلكتروني غير صحيح" });
      return;
    }
    if (!businessType || typeof businessType !== "string" || businessType.trim().length < 2 || businessType.trim().length > 100) {
      res.status(400).json({ success: false, error: "نوع النشاط مطلوب" });
      return;
    }
    if (city && (typeof city !== "string" || city.length > 100)) {
      res.status(400).json({ success: false, error: "اسم المدينة طويل جداً" });
      return;
    }

    const [saved] = await db.insert(aibosLeads).values({
      name:         name.trim(),
      email:        email.trim().toLowerCase(),
      businessType: businessType.trim(),
      city:         (city ?? "").trim(),
    }).returning();

    // Fire-and-forget admin notification
    sendAibosLeadNotification({
      name:         saved.name,
      email:        saved.email,
      businessType: saved.businessType,
      city:         saved.city,
    });

    res.json({ success: true, id: saved.id });
  } catch (err) {
    console.error("[ai-business-os] leads error:", err);
    res.status(500).json({ success: false, error: "حدث خطأ — يرجى المحاولة مجدداً" });
  }
});

export default router;
