/**
 * Database singleton — dual-mode (Node.js pool vs CF Workers per-request client).
 *
 * Node.js (pnpm start / pnpm migrate):
 *   A global pg.Pool is created from DATABASE_URL at module load time (or via
 *   initDb()).  All requests share the pool as before.
 *
 * Cloudflare Workers (wrangler dev / wrangler deploy):
 *   Cloudflare recommends a fresh pg.Client per request when using Hyperdrive.
 *   Hyperdrive maintains the real connection pool at the edge, so creating a new
 *   Client is cheap — it connects through Hyperdrive's local socket, not directly
 *   to the database.
 *
 *   Call setRequestDb(drizzleInstance) from the Worker's fetch() handler BEFORE
 *   handing the request to Express.  The global `db` Proxy will then route all
 *   DB access to that per-request instance.  After the response is sent, call
 *   the returned cleanup function (or client.end() directly).
 *
 * All existing `import { db } from "..."` call sites are unchanged.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool, Client } = pg;

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let _pool: pg.Pool | null = null;
let _db: DrizzleDb | null = null;

// ── Node.js pool-based init (idempotent) ─────────────────────────────────────

/** Initialise a shared pg.Pool (Node.js only, idempotent). */
export function initDb(connectionString: string): void {
  if (_pool) return;
  _pool = new Pool({ connectionString });
  _db = drizzle(_pool, { schema });
}

// Auto-init in plain Node.js where DATABASE_URL is available at startup.
if (typeof process !== "undefined" && process.env?.DATABASE_URL) {
  initDb(process.env.DATABASE_URL);
}

// ── CF Workers per-request client ────────────────────────────────────────────

/**
 * Create a fresh pg.Client backed by Hyperdrive and wrap it with Drizzle.
 *
 * Returns both the Drizzle instance (to pass to setRequestDb) and the raw
 * client (so the caller can call client.end() after the response is sent).
 *
 * connectTimeoutMs (default 10 s) aborts the connection attempt if Hyperdrive
 * or the database doesn't respond in time.
 */
export async function createRequestDb(
  connectionString: string,
  connectTimeoutMs = 10_000,
): Promise<{ db: DrizzleDb; client: pg.Client }> {
  const client = new Client({ connectionString });

  await Promise.race([
    client.connect(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`pg.Client.connect() timed out after ${connectTimeoutMs} ms`)),
        connectTimeoutMs,
      ),
    ),
  ]);

  const db = drizzle(client, { schema });
  return { db, client };
}

/**
 * Override the active Drizzle instance.  All subsequent `db.*` access in route
 * handlers will use this instance until the next call to setRequestDb().
 *
 * Safe for CF Workers because each request runs serially in a single isolate.
 */
export function setRequestDb(instance: DrizzleDb): void {
  _db = instance;
}

// ── Shared accessors (used by all routes via the Proxy) ──────────────────────

function assertPool(): pg.Pool {
  if (!_pool) throw new Error("DB pool not initialised — call initDb(connectionString) first");
  return _pool;
}
function assertDb(): DrizzleDb {
  if (!_db) throw new Error("DB not initialised — call initDb() or setRequestDb() first");
  return _db;
}

export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_, key) {
    return (assertPool() as unknown as Record<string | symbol, unknown>)[key];
  },
});

export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_, key) {
    return (assertDb() as unknown as Record<string | symbol, unknown>)[key];
  },
});

export * from "./schema";
