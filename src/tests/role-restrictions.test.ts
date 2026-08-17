/**
 * Role-restriction regression tests — settings and broadcast endpoints.
 *
 * Imports the actual production portal-admin router with all I/O mocked so
 * the full middleware chain (requirePortalAdmin → requireRole → handler) is
 * exercised.  Finance, marketing, and support must receive 403; super_admin
 * and manager must not.
 *
 * Endpoints covered:
 *   PUT  /portal/admin/settings           → super_admin, manager only
 *   POST /portal/admin/notifications/send → super_admin, manager only
 */

import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";

// ── Mock all I/O dependencies before the production router is imported ────────

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
        orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }),
        limit: () => ({ offset: () => Promise.resolve([]) }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
  portalSettings:           {},
  portalUsers:              {},
  portalAdminUsers:         {},
  portalProfiles:           {},
  portalOrders:             {},
  portalOrderTimeline:      {},
  portalCampaigns:          {},
  portalWallets:            {},
  portalWalletTransactions: {},
  portalTopupRequests:      {},
  portalNotifications:      {},
  portalSupportTickets:     {},
  portalSupportMessages:    {},
  portalServices:           {},
  portalPackages:           {},
  portalAuditLogs:          {},
  portalFiles:              {},
  portalCampaignReports:    {},
}));

vi.mock("../vendor/db/schema/portal.js", () => ({
  portalSettings:           {},
  portalUsers:              {},
  portalAdminUsers:         {},
  portalProfiles:           {},
  portalOrders:             {},
  portalOrderTimeline:      {},
  portalCampaigns:          {},
  portalWallets:            {},
  portalWalletTransactions: {},
  portalTopupRequests:      {},
  portalNotifications:      {},
  portalSupportTickets:     {},
  portalSupportMessages:    {},
  portalServices:           {},
  portalPackages:           {},
  portalAuditLogs:          {},
  portalFiles:              {},
  portalCampaignReports:    {},
}));

vi.mock("../lib/portalAuth.js", () => ({
  requirePortalAdmin: (req: any, _res: any, next: () => void) => {
    req.portalAdmin = {
      id:    1,
      email: "admin@test.com",
      role:  req.headers["x-test-role"] ?? "super_admin",
    };
    next();
  },
  admin:  (req: any) => req.portalAdmin,
  issueAdminToken:          vi.fn().mockReturnValue("tok"),
  setAdminCookie:           vi.fn(),
  PORTAL_ADMIN_SESSION_COOKIE: "portal_admin_session",
}));

vi.mock("../lib/portalNotify.js", () => ({
  notifyUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/portalAudit.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info:  vi.fn(),
    error: vi.fn(),
    warn:  vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import the real production router (mocks above are hoisted before this) ──
import portalAdminRouter from "../routes/portal-admin.js";

// ── requireRole unit tests (middleware in isolation, no HTTP) ─────────────────
import { requireRole } from "../middleware/roleCheck.js";

type AdminRole = "super_admin" | "manager" | "marketing" | "support" | "finance";

function makeReq(role: AdminRole) {
  return { portalAdmin: { id: 1, email: "t@t.com", role } } as any;
}
function makeRes() {
  const res: any = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

describe("requireRole middleware — unit", () => {
  it("calls next() for an allowed role", () => {
    const mw = requireRole("super_admin", "manager");
    const next = vi.fn();
    mw(makeReq("super_admin"), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 403 for a blocked role (finance)", () => {
    const mw = requireRole("super_admin", "manager");
    const res = makeRes();
    const next = vi.fn();
    mw(makeReq("finance"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
  });

  it("returns 403 for a blocked role (marketing)", () => {
    const mw = requireRole("super_admin", "manager");
    const res = makeRes();
    const next = vi.fn();
    mw(makeReq("marketing"), res, next);
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 when portalAdmin is absent", () => {
    const mw = requireRole("super_admin", "manager");
    const res = makeRes();
    const next = vi.fn();
    mw({} as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

// ── Build a lightweight Express app mounting the production router ─────────────

function buildApp(role: AdminRole) {
  const app = express();
  app.use(express.json());
  // Inject the test role header so the mocked requirePortalAdmin sets the right role.
  app.use((req: any, _res, next) => {
    req.headers["x-test-role"] = role;
    next();
  });
  app.use(portalAdminRouter);
  return app;
}

// ── PUT /portal/admin/settings ────────────────────────────────────────────────

describe("PUT /portal/admin/settings — production router guard", () => {
  const blockedRoles: AdminRole[] = ["finance", "marketing", "support"];
  const allowedRoles: AdminRole[] = ["super_admin", "manager"];

  for (const role of blockedRoles) {
    it(`blocks ${role} → 403`, async () => {
      const res = await request(buildApp(role))
        .put("/portal/admin/settings")
        .send({ vat_enabled: true });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    });
  }

  for (const role of allowedRoles) {
    it(`allows ${role} → 200`, async () => {
      const res = await request(buildApp(role))
        .put("/portal/admin/settings")
        .send({ vat_enabled: true });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });
  }
});

// ── POST /portal/admin/notifications/send ─────────────────────────────────────

describe("POST /portal/admin/notifications/send — production router guard", () => {
  const blockedRoles: AdminRole[] = ["finance", "marketing", "support"];
  const allowedRoles: AdminRole[] = ["super_admin", "manager"];

  for (const role of blockedRoles) {
    it(`blocks ${role} → 403`, async () => {
      const res = await request(buildApp(role))
        .post("/portal/admin/notifications/send")
        .send({ title: "Test", body: "Hello" });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    });
  }

  for (const role of allowedRoles) {
    it(`allows ${role} → 200`, async () => {
      const res = await request(buildApp(role))
        .post("/portal/admin/notifications/send")
        .send({ title: "Test", body: "Hello" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
    });
  }
});
