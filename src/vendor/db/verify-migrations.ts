/**
 * Integration check for the migration runner.
 * Creates a scratch database (`migrate_verify`) on the same Postgres server
 * and verifies three scenarios converge to the full schema:
 *   1. fresh DB (empty)
 *   2. fully-provisioned legacy DB (all tables, empty journal)
 *   3. partial legacy DB (later tables/columns missing, empty journal)
 * Run: pnpm --filter @workspace/db run verify-migrations
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL must be set");

const SCRATCH = "migrate_verify";
const scratchUrl = (() => {
  const u = new URL(baseUrl);
  u.pathname = `/${SCRATCH}`;
  return u.toString();
})();

function runMigrateCli(): void {
  execFileSync("npx", ["tsx", "src/migrate-cli.ts"], {
    env: { ...process.env, DATABASE_URL: scratchUrl },
    stdio: "inherit",
  });
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: baseUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function withScratch<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: scratchUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function assertFullSchema(label: string): Promise<void> {
  await withScratch(async (c) => {
    const tables = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`,
    );
    const journal = await c.query(
      `SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`,
    );
    const cols = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE (table_name='students' AND column_name IN ('google_id','session_version'))
          OR (table_name='campaign_reports' AND column_name IN ('notification_status','notification_at'))
          OR (table_name IN ('ai_audits','ai_plans','conversations') AND column_name='student_id')`,
    );
    const expectedTables = 25;
    if (tables.rows[0].n < expectedTables)
      throw new Error(`${label}: expected >=${expectedTables} tables, got ${tables.rows[0].n}`);
    if (journal.rows[0].n < 15)
      throw new Error(`${label}: expected >=15 journal rows, got ${journal.rows[0].n}`);
    if (cols.rows[0].n !== 7)
      throw new Error(`${label}: expected 7 sentinel columns, got ${cols.rows[0].n}`);
    console.log(`OK — ${label}: ${tables.rows[0].n} tables, ${journal.rows[0].n} journal rows`);
  });
}

async function recreateScratch(): Promise<void> {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${SCRATCH}`);
  });
}

async function main(): Promise<void> {
  // Scenario 1: fresh DB
  await recreateScratch();
  runMigrateCli();
  await assertFullSchema("scenario 1 (fresh DB)");

  // Scenario 2: fully-provisioned legacy DB (tables exist, journal wiped)
  await withScratch((c) => c.query(`DROP SCHEMA "drizzle" CASCADE`));
  runMigrateCli();
  await assertFullSchema("scenario 2 (legacy DB, empty journal)");

  // Scenario 3: partial legacy DB (later tables/columns missing, journal wiped)
  await withScratch(async (c) => {
    await c.query(`DROP SCHEMA "drizzle" CASCADE`);
    await c.query(`DROP TABLE "ai_usage_quotas", "ai_business_os_leads"`);
    await c.query(
      `ALTER TABLE "campaign_reports" DROP COLUMN "notification_status", DROP COLUMN "notification_at"`,
    );
    await c.query(
      `ALTER TABLE "students" DROP COLUMN "google_id", DROP COLUMN "session_version"`,
    );
  });
  runMigrateCli();
  await assertFullSchema("scenario 3 (partial legacy DB)");

  // Re-run once more: must be a no-op
  runMigrateCli();
  await assertFullSchema("scenario 4 (idempotent re-run)");

  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  console.log("verify-migrations: ALL SCENARIOS PASSED");
}

main().catch((err) => {
  console.error("verify-migrations FAILED:", err);
  process.exit(1);
});
