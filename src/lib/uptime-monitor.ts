/**
 * Uptime monitor — runs on the CF Workers cron every minute.
 *
 * Pings https://mtuaefans.com/api/healthz from Cloudflare's edge network.
 * If the endpoint returns a non-200 status or the fetch times out, an alert
 * email is sent via the Resend API to ADMIN_EMAIL.
 *
 * Because CF Worker cron triggers run on Cloudflare's infrastructure
 * independently from request-handling, this provides true external monitoring
 * at 1-minute intervals without a third-party account.
 */

import { logger } from "./logger.js";

const HEALTHZ_URL = "https://mtuaefans.com/api/healthz";
const TIMEOUT_MS  = 30_000;

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

function alertHtml(status: string, body: string, checkedAt: string): string {
  const escBody = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 500);

  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
  <div style="background:linear-gradient(135deg,#DC2626,#B91C1C);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <div style="font-size:36px;margin-bottom:10px;">🚨</div>
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900;">API Down — مtuaefans.com</h1>
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
        <td style="padding:10px 0;font-size:14px;font-weight:700;color:#DC2626;" dir="ltr">${escBody.replace(/&/g, "&amp;")}</td>
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
      </p>
    </div>
  </div>
</div>`;
}

/**
 * Run the uptime check. Call this from the Worker's `scheduled` handler.
 *
 * @param env - The Worker env object (needs RESEND_API_KEY, ADMIN_EMAIL).
 */
export async function runUptimeCheck(env: Record<string, unknown>): Promise<void> {
  const apiKey    = (env.RESEND_API_KEY as string | undefined) ?? process.env.RESEND_API_KEY;
  const adminEmail = (env.ADMIN_EMAIL  as string | undefined) ?? process.env.ADMIN_EMAIL;
  const from      = (env.SMTP_USER     as string | undefined) ?? process.env.SMTP_USER ?? "no-reply@mtuaefans.com";

  const checkedAt = new Date().toUTCString();

  let httpStatus = "unknown";
  let bodySnippet = "";
  let failed = false;

  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(HEALTHZ_URL, {
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    httpStatus  = String(res.status);
    bodySnippet = await res.text().catch(() => "");

    if (res.status !== 200) {
      failed = true;
      logger.error(
        { status: res.status, body: bodySnippet.slice(0, 200) },
        "uptime-monitor: health check FAILED"
      );
    } else {
      logger.info({ status: res.status }, "uptime-monitor: health check OK");
    }
  } catch (err: unknown) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    httpStatus  = "fetch-error";
    bodySnippet = msg;
    logger.error({ err: msg }, "uptime-monitor: health check threw");
  }

  if (failed && apiKey && adminEmail) {
    await sendAlertEmail({
      apiKey,
      to:   adminEmail,
      from: `"Dubai Fans API Monitor" <${from}>`,
      subject: `🚨 API Down — mtuaefans.com/api/healthz returned ${httpStatus}`,
      html: alertHtml(httpStatus, bodySnippet, checkedAt),
    });
  } else if (failed) {
    logger.warn(
      { hasApiKey: !!apiKey, hasAdminEmail: !!adminEmail },
      "uptime-monitor: check failed but email not configured — alert suppressed"
    );
  }
}
