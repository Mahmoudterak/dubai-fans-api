/**
 * Dubai Fans Portal — Ziina Payment Gateway (test-environment mirror)
 *
 * Financial integrity guarantees (same as src/routes/portal-payments.ts):
 * - All settlement in ONE DB transaction
 * - Atomic claim: UPDATE WHERE status='pending' RETURNING id
 * - Atomic wallet: SET balance = balance + amount (no read-modify-write)
 * - Unique wallet-tx reference: ziina:<provider_payment_id>
 * - HTTP 200 only after transaction commits
 * - If tx rolls back: payment stays 'pending', Ziina can retry
 */
import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import { z } from "zod/v4";
import { eq, and, desc, isNull, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  portalPayments, portalOrders, portalWallets, portalWalletTransactions,
  portalTopupRequests, portalUsers,
} from "../vendor/db/schema/portal.js";
import { requirePortalUser, requirePortalAdmin } from "../lib/portalAuth.js";
import { createZiinaPaymentIntent } from "../lib/ziina.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── HMAC signature verification ───────────────────────────────────────────────

function verifyZiinaSignature(rawBody: string, signatureHeader: string): boolean {
  try {
    const secret   = process.env.ZIINA_WEBHOOK_SECRET ?? "";
    if (!secret) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const sigBuf   = Buffer.from(signatureHeader, "hex");
    const expBuf   = Buffer.from(expected, "hex");
    if (sigBuf.length === 0 || sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

function firstHeader(val: string | string[] | undefined): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val[0] ?? "";
  return "";
}

const APP_SCHEME = "dubaifans";
function makeRedirectUrls(paymentId: number) {
  return {
    successUrl: `${APP_SCHEME}://payment/result?status=success&paymentId=${paymentId}`,
    cancelUrl:  `${APP_SCHEME}://payment/result?status=cancelled&paymentId=${paymentId}`,
    failureUrl: `${APP_SCHEME}://payment/result?status=failed&paymentId=${paymentId}`,
  };
}

// ── Supported currency — enforced by the server; clients cannot override ──────
const PORTAL_PAYMENT_CURRENCY = "AED" as const;

// ── POST /api/portal/payments/ziina/create ────────────────────────────────────
const CreateSchema = z.object({
  orderId:     z.number().int().positive().optional(),
  topupAmount: z.number().min(50).max(100_000).optional(),
  // currency is intentionally NOT accepted from the client — always AED
});

router.post("/portal/payments/ziina/create", requirePortalUser,
  async (req: Request, res: Response): Promise<void> => {
    const user   = (req as any).portalUser;
    const parsed = CreateSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid input." } });
      return;
    }

    const { orderId, topupAmount } = parsed.data;
    // Currency is always server-controlled — the client cannot override it
    const currency = PORTAL_PAYMENT_CURRENCY;

    if (!orderId && !topupAmount) {
      res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Provide orderId or topupAmount." } });
      return;
    }

    if (!process.env.ZIINA_API_KEY) {
      res.status(503).json({ success: false, error: { code: "PAYMENT_NOT_CONFIGURED" } });
      return;
    }

    try {
      let amountAed: number;
      let description: string;
      let topupRequestId: number | null = null;
      let resolvedOrderId: number | null = null;

      if (orderId) {
        const [order] = await db.select().from(portalOrders).where(eq(portalOrders.id, orderId)).limit(1);
        if (!order) { res.status(404).json({ success: false, error: { code: "ORDER_NOT_FOUND" } }); return; }
        if (order.userId !== user.id) { res.status(403).json({ success: false, error: { code: "FORBIDDEN" } }); return; }
        if (order.walletTxId !== null) { res.status(400).json({ success: false, error: { code: "ALREADY_PAID" } }); return; }
        if (order.status === "completed" || order.status === "cancelled") {
          res.status(400).json({ success: false, error: { code: "ORDER_NOT_PAYABLE" } }); return;
        }
        // Amount is ALWAYS from the DB — never trusted from the request body
        amountAed       = parseFloat(order.total);
        description     = `Dubai Fans — Order #${order.id}`;
        resolvedOrderId = order.id;
        // Validate the order's stored currency is supported (server check, not client-supplied)
        const orderCurrency = (order.currency ?? PORTAL_PAYMENT_CURRENCY).toUpperCase();
        if (orderCurrency !== PORTAL_PAYMENT_CURRENCY) {
          res.status(400).json({ success: false, error: { code: "UNSUPPORTED_CURRENCY" } }); return;
        }
      } else {
        // Top-up: currency is always PORTAL_PAYMENT_CURRENCY (AED) — no client input accepted
        amountAed  = topupAmount!;
        const [topup] = await db.insert(portalTopupRequests).values({
          userId: user.id, amount: amountAed.toFixed(2), paymentMethod: "ziina", status: "pending",
        }).returning();
        topupRequestId = topup.id;
        description    = `Dubai Fans — Wallet top-up ${amountAed.toFixed(2)} ${currency}`;
      }

      const amountFils  = Math.round(amountAed * 100);
      const operationId = randomUUID();

      const [payment] = await db.insert(portalPayments).values({
        userId: user.id, orderId: resolvedOrderId, topupRequestId,
        operationId, amount: amountAed.toFixed(2), currency, status: "pending",
      }).returning();

      const { successUrl, cancelUrl, failureUrl } = makeRedirectUrls(payment.id);

      let checkoutUrl: string;
      let providerPaymentId: string;

      try {
        const result = await createZiinaPaymentIntent({
          amountFils, currency, description, successUrl, cancelUrl, failureUrl, operationId,
        });
        checkoutUrl       = result.checkoutUrl;
        providerPaymentId = result.providerPaymentId;
      } catch (err) {
        await db.update(portalPayments).set({ status: "failed", failureReason: String(err), updatedAt: new Date() }).where(eq(portalPayments.id, payment.id));
        logger.error({ err }, "Ziina create payment error");
        res.status(502).json({ success: false, error: { code: "PAYMENT_GATEWAY_ERROR" } });
        return;
      }

      await db.update(portalPayments).set({ providerPaymentId, updatedAt: new Date() }).where(eq(portalPayments.id, payment.id));

      res.status(201).json({ success: true, data: { paymentId: payment.id, checkoutUrl, amount: amountAed, currency } });
    } catch (err) {
      logger.error({ err }, "portal payment create error");
      res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
    }
  }
);

// ── POST /api/payments/ziina/webhook ─────────────────────────────────────────

router.post("/payments/ziina/webhook",
  async (req: Request, res: Response): Promise<void> => {
    const rawBody   = (req as any).rawBody ?? "";
    const signature = firstHeader(req.headers["x-ziina-signature"] ?? req.headers["x-signature"]);

    if (!process.env.ZIINA_WEBHOOK_SECRET) {
      res.status(500).json({ success: false, error: { code: "NOT_CONFIGURED" } }); return;
    }

    if (!signature || !verifyZiinaSignature(rawBody, signature)) {
      res.status(403).json({ success: false, error: { code: "INVALID_SIGNATURE" } }); return;
    }

    let event: any;
    try { event = rawBody ? JSON.parse(rawBody) : req.body; }
    catch { res.status(400).json({ success: false, error: { code: "INVALID_JSON" } }); return; }

    const providerPaymentId = String(event.id ?? event.payment_intent_id ?? event.data?.id ?? "");
    if (!providerPaymentId) {
      res.status(400).json({ success: false, error: { code: "MISSING_PAYMENT_ID" } }); return;
    }

    const eventType   = String(event.type ?? event.event ?? "").toLowerCase();
    const isCompleted = eventType.includes("paid") || eventType.includes("completed") || eventType.includes("success");
    const isFailed    = eventType.includes("fail");
    const isCancelled = eventType.includes("cancel");

    try {
      await db.transaction(async (tx) => {
        const [payment] = await tx.select()
          .from(portalPayments)
          .where(eq(portalPayments.providerPaymentId, providerPaymentId))
          .limit(1);

        if (!payment) return;

        // Non-completed events
        if (isFailed || isCancelled) {
          await tx.update(portalPayments)
            .set({ status: isFailed ? "failed" : "cancelled", updatedAt: new Date() })
            .where(and(eq(portalPayments.id, payment.id), inArray(portalPayments.status, ["pending", "processing"])));
          return;
        }

        if (!isCompleted) return;

        // Already settled — idempotent
        if (payment.status === "completed") return;

        // ── Currency validation (fail-closed) ────────────────────────────
        // Only event.currency_code is the confirmed Ziina webhook field.
        // Missing, empty, whitespace, or non-AED currency ALL block settlement.
        const rawProviderCurrency = event.currency_code;
        const providerCurrency = typeof rawProviderCurrency === "string"
          ? rawProviderCurrency.trim().toUpperCase()
          : null;   // null ← absent; always blocks

        const rawInternalCurrency = payment.currency;
        const internalCurrency = typeof rawInternalCurrency === "string"
          ? rawInternalCurrency.trim().toUpperCase()
          : null;

        if (
          providerCurrency === null ||
          providerCurrency === "" ||
          providerCurrency !== PORTAL_PAYMENT_CURRENCY ||
          internalCurrency !== PORTAL_PAYMENT_CURRENCY ||
          providerCurrency !== internalCurrency
        ) {
          await tx.update(portalPayments)
            .set({
              status:        "failed",
              failureReason: `CURRENCY_MISMATCH: provider=${providerCurrency || "unknown"} internal=${internalCurrency}`,
              updatedAt:     new Date(),
            })
            .where(and(eq(portalPayments.id, payment.id), inArray(portalPayments.status, ["pending", "processing"])));
          return;
        }

        // Atomic claim: pending → processing
        const claimed = await tx.update(portalPayments)
          .set({ status: "processing", updatedAt: new Date() })
          .where(and(eq(portalPayments.id, payment.id), eq(portalPayments.status, "pending")))
          .returning({ id: portalPayments.id });

        if (claimed.length === 0) return; // Another webhook owns this settlement

        // Atomic wallet credit
        await tx.update(portalWallets)
          .set({ balance: sql`${portalWallets.balance} + ${payment.amount}::numeric`, updatedAt: new Date() })
          .where(eq(portalWallets.userId, payment.userId));

        const [wallet] = await tx.select({ id: portalWallets.id })
          .from(portalWallets).where(eq(portalWallets.userId, payment.userId)).limit(1);

        if (!wallet) throw new Error(`Wallet not found for user ${payment.userId}`);

        const creditRef = `ziina:${providerPaymentId}`;
        await tx.insert(portalWalletTransactions).values({
          userId:      payment.userId,
          walletId:    wallet.id,
          amount:      payment.amount,
          type:        "credit",
          description: "شحن رصيد عبر Ziina",
          reference:   creditRef,
          orderId:     payment.orderId,
          status:      "completed",
        });

        if (payment.orderId) {
          const [order] = await tx.select({ id: portalOrders.id, walletTxId: portalOrders.walletTxId })
            .from(portalOrders).where(eq(portalOrders.id, payment.orderId)).limit(1);

          if (order) {
            if (order.walletTxId !== null) {
              // Overpayment — wallet credited but order not double-settled
              await tx.update(portalPayments)
                .set({
                  status:        "completed",
                  completedAt:   new Date(),
                  updatedAt:     new Date(),
                  failureReason: `overpayment_review: order #${payment.orderId} already settled`,
                })
                .where(eq(portalPayments.id, payment.id));
              return;
            }

            // Normal order debit
            const debitRef = `order:${payment.orderId}:ziina:${providerPaymentId}`;
            await tx.update(portalWallets)
              .set({ balance: sql`${portalWallets.balance} - ${payment.amount}::numeric`, updatedAt: new Date() })
              .where(eq(portalWallets.userId, payment.userId));

            const [debitTx] = await tx.insert(portalWalletTransactions).values({
              userId:      payment.userId,
              walletId:    wallet.id,
              amount:      payment.amount,
              type:        "debit",
              description: `دفع الطلب #${payment.orderId} عبر Ziina`,
              reference:   debitRef,
              orderId:     payment.orderId,
              status:      "completed",
            }).returning({ id: portalWalletTransactions.id });

            await tx.update(portalOrders)
              .set({ walletTxId: debitTx.id, status: "under_review", updatedAt: new Date() })
              .where(and(eq(portalOrders.id, payment.orderId), isNull(portalOrders.walletTxId)));
          }
        } else if (payment.topupRequestId) {
          await tx.update(portalTopupRequests)
            .set({ status: "approved", reviewedAt: new Date() })
            .where(eq(portalTopupRequests.id, payment.topupRequestId));
        }

        // Final: completed (LAST write)
        await tx.update(portalPayments)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(portalPayments.id, payment.id));
      });

      res.status(200).json({ received: true });
    } catch (err) {
      logger.error({ err, providerPaymentId }, "Ziina webhook settlement transaction failed");
      res.status(500).json({ success: false, error: { code: "SETTLEMENT_FAILED" } });
    }
  }
);

// ── GET /api/portal/payments/:id/status ──────────────────────────────────────

router.get("/portal/payments/:id/status", requirePortalUser,
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const user = (req as any).portalUser;
    const id   = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, error: { code: "INVALID_ID" } }); return;
    }
    try {
      const [payment] = await db.select({
        id: portalPayments.id, status: portalPayments.status,
        amount: portalPayments.amount, currency: portalPayments.currency,
        orderId: portalPayments.orderId, completedAt: portalPayments.completedAt,
        createdAt: portalPayments.createdAt,
      }).from(portalPayments).where(and(eq(portalPayments.id, id), eq(portalPayments.userId, user.id))).limit(1);

      if (!payment) { res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return; }
      res.json({ success: true, data: payment });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
    }
  }
);

// ── GET /api/portal/admin/payments ───────────────────────────────────────────

router.get("/portal/admin/payments", requirePortalAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const page   = Math.max(1, Number.parseInt(req.query["page"] as string || "1", 10));
    const limit  = Math.min(100, Number.parseInt(req.query["limit"] as string || "20", 10));
    const offset = (page - 1) * limit;
    const status = req.query["status"] as string | undefined;
    try {
      const where = status ? eq(portalPayments.status, status) : sql`true`;
      const [payments, [{ total }]] = await Promise.all([
        db.select({
          id: portalPayments.id, status: portalPayments.status,
          amount: portalPayments.amount, currency: portalPayments.currency,
          provider: portalPayments.provider, orderId: portalPayments.orderId,
          completedAt: portalPayments.completedAt, createdAt: portalPayments.createdAt,
          userId: portalPayments.userId, userName: portalUsers.fullName, userEmail: portalUsers.email,
        }).from(portalPayments).leftJoin(portalUsers, eq(portalPayments.userId, portalUsers.id)).where(where).orderBy(desc(portalPayments.createdAt)).limit(limit).offset(offset),
        db.select({ total: sql<number>`count(*)::int` }).from(portalPayments).where(where),
      ]);
      res.json({ success: true, data: payments, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (err) {
      res.status(500).json({ success: false, error: { code: "SERVER_ERROR" } });
    }
  }
);

export default router;
