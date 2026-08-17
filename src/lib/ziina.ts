/**
 * Ziina payment gateway — thin typed wrapper.
 * Mirrors the pattern used in src/routes/instagram-payment.ts.
 */
import { logger } from "./logger.js";

const ZIINA_API_BASE = "https://api-v2.ziina.com/api";

function getApiKey(): string {
  const key = process.env.ZIINA_API_KEY;
  if (!key) throw new Error("ZIINA_API_KEY is not configured.");
  return key;
}

export interface ZiinaPaymentIntentParams {
  amountFils:  number;   // AED * 100 (Ziina uses smallest currency unit)
  currency:    string;   // "AED"
  description: string;
  successUrl:  string;
  cancelUrl:   string;
  failureUrl:  string;
  operationId: string;   // idempotency key
}

export interface ZiinaPaymentIntent {
  providerPaymentId: string;
  checkoutUrl:       string;
}

export async function createZiinaPaymentIntent(
  params: ZiinaPaymentIntentParams,
): Promise<ZiinaPaymentIntent> {
  const apiKey = getApiKey();
  const isTest = process.env.ZIINA_ENVIRONMENT !== "production";

  const body = {
    amount:               params.amountFils,
    currency_code:        params.currency,
    message:              params.description,
    success_url:          params.successUrl,
    cancel_url:           params.cancelUrl,
    failure_url:          params.failureUrl,
    transaction_source:   "directlink",
    test:                 isTest,
  };

  const response = await fetch(`${ZIINA_API_BASE}/payment_intent`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error({ status: response.status, body: text.slice(0, 300) }, "Ziina API error");
    throw new Error(`Ziina API returned ${response.status}`);
  }

  const data: any = await response.json();
  const providerPaymentId = String(data.id ?? data.payment_intent_id ?? data._id ?? "");
  const checkoutUrl       = String(data.redirect_url ?? data.checkout_url ?? data.url ?? "");

  if (!providerPaymentId || !checkoutUrl) {
    throw new Error("Ziina API response missing payment intent id or checkout URL.");
  }

  return { providerPaymentId, checkoutUrl };
}
