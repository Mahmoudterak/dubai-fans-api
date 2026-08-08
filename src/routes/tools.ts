import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  GenerateKeywordsBody,
  GenerateMetaBody,
  AuditSeoBody,
  GenerateContentIdeasBody,
  GenerateHashtagsBody,
} from "@workspace/api-zod";
import { aiToolsLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();

// Apply rate limiting to all AI tool endpoints
router.use("/tools", aiToolsLimiter);

// ── Helper ────────────────────────────────────────────────────────────────────
async function askAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: process.env.AI_MODEL ?? "gpt-4o-mini",
    max_completion_tokens: 2048,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response");
  return content;
}

// ── 1. Keyword Generator ──────────────────────────────────────────────────────
router.post("/tools/keywords", async (req, res): Promise<void> => {
  const parsed = GenerateKeywordsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { keyword, language = "ar" } = parsed.data;
  const lang = language === "ar" ? "العربية" : "English";

  try {
    const raw = await askAI(
      `أنت خبير SEO. أجب فقط بـ JSON صحيح دون أي نص خارجه. اللغة المطلوبة: ${lang}.`,
      `للكلمة المفتاحية الأساسية: "${keyword}"
أعطني JSON بالهيكل:
{
  "keywords": [
    { "keyword": "...", "intent": "informational|commercial|transactional|navigational", "difficulty": "easy|medium|hard" }
  ],
  "questions": ["سؤال 1", "سؤال 2", ...],
  "longtail": ["كلمة طويلة 1", "كلمة طويلة 2", ...]
}
أريد 8 كلمات رئيسية، 6 أسئلة يبحث عنها الناس، 6 كلمات مفتاحية طويلة. كل النتائج بـ ${lang}.`
    );
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("[tools] keywords tool error:", err);
    res.status(500).json({ error: "حدث خطأ، يرجى المحاولة لاحقاً." });
  }
});

// ── 2. Meta Title & Description Generator ─────────────────────────────────────
router.post("/tools/meta", async (req, res): Promise<void> => {
  const parsed = GenerateMetaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { topic, language = "ar" } = parsed.data;
  const lang = language === "ar" ? "العربية" : "English";

  try {
    const raw = await askAI(
      `أنت خبير SEO ومتخصص في كتابة عناوين ووصف تعريفي (Meta) يحقق أعلى نسبة نقر (CTR). أجب فقط بـ JSON صحيح. اللغة: ${lang}.`,
      `الموضوع / عنوان الصفحة: "${topic}"
أنشئ 3 نسخ مختلفة من العنوان التعريفي والوصف التعريفي.
JSON المطلوب:
{
  "variants": [
    {
      "title": "عنوان لا يتجاوز 60 حرفاً",
      "description": "وصف بين 140-160 حرفاً",
      "titleLength": رقم,
      "descriptionLength": رقم
    }
  ]
}
اجعل كل نسخة بأسلوب مختلف: الأولى إعلامية، الثانية مشوّقة بسؤال، الثالثة تحفيزية بفائدة مباشرة. اللغة: ${lang}.`
    );
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("[tools] meta tool error:", err);
    res.status(500).json({ error: "حدث خطأ، يرجى المحاولة لاحقاً." });
  }
});

// ── 3. SEO Audit ──────────────────────────────────────────────────────────────
router.post("/tools/seo-audit", async (req, res): Promise<void> => {
  const parsed = AuditSeoBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { url } = parsed.data;

  // Try to fetch the page for basic signals
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
    // Extract just the head for analysis (limit size)
    const headMatch = html.match(/<head[\s\S]*?<\/head>/i);
    pageContent = headMatch ? headMatch[0].slice(0, 4000) : html.slice(0, 4000);
  } catch {
    pageContent = `تعذّر الوصول إلى الموقع: ${url} — قدّم توصيات عامة بناءً على عنوان URL فقط.`;
  }

  try {
    const raw = await askAI(
      `أنت خبير SEO تقني. بناءً على محتوى الصفحة المقدم، قيّم الموقع وأعطِ تقريراً عملياً. أجب بـ JSON فقط بالعربية.`,
      `الرابط: ${url}
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
  "quickWins": ["إجراء سريع 1", "إجراء سريع 2", ...]
}
افحص: وجود title tag وطوله، meta description، بنية URL، سرعة الموقع (تخمين)، HTTPS، روابط كانونية، Open Graph، وأي مشاكل واضحة. قدّم 5-8 فحوصات و3-5 إجراءات سريعة. بالعربية.`
    );
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("[tools] seo-audit tool error:", err);
    res.status(500).json({ error: "حدث خطأ، يرجى المحاولة لاحقاً." });
  }
});

// ── 4. Content Ideas Generator ────────────────────────────────────────────────
router.post("/tools/content-ideas", async (req, res): Promise<void> => {
  const parsed = GenerateContentIdeasBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { niche } = parsed.data;

  try {
    const raw = await askAI(
      `أنت مدير إبداعي متخصص في محتوى السوشيال ميديا للسوق الإماراتي والخليجي. أجب بـ JSON فقط بالعربية.`,
      `المجال / نوع النشاط التجاري: "${niche}"
ولّد 10 أفكار محتوى متنوعة ومبتكرة لمنشورات السوشيال ميديا.
JSON المطلوب:
{
  "ideas": [
    {
      "idea": "عنوان الفكرة",
      "platform": "instagram|tiktok|facebook|all",
      "format": "reel|post|story|carousel",
      "hook": "الجملة الافتتاحية التي تجذب الانتباه"
    }
  ]
}
تنوّع في المنصات والأشكال. اجعل الأفكار عملية ومحددة لمجال "${niche}". الـ hook يجب أن يكون جذاباً وقابلاً للنشر مباشرة.`
    );
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("[tools] content-ideas tool error:", err);
    res.status(500).json({ error: "حدث خطأ، يرجى المحاولة لاحقاً." });
  }
});

// ── 5. Hashtag Generator ─────────────────────────────────────────────────────
router.post("/tools/hashtags", async (req, res): Promise<void> => {
  const parsed = GenerateHashtagsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { topic, platform = "both" } = parsed.data;
  const platformLabel = platform === "instagram" ? "إنستغرام" : platform === "tiktok" ? "تيك توك" : "إنستغرام وتيك توك";

  try {
    const raw = await askAI(
      `أنت خبير سوشيال ميديا متخصص في السوق الإماراتي والعربي. أجب بـ JSON فقط.`,
      `الموضوع: "${topic}" — المنصة: ${platformLabel}
ولّد هاشتاجات فعّالة ومتنوعة.
JSON المطلوب:
{
  "popular": ["#هاشتاج1", "#هاشتاج2", ...],
  "niche": ["#هاشتاج1", "#هاشتاج2", ...],
  "local": ["#هاشتاج1", "#هاشتاج2", ...],
  "all": ["#هاشتاج1", "#هاشتاج2", ...]
}
popular: 8 هاشتاجات واسعة الانتشار (ملايين المنشورات)
niche: 8 هاشتاجات تخصصية متعلقة بـ "${topic}" (آلاف-مئة ألف)
local: 6 هاشتاجات إماراتية وخليجية
all: الكل مجتمعاً جاهز للنسخ. استخدم العربية والإنجليزية بشكل مناسب.`
    );
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("[tools] hashtags tool error:", err);
    res.status(500).json({ error: "حدث خطأ، يرجى المحاولة لاحقاً." });
  }
});

export default router;
