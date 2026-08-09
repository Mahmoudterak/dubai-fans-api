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

    // ── Fast-path: public status page — no DB required ───────────────────────
    // mtuaefans.com/status is routed to this Worker (see wrangler.toml).
    // If STATUS_PAGE_URL is set (BetterStack hosted page), redirect there so
    // users always land on an independently-hosted page that stays up even when
    // this server is down.  Otherwise serve a minimal live-health HTML page.
    if (method === "GET" && path === "/status") {
      const statusPageUrl = env["STATUS_PAGE_URL"] as string | undefined;
      if (statusPageUrl) {
        return new Response(null, {
          status: 301,
          headers: {
            Location: statusPageUrl,
            "Cache-Control": "no-cache",
          },
        });
      }
      // Fallback: minimal branded status page that polls /api/healthz in-browser
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Service Status — Dubai Fans</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0;
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 1.5rem; padding: 2rem;
    }
    .logo { font-size: 1.4rem; font-weight: 700; color: #f8fafc; }
    .card {
      background: #1e293b; border: 1px solid #334155; border-radius: 1rem;
      padding: 2rem 2.5rem; width: 100%; max-width: 480px; text-align: center;
    }
    .dot {
      width: 14px; height: 14px; border-radius: 50%;
      display: inline-block; margin-right: .5rem; vertical-align: middle;
    }
    .ok  { background: #22c55e; box-shadow: 0 0 8px #22c55e88; }
    .err { background: #ef4444; box-shadow: 0 0 8px #ef444488; }
    .checking { background: #94a3b8; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .msg { font-size: 1.1rem; font-weight: 600; vertical-align: middle; }
    .sub { margin-top: .75rem; font-size: .85rem; color: #94a3b8; }
    .ts  { margin-top: .5rem; font-size: .75rem; color: #64748b; }
    a { color: #60a5fa; text-decoration: none; }
  </style>
</head>
<body>
  <div class="logo">Dubai Fans — دبي فانز</div>
  <div class="card">
    <span class="dot checking" id="dot"></span>
    <span class="msg" id="msg">Checking…</span>
    <p class="sub">Dubai Fans API — <a href="https://mtuaefans.com">mtuaefans.com</a></p>
    <p class="ts" id="ts"></p>
  </div>
  <script>
    async function check() {
      const dot = document.getElementById('dot');
      const msg = document.getElementById('msg');
      const ts  = document.getElementById('ts');
      try {
        const r = await fetch('/api/healthz', { cache: 'no-store' });
        dot.className = 'dot ' + (r.ok ? 'ok' : 'err');
        msg.textContent = r.ok ? 'All systems operational' : 'Service disruption detected';
      } catch {
        dot.className = 'dot err';
        msg.textContent = 'Service unreachable';
      }
      ts.textContent = 'Last checked: ' + new Date().toUTCString();
    }
    check();
    setInterval(check, 30000);
  </script>
</body>
</html>`;
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
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
