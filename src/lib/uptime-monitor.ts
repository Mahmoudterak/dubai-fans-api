/**
 * Uptime monitor — runs on the CF Workers cron every minute.
 *
 * Pings https://mtuaefans.com/api/healthz from Cloudflare's edge network.
 * An alert email is sent only on state transitions (healthy → down), and at
 * most once every RESEND_INTERVAL_MS while the outage continues. This prevents
 * email floods when the endpoint stays down across multiple cron invocations.
 *
 * Because CF Worker cron triggers run on Cloudflare's infrastructure
 * independently from request-handling, this provides true external monitoring
 * at 1-minute intervals without a third-party account.
 */

import { logger } from "./logger.js";

const HEALTHZ_URL        = "https://mtuaefans.com/api/healthz";
const TIMEOUT_MS         = 30_000;
/**
 * Minimum gap between consecutive alert emails while an outage is ongoing.
 * The first alert fires immediately on transition to "down"; subsequent
 * reminders fire at most once per 30 minutes until the service recovers.
 */
const RESEND_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ── Module-level outage state ─────────────────────────────────────────────────
// CF Worker instances persist across multiple cron invocations within their
// lifetime, so this state survives as long as the same isolate is reused.
// On cold-start the state resets and only one "first alert" fires per cold-start
// per outage — which is acceptable; Task #305 will add durable KV-backed state.
let outageActive    = false;
let lastAlertSentAt = 0;

/** Lightweight Resend send — avoids importing the full mailer module. */
async function sendAlertEmail(params: {
  apiKey: string;
  to: string;
  from: string;
  subject: string;
  html: string;
}): Promise<void> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: params.from,
        to:   params.to,
        subject: params.subject,
        html:    params.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body }, "uptime-monitor: Resend API error");
    } else {
      logger.info({ to: params.to }, "uptime-monitor: alert email sent");
    }
  } catch (err) {
    logger.error({ err }, "uptime-monitor: failed to call Resend API");
  }
}

function alertHtml(status: string, body: string, checkedAt: string, isReminder: boolean): string {
  const escBody = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 500);

  const heading = isReminder ? "API Still Down — mtuaefans.com" : "API Down — mtuaefans.com";

  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#DC2626,#B91C1C);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <div style="font-size:36px;margin-bottom:10px;">🚨</div>
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900;">${heading}</h1>
    <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px;">Health check failed · Dubai Fans API Monitor</p>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:28px 24px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="border-bottom:1px solid #F3F4F6;">
        <td style="padding:10px 0;font-size:13px;color:#9CA3AF;width:35%;">Endpoint</td>
        <td style="padding:10px 0;font-size:14px;font-weight:700;color:#111827;" dir="ltr">${HEALTHZ_URL}</td>
      </tr>
      <tr style="border-bottom:1px solid #F3F4F6;">
        <td style="padding:10px 0;font-size:13px;color:#9CA3AF;">Status</td>
        <td style="padding:10px 0;font-size:14px;font-weight:700;color:#DC2626;" dir="ltr">${escBody}</td>
      </tr>
      <tr style="border-bottom:1px solid #F3F4F6;">
        <td style="padding:10px 0;font-size:13px;color:#9CA3AF;">HTTP code</td>
        <td style="padding:10px 0;font-size:14px;font-weight:700;color:#DC2626;" dir="ltr">${status}</td>
      </tr>
      <tr>
        <td style="padding:10px 0;font-size:13px;color:#9CA3AF;">Checked at</td>
        <td style="padding:10px 0;font-size:14px;color:#374151;" dir="ltr">${checkedAt}</td>
      </tr>
    </table>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://mtuaefans.com/api/healthz"
         style="display:inline-block;background:linear-gradient(135deg,#DC2626,#B91C1C);color:#fff;text-decoration:none;padding:12px 32px;border-radius:10px;font-weight:700;font-size:14px;">
        Check endpoint now →
      </a>
    </div>
    <div style="border-top:1px solid #F3F4F6;padding-top:18px;">
      <p style="margin:0;font-size:12px;color:#D1D5DB;text-align:center;">
        Dubai Fans API Monitor · <a href="https://mtuaefans.com" style="color:#D1D5DB;">mtuaefans.com</a>
        ${isReminder ? "· reminder — outage still ongoing" : ""}
      </p>
    </div>
  </div>
</div>`;
}

/**
 * Run the uptime check. Call this from the Worker's `scheduled` handler.
 *
 * Deduplication logic:
 * - Transition healthy→down  : always send one alert immediately.
 * - Sustained outage          : send at most one reminder per RESEND_INTERVAL_MS.
 * - Recovery (down→healthy)  : log recovery; reset state so the next outage
 *                              triggers a fresh alert.
 *
 * @param env - The Worker env object (needs RESEND_API_KEY, ADMIN_EMAIL).
 */
export async function runUptimeCheck(env: Record<string, unknown>): Promise<void> {
  const apiKey     = (env.RESEND_API_KEY as string | undefined) ?? process.env.RESEND_API_KEY;
  const adminEmail = (env.ADMIN_EMAIL    as string | undefined) ?? process.env.ADMIN_EMAIL;
  const from       = (env.SMTP_USER      as string | undefined) ?? process.env.SMTP_USER ?? "no-reply@mtuaefans.com";

  const checkedAt = new Date().toUTCString();
  const now       = Date.now();

  let httpStatus  = "unknown";
  let bodySnippet = "";
  let failed      = false;

  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(HEALTHZ_URL, { method: "GET", signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    httpStatus  = String(res.status);
    bodySnippet = await res.text().catch(() => "");

    if (res.status !== 200) {
      failed = true;
      logger.error({ status: res.status, body: bodySnippet.slice(0, 200) }, "uptime-monitor: health check FAILED");
    } else {
      if (outageActive) {
        logger.info({ status: res.status }, "uptime-monitor: service RECOVERED");
        outageActive    = false;
        lastAlertSentAt = 0;
      } else {
        logger.info({ status: res.status }, "uptime-monitor: health check OK");
      }
    }
  } catch (err: unknown) {
    failed = true;
    const msg   = err instanceof Error ? err.message : String(err);
    httpStatus  = "fetch-error";
    bodySnippet = msg;
    logger.error({ err: msg }, "uptime-monitor: health check threw");
  }

  if (!failed) return;

  // ── Deduplication: only alert on state-change or after RESEND_INTERVAL_MS ──
  const isNewOutage  = !outageActive;
  const reminderDue  = outageActive && (now - lastAlertSentAt) >= RESEND_INTERVAL_MS;

  if (!isNewOutage && !reminderDue) {
    logger.info(
      { outageActive, msSinceLastAlert: now - lastAlertSentAt },
      "uptime-monitor: outage ongoing — alert suppressed (deduplication)"
    );
    return;
  }

  outageActive    = true;
  lastAlertSentAt = now;

  if (apiKey && adminEmail) {
    await sendAlertEmail({
      apiKey,
      to:      adminEmail,
      from:    `"Dubai Fans API Monitor" <${from}>`,
      subject: isNewOutage
        ? `🚨 API Down — mtuaefans.com/api/healthz returned ${httpStatus}`
        : `🔁 Reminder: API Still Down — mtuaefans.com (${httpStatus})`,
      html: alertHtml(httpStatus, bodySnippet, checkedAt, !isNewOutage),
    });
  } else {
    logger.warn(
      { hasApiKey: !!apiKey, hasAdminEmail: !!adminEmail },
      "uptime-monitor: check failed but email not configured — alert suppressed"
    );
  }
}
