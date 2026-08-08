import type { Request, Response, NextFunction } from "express";

const ENTERPRISE_SITE_KEY = "6LdKiG8tAAAAACi2_6d-Pyz-AuOirAqXFTNFCykf";
const API_KEY = process.env.RECAPTCHA_SECRET_KEY ?? "";
const PROJECT_ID = process.env.RECAPTCHA_PROJECT_ID ?? "mtuaefans";

// Minimum score to accept (0.0 = bot, 1.0 = human)
const MIN_SCORE = 0.5;

/**
 * Express middleware that verifies a reCAPTCHA Enterprise token.
 *
 * - Reads the token from the `X-Recaptcha-Token` request header.
 * - Uses the Enterprise Assessment API when RECAPTCHA_PROJECT_ID is set.
 * - Falls back to the legacy siteverify endpoint when PROJECT_ID is absent
 *   (development / backward compat).
 * - When RECAPTCHA_SECRET_KEY is not configured at all, the check is skipped
 *   so local dev stays frictionless.
 */
export async function verifyRecaptcha(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Skip entirely when no secret/API key is configured
  if (!API_KEY) {
    next();
    return;
  }

  const token =
    (req.headers["x-recaptcha-token"] as string | undefined) ?? "";

  if (!token) {
    res.status(400).json({ error: "reCAPTCHA token مطلوب." });
    return;
  }

  try {
    if (PROJECT_ID) {
      // ── Enterprise Assessment API ───────────────────────────────────────
      const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${API_KEY}`;
      const googleRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: {
            token,
            siteKey: ENTERPRISE_SITE_KEY,
            expectedAction: req.headers["x-recaptcha-action"] ?? "ANALYZE",
          },
        }),
      });

      const data = await googleRes.json() as {
        tokenProperties?: { valid: boolean; action?: string };
        riskAnalysis?: { score: number };
        error?: { message: string };
      };

      if (data.error) {
        req.log?.warn({ error: data.error }, "reCAPTCHA Enterprise API error");
        // Fail open — don't block users if Google's API errors
        next();
        return;
      }

      if (!data.tokenProperties?.valid) {
        req.log?.warn({ tokenProperties: data.tokenProperties }, "reCAPTCHA Enterprise token invalid");
        res.status(403).json({ error: "فشل التحقق من reCAPTCHA. يرجى المحاولة مرة أخرى." });
        return;
      }

      const score = data.riskAnalysis?.score ?? 1;
      if (score < MIN_SCORE) {
        req.log?.warn({ score }, "reCAPTCHA Enterprise score too low");
        res.status(403).json({ error: "تم رفض الطلب بسبب نشاط مشبوه." });
        return;
      }

      next();
    } else {
      // ── Legacy v2 siteverify (fallback for dev / when PROJECT_ID is absent) ─
      const body = new URLSearchParams({ secret: API_KEY, response: token });
      const googleRes = await fetch("https://www.google.com/recaptcha/api/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const data = (await googleRes.json()) as { success: boolean; "error-codes"?: string[] };
      if (!data.success) {
        req.log?.warn({ errorCodes: data["error-codes"] }, "reCAPTCHA v2 verification failed");
        res.status(403).json({ error: "فشل التحقق من reCAPTCHA. يرجى المحاولة مرة أخرى." });
        return;
      }
      next();
    }
  } catch (err) {
    req.log?.error({ err }, "reCAPTCHA verification error");
    // Fail open: if Google's API is unreachable, allow the request
    next();
  }
}
