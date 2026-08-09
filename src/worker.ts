/**
 * Cloudflare Workers entry point.
 *
 * DB lifecycle (per Cloudflare Hyperdrive docs):
 *   A fresh pg.Client is created for EACH request.  Hyperdrive maintains the
 *   real TCP connection pool at the edge, so pg.Client.connect() is cheap — it
 *   connects to Hyperdrive's local socket, not the remote database directly.
 *
 *   Using a global pg.Pool across requests causes connection stalls because the
 *   pool reuses sockets that Hyperdrive has already recycled.
 *
 * Request flow:
 *   1. create pg.Client + connect (10 s timeout)
 *   2. wrap with Drizzle → setRequestDb()
 *   3. run Express via expressToFetch()
 *   4. client.end() after the Response resolves
 */
import app from "./app.js";
import { createRequestDb, setRequestDb } from "./vendor/db/index.js";
import { initStorage } from "./lib/storage/index.js";
import { cleanupExpiredResetTokens } from "./routes/company-auth.js";
import { cleanupAibosAnonData } from "./lib/aibos-cleanup.js";
import { logger } from "./lib/logger.js";
import { expressToFetch } from "./lib/express-fetch-adapter.js";
import { runUptimeCheck } from "./lib/uptime-monitor.js";

// ── CF Workers type shims ──────────────────────────────────────────────────────

interface R2Bucket {
  get(key: string): Promise<unknown>;
  head(key: string): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
}

interface Hyperdrive {
  connectionString: string;
}

interface Env {
  R2?: R2Bucket;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  PUBLIC_R2_PREFIXES?: string;
  [key: string]: unknown;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

// ── Worker export ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const reqId = Math.random().toString(36).slice(2, 8);
    const method = request.method;
    const path   = new URL(request.url).pathname;

    // ── Fast-path: health probe — no DB required ────────────────────────────
    // The monitoring tool hits /api/healthz to check liveness. Requiring a DB
    // connection here means any transient Hyperdrive/Neon hiccup turns a healthy
    // Worker into a reported outage. Return immediately without touching the DB.
    if (method === "GET" && path === "/api/healthz") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Resolve DB connection string ─────────────────────────────────────────
    const connStr = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!connStr) {
      logger.error({ reqId }, "worker: no database connection string");
      return new Response(
        JSON.stringify({ error: "No database connection: set DATABASE_URL or configure Hyperdrive" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Inject CF Workers env vars into process.env ──────────────────────────
    // Always overwrite — CF env (from wrangler secrets / .dev.vars) is the
    // canonical source of truth.  Miniflare may pre-seed process.env from
    // .dev.vars before the Worker runs, but other env sources (Replit secrets,
    // host OS) might shadow them.  Using CF env unconditionally keeps behaviour
    // identical between wrangler dev --local and wrangler deploy.
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        (process.env as Record<string, string>)[key] = value;
      }
    }

    // ── Storage init (idempotent) ────────────────────────────────────────────
    initStorage({ R2: env.R2, PUBLIC_R2_PREFIXES: env.PUBLIC_R2_PREFIXES });

    // ── Per-request pg.Client (Hyperdrive recommendation) ────────────────────
    // Hyperdrive pools real DB connections at the edge; pg.Client.connect() is
    // cheap because it connects to a local Hyperdrive socket, not the DB.
    // A global pg.Pool must NOT be used across requests — Hyperdrive recycles
    // the underlying socket between requests, causing pool.connect() to stall.
    const t0 = Date.now();
    logger.info({ reqId, method, path }, "DB: before connect");

    let client: import("pg").Client | null = null;
    try {
      const result = await createRequestDb(connStr, 10_000);
      client = result.client;
      logger.info({ reqId, ms: Date.now() - t0 }, "DB: after connect");

      // Make this request's Drizzle instance visible to all route handlers
      // via the `db` Proxy exported from vendor/db/index.ts.
      setRequestDb(result.db);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ reqId, ms: Date.now() - t0, err: msg }, "DB: connect failed");
      return new Response(
        JSON.stringify({ error: "Database connection failed", detail: msg }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Handle the HTTP request ──────────────────────────────────────────────
    let response: Response;
    try {
      response = await expressToFetch(app, request, ctx.waitUntil.bind(ctx));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ reqId, err: msg }, "worker: expressToFetch threw");
      response = new Response(
        JSON.stringify({ error: "Internal server error", detail: msg }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    } finally {
      // Always end the client so Hyperdrive can recycle the connection.
      const tEnd = Date.now();
      try {
        await client!.end();
        logger.info({ reqId, totalMs: tEnd - t0 }, "DB: client ended");
      } catch (err: unknown) {
        logger.warn({ reqId, err: String(err) }, "DB: client.end() failed (ignored)");
      }
    }

    return response;
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // ── 1-minute uptime check — no DB required ──────────────────────────────
    // Runs independently of the DB so a database outage never silences alerts.
    if (event.cron === "* * * * *") {
      logger.info("scheduled: running uptime check");
      await runUptimeCheck(env as Record<string, unknown>);
      return;
    }

    // ── DB-backed maintenance crons ──────────────────────────────────────────
    const connStr = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!connStr) {
      logger.error("scheduled: no database connection — skipping");
      return;
    }

    logger.info({ cron: event.cron }, "scheduled: before connect");
    const t0 = Date.now();
    let client: import("pg").Client | null = null;
    try {
      const result = await createRequestDb(connStr, 10_000);
      client = result.client;
      logger.info({ ms: Date.now() - t0 }, "scheduled: after connect");
      setRequestDb(result.db);
    } catch (err: unknown) {
      logger.error({ err: String(err) }, "scheduled: DB connect failed — skipping");
      return;
    }

    try {
      if (event.cron === "0 2 * * *") {
        logger.info("scheduled: running reset-token cleanup");
        await cleanupExpiredResetTokens();
      } else if (event.cron === "0 3 * * 0") {
        logger.info("scheduled: running AIBOS anon cleanup");
        await cleanupAibosAnonData();
      } else {
        logger.warn({ cron: event.cron }, "scheduled: unknown cron — no handler");
      }
    } finally {
      try { await client!.end(); } catch { /* ignore */ }
    }
  },
};
