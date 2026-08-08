/**
 * Idempotent migration runner.
 *
 * Applies any pending SQL migrations from lib/db/migrations using
 * drizzle-orm's programmatic migrator (no TTY needed, unlike drizzle-kit
 * push). Progress is journaled in drizzle.__drizzle_migrations, so
 * already-applied migrations are skipped on subsequent runs.
 *
 * Every migration file is written to be idempotent (CREATE TABLE IF NOT
 * EXISTS, ADD COLUMN IF NOT EXISTS, DO $$ ... EXCEPTION guards, table
 * existence checks), so replays are safe on databases provisioned earlier
 * via `drizzle-kit push`: fresh DBs get everything, fully provisioned DBs
 * no-op, and DBs missing whole tables/columns from later migrations get
 * repaired. (Guarded DDL cannot repair arbitrary hand-modified schemas —
 * e.g. an existing table with unrelated columns removed.) Keep new
 * migrations idempotent too.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index";

/** Locate lib/db/migrations whether we run from source (tsx) or from a bundled server. */
export function findMigrationsFolder(): string {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Bundled server: build copies lib/db/migrations to <bundle dir>/migrations.
    candidates.push(path.resolve(here, "migrations"));
    // Running from source (tsx): lib/db/src -> lib/db/migrations.
    candidates.push(path.resolve(here, "../migrations"));
  } catch {
    /* import.meta.url may be unusable in some bundles */
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, "lib", "db", "migrations"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "meta", "_journal.json"))) return c;
  }
  throw new Error(
    `Could not locate lib/db/migrations (looked in: ${candidates.join(", ")})`,
  );
}

const ADVISORY_LOCK_KEY = 727_193_001; // arbitrary app-wide migration lock

/** Apply all pending migrations. Throws on failure. */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = findMigrationsFolder();
  // Serialize concurrent runners (e.g. post-merge script + server boot).
  const lockClient = await pool.connect();
  try {
    await lockClient.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);
    await migrate(db, { migrationsFolder });
    console.log(`[db:migrate] database is up to date (${migrationsFolder})`);
  } finally {
    await lockClient
      .query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    lockClient.release();
  }
}
