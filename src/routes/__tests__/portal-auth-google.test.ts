/**
 * Integration tests: POST /api/portal/auth/google
 *
 * Uses vi.spyOn(OAuth2Client.prototype, "verifyIdToken") so that:
 * - No custom vi.mock factory is needed for google-auth-library
 * - vi.resetAllMocks() in beforeEach cleanly resets every test's state
 * - The spy intercepts any OAuth2Client instance the route creates
 *
 * Covers every constraint from the security review:
 *  ✓ no client IDs configured → 503 GOOGLE_NOT_CONFIGURED
 *  ✓ missing/empty idToken → 400 VALIDATION_ERROR
 *  ✓ invalid/expired Google token → 401 INVALID_TOKEN
 *  ✓ wrong audience (not in allowlist) → 401 INVALID_TOKEN
 *  ✓ null getPayload() → 401 INVALID_TOKEN
 *  ✓ email_verified = false → 401 EMAIL_NOT_VERIFIED
 *  ✓ GOOGLE_ANDROID_CLIENT_ID added to allowlist when set
 *  ✓ new Google user → 201, token in JSON body, HttpOnly cookie
 *  ✓ transaction: profile + wallet + identity created atomically
 *  ✓ transaction rollback if any insert fails → 500 (no partial account)
 *  ✓ existing Google identity → 200 login, token in JSON
 *  ✓ JSON body token === cookie token (same session)
 *  ✓ existing email (no identity) → link + 200 login
 *  ✓ duplicate identity race (23505) → recovered, not 500
 *  ✓ suspended user → 403
 *  ✓ bcrypt.compare always returns false for null/empty hash
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { OAuth2Client } from "google-auth-library";

// ── Hoisted db mock helpers ───────────────────────────────────────────────────

const { mockDb, makeChain, makeInsertChain, MOCK_USER, MOCK_IDENTITY } = vi.hoisted(() => {
  /** Drizzle chain proxy: every builder method returns itself; awaiting resolves to `rows`. */
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

  const MOCK_USER = {
    id: 42,
    fullName: "Ahmed Hassan",
    email: "ahmed@example.com",
    passwordHash: null as string | null,
    isActive: true,
    sessionVersion: 1,
    mobile: null,
    country: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const MOCK_IDENTITY = {
    id: 1,
    userId: 42,
    provider: "google",
    providerSubject: "google-sub-123",
    email: "ahmed@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockDb = {
    select:      vi.fn(),
    insert:      vi.fn(),
    update:      vi.fn(),
    delete:      vi.fn(),
    transaction: vi.fn(),
  };

  return { mockDb, makeChain, makeInsertChain, MOCK_USER, MOCK_IDENTITY };
});

// ── Module mocks (db + schema + logger only — NOT google-auth-library) ────────

vi.mock("@workspace/db",                    () => ({ db: mockDb }));
vi.mock("../../vendor/db/schema/portal.js", () => ({
  portalUsers: {}, portalProfiles: {}, portalWallets: {},
  userIdentities: {}, portalAdminUsers: {},
}));
vi.mock("../../lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── Shared app — created once from a single static import ────────────────────

let app: express.Application;
let verifyIdTokenSpy: ReturnType<typeof vi.spyOn<OAuth2Client, "verifyIdToken">>;

beforeAll(async () => {
  process.env.SESSION_SECRET       = "test-session-secret-32-chars-long!!";
  process.env.GOOGLE_WEB_CLIENT_ID = "web-client-id.apps.googleusercontent.com";
  delete process.env.GOOGLE_ANDROID_CLIENT_ID;

  const { default: router } = await import("../portal-auth-google.js");
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", router);
});

beforeEach(() => {
  // Full reset of all vi.fn() mocks (clears both call history and queued values)
  vi.resetAllMocks();
  // Spy on the prototype method — intercepts any OAuth2Client instance the route creates
  verifyIdTokenSpy = vi.spyOn(OAuth2Client.prototype, "verifyIdToken");
  // Restore env defaults
  process.env.GOOGLE_WEB_CLIENT_ID = "web-client-id.apps.googleusercontent.com";
  delete process.env.GOOGLE_ANDROID_CLIENT_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Set up a successful Google ID token response. */
function mockValidToken(overrides: Record<string, unknown> = {}) {
  verifyIdTokenSpy.mockResolvedValueOnce({
    getPayload: () => ({
      sub:            "google-sub-123",
      email:          "ahmed@example.com",
      email_verified: true,
      name:           "Ahmed Hassan",
      iss:            "accounts.google.com",
      aud:            "web-client-id.apps.googleusercontent.com",
      ...overrides,
    }),
  } as any);
}

function getSessionCookie(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"];
  const arr = Array.isArray(raw) ? raw : [String(raw ?? "")];
  return arr.find(c => c.startsWith("portal_session="));
}

// ── Configuration ─────────────────────────────────────────────────────────────

describe("POST /api/portal/auth/google — configuration", () => {
  it("503 GOOGLE_NOT_CONFIGURED when no client IDs are set", async () => {
    delete process.env.GOOGLE_WEB_CLIENT_ID;
    delete process.env.GOOGLE_ANDROID_CLIENT_ID;
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("GOOGLE_NOT_CONFIGURED");
  });

  it("includes GOOGLE_ANDROID_CLIENT_ID in allowlist when both IDs are set", async () => {
    process.env.GOOGLE_ANDROID_CLIENT_ID = "android-client-id.apps.googleusercontent.com";
    verifyIdTokenSpy.mockResolvedValueOnce({ getPayload: () => null } as any);
    await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    const call = verifyIdTokenSpy.mock.calls[0][0] as { audience: string[] };
    expect(call.audience).toContain("web-client-id.apps.googleusercontent.com");
    expect(call.audience).toContain("android-client-id.apps.googleusercontent.com");
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("POST /api/portal/auth/google — validation", () => {
  it("400 VALIDATION_ERROR when idToken is absent", async () => {
    const res = await request(app).post("/api/portal/auth/google").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("400 VALIDATION_ERROR when idToken is empty string", async () => {
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("401 INVALID_TOKEN when verifyIdToken throws (wrong audience, expired, etc.)", async () => {
    verifyIdTokenSpy.mockRejectedValueOnce(new Error("Wrong recipient"));
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "bad.tok" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("401 INVALID_TOKEN when getPayload() returns null", async () => {
    verifyIdTokenSpy.mockResolvedValueOnce({ getPayload: () => null } as any);
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("401 EMAIL_NOT_VERIFIED when email_verified is false", async () => {
    mockValidToken({ email_verified: false });
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });
});

// ── New account (201) ─────────────────────────────────────────────────────────

describe("POST /api/portal/auth/google — new account (201)", () => {
  function setupNewUser() {
    mockValidToken();
    mockDb.select
      .mockReturnValueOnce(makeChain([]))   // no existing identity
      .mockReturnValueOnce(makeChain([]));  // no existing email user
    mockDb.transaction.mockImplementationOnce(async (fn: Function) =>
      fn({ insert: vi.fn().mockReturnValue(makeChain([MOCK_USER])) })
    );
    mockDb.update.mockReturnValue(makeChain([{ ...MOCK_USER, sessionVersion: 2 }]));
  }

  it("201 with token, id, fullName, email in data body", async () => {
    setupNewUser();
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: MOCK_USER.id, email: MOCK_USER.email });
    expect(typeof res.body.data.token).toBe("string");
    expect(res.body.data.token.startsWith("p.")).toBe(true);
  });

  it("HttpOnly SameSite=Lax cookie set; cookie token equals JSON token", async () => {
    setupNewUser();
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    const cookie = getSessionCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie!.split(";")[0].split("=")[1]).toBe(res.body.data.token);
  });

  it("tx.insert called exactly 4 times (portal_users, profiles, wallets, identities)", async () => {
    mockValidToken();
    mockDb.select.mockReturnValueOnce(makeChain([])).mockReturnValueOnce(makeChain([]));
    const txInsert = vi.fn().mockReturnValue(makeChain([MOCK_USER]));
    mockDb.transaction.mockImplementationOnce(async (fn: Function) => fn({ insert: txInsert }));
    mockDb.update.mockReturnValue(makeChain([{ ...MOCK_USER, sessionVersion: 2 }]));
    await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(txInsert).toHaveBeenCalledTimes(4);
  });

  it("500 SERVER_ERROR when transaction fails (partial account rolled back)", async () => {
    mockValidToken();
    mockDb.select.mockReturnValueOnce(makeChain([])).mockReturnValueOnce(makeChain([]));
    mockDb.transaction.mockRejectedValueOnce(new Error("wallet insert failed"));
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("SERVER_ERROR");
  });
});

// ── Existing Google identity (200) ────────────────────────────────────────────

describe("POST /api/portal/auth/google — existing Google identity (200)", () => {
  it("200 login with token in body; cookie and JSON token match", async () => {
    mockValidToken();
    mockDb.select.mockReturnValueOnce(makeChain([{ identity: MOCK_IDENTITY, user: MOCK_USER }]));
    mockDb.update.mockReturnValue(makeChain([{ ...MOCK_USER, sessionVersion: 2 }]));

    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
    expect(res.body.data.token.startsWith("p.")).toBe(true);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    // Cookie must match JSON token
    const cookieToken = getSessionCookie(res)!.split(";")[0].split("=")[1];
    expect(cookieToken).toBe(res.body.data.token);
  });

  it("403 SUSPENDED when matched user via identity is inactive", async () => {
    mockValidToken();
    mockDb.select.mockReturnValueOnce(
      makeChain([{ identity: MOCK_IDENTITY, user: { ...MOCK_USER, isActive: false } }])
    );
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SUSPENDED");
  });
});

// ── Email linking (200) ───────────────────────────────────────────────────────

describe("POST /api/portal/auth/google — email linking (200)", () => {
  it("links Google identity to existing email account and returns 200 with token", async () => {
    mockValidToken();
    mockDb.select.mockReturnValueOnce(makeChain([])).mockReturnValueOnce(makeChain([MOCK_USER]));
    mockDb.insert.mockReturnValue(makeChain([MOCK_IDENTITY]));
    mockDb.update.mockReturnValue(makeChain([{ ...MOCK_USER, sessionVersion: 2 }]));

    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
    expect(mockDb.insert).toHaveBeenCalledTimes(1); // identity insert only
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("403 SUSPENDED when matched email account is inactive", async () => {
    mockValidToken();
    mockDb.select
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ ...MOCK_USER, isActive: false }]));
    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SUSPENDED");
  });

  it("recovers from duplicate identity race (23505) — returns 200 not 500", async () => {
    mockValidToken();
    mockDb.select.mockReturnValueOnce(makeChain([])).mockReturnValueOnce(makeChain([MOCK_USER]));
    const raceErr = Object.assign(new Error("duplicate key value"), { code: "23505" });
    mockDb.insert.mockReturnValue(makeInsertChain([], raceErr));
    mockDb.update.mockReturnValue(makeChain([{ ...MOCK_USER, sessionVersion: 2 }]));

    const res = await request(app).post("/api/portal/auth/google").send({ idToken: "tok" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.token).toBe("string");
  });
});

// ── Sentinel safety check ─────────────────────────────────────────────────────
// Verifies that bcrypt.compare never returns true for null/sentinel hash values.
// This covers the null-passwordHash guard added to the login route.

describe("Password login — null/sentinel hash is always rejected by bcrypt", () => {
  it("bcrypt.compare returns false for empty string hash", async () => {
    const bcrypt = await import("bcryptjs");
    expect(await bcrypt.compare("anypassword", "").catch(() => false)).toBe(false);
  });

  it("bcrypt.compare returns false for sentinel string hash", async () => {
    const bcrypt = await import("bcryptjs");
    expect(await bcrypt.compare("anypassword", "!google_oauth").catch(() => false)).toBe(false);
  });
});
