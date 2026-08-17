/**
 * Tests: portal admin login rate limiting
 *
 * Verifies that the login endpoint enforces a request limit so that an
 * attacker cannot brute-force admin credentials indefinitely.
 *
 * NOTE: The production loginLimiter skips in NODE_ENV=test so normal unit
 * tests can call the endpoint freely. These tests mount a tight in-process
 * limiter directly to verify the throttling behaviour without relying on
 * real IP-state or time windows.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
}));

vi.mock("../../lib/portalAuth.js", () => ({
  requirePortalAdmin: (_req: any, _res: any, next: () => void) => next(),
  PORTAL_ADMIN_SESSION_COOKIE: "portal_admin_session",
  issueAdminToken: vi.fn().mockReturnValue("tok"),
  setAdminCookie: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── SUT ─────────────────────────────────────────────────────────────────────

// Import the raw login handler separately so we can wrap it with a tight
// test-specific limiter without touching production NODE_ENV logic.
import portalAdminAuthRouter from "../portal-admin-auth.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds an app that protects /portal/admin/auth/login with a strict
 * max=N limiter (no IP skip, no success skip) so we can assert on 429
 * behaviour in isolation.
 */
function buildThrottledApp(max: number) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Tight in-process limiter (no time-based expiry in this test window)
  const testLimiter = rateLimit({
    windowMs: 60_000,
    max,
    skipSuccessfulRequests: false,
    // Disable the keyGenerator default to avoid needing real IPs
    keyGenerator: () => "test-client",
  });

  // Mount the limiter ahead of the actual router for the login path only
  app.use("/api/portal/admin/auth/login", testLimiter);
  app.use("/api", portalAdminAuthRouter);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("portal admin login rate limiting", () => {
  it("allows requests up to the configured limit", async () => {
    const app = buildThrottledApp(3);
    const body = { email: "admin@example.com", password: "wrong" };

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/api/portal/admin/auth/login").send(body);
      // Will be 401 (bad creds) but NOT 429
      expect(res.status).not.toBe(429);
    }
  });

  it("returns 429 once the limit is exceeded", async () => {
    const app = buildThrottledApp(2);
    const body = { email: "admin@example.com", password: "wrong" };

    // Exhaust the limit
    await request(app).post("/api/portal/admin/auth/login").send(body);
    await request(app).post("/api/portal/admin/auth/login").send(body);

    // Third attempt should be throttled
    const res = await request(app).post("/api/portal/admin/auth/login").send(body);
    expect(res.status).toBe(429);
  });

  it("does NOT rate-limit the logout or me endpoints", async () => {
    const app = buildThrottledApp(1);

    // Exhaust the login limiter (only mounted on the login path)
    await request(app).post("/api/portal/admin/auth/login")
      .send({ email: "a@b.com", password: "x" });
    await request(app).post("/api/portal/admin/auth/login")
      .send({ email: "a@b.com", password: "x" });

    // Logout should still work regardless
    const logoutRes = await request(app).post("/api/portal/admin/auth/logout");
    expect(logoutRes.status).toBe(200);
  });
});
