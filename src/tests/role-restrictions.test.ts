/**
 * Role-restriction tests for the portal admin API.
 *
 * Two test layers:
 *
 * 1. Unit tests — requireRole middleware in isolation (no HTTP, no DB).
 * 2. Route-level integration tests — a lightweight Express app that mirrors
 *    the two protected routes and injects a fake admin session, so we can
 *    verify 403 for blocked roles and 2xx pass-through for allowed ones
 *    without touching the database.
 *
 * Endpoints covered:
 *   PUT  /api/portal/admin/settings           → super_admin, manager only
 *   POST /api/portal/admin/notifications/send → super_admin, manager only
 */

import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { requireRole } from "../middleware/roleCheck.js";
import type { Request, Response } from "express";

// ── helpers ──────────────────────────────────────────────────────────────────

type AdminRole = "super_admin" | "manager" | "marketing" | "support" | "finance";

function makeReq(role: AdminRole): Request {
  return { portalAdmin: { id: 1, email: "test@example.com", role } } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

/**
 * Build a minimal Express app that mirrors the two protected routes.
 * The `fakeAdminMiddleware` injects a portal admin with the given role so the
 * test never needs a real cookie or database.
 */
function buildTestApp(role: AdminRole) {
  const app = express();
  app.use(express.json());

  // Simulate requirePortalAdmin by injecting a fake admin
  app.use((req: any, _res, next) => {
    req.portalAdmin = { id: 1, email: "admin@test.com", role };
    next();
  });

  app.put(
    "/api/portal/admin/settings",
    requireRole("super_admin", "manager"),
    (_req: Request, res: Response) => res.json({ success: true, data: {} }),
  );

  app.post(
    "/api/portal/admin/notifications/send",
    requireRole("super_admin", "manager"),
    (_req: Request, res: Response) => res.json({ success: true, data: { sent: 0 } }),
  );

  return app;
}

// ── Unit: requireRole middleware ──────────────────────────────────────────────

describe("requireRole middleware — unit", () => {
  it("calls next() for an allowed role", () => {
    const middleware = requireRole("super_admin", "manager");
    const req = makeReq("super_admin");
    const res = makeRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((res as any).statusCode).toBe(200);
  });

  it("returns 403 for a disallowed role", () => {
    const middleware = requireRole("super_admin", "manager");
    const req = makeReq("finance");
    const res = makeRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(403);
    expect((res as any).body).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
  });

  it("returns 401 when portalAdmin is absent", () => {
    const middleware = requireRole("super_admin", "manager");
    const req = {} as Request;
    const res = makeRes();
    const next = vi.fn();
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect((res as any).statusCode).toBe(401);
  });
});

// ── Route-level: PUT /api/portal/admin/settings ───────────────────────────────

describe("PUT /api/portal/admin/settings — route guard", () => {
  const allowedRoles: AdminRole[] = ["super_admin", "manager"];
  const blockedRoles: AdminRole[] = ["finance", "marketing", "support"];

  for (const role of allowedRoles) {
    it(`allows ${role} — responds 200`, async () => {
      const res = await request(buildTestApp(role))
        .put("/api/portal/admin/settings")
        .send({ vatEnabled: true, vatRate: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });
  }

  for (const role of blockedRoles) {
    it(`blocks ${role} — responds 403`, async () => {
      const res = await request(buildTestApp(role))
        .put("/api/portal/admin/settings")
        .send({ vatEnabled: true, vatRate: 5 });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    });
  }
});

// ── Route-level: POST /api/portal/admin/notifications/send ───────────────────

describe("POST /api/portal/admin/notifications/send — route guard", () => {
  const allowedRoles: AdminRole[] = ["super_admin", "manager"];
  const blockedRoles: AdminRole[] = ["finance", "marketing", "support"];

  for (const role of allowedRoles) {
    it(`allows ${role} — responds 200`, async () => {
      const res = await request(buildTestApp(role))
        .post("/api/portal/admin/notifications/send")
        .send({ title: "Test", body: "Hello" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });
  }

  for (const role of blockedRoles) {
    it(`blocks ${role} — responds 403`, async () => {
      const res = await request(buildTestApp(role))
        .post("/api/portal/admin/notifications/send")
        .send({ title: "Test", body: "Hello" });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    });
  }
});
