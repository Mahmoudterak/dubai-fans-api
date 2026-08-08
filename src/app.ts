import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import router from "./routes";
import { logger } from "./lib/logger";
import { getSitemapXml, rebuildSitemap } from "./lib/sitemap";
import { NOTIFICATIONS_HTML } from "./lib/notifications-html.js";

const ROBOTS_TXT = `User-agent: *
Allow: /

# Explicitly allow AI crawlers for citation indexing
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: Googlebot-Extended
Allow: /

User-agent: YouBot
Allow: /

# Block admin/private paths for all
Disallow: /api/

# Sitemap
Sitemap: https://mtuaefans.com/sitemap.xml`;

const LLMS_TXT = `# دبي فانز — Dubai Fans Digital Marketing Agency
> وكالة تسويق رقمي متخصصة في الإمارات العربية المتحدة. نقدم خدمات إدارة الإعلانات المدفوعة على Meta وGoogle وTikTok وSnapchat، تصميم المواقع والمتاجر الإلكترونية، تحسين محركات البحث SEO، الهوية البصرية، وإدارة السوشيال ميديا. موقعنا: mtuaefans.com

## الخدمات الرئيسية

- [جميع الخدمات](https://mtuaefans.com/services)
- [إعلانات فيسبوك وإنستغرام — Meta Ads](https://mtuaefans.com/services/meta-ads-dubai)
- [إعلانات جوجل — Google Ads UAE](https://mtuaefans.com/services/google-ads-uae)
- [إعلانات تيك توك — TikTok Ads](https://mtuaefans.com/services/tiktok-ads-uae)
- [إعلانات سناب شات — Snapchat Ads](https://mtuaefans.com/services/snapchat-ads-dubai)
- [إعلانات لينكدإن — LinkedIn Ads](https://mtuaefans.com/services/linkedin-ads-uae)
- [تحسين محركات البحث — SEO دبي](https://mtuaefans.com/services/seo-dubai)
- [إدارة السوشيال ميديا](https://mtuaefans.com/services/social-media-management)
- [تصميم المواقع الإلكترونية](https://mtuaefans.com/services/website-design-dubai)

## الأسعار والباقات

- [باقات التسويق الرقمي والمتجر](https://mtuaefans.com/store#pricing)

## أدوات مجانية

- [أدوات تسويق رقمي مجانية](https://mtuaefans.com/tools) — مولّد كلمات مفتاحية، حاسبة ROI وROAS، مولّد هاشتاجات، فاحص سيو، مولّد رابط واتساب
- [تحليل مجاني بالذكاء الاصطناعي](https://mtuaefans.com/analyze) — تحليل موقعك أو حسابات السوشيال ميديا

## المدونة — مقالات التسويق الرقمي

- [مدونة التسويق الرقمي](https://mtuaefans.com/blog)
- [صفحة الهبوط تُدرّب ذكاء جوجل: كيف تختار الصور لتحسين أداء حملات Performance Max](https://mtuaefans.com/blog/landing-page-images-performance-max-guide)
- [PPC مقابل SEO: أيهما يحقق عائدًا أفضل على الاستثمار في الإمارات؟](https://mtuaefans.com/blog/ppc-vs-seo-uae-roi-2026)
- [تكلفة خدمات التسويق الرقمي ووكالات إعلانات الدفع مقابل النقرة في دبي 2026](https://mtuaefans.com/blog/digital-marketing-costs-dubai-2026)
- [أسباب خسارة الشركات في الإمارات للعملاء المحتملين بسبب ضعف تصميم المواقع في 2026](https://mtuaefans.com/blog/website-design-leads-uae-2026)
- [إعلاناتك المدفوعة في دبي تهدر أموالك — إليك كيف توقف ذلك](https://mtuaefans.com/blog/paid-ads-dubai-wasting-money)
- [ChatGPT مقابل جوجل في 2026: ما الذي تقوله البيانات فعلاً؟](https://mtuaefans.com/blog/chatgpt-vs-google-2026-data)
- [خدمات SEO في دبي: كيف تساعدك على الظهور في نتائج Google AI Overview (دليل 2026)](https://mtuaefans.com/blog/seo-dubai-google-ai-overview-2026)
- [خدمات السيو بالذكاء الاصطناعي للشركات الصغيرة — منافسة الكبار في 2026](https://mtuaefans.com/blog/ai-seo-small-business-2026)
- [أفضل أوقات النشر على وسائل التواصل الاجتماعي | دليل 2026 المحدث](https://mtuaefans.com/blog/best-posting-times-social-media-2026)
- [أبرز اتجاهات السوشيال ميديا التي لا يمكن للشركات في الإمارات تجاهلها في 2026](https://mtuaefans.com/blog/uae-social-media-trends-2026)
- [أفضل أدوات التسويق الرقمي في 2025: الدليل الشامل لأصحاب الأعمال](https://mtuaefans.com/blog/best-digital-marketing-tools-2025-complete-guide)
- [كيف تختار وكالة تسويق رقمي في الإمارات؟](https://mtuaefans.com/blog/how-to-choose-digital-marketing-agency-uae)
- [أفضل منصات الإعلانات المدفوعة في 2025: فيسبوك أم جوجل؟](https://mtuaefans.com/blog/best-paid-ads-platforms-2025-facebook-vs-google)
- [كيف تزيد متابعيك على إنستغرام بشكل حقيقي في 2025](https://mtuaefans.com/blog/how-to-increase-instagram-followers-organically-2025)
- [دليل تصميم الهوية البصرية للشركات الناشئة في الخليج](https://mtuaefans.com/blog/brand-identity-design-guide-startups-gcc)
- [لماذا يحتاج مطعمك في دبي إلى موقع إلكتروني احترافي؟](https://mtuaefans.com/blog/why-dubai-restaurant-needs-professional-website)
- [تيك توك للأعمال: كيف تحوّل فيديو 60 ثانية إلى مبيعات؟](https://mtuaefans.com/blog/tiktok-for-business-60-seconds-to-sales)

## عن الوكالة

- [من نحن](https://mtuaefans.com/about)
- [أعمالنا ومشاريعنا](https://mtuaefans.com/projects)
- [اتصل بنا](https://mtuaefans.com/contact)

## التواصل

- الهاتف / واتساب: +971 55 198 1564
- البريد الإلكتروني: info@mtuaefans.com
- العنوان: دبي، الإمارات العربية المتحدة`;

const app: Express = express();

// ── Trust exactly one proxy hop (reverse proxy / Railway / Cloudflare) ────────
// Makes Express derive req.ip from X-Forwarded-For correctly.
app.set("trust proxy", 1);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ── www → non-www 301 redirect ────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = req.hostname;
  if (host.startsWith("www.")) {
    const canonical = `https://${host.slice(4)}${req.url}`;
    res.redirect(301, canonical);
    return;
  }
  next();
});

// Allow credentialed requests only from known origins. Never reflect an arbitrary Origin.
const ALLOWED_ORIGINS = new Set<string>([
  "https://mtuaefans.com",
  "https://www.mtuaefans.com",
  "https://dubai-fans-website.pages.dev",
  // Optional: inject one extra origin at runtime (e.g. a Cloudflare Pages branch preview)
  ...(process.env.EXTRA_CORS_ORIGIN
    ? [process.env.EXTRA_CORS_ORIGIN]
    : []),
  // Development
  ...(process.env.NODE_ENV !== "production"
    ? ["http://localhost:5173", "http://localhost:4173"]
    : []),
]);

/**
 * Strict credentialed-CORS middleware.
 *
 * - Trusted origins → full ACAO + ACAC + method/header grants.
 * - Untrusted origins → zero CORS headers (no credentials, no ACAO echo).
 * - OPTIONS preflight for trusted origins → 204; for untrusted → 204 without headers.
 * - Requests with no Origin header (same-origin, server-to-server) → pass through.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Prevent caching of HTML pages — always serve fresh content
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// Serve sitemap.xml and robots.txt with correct content-type
// (bypasses the SPA /* → index.html rewrite rule)
app.get("/sitemap.xml", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  // 1 hour — short enough that a fresh rebuild is visible promptly
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(getSitemapXml());
});

app.get("/robots.txt", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(ROBOTS_TXT);
});

app.get("/llms.txt", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(LLMS_TXT);
});

// Old AMLAK OS paths — return 410 Gone so Google removes them from the index faster
const AMLAK_OS_GONE_PATHS = [
  "/dashboard",
  "/properties",
  "/units",
  "/tenants",
  "/landlords",
  "/owners",
  "/contracts",
  "/leases",
  "/payments",
  "/maintenance",
  "/reports",
  "/buildings",
  "/users",
  "/settings",
  "/login",
  "/register",
  "/signup",
  "/profile",
  "/invoices",
  "/receipts",
  "/notifications",
  "/requests",
  "/amenities",
  "/floors",
  "/areas",
  "/expenses",
];

// Middleware: match any request whose path equals or starts with a legacy AMLAK OS prefix.
// Uses a plain string startsWith check to stay compatible with Express 5 / path-to-regexp v8
// which no longer accepts bare wildcards like "/*".
app.use((req: Request, res: Response, next) => {
  const urlPath = req.path;
  const isLegacy = AMLAK_OS_GONE_PATHS.some(
    (p) => urlPath === p || urlPath.startsWith(`${p}/`),
  );
  if (isLegacy) {
    res.status(410).json({
      status: 410,
      error: "Gone",
      message:
        "This page no longer exists. The AMLAK OS platform has been permanently removed.",
    });
    return;
  }
  next();
});

// Internal webhook: rebuild the sitemap without a server restart.
// Requires the Authorization header to match the SESSION_SECRET env var.
app.post("/api/sitemap/rebuild", async (req: Request, res: Response) => {
  const secret = process.env.SESSION_SECRET;
  const auth = req.headers["authorization"];

  if (!secret || auth !== `Bearer ${secret}`) {
    res.status(401).json({ status: 401, error: "Unauthorized" });
    return;
  }

  await rebuildSitemap();
  logger.info("sitemap rebuilt via /api/sitemap/rebuild");
  res.json({ status: "ok", message: "Sitemap rebuilt successfully." });
});

app.use("/api", router);

// ── Admin notifications page ──────────────────────────────────────────────────
app.get("/api/admin/notifications", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(NOTIFICATIONS_HTML);
});

export default app;
