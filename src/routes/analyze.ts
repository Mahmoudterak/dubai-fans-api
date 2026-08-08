import { Router, type IRouter } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { AnalyzeBusinessBody } from "@workspace/api-zod";
import { analyzeLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();

// Apply rate limiting: 3 requests per 5 minutes per IP
router.use("/analyze", analyzeLimiter);

const PLATFORM_LABELS: Record<string, string> = {
  website: "موقع إلكتروني",
  instagram: "إنستغرام",
  facebook: "فيسبوك",
  tiktok: "تيك توك",
  snapchat: "سناب شات",
  google: "جوجل ماي بيزنس",
};

router.post("/analyze", async (req, res): Promise<void> => {
  const parsed = AnalyzeBusinessBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { url, platformType, businessName } = parsed.data;
  const platformLabel = PLATFORM_LABELS[platformType] ?? platformType;

  const systemPrompt = `أنت خبير تسويق رقمي متخصص في السوق الإماراتي. مهمتك تحليل النشاط التجاري بناءً على رابط المنصة وتقديم توصيات عملية واضحة.

قدّم تحليلك بالعربية الفصحى البسيطة. التوصيات يجب أن تكون عملية ومباشرة مثل:
- تشغيل حملات إعلانية على فيسبوك وإنستغرام لمدة شهر
- زيادة المتابعين والتفاعل على الحساب
- تحسين تصميم الموقع وسرعته
- إنشاء محتوى منتظم ومتنوع
- تحسين الهوية البصرية والجرافيك

يجب أن يكون ردك بتنسيق JSON صحيح فقط بدون أي نص خارجه.`;

  const userPrompt = `حلل هذا النشاط التجاري:
- المنصة: ${platformLabel}
- الرابط: ${url}
${businessName ? `- اسم النشاط: ${businessName}` : ""}

قدم التحليل بتنسيق JSON بالهيكل التالي:
{
  "score": رقم من 0 إلى 100 يمثل قوة الحضور الرقمي,
  "summary": "ملخص عام عن وضع النشاط التجاري رقمياً بجملتين",
  "strengths": ["نقطة قوة 1", "نقطة قوة 2", "نقطة قوة 3"],
  "weaknesses": ["نقطة ضعف 1", "نقطة ضعف 2", "نقطة ضعف 3"],
  "recommendations": [
    {
      "title": "عنوان التوصية",
      "description": "شرح تفصيلي للتوصية وكيفية تنفيذها",
      "priority": "high" أو "medium" أو "low",
      "category": "advertising" أو "followers" أو "content" أو "design" أو "seo" أو "engagement"
    }
  ]
}

قدم 4 إلى 6 توصيات مخصصة لهذا النوع من المنصة (${platformLabel}).`;

  try {
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
    if (!content) {
      res.status(500).json({ error: "لم نتمكن من إجراء التحليل، حاول مرة أخرى." });
      return;
    }

    const result = JSON.parse(content);
    res.json(result);
  } catch (err) {
    console.error("[analyze] Error analyzing business:", err);
    res.status(500).json({ error: "حدث خطأ أثناء التحليل، يرجى المحاولة لاحقاً." });
  }
});

export default router;
