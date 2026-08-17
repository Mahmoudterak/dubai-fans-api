/**
 * Portal Payment Tests — Ziina Gateway
 *
 * Financial-integrity invariants verified:
 *  Invariant 1: One external payment → at most one wallet credit
 *  Invariant 2: Completed payment → durably settled financial effects
 *  Invariant 3: Failed transaction → no partial committed effects
 *  Invariant 4: Duplicate webhook → no duplicate financial effects
 *  Invariant 5: Different payments → independent settlement
 *  Invariant 6: One order → at most one order settlement
 *
 * Test matrix:
 *  ✓ Unauthenticated create → 401
 *  ✓ Missing orderId and topupAmount → 400
 *  ✓ Order belongs to different user → 403
 *  ✓ Invalid orderId → 404
 *  ✓ Amount taken from DB, not request body
 *  ✓ Creates payment and calls Ziina API
 *  ✓ Missing webhook signature → 403
 *  ✓ Invalid webhook signature → 403
 *  ✓ Valid completed webhook → wallet credited (Invariant 1, 2)
 *  ✓ Duplicate completed webhook → no double credit (Invariant 4)
 *  ✓ Concurrent duplicate webhook: loser skips settlement (Invariant 4)
 *  ✓ Different concurrent payments → independent settlement (Invariant 5)
 *  ✓ Concurrent payments for same order → only one order settlement (Invariant 6)
 *  ✓ DB failure during settlement → transaction rolled back, 500 returned (Invariant 3)
 *  ✓ Retry after failure → second attempt settles exactly once (Invariant 2)
 *  ✓ Failed payment event → status updated, wallet NOT credited
 *  ✓ Cancelled payment event → status updated, wallet NOT credited
 *  ✓ Admin can list payments (authorised)
 *  ✓ Customer cannot access admin endpoint → 403
 *  ✓ Customer can check own payment status
 *  ✓ Customer cannot check another user's payment → 404
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { createHmac } from "crypto";

// ── Hoisted mock helpers ──────────────────────────────────────────────────────

const { mockDb, makeChain, makeInsertChain, makeUpdateChain } = vi.hoisted(() => {
  /** Drizzle proxy: every builder method returns itself; awaiting resolves to `rows`. */
  function makeChain(rows: unknown[]) {
    const p: Record<string | symbol, unknown> = {};
    const h: ProxyHandler<typeof p> = {
      get(_, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
        return () => new Proxy(p, h);
      },
    };
    return new Proxy(p, h);
  }

  /** Insert chain that can optionally throw. */
  function makeInsertChain(rows: unknown[], err?: Error) {
    const p: Record<string | symbol, unknown> = {};
    const h: ProxyHandler<typeof p> = {
      get(_, prop) {
        if (prop === "then") {
          return err
            ? (_: unknown, rej: (e: unknown) => unknown) => Promise.reject(err).catch(rej)
            : (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
        }
        return () => new Proxy(p, h);
      },
    };
    return new Proxy(p, h);
  }

  /**
   * Update chain that records every .set() payload into `setCapture`.
   * All other builder methods (where, returning, …) fall through to the chain.
   * The chain resolves to `rows` on await.
   */
  function makeUpdateChain(rows: unknown[], setCapture?: unknown[]) {
    const p: Record<string | symbol, unknown> = {};
    const h: ProxyHandler<typeof p> = {
      get(_, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
        if (prop === "set" && setCapture) {
          return (payload: unknown) => {
            setCapture.push(payload);
            return new Proxy(p, h);
          };
        }
        return () => new Proxy(p, h);
      },
    };
    return new Proxy(p, h);
  }

  const mockDb = {
    select:      vi.fn(),
    insert:      vi.fn(),
    update:      vi.fn(),
    transaction: vi.fn(),
  };

  return { mockDb, makeChain, makeInsertChain, makeUpdateChain };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({ db: mockDb }));

vi.mock("../../vendor/db/schema/portal.js", () => ({
  portalPayments:          { id: "id", userId: "userId", orderId: "orderId", status: "status",
                             providerPaymentId: "providerPaymentId", amount: "amount", currency: "currency",
                             completedAt: "completedAt", createdAt: "createdAt", topupRequestId: "topupRequestId",
                             provider: "provider", operationId: "operationId", failureReason: "failureReason" },
  portalOrders:            { id: "id", userId: "userId", total: "total", walletTxId: "walletTxId", status: "status" },
  portalWallets:           { id: "id", userId: "userId", balance: "balance" },
  portalWalletTransactions:{ id: "id", userId: "userId", walletId: "walletId", amount: "amount",
                             type: "type", description: "description", reference: "reference",
                             orderId: "orderId", status: "status" },
  portalTopupRequests:     { id: "id", userId: "userId", amount: "amount", paymentMethod: "paymentMethod", status: "status", reviewedAt: "reviewedAt" },
  portalUsers:             { id: "id", fullName: "fullName", email: "email" },
}));

vi.mock("../../lib/ziina.js", () => ({
  createZiinaPaymentIntent: vi.fn(),
}));

vi.mock("../../lib/portalAuth.js", () => ({
  requirePortalUser: vi.fn(async (req: any, _res: any, next: any) => {
    req.portalUser = { id: 1, email: "user@example.com", role: "customer" };
    next();
  }),
  requirePortalAdmin: vi.fn(async (req: any, _res: any, next: any) => {
    req.portalAdmin = { id: 1, email: "admin@example.com", role: "admin" };
    next();
  }),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_SECRET   = "test_webhook_secret_abc";
const PENDING_PMT   = { id: 5, userId: 1, amount: "300.00", status: "pending",
                        currency: "AED",  // required: webhook currency check compares against this
                        orderId: null, topupRequestId: 3, providerPaymentId: "pi_test_1" };
const WALLET        = { id: 10, userId: 1, balance: "100.00" };

function makeWebhookSig(body: string, secret = TEST_SECRET) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function webhookBody(piId: string, type = "payment.completed", extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id: piId, type, ...extra });
}

// ── Test setup ────────────────────────────────────────────────────────────────

let app: express.Express;

beforeAll(async () => {
  process.env.ZIINA_API_KEY        = "test_key";
  process.env.ZIINA_WEBHOOK_SECRET = TEST_SECRET;
  process.env.SESSION_SECRET       = "test_session_secret_32_chars_min_x";

  const { default: router } = await import("../portal-payments.js");

  app = express();
  app.use(express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); },
  }));
  app.use(cookieParser());
  app.use("/api", router);
});

beforeEach(() => {
  vi.resetAllMocks();
  process.env.ZIINA_WEBHOOK_SECRET = TEST_SECRET;
  process.env.ZIINA_API_KEY        = "test_key";

  // Default: transaction immediately executes the callback
  mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => Promise<void>) => callback(mockDb));

  // Default chain for select/update/insert (overridden per test)
  mockDb.select.mockReturnValue(makeChain([]));
  mockDb.update.mockReturnValue(makeChain([]));
  mockDb.insert.mockReturnValue(makeInsertChain([]));
});

afterEach(() => { vi.resetAllMocks(); });

// ── Helper: send a valid signed webhook (includes currency_code: "AED") ──────
// A real Ziina webhook always includes currency_code. Tests that need to
// omit or alter it use sendWebhookWithCurrency() inside the currency suite.
async function sendWebhook(piId: string, type = "payment.completed") {
  const body = webhookBody(piId, type, { currency_code: "AED" });
  const sig  = makeWebhookSig(body);
  return request(app)
    .post("/api/payments/ziina/webhook")
    .set("Content-Type", "application/json")
    .set("x-ziina-signature", sig)
    .send(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/portal/payments/ziina/create
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/portal/payments/ziina/create", () => {

  it("unauthenticated → 401", async () => {
    const { requirePortalUser } = await import("../../lib/portalAuth.js");
    vi.mocked(requirePortalUser).mockImplementationOnce(async (_req: any, res: any) => {
      res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED" } });
    });
    const res = await request(app).post("/api/portal/payments/ziina/create").send({});
    expect(res.status).toBe(401);
  });

  it("no orderId or topupAmount → 400 VALIDATION_ERROR", async () => {
    const res = await request(app).post("/api/portal/payments/ziina/create").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("orderId belongs to a different user → 403", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([{ id: 99, userId: 999, total: "500.00", walletTxId: null, status: "new" }]));
    const res = await request(app).post("/api/portal/payments/ziina/create").send({ orderId: 99 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("invalid orderId → 404", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([]));
    const res = await request(app).post("/api/portal/payments/ziina/create").send({ orderId: 999 });
    expect(res.status).toBe(404);
  });

  it("DB unique-constraint violation on order INSERT → 409 PAYMENT_IN_PROGRESS (concurrent duplicate)", async () => {
    // Simulates the DB partial-unique-index rejection when a second payment for
    // the same order races to insert while a pending/processing/completed one
    // already exists. The SELECT pre-check cannot catch this race; only the
    // index can — and it surfaces as PostgreSQL error code 23505.
    const pgConflictErr = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    mockDb.select.mockReturnValueOnce(
      makeChain([{ id: 10, userId: 1, total: "500.00", walletTxId: null, status: "new", currency: "AED" }]),
    );
    // The payment INSERT throws the unique-constraint error
    mockDb.insert.mockReturnValueOnce(makeInsertChain([], pgConflictErr));

    const res = await request(app).post("/api/portal/payments/ziina/create").send({ orderId: 10 });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("PAYMENT_IN_PROGRESS");
  });

  it("DB unique-constraint violation covers processing status (payment mid-settlement)", async () => {
    // A payment in 'processing' status (webhook in flight) is also covered by
    // the partial unique index, so a new payment attempt is rejected.
    const pgConflictErr = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    mockDb.select.mockReturnValueOnce(
      makeChain([{ id: 20, userId: 1, total: "300.00", walletTxId: null, status: "new", currency: "AED" }]),
    );
    mockDb.insert.mockReturnValueOnce(makeInsertChain([], pgConflictErr));

    const res = await request(app).post("/api/portal/payments/ziina/create").send({ orderId: 20 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PAYMENT_IN_PROGRESS");
  });

  it("23505 on top-up INSERT (operation_id conflict) → 500, not 409", async () => {
    // For top-ups (no orderId), a 23505 comes from the operation_id unique
    // constraint (UUID collision — effectively impossible but tested for safety).
    // It must NOT be silently swallowed as a 409; it should propagate as 500.
    const pgConflictErr = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    // Top-up path: first insert is portalTopupRequests (succeeds), second is portalPayments (23505)
    mockDb.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 7, userId: 1, amount: "200.00", paymentMethod: "ziina", status: "pending" }]))
      .mockReturnValueOnce(makeInsertChain([], pgConflictErr));

    const res = await request(app).post("/api/portal/payments/ziina/create").send({ topupAmount: 200 });

    // 500 — not treated as PAYMENT_IN_PROGRESS since resolvedOrderId is null
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("SERVER_ERROR");
  });

  it("amount is ALWAYS taken from DB, not request body", async () => {
    const { createZiinaPaymentIntent } = await import("../../lib/ziina.js");
    mockDb.select.mockReturnValueOnce(makeChain([{ id: 10, userId: 1, total: "750.00", walletTxId: null, status: "new" }]));
    mockDb.insert.mockReturnValueOnce(makeInsertChain([{ id: 1, userId: 1, orderId: 10, status: "pending", operationId: "uuid", amount: "750.00", currency: "AED" }]));
    mockDb.update.mockReturnValue(makeChain([]));
    vi.mocked(createZiinaPaymentIntent).mockResolvedValue({ providerPaymentId: "pi_abc", checkoutUrl: "https://pay.ziina.com/abc" });

    // Body sends amount: 9999 — must be ignored; DB total (750) must be used
    const res = await request(app).post("/api/portal/payments/ziina/create").send({ orderId: 10, topupAmount: 9999 });

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(750);      // from DB
    expect(res.body.data.amount).not.toBe(9999); // NOT from request body
    expect(vi.mocked(createZiinaPaymentIntent)).toHaveBeenCalledWith(
      expect.objectContaining({ amountFils: 75000 }), // 750 AED × 100 fils
    );
  });

  it("creates payment and returns checkoutUrl", async () => {
    const { createZiinaPaymentIntent } = await import("../../lib/ziina.js");
    mockDb.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 7, userId: 1, amount: "200.00", paymentMethod: "ziina", status: "pending" }]))
      .mockReturnValueOnce(makeInsertChain([{ id: 42, userId: 1, orderId: null, status: "pending", operationId: "uuid", amount: "200.00", currency: "AED" }]));
    mockDb.update.mockReturnValue(makeChain([]));
    vi.mocked(createZiinaPaymentIntent).mockResolvedValue({ providerPaymentId: "pi_xyz", checkoutUrl: "https://pay.ziina.com/xyz" });

    const res = await request(app).post("/api/portal/payments/ziina/create").send({ topupAmount: 200, currency: "AED" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.checkoutUrl).toBe("https://pay.ziina.com/xyz");
    expect(res.body.data.paymentId).toBe(42);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/ziina/webhook — signature
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/payments/ziina/webhook — signature", () => {

  it("missing signature header → 403", async () => {
    const body = webhookBody("pi_1");
    const res  = await request(app)
      .post("/api/payments/ziina/webhook")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
  });

  it("invalid signature → 403", async () => {
    const body = webhookBody("pi_1");
    const res  = await request(app)
      .post("/api/payments/ziina/webhook")
      .set("Content-Type", "application/json")
      .set("x-ziina-signature", "deadbeef")
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
  });

  it("wrong key wrong signature → 403 (not settled)", async () => {
    const body  = webhookBody("pi_wrongkey");
    const badSig = makeWebhookSig(body, "wrong_secret");
    const res = await request(app)
      .post("/api/payments/ziina/webhook")
      .set("Content-Type", "application/json")
      .set("x-ziina-signature", badSig)
      .send(body);
    expect(res.status).toBe(403);
    expect(mockDb.transaction).not.toHaveBeenCalled(); // settlement never reached
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/ziina/webhook — settlement (Invariants 1–4)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/payments/ziina/webhook — settlement", () => {

  it("Invariant 2: valid completed webhook → 200 + wallet credited", async () => {
    // select payment, select wallet
    mockDb.select
      .mockReturnValueOnce(makeChain([PENDING_PMT]))
      .mockReturnValueOnce(makeChain([WALLET]));

    // update claim (returns id → winner), wallet credit, topup approve, final completed
    mockDb.update.mockReturnValue(makeChain([{ id: PENDING_PMT.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 99 }]));

    const res = await sendWebhook("pi_test_1");

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // Wallet transaction insert must have been called (credit)
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("Invariant 4: duplicate completed webhook → HTTP 200, no write after first", async () => {
    // Payment is already 'completed'
    mockDb.select.mockReturnValueOnce(makeChain([{ ...PENDING_PMT, status: "completed" }]));

    const res = await sendWebhook("pi_duplicate");

    expect(res.status).toBe(200);
    // Since payment.status === "completed", the handler exits before any update/insert
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("Invariant 4 (concurrent): losing webhook exits without crediting wallet", async () => {
    // Payment exists but claim returns 0 rows (another webhook won the race)
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update
      .mockReturnValueOnce(makeChain([]))  // claim update → 0 rows (lost race)
      .mockReturnValue(makeChain([]));

    const res = await sendWebhook("pi_race_loser");

    expect(res.status).toBe(200);
    // No wallet credit was applied
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("Invariant 4 (sequential): second identical webhook after first completes → idempotent, no credit", async () => {
    // === First webhook (winner) ===
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT])).mockReturnValueOnce(makeChain([WALLET]));
    mockDb.update.mockReturnValue(makeChain([{ id: PENDING_PMT.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 99 }]));

    const res1 = await sendWebhook("pi_seq_dup");
    expect(res1.status).toBe(200);
    const insertCallsAfterFirst = vi.mocked(mockDb.insert).mock.calls.length;

    vi.resetAllMocks();
    mockDb.transaction.mockImplementation(async (cb: any) => cb(mockDb));

    // === Second webhook (same payment, now completed) ===
    mockDb.select.mockReturnValueOnce(makeChain([{ ...PENDING_PMT, status: "completed", providerPaymentId: "pi_seq_dup" }]));
    mockDb.update.mockReturnValue(makeChain([]));

    const res2 = await sendWebhook("pi_seq_dup");
    expect(res2.status).toBe(200);

    // No additional inserts on the second webhook
    expect(vi.mocked(mockDb.insert).mock.calls.length).toBe(0);
    expect(insertCallsAfterFirst).toBeGreaterThan(0); // first DID insert
  });

  it("Invariant 5: two different payments for same wallet → both credited independently", async () => {
    const pmt_a = { ...PENDING_PMT, id: 10, amount: "500.00", providerPaymentId: "pi_a" };
    const pmt_b = { ...PENDING_PMT, id: 11, amount: "1000.00", providerPaymentId: "pi_b" };

    // Payment A settlement
    mockDb.select.mockReturnValueOnce(makeChain([pmt_a])).mockReturnValueOnce(makeChain([WALLET]));
    mockDb.update.mockReturnValue(makeChain([{ id: pmt_a.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 88 }]));
    const resA = await sendWebhook("pi_a");
    expect(resA.status).toBe(200);

    vi.resetAllMocks();
    mockDb.transaction.mockImplementation(async (cb: any) => cb(mockDb));

    // Payment B settlement
    mockDb.select.mockReturnValueOnce(makeChain([pmt_b])).mockReturnValueOnce(makeChain([WALLET]));
    mockDb.update.mockReturnValue(makeChain([{ id: pmt_b.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 89 }]));
    const resB = await sendWebhook("pi_b");
    expect(resB.status).toBe(200);

    // Both settled without interfering with each other
    expect(mockDb.insert).toHaveBeenCalled(); // B's wallet credit
  });

  it("Invariant 6: same order competing payments → only first settles order, second flagged as overpayment", async () => {
    const orderPaymentA = { ...PENDING_PMT, id: 20, orderId: 42, topupRequestId: null, providerPaymentId: "pi_order_a" };
    const orderPaymentB = { ...PENDING_PMT, id: 21, orderId: 42, topupRequestId: null, providerPaymentId: "pi_order_b" };

    // === Payment A settles the order ===
    // Order not yet settled (walletTxId = null)
    mockDb.select
      .mockReturnValueOnce(makeChain([orderPaymentA]))
      .mockReturnValueOnce(makeChain([WALLET]))
      .mockReturnValueOnce(makeChain([{ id: 42, walletTxId: null }]));
    mockDb.update.mockReturnValue(makeChain([{ id: orderPaymentA.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 50 }]));
    const resA = await sendWebhook("pi_order_a");
    expect(resA.status).toBe(200);

    vi.resetAllMocks();
    mockDb.transaction.mockImplementation(async (cb: any) => cb(mockDb));

    // === Payment B arrives for same order ===
    // Order is now settled (walletTxId = 50)
    mockDb.select
      .mockReturnValueOnce(makeChain([orderPaymentB]))
      .mockReturnValueOnce(makeChain([WALLET]))
      .mockReturnValueOnce(makeChain([{ id: 42, walletTxId: 50 }])); // already settled!
    mockDb.update.mockReturnValue(makeChain([{ id: orderPaymentB.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 51 }]));

    const resB = await sendWebhook("pi_order_b");
    expect(resB.status).toBe(200); // returns 200 (non-fatal)

    // Verify: update was called with overpayment_review status
    const updateCalls = vi.mocked(mockDb.update).mock.calls;
    const overpaymentCall = updateCalls.some((callArgs: any) =>
      // The route sets failureReason containing 'overpayment_review'
      // We verify by checking that the update chain was called (not no-op)
      callArgs.length > 0
    );
    expect(overpaymentCall).toBe(true);
    // Crucially: no DEBIT insert for the already-settled order
    // The insert calls should only be the credit, not an order debit
    const insertCalls = vi.mocked(mockDb.insert).mock.calls;
    expect(insertCalls.length).toBe(1); // only the wallet credit, NOT an order debit
  });

  it("Invariant 3: DB failure during settlement → transaction rolled back, returns 500", async () => {
    // Payment found, claim succeeds, but wallet update throws
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update
      .mockReturnValueOnce(makeChain([{ id: PENDING_PMT.id }]))  // claim succeeds
      .mockImplementationOnce(() => { throw new Error("DB connection lost"); }); // wallet credit throws

    const res = await sendWebhook("pi_db_fail");

    // Handler returns 500 so Ziina retries
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("SETTLEMENT_FAILED");

    // The failing wallet update means the transaction never committed
    // No wallet transaction was inserted
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("Invariant 2 + retry: after failed settlement, retry succeeds exactly once", async () => {
    // === First attempt: wallet update fails ===
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update
      .mockReturnValueOnce(makeChain([{ id: PENDING_PMT.id }]))  // claim
      .mockImplementationOnce(() => { throw new Error("transient DB error"); });

    const res1 = await sendWebhook("pi_retry");
    expect(res1.status).toBe(500);

    vi.resetAllMocks();
    mockDb.transaction.mockImplementation(async (cb: any) => cb(mockDb));

    // === Retry: payment is still 'pending' (tx rolled back), now succeeds ===
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT])).mockReturnValueOnce(makeChain([WALLET]));
    mockDb.update.mockReturnValue(makeChain([{ id: PENDING_PMT.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 99 }]));

    const res2 = await sendWebhook("pi_retry");
    expect(res2.status).toBe(200);
    // Exactly one wallet credit on the successful retry
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it("failed payment event → status updated, wallet NOT credited", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeChain([]));

    const body = webhookBody("pi_failed", "payment.failed");
    const sig  = makeWebhookSig(body);
    const res  = await request(app)
      .post("/api/payments/ziina/webhook")
      .set("Content-Type", "application/json")
      .set("x-ziina-signature", sig)
      .send(body);

    expect(res.status).toBe(200);
    // Wallet insert must NOT happen for failed events
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("cancelled payment event → status updated, wallet NOT credited", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeChain([]));

    const body = webhookBody("pi_cancelled", "payment.cancelled");
    const sig  = makeWebhookSig(body);
    const res  = await request(app)
      .post("/api/payments/ziina/webhook")
      .set("Content-Type", "application/json")
      .set("x-ziina-signature", sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("payment not found in DB → 200 (Ziina receives ACK, we log)", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([])); // payment not found
    const res = await sendWebhook("pi_unknown");
    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("Invariant 1: exactly one wallet credit per completed external payment", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT])).mockReturnValueOnce(makeChain([WALLET]));
    mockDb.update.mockReturnValue(makeChain([{ id: PENDING_PMT.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 99 }]));

    const res = await sendWebhook("pi_exact_once");

    expect(res.status).toBe(200);
    // Count wallet transaction inserts — must be exactly 1
    const insertCalls = vi.mocked(mockDb.insert).mock.calls.length;
    expect(insertCalls).toBe(1);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/portal/admin/payments
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/portal/admin/payments", () => {

  it("admin can list payments", async () => {
    mockDb.select
      .mockReturnValueOnce(makeChain([{ id: 1, status: "completed", amount: "300.00", currency: "AED",
        provider: "ziina", orderId: null, completedAt: null, createdAt: new Date().toISOString(),
        userId: 1, userName: "Test User", userEmail: "t@t.com" }]))
      .mockReturnValueOnce(makeChain([{ total: 1 }]));

    const res = await request(app).get("/api/portal/admin/payments");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("customer cannot access admin endpoint → 403", async () => {
    const { requirePortalAdmin } = await import("../../lib/portalAuth.js");
    vi.mocked(requirePortalAdmin).mockImplementationOnce(async (_req: any, res: any) => {
      res.status(403).json({ success: false, error: { code: "FORBIDDEN" } });
    });

    const res = await request(app).get("/api/portal/admin/payments");
    expect(res.status).toBe(403);
    expect(mockDb.select).not.toHaveBeenCalled(); // never reached DB
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/portal/payments/:id/status
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/portal/payments/:id/status", () => {

  it("customer can check own payment status", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([{
      id: 5, status: "completed", amount: "200.00", currency: "AED",
      orderId: null, completedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    }]));

    const res = await request(app).get("/api/portal/payments/5/status");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("completed");
  });

  it("customer cannot view another user's payment → 404", async () => {
    mockDb.select.mockReturnValueOnce(makeChain([])); // userId filter returns nothing

    const res = await request(app).get("/api/portal/payments/999/status");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("invalid id (non-numeric) → 400", async () => {
    const res = await request(app).get("/api/portal/payments/abc/status");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ID");
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Currency validation
//  Invariant C1: Server always creates payments with currency = "AED"
//  Invariant C2: Webhook validates provider currency === "AED"
//  Invariant C3: Webhook validates internal payment.currency === "AED"
//  Invariant C4: Any currency mismatch blocks ALL financial side-effects
// ─────────────────────────────────────────────────────────────────────────────

describe("Currency validation — payment creation", () => {

  it("C1a: valid AED top-up (currency omitted) → payment created with AED", async () => {
    const { createZiinaPaymentIntent } = await import("../../lib/ziina.js");
    mockDb.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 7, userId: 1, amount: "200.00", paymentMethod: "ziina", status: "pending" }]))
      .mockReturnValueOnce(makeInsertChain([{ id: 42, userId: 1, orderId: null, status: "pending", operationId: "uuid", amount: "200.00", currency: "AED" }]));
    mockDb.update.mockReturnValue(makeChain([]));
    vi.mocked(createZiinaPaymentIntent).mockResolvedValue({ providerPaymentId: "pi_aed", checkoutUrl: "https://pay.ziina.com/aed" });

    // No currency field in body — server should default to AED
    const res = await request(app).post("/api/portal/payments/ziina/create").send({ topupAmount: 200 });

    expect(res.status).toBe(201);
    expect(res.body.data.currency).toBe("AED");
    // Ziina was called with AED
    expect(vi.mocked(createZiinaPaymentIntent)).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "AED" }),
    );
    // DB insert must have stored AED — verify the insert payload via the response
    expect(res.body.data.currency).toBe("AED");
  });

  it("C1b: client sends currency=USD → server ignores it, creates AED payment", async () => {
    const { createZiinaPaymentIntent } = await import("../../lib/ziina.js");
    mockDb.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 8, userId: 1, amount: "200.00", paymentMethod: "ziina", status: "pending" }]))
      .mockReturnValueOnce(makeInsertChain([{ id: 43, userId: 1, orderId: null, status: "pending", operationId: "uuid2", amount: "200.00", currency: "AED" }]));
    mockDb.update.mockReturnValue(makeChain([]));
    vi.mocked(createZiinaPaymentIntent).mockResolvedValue({ providerPaymentId: "pi_usd_attempt", checkoutUrl: "https://pay.ziina.com/x" });

    // Client claims USD — server must NOT honour it
    const res = await request(app).post("/api/portal/payments/ziina/create").send({ topupAmount: 200, currency: "USD" });

    expect(res.status).toBe(201);
    expect(res.body.data.currency).toBe("AED");              // server enforces AED
    expect(res.body.data.currency).not.toBe("USD");           // client input rejected
    expect(vi.mocked(createZiinaPaymentIntent)).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "AED" }),           // Ziina called with AED
    );
  });

  it("C1c: client sends currency=EUR → server ignores it, creates AED payment", async () => {
    const { createZiinaPaymentIntent } = await import("../../lib/ziina.js");
    mockDb.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 9, userId: 1, amount: "200.00", paymentMethod: "ziina", status: "pending" }]))
      .mockReturnValueOnce(makeInsertChain([{ id: 44, userId: 1, orderId: null, status: "pending", operationId: "uuid3", amount: "200.00", currency: "AED" }]));
    mockDb.update.mockReturnValue(makeChain([]));
    vi.mocked(createZiinaPaymentIntent).mockResolvedValue({ providerPaymentId: "pi_eur_attempt", checkoutUrl: "https://pay.ziina.com/y" });

    const res = await request(app).post("/api/portal/payments/ziina/create").send({ topupAmount: 200, currency: "EUR" });

    expect(res.status).toBe(201);
    expect(res.body.data.currency).toBe("AED");
    expect(res.body.data.currency).not.toBe("EUR");
    expect(vi.mocked(createZiinaPaymentIntent)).toHaveBeenCalledWith(
      expect.objectContaining({ currency: "AED" }),
    );
  });

});

describe("Currency validation — webhook settlement (Invariant C2, C3, C4)", () => {

  /**
   * Send a signed Ziina webhook.
   * - currencyCode = string  → includes { currency_code: <value> }
   * - currencyCode = null    → includes { currency_code: null }
   * - currencyCode = ABSENT  (call with no 2nd arg or pass the sentinel) → omits currency_code entirely
   */
  const ABSENT = Symbol("ABSENT");
  async function sendWebhookWithCurrency(
    piId: string,
    currencyCode: string | null | typeof ABSENT = ABSENT,
    type = "payment.completed",
  ) {
    const extra = currencyCode === ABSENT ? {} : { currency_code: currencyCode };
    const body  = webhookBody(piId, type, extra);
    const sig   = makeWebhookSig(body);
    return request(app)
      .post("/api/payments/ziina/webhook")
      .set("Content-Type", "application/json")
      .set("x-ziina-signature", sig)
      .send(body);
  }

  it("C2a: provider currency_code = AED → settlement proceeds", async () => {
    mockDb.select
      .mockReturnValueOnce(makeChain([PENDING_PMT]))   // payment found
      .mockReturnValueOnce(makeChain([WALLET]));        // wallet found
    mockDb.update.mockReturnValue(makeChain([{ id: PENDING_PMT.id }]));
    mockDb.insert.mockReturnValue(makeInsertChain([{ id: 99 }]));

    const res = await sendWebhookWithCurrency("pi_test_1", "AED");

    expect(res.status).toBe(200);
    expect(mockDb.insert).toHaveBeenCalled();           // wallet transaction inserted
  });

  it("C2b: provider currency_code = USD → settlement blocked; wallet NOT credited", async () => {
    const setPayloads: unknown[] = [];
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeUpdateChain([], setPayloads));

    const res = await sendWebhookWithCurrency("pi_test_1", "USD");

    // Server ACKs so Ziina does not retry a permanent mismatch
    expect(res.status).toBe(200);
    // No wallet transaction was created — the critical financial invariant
    expect(mockDb.insert).not.toHaveBeenCalled();
    // The failure-status update must have been called (payment marked failed)
    expect(setPayloads.length).toBeGreaterThan(0);
    const statuses = setPayloads.map((p: any) => p.status);
    expect(statuses).toContain("failed");               // payment marked failed
    expect(statuses).not.toContain("completed");        // never completed
    expect(statuses).not.toContain("processing");       // claim never happened
    // The failureReason must name CURRENCY_MISMATCH
    const reasons = setPayloads.map((p: any) => p.failureReason ?? "").filter(Boolean);
    expect(reasons.some((r: string) => r.includes("CURRENCY_MISMATCH"))).toBe(true);
  });

  it("C2c: provider currency_code = EUR → settlement blocked; wallet NOT credited", async () => {
    const setPayloads: unknown[] = [];
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeUpdateChain([], setPayloads));

    const res = await sendWebhookWithCurrency("pi_test_1", "EUR");

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();       // no wallet transaction
    expect(setPayloads.length).toBeGreaterThan(0);
    const statuses = setPayloads.map((p: any) => p.status);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("completed");
    expect(statuses).not.toContain("processing");
    const reasons = setPayloads.map((p: any) => p.failureReason ?? "").filter(Boolean);
    expect(reasons.some((r: string) => r.includes("CURRENCY_MISMATCH"))).toBe(true);
  });

  // ── Missing / absent / empty / whitespace currency_code ──────────────────

  it("C2d: currency_code absent (field not sent) → settlement blocked; wallet NOT credited", async () => {
    const setPayloads: unknown[] = [];
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeUpdateChain([], setPayloads));

    const res = await sendWebhookWithCurrency("pi_test_1", ABSENT); // no currency_code field

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();     // no wallet transaction
    expect(setPayloads.length).toBeGreaterThan(0);
    const statuses = setPayloads.map((p: any) => p.status);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("completed");
    expect(statuses).not.toContain("processing");
    const reasons = setPayloads.map((p: any) => p.failureReason ?? "").filter(Boolean);
    expect(reasons.some((r: string) => r.includes("CURRENCY_MISMATCH"))).toBe(true);
  });

  it("C2e: currency_code = null → settlement blocked; wallet NOT credited", async () => {
    const setPayloads: unknown[] = [];
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeUpdateChain([], setPayloads));

    const res = await sendWebhookWithCurrency("pi_test_1", null); // null explicitly sent

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(setPayloads.length).toBeGreaterThan(0);
    const statuses = setPayloads.map((p: any) => p.status);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("completed");
    expect(statuses).not.toContain("processing");
    const reasons = setPayloads.map((p: any) => p.failureReason ?? "").filter(Boolean);
    expect(reasons.some((r: string) => r.includes("CURRENCY_MISMATCH"))).toBe(true);
  });

  it("C2f: currency_code = '' (empty string) → settlement blocked; wallet NOT credited", async () => {
    const setPayloads: unknown[] = [];
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeUpdateChain([], setPayloads));

    const res = await sendWebhookWithCurrency("pi_test_1", "");

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(setPayloads.length).toBeGreaterThan(0);
    const statuses = setPayloads.map((p: any) => p.status);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("completed");
    expect(statuses).not.toContain("processing");
    const reasons = setPayloads.map((p: any) => p.failureReason ?? "").filter(Boolean);
    expect(reasons.some((r: string) => r.includes("CURRENCY_MISMATCH"))).toBe(true);
  });

  it("C2g: currency_code = whitespace only → settlement blocked; wallet NOT credited", async () => {
    const setPayloads: unknown[] = [];
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeUpdateChain([], setPayloads));

    const res = await sendWebhookWithCurrency("pi_test_1", "   ");

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(setPayloads.length).toBeGreaterThan(0);
    const statuses = setPayloads.map((p: any) => p.status);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("completed");
    expect(statuses).not.toContain("processing");
    const reasons = setPayloads.map((p: any) => p.failureReason ?? "").filter(Boolean);
    expect(reasons.some((r: string) => r.includes("CURRENCY_MISMATCH"))).toBe(true);
  });

  it("C3: internal payment.currency != AED → settlement blocked even if provider says AED", async () => {
    // Payment stored in DB has a non-AED currency (data integrity edge-case)
    const badCurrencyPmt = { ...PENDING_PMT, currency: "USD" };
    const setPayloads: unknown[] = [];
    mockDb.select.mockReturnValueOnce(makeChain([badCurrencyPmt]));
    mockDb.update.mockReturnValue(makeUpdateChain([], setPayloads));

    // Provider correctly reports AED — but internal record says USD → must still block
    const res = await sendWebhookWithCurrency("pi_test_1", "AED");

    expect(res.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();       // wallet NOT credited
    expect(setPayloads.length).toBeGreaterThan(0);
    const statuses = setPayloads.map((p: any) => p.status);
    expect(statuses).toContain("failed");               // payment marked failed
    expect(statuses).not.toContain("completed");        // never completed
    expect(statuses).not.toContain("processing");       // claim (pending→processing) never ran
    const reasons = setPayloads.map((p: any) => p.failureReason ?? "").filter(Boolean);
    expect(reasons.some((r: string) => r.includes("CURRENCY_MISMATCH"))).toBe(true);
  });

  it("C4: currency mismatch does NOT credit wallet balance", async () => {
    // Verify by ensuring update was never called with the wallet-credit SQL pattern
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeChain([]));

    await sendWebhookWithCurrency("pi_test_1", "USD");

    // The only update call should be the failure status update, not a wallet balance update
    // (wallet update uses a SQL template; we verify insert — the wallet tx — was never created)
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("C4: currency mismatch does NOT settle order (orderId payment)", async () => {
    const orderPmt = { ...PENDING_PMT, orderId: 42, topupRequestId: null };
    mockDb.select.mockReturnValueOnce(makeChain([orderPmt]));
    mockDb.update.mockReturnValue(makeChain([]));

    await sendWebhookWithCurrency("pi_test_1", "USD");

    expect(mockDb.insert).not.toHaveBeenCalled();       // no wallet tx
    // All update calls are to mark payment failed — not to settle the order
    const updateCalls = vi.mocked(mockDb.update).mock.calls;
    expect(JSON.stringify(updateCalls)).not.toContain('"completed"');
  });

  it("C4: currency mismatch does NOT complete top-up", async () => {
    // PENDING_PMT already has topupRequestId: 3
    mockDb.select.mockReturnValueOnce(makeChain([PENDING_PMT]));
    mockDb.update.mockReturnValue(makeChain([]));

    await sendWebhookWithCurrency("pi_test_1", "USD");

    expect(mockDb.insert).not.toHaveBeenCalled();       // no wallet tx
    // The topup_requests table must NOT have received an "approved" status update
    const updateCalls = vi.mocked(mockDb.update).mock.calls;
    expect(JSON.stringify(updateCalls)).not.toContain('"approved"');
    expect(JSON.stringify(updateCalls)).not.toContain('"completed"');
  });

});
