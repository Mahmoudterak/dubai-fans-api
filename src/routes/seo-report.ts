import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db, seoLeads } from "@workspace/db";
import { aiToolsLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();

router.use("/seo-report", aiToolsLimiter);

function validate(body: Record<string, unknown>): string | null {
  const { firstName, lastName, email, phone, country, websiteUrl } = body;
  if (!firstName || !lastName)        return "الاسم مطلوب.";
  if (!email || !(email as string).includes("@")) return "البريد الإلكتروني غير صحيح.";
  if (!phone)                          return "رقم الهاتف مطلوب.";
  if (!websiteUrl)                     return "رابط الموقع مطلوب.";
  try { new URL(websiteUrl as string); } catch { return "رابط الموقع غير صحيح."; }
  if (!country) body.country = "United Arab Emirates";
  return null;
}

async function runSeoAudit(url: string) {
  // Try to fetch page head for real signals
  let pageContent = "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const fetchRes = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "DubaiFans-SEO-Checker/1.0" },
    });
    clearTimeout(timeout);
    const html = await fetchRes.text();
    const headMatch = html.match(/<head[\s\S]*?<\/head>/i);
    pageContent = headMatch
      ? headMatch[0].slice(0, 4000)
      : html.slice(0, 4000);
  } catch {
    pageContent = `تعذّر الوصول إلى الموقع: ${url} — قدّم توصيات عامة بناءً على عنوان URL فقط.`;
  }

  const response = await openai.chat.completions.create({
    model: process.env.AI_MODEL ?? "gpt-4o-mini",
    max_completion_tokens: 2048,
    messages: [
      {
        role: "system",
        content:
          "أنت خبير SEO تقني. بناءً على محتوى الصفحة المقدم، قيّم الموقع وأعطِ تقريراً عملياً. أجب بـ JSON فقط بالعربية.",
      },
      {
        role: "user",
        content: `الرابط: ${url}
محتوى head الصفحة:
${pageContent}

أنشئ تقرير SEO بالهيكل:
{
  "score": رقم من 0 إلى 100,
  "checks": [
    {
      "name": "اسم الفحص بالعربية",
      "status": "pass|warning|fail",
      "message": "شرح النتيجة",
      "impact": "high|medium|low"
    }
  ],
  "quickWins": ["إجراء سريع 1", "إجراء سريع 2"]
}
افحص: وجود title tag وطوله، meta description، HTTPS، سرعة متوقعة، Open Graph، بنية URL. قدّم 5-7 فحوصات و3-5 إجراءات سريعة.`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response");
  return JSON.parse(content) as {
    score: number;
    checks: { name: string; status: string; message: string; impact: string }[];
    quickWins: string[];
  };
}

router.post("/seo-report", async (req, res): Promise<void> => {
  const err = validate(req.body as Record<string, unknown>);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }

  const { firstName, lastName, email, phone, websiteUrl } = req.body as Record<string, string>;
  const country = (req.body as Record<string, string>).country || "United Arab Emirates";

  try {
    const audit = await runSeoAudit(websiteUrl);

    // Save lead + audit result to database
    await db.insert(seoLeads).values({
      firstName,
      lastName,
      email,
      phone,
      country,
      websiteUrl,
      auditScore: audit.score,
      auditResult: audit as unknown as Record<string, unknown>,
    });

    res.json(audit);
  } catch (err) {
    console.error("[seo-report] error:", err);
    res.status(500).json({ error: "حدث خطأ أثناء التدقيق، يرجى المحاولة مجدداً." });
  }
});

export default router;
