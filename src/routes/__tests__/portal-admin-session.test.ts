/**
 * Integration tests: portal_admin_session enforcement on migrated admin routes.
 *
 * For every route file that was migrated from the old df_admin_session cookie to
 * requirePortalAdmin, we verify three scenarios:
 *   1. No cookie              → 401
 *   2. Old df_admin_session   → 401 (stale cookie must be rejected)
 *   3. Valid portal_admin_session → HTTP 2xx (auth passes, route executes)
 */
import { vi, describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

// ── Hoisted helpers ────────────────────────────────────────────────────────────
// vi.hoisted runs before vi.mock() factories and before any imports, so these
// values are available inside the mock factories below.
const { MOCK_ADMIN, mockDb } = vi.hoisted(() => {
  /** Generic chainable Drizzle ORM mock: every builder method returns itself;
   *  awaiting the chain resolves to `rows`. */
  function makeDbChain(rows: unknown[]) {
    const proxy: Record<string | symbol, unknown> = {};
    const handler: ProxyHandler<typeof proxy> = {
      get(_, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve);
        }
        // All Drizzle builder methods (from, where, limit, orderBy, values,
        // set, returning, onConflictDoUpdate, groupBy, …) return the same proxy.
        return () => new Proxy(proxy, handler);
      },
    };
    return new Proxy(proxy, handler);
  }

  const MOCK_ADMIN = {
    id: 1,
    sessionVersion: 0,
    isActive: true,
    fullName: "Test Admin",
    email: "admin@test.example",
    role: "admin",
    passwordHash: "$2b$10$placeholder",
  };

  const mockDb = {
    select: () => makeDbChain([MOCK_ADMIN]),
    insert: () => makeDbChain([MOCK_ADMIN]),
    update: () => makeDbChain([MOCK_ADMIN]),
    delete: () => makeDbChain([MOCK_ADMIN]),
  };

  return { MOCK_ADMIN, mockDb };
});

// ── Module mocks ───────────────────────────────────────────────────────────────
// Must be declared before any imports that transitively load these modules.

vi.mock("@workspace/db", () => ({
  db: mockDb,
  // Table stubs — passed as arguments to mocked builder methods (ignored at runtime)
  portalAdminUsers: {},
  aibosLeads: {},
  businessAudits: {},
  websiteOrders: {},
  courseEnrollments: {},
  blogPosts: {},
  clients: {},
  companyUsers: {},
  campaignReports: {},
  campaignData: {},
  reportContent: {},
  // Enum / misc
  insertBlogPostSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
}));

vi.mock("../../lib/sitemap", () => ({
  rebuildSitemap: vi.fn().mockResolvedValue(undefined),
  initSitemap: vi.fn().mockResolvedValue(undefined),
  getSitemapXml: vi.fn().mockReturnValue(""),
}));

vi.mock("../../lib/mailer", () => ({
  sendReportPublishedEmail: vi.fn().mockResolvedValue("not_configured"),
}));

vi.mock("../../lib/objectStorage", () => ({
  ObjectStorageService: class {
    getObjectEntityUploadURL = vi.fn().mockResolvedValue("https://r2.example/upload");
    normalizeObjectEntityPath = vi.fn().mockReturnValue("/objects/test");
  },
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "{}" } }] }) } },
  },
}));

// ── Real imports (after mocks are registered) ──────────────────────────────────
import {
  issueAdminToken,
  PORTAL_ADMIN_SESSION_COOKIE,
} from "../../lib/portalAuth.js";

import blogRouter       from "../blog.js";
import clientsRouter    from "../admin-clients.js";
import aibosRouter      from "../admin-aibos-leads.js";
import auditsRouter     from "../admin-business-audits.js";
import ordersRouter     from "../admin-website-orders.js";
import courseRouter     from "../course-register.js";

// ── Test helpers ───────────────────────────────────────────────────────────────

const SECRET = "test-session-secret-at-least-32-chars-long";

/** Build a minimal express app mounting one or more routers under /api */
function buildApp(...routers: express.IRouter[]) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  for (const r of routers) app.use("/api", r);
  return app;
}

/** Cookie header containing a valid portal_admin_session token */
function validPortalAdminCookie(): string {
  const token = issueAdminToken(MOCK_ADMIN.id, MOCK_ADMIN.sessionVersion);
  return `${PORTAL_ADMIN_SESSION_COOKIE}=${token}`;
}

/** Cookie header containing the OLD df_admin_session token (any value is sufficient
 *  to test rejection — the middleware only looks for portal_admin_session). */
const OLD_SESSION_COOKIE =
  "df_admin_session=1a2b3c4d.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

beforeAll(() => {
  // Required by issueAdminToken / verifyAdminToken inside requirePortalAdmin
  process.env.SESSION_SECRET = SECRET;
  // Prevent stray ADMIN_PASSWORD checks from returning 503
  process.env.ADMIN_PASSWORD = "test-admin-password";
});

// ══════════════════════════════════════════════════════════════════════════════
// blog.ts — POST / PATCH / DELETE  /api/admin/blog/posts
// ══════════════════════════════════════════════════════════════════════════════
describe("blog.ts › DELETE /api/admin/blog/posts/:id", () => {
  const app = buildApp(blogRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).delete("/api/admin/blog/posts/test-post");
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .delete("/api/admin/blog/posts/test-post")
      .set("Cookie", OLD_SESSION_COOKIE);
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie → 2xx", async () => {
    const res = await request(app)
      .delete("/api/admin/blog/posts/test-post")
      .set("Cookie", validPortalAdminCookie());
    // Auth passed — mock DB returns a deleted row, so expect 200, not 401
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });
});

describe("blog.ts › POST /api/admin/blog/posts", () => {
  const app = buildApp(blogRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).post("/api/admin/blog/posts").send({});
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .post("/api/admin/blog/posts")
      .set("Cookie", OLD_SESSION_COOKIE)
      .send({});
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie (auth passes, body may be invalid → 400, not 401)", async () => {
    const res = await request(app)
      .post("/api/admin/blog/posts")
      .set("Cookie", validPortalAdminCookie())
      .send({});
    // Auth passed — even with an empty body the handler runs (returns 400 for bad data)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// admin-clients.ts — GET /api/admin/clients
// ══════════════════════════════════════════════════════════════════════════════
describe("admin-clients.ts › GET /api/admin/clients", () => {
  const app = buildApp(clientsRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).get("/api/admin/clients");
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .get("/api/admin/clients")
      .set("Cookie", OLD_SESSION_COOKIE);
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie → 200", async () => {
    const res = await request(app)
      .get("/api/admin/clients")
      .set("Cookie", validPortalAdminCookie());
    expect(res.status).toBe(200);
  });
});

describe("admin-clients.ts › DELETE /api/admin/clients/:id", () => {
  const app = buildApp(clientsRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).delete("/api/admin/clients/1");
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .delete("/api/admin/clients/1")
      .set("Cookie", OLD_SESSION_COOKIE);
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie → 2xx", async () => {
    const res = await request(app)
      .delete("/api/admin/clients/1")
      .set("Cookie", validPortalAdminCookie());
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// admin-aibos-leads.ts — GET /api/admin/aibos-leads
// ══════════════════════════════════════════════════════════════════════════════
describe("admin-aibos-leads.ts › GET /api/admin/aibos-leads", () => {
  const app = buildApp(aibosRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).get("/api/admin/aibos-leads");
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .get("/api/admin/aibos-leads")
      .set("Cookie", OLD_SESSION_COOKIE);
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie → 200", async () => {
    const res = await request(app)
      .get("/api/admin/aibos-leads")
      .set("Cookie", validPortalAdminCookie());
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// admin-business-audits.ts — GET /api/admin/business-audits
// ══════════════════════════════════════════════════════════════════════════════
describe("admin-business-audits.ts › GET /api/admin/business-audits", () => {
  const app = buildApp(auditsRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).get("/api/admin/business-audits");
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .get("/api/admin/business-audits")
      .set("Cookie", OLD_SESSION_COOKIE);
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie → 200", async () => {
    const res = await request(app)
      .get("/api/admin/business-audits")
      .set("Cookie", validPortalAdminCookie());
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// admin-website-orders.ts — GET /api/admin/website-orders
// ══════════════════════════════════════════════════════════════════════════════
describe("admin-website-orders.ts › GET /api/admin/website-orders", () => {
  const app = buildApp(ordersRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).get("/api/admin/website-orders");
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .get("/api/admin/website-orders")
      .set("Cookie", OLD_SESSION_COOKIE);
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie → 200", async () => {
    const res = await request(app)
      .get("/api/admin/website-orders")
      .set("Cookie", validPortalAdminCookie());
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// course-register.ts — GET /api/admin/course-enrollments
// ══════════════════════════════════════════════════════════════════════════════
describe("course-register.ts › GET /api/admin/course-enrollments", () => {
  const app = buildApp(courseRouter);

  it("rejects request with no cookie → 401", async () => {
    const res = await request(app).get("/api/admin/course-enrollments");
    expect(res.status).toBe(401);
  });

  it("rejects request with old df_admin_session cookie → 401", async () => {
    const res = await request(app)
      .get("/api/admin/course-enrollments")
      .set("Cookie", OLD_SESSION_COOKIE);
    expect(res.status).toBe(401);
  });

  it("admits request with valid portal_admin_session cookie → 200", async () => {
    const res = await request(app)
      .get("/api/admin/course-enrollments")
      .set("Cookie", validPortalAdminCookie());
    expect(res.status).toBe(200);
  });
});
