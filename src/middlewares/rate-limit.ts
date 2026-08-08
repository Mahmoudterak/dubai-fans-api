/**
 * rate-limit.ts
 *
 * All limiters are wrapped with a lazy initialiser so that express-rate-limit's
 * MemoryStore (which calls setInterval) is only created inside a request handler,
 * never at module load time.  CF Workers forbids setInterval/setTimeout in global
 * scope; the lazy wrapper defers creation to the first actual request.
 */

import rateLimit, { type RequestHandler } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";

function lazy(factory: () => RequestHandler): RequestHandler {
  let handler: RequestHandler | null = null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!handler) handler = factory();
    handler(req, res, next);
  };
}

/**
 * AI Tools rate limiter — 10 requests per minute per IP.
 * Applied to: /api/tools/keywords, /api/tools/meta, /api/tools/seo-audit,
 *             /api/tools/content-ideas, /api/tools/hashtags
 */
export const aiToolsLimiter = lazy(() =>
  rateLimit({
    validate: { creationStack: false },
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error:
          "لقد تجاوزت الحد المسموح به. يرجى الانتظار دقيقة قبل المحاولة مجدداً.",
        retryAfter: 60,
      });
    },
  }),
);

/**
 * AI Business OS leads rate limiter — 5 submissions per hour per IP.
 * Applied to: POST /api/ai-business-os/leads
 */
export const aibosLeadsLimiter = lazy(() =>
  rateLimit({
    validate: { creationStack: false },
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: "لقد تجاوزت الحد المسموح به للتسجيل. يرجى المحاولة بعد ساعة.",
        retryAfter: 3600,
      });
    },
  }),
);

/**
 * Website orders rate limiter — 5 submissions per hour per IP.
 * Applied to: POST /api/website-orders
 */
export const websiteOrdersLimiter = lazy(() =>
  rateLimit({
    validate: { creationStack: false },
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: "لقد تجاوزت الحد المسموح به للطلبات. يرجى المحاولة بعد ساعة.",
        retryAfter: 3600,
      });
    },
  }),
);

/**
 * Business audit rate limiter — 3 submissions per hour per IP.
 * Applied to: POST /api/business-audit
 */
export const businessAuditLimiter = lazy(() =>
  rateLimit({
    validate: { creationStack: false },
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: "لقد تجاوزت الحد المسموح به لطلبات التحليل. يرجى المحاولة بعد ساعة.",
        retryAfter: 3600,
      });
    },
  }),
);

/**
 * Analyze endpoint rate limiter — 3 requests per 5 minutes per IP.
 * Applied to: /api/analyze
 */
export const analyzeLimiter = lazy(() =>
  rateLimit({
    validate: { creationStack: false },
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error:
          "لقد استنفدت طلبات التحليل المجانية. يرجى الانتظار 5 دقائق قبل المحاولة مجدداً.",
        retryAfter: 300,
      });
    },
  }),
);
