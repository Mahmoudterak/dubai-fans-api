/**
 * Tests: CSV export audit trail
 *
 * Verifies that:
 * 1. GET /portal/admin/customers/export writes a "customers.export" audit log
 *    entry with the correct adminId, adminEmail, and metadata.columns.
 * 2. GET /portal/admin/orders/export writes an "orders.export" audit log entry
 *    with the correct adminId, adminEmail, and metadata.columns.
 * 3. A custom ?columns= query param is reflected in the audit metadata and only
 *    those columns appear in the CSV header row.
 * 4. Unknown column names are silently stripped; an all-invalid list falls back
 *    to the full default column set.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

// ─── Hoisted mock primitives (available inside vi.mock factories) ─────────────

const mocks = vi.hoisted(() => {
  const auditLogFn  = vi.fn();
  const mockOrderBy = vi.fn();
  const mockFrom    = vi.fn();
  const mockSelect  = vi.fn();
  return { auditLogFn, mockOrderBy, mockFrom, mockSelect };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  db: { select: mocks.mockSelect },
}));

vi.mock("../../lib/portalAudit.js", () => ({
  auditLog: mocks.auditLogFn,
}));

vi.mock("../../lib/portalAuth.js", () => ({
  requirePortalAdmin: (req: any, _res: any, next: () => void) => {
    req.portalAdmin = {
      id:             7,
      email:          "admin@example.com",
      role:           "super_admin",
      fullName:       "Test Admin",
      isActive:       true,
      sessionVersion: 1,
    };
    next();
  },
  PORTAL_ADMIN_SESSION_COOKIE: "portal_admin_session",
  issueAdminToken: vi.fn(),
  setAdminCookie:  vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import portalAdminExportRouter from "../portal-admin-export.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", portalAdminExportRouter);
  return app;
}

const DEFAULT_CUSTOMER_COLUMNS = [
  "id", "fullName", "email", "mobile", "country", "isActive", "createdAt",
];
const DEFAULT_ORDER_COLUMNS = [
  "id", "userId", "serviceId", "packageId", "status",
  "subtotal", "vatAmount", "total", "currency", "createdAt",
];

const SAMPLE_CUSTOMER = {
  id: 1, fullName: "Alice", email: "alice@example.com",
  mobile: "050123456", country: "AE", isActive: true, createdAt: new Date(),
};
const SAMPLE_ORDER = {
  id: 10, userId: 1, serviceId: 2, packageId: 3, status: "active",
  subtotal: "100.00", vatAmount: "5.00", total: "105.00",
  currency: "AED", createdAt: new Date(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CSV export audit trail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire the drizzle query chain after clearAllMocks resets all return values
    mocks.mockFrom.mockReturnValue({ orderBy: mocks.mockOrderBy });
    mocks.mockSelect.mockReturnValue({ from: mocks.mockFrom });
    mocks.mockOrderBy.mockResolvedValue([]);
    mocks.auditLogFn.mockResolvedValue(undefined);
  });

  // ── customers/export ───────────────────────────────────────────────────────

  describe("GET /api/portal/admin/customers/export", () => {
    it("returns CSV and writes a customers.export audit log with admin identity and all default columns", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_CUSTOMER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/customers/export");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);

      // CSV first line must contain the full default column set
      const firstLine = res.text.split("\n")[0];
      expect(firstLine).toBe(DEFAULT_CUSTOMER_COLUMNS.join(","));

      expect(mocks.auditLogFn).toHaveBeenCalledOnce();
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.action).toBe("customers.export");
      expect(call.adminId).toBe(7);
      expect(call.adminEmail).toBe("admin@example.com");
      expect(call.metadata.columns).toEqual(DEFAULT_CUSTOMER_COLUMNS);
      expect(call.metadata.rowCount).toBe(1);
    });

    it("records only the requested columns in the audit metadata when ?columns= is supplied", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_CUSTOMER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/customers/export?columns=id,email");

      expect(res.status).toBe(200);
      expect(res.text.split("\n")[0]).toBe("id,email");

      expect(mocks.auditLogFn).toHaveBeenCalledOnce();
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.action).toBe("customers.export");
      expect(call.adminEmail).toBe("admin@example.com");
      expect(call.metadata.columns).toEqual(["id", "email"]);
    });

    it("silently strips unknown column names from the ?columns= param", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_CUSTOMER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/customers/export?columns=id,INVALID_COL,email");

      expect(res.status).toBe(200);
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.metadata.columns).toEqual(["id", "email"]);
    });

    it("falls back to all default columns when every ?columns= value is invalid", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_CUSTOMER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/customers/export?columns=NOPE,ALSO_NOPE");

      expect(res.status).toBe(200);
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.metadata.columns).toEqual(DEFAULT_CUSTOMER_COLUMNS);
    });
  });

  // ── orders/export ──────────────────────────────────────────────────────────

  describe("GET /api/portal/admin/orders/export", () => {
    it("returns CSV and writes an orders.export audit log with admin identity and all default columns", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_ORDER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/orders/export");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text.split("\n")[0]).toBe(DEFAULT_ORDER_COLUMNS.join(","));

      expect(mocks.auditLogFn).toHaveBeenCalledOnce();
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.action).toBe("orders.export");
      expect(call.adminId).toBe(7);
      expect(call.adminEmail).toBe("admin@example.com");
      expect(call.metadata.columns).toEqual(DEFAULT_ORDER_COLUMNS);
      expect(call.metadata.rowCount).toBe(1);
    });

    it("records only the requested columns in the audit metadata when ?columns= is supplied", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_ORDER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/orders/export?columns=id,status,total");

      expect(res.status).toBe(200);
      expect(res.text.split("\n")[0]).toBe("id,status,total");

      expect(mocks.auditLogFn).toHaveBeenCalledOnce();
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.action).toBe("orders.export");
      expect(call.adminEmail).toBe("admin@example.com");
      expect(call.metadata.columns).toEqual(["id", "status", "total"]);
    });

    it("silently strips unknown column names from the ?columns= param", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_ORDER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/orders/export?columns=id,UNKNOWN_COL,currency");

      expect(res.status).toBe(200);
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.metadata.columns).toEqual(["id", "currency"]);
    });

    it("falls back to all default columns when every ?columns= value is invalid", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_ORDER]);

      const res = await request(buildApp())
        .get("/api/portal/admin/orders/export?columns=BAD_COL");

      expect(res.status).toBe(200);
      const call = mocks.auditLogFn.mock.calls[0][0];
      expect(call.metadata.columns).toEqual(DEFAULT_ORDER_COLUMNS);
    });
  });

  // ── Audit write failure → fail closed ─────────────────────────────────────

  describe("fail-closed on audit persistence failure", () => {
    it("returns 500 and does NOT send a CSV when the customers audit write fails", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_CUSTOMER]);
      mocks.auditLogFn.mockRejectedValueOnce(new Error("DB connection lost"));

      const res = await request(buildApp())
        .get("/api/portal/admin/customers/export");

      expect(res.status).toBe(500);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(res.body).toMatchObject({ success: false });
      // Must not have sent CSV content
      expect(res.text).not.toContain("id,fullName");
    });

    it("returns 500 and does NOT send a CSV when the orders audit write fails", async () => {
      mocks.mockOrderBy.mockResolvedValueOnce([SAMPLE_ORDER]);
      mocks.auditLogFn.mockRejectedValueOnce(new Error("DB connection lost"));

      const res = await request(buildApp())
        .get("/api/portal/admin/orders/export");

      expect(res.status).toBe(500);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(res.body).toMatchObject({ success: false });
      expect(res.text).not.toContain("id,userId");
    });
  });

  // ── CSV injection sanitization ─────────────────────────────────────────────

  describe("CSV injection sanitization in toCsv", () => {
    it("prefixes formula-trigger characters with a single quote so spreadsheets cannot execute them", async () => {
      // Row with values that start with each dangerous prefix
      const maliciousRow = {
        ...SAMPLE_CUSTOMER,
        fullName:  "=SUM(A1:A10)",
        email:     "+cmd|'/C calc'!A0",
        mobile:    "-2+3+cmd|'/C calc'",
        country:   "@SUM(1+1)*cmd|'/C calc'",
        isActive:  true,
        createdAt: new Date("2024-01-01"),
      };

      mocks.mockOrderBy.mockResolvedValueOnce([maliciousRow]);

      const res = await request(buildApp())
        .get("/api/portal/admin/customers/export?columns=fullName,email,mobile,country");

      expect(res.status).toBe(200);
      const lines = res.text.split("\n");

      // Each dangerous value must be prefixed with ' inside the quotes
      expect(lines[1]).toContain("'=SUM(A1:A10)");
      expect(lines[1]).toContain("'+cmd|'/C calc'");
      expect(lines[1]).toContain("'-2+3+cmd|'/C calc'");
      expect(lines[1]).toContain("'@SUM(1+1)");
    });
  });
});
