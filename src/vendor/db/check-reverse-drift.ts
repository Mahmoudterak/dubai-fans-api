/**
 * Reverse schema drift detector.
 *
 * Introspects the live database and compares it against the Drizzle schema.
 * Flags tables or columns that exist in the DB but are absent from the schema —
 * i.e. objects that were dropped from the code without a corresponding DROP
 * migration, leaving orphaned structures in production.
 *
 * Exit codes (CLI):
 *   0 — every public table/column in the DB is present in the schema
 *   1 — orphaned DB objects found OR DB connection failed; details on stderr
 *
 * Usage:
 *   pnpm --filter @workspace/db run check-reverse-drift
 */

import { Pool } from "pg";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { fileURLToPath } from "node:url";

// ── Schema introspection ─────────────────────────────────────────────────────

/**
 * Returns a map of { tableName → Set<columnName> } derived from the Drizzle
 * schema, covering every exported pgTable.
 */
async function getSchemaMap(): Promise<Map<string, Set<string>>> {
  // Dynamic import so this file can be used as a library without side-effects.
  const schema = await import("./schema/index.js");

  const map = new Map<string, Set<string>>();

  for (const value of Object.values(schema)) {
    if (is(value as object, PgTable)) {
      const config = getTableConfig(value as PgTable);
      const cols = new Set(config.columns.map((c) => c.name));
      map.set(config.name, cols);
    }
  }

  return map;
}

// ── DB introspection ─────────────────────────────────────────────────────────

interface DbColumn {
  table_name: string;
  column_name: string;
}

/**
 * Returns all (table, column) pairs in the `public` schema of the connected
 * database, excluding Drizzle's own internal journal table.
 */
async function getDbColumns(pool: Pool): Promise<DbColumn[]> {
  const result = await pool.query<DbColumn>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   <> '__drizzle_migrations'
     ORDER BY table_name, column_name`,
  );
  return result.rows;
}

// ── Comparison ───────────────────────────────────────────────────────────────

export interface ReverseDriftOrphan {
  table: string;
  /** undefined when the whole table is orphaned */
  column?: string;
}

export type ReverseDriftResult =
  | { ok: true }
  | { ok: false; reason: "orphans"; orphans: ReverseDriftOrphan[] }
  | { ok: false; reason: "db_error"; message: string };

/**
 * Connect to the database, introspect it, and compare against the Drizzle
 * schema. Returns a structured result describing any orphaned objects.
 */
export async function checkReverseDrift(
  databaseUrl: string,
): Promise<ReverseDriftResult> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const [schemaMap, dbColumns] = await Promise.all([
      getSchemaMap(),
      getDbColumns(pool),
    ]);

    const orphans: ReverseDriftOrphan[] = [];

    // Build a set of table names found in the DB to detect entirely orphaned
    // tables (the table does not exist in the schema at all).
    const dbTables = new Set(dbColumns.map((r) => r.table_name));

    for (const tableName of dbTables) {
      if (!schemaMap.has(tableName)) {
        // Whole table is orphaned — report once, skip its columns.
        orphans.push({ table: tableName });
        continue;
      }

      // Table exists in schema — check individual columns.
      const schemaColumns = schemaMap.get(tableName)!;
      const tableDbColumns = dbColumns.filter(
        (r) => r.table_name === tableName,
      );

      for (const { column_name } of tableDbColumns) {
        if (!schemaColumns.has(column_name)) {
          orphans.push({ table: tableName, column: column_name });
        }
      }
    }

    if (orphans.length > 0) {
      return { ok: false, reason: "orphans", orphans };
    }

    return { ok: true };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "db_error", message };
  } finally {
    await pool.end();
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error(
      "❌  DATABASE_URL is not set. Cannot connect to the database.\n" +
        "    Export DATABASE_URL and re-run:\n" +
        "      pnpm --filter @workspace/db run check-reverse-drift\n",
    );
    process.exit(1);
  }

  checkReverseDrift(databaseUrl).then((result) => {
    if (result.ok) {
      console.log(
        "✅  No reverse drift found. Every table and column in the DB is present in the schema.",
      );
      return;
    }

    if (result.reason === "db_error") {
      console.error(
        "\n❌  Could not connect to or query the database.\n\n" +
          `    ${result.message}\n\n` +
          "    Verify DATABASE_URL is correct and the DB is reachable.\n",
      );
      process.exit(1);
    }

    // reason === "orphans"
    console.error(
      "\n❌  Reverse schema drift detected!\n\n" +
        "    The following objects exist in the database but are absent from the\n" +
        "    Drizzle schema. Add a DROP migration for each, or restore the schema\n" +
        "    definition if the removal was accidental.\n",
    );

    // Group by table for readability.
    const byTable = new Map<string, string[]>();
    for (const { table, column } of result.orphans) {
      if (!byTable.has(table)) byTable.set(table, []);
      if (column) byTable.get(table)!.push(column);
    }

    for (const [table, columns] of byTable) {
      if (columns.length === 0) {
        console.error(`  • Table  "${table}"  (entire table is orphaned)`);
      } else {
        console.error(`  • Table  "${table}":`);
        for (const col of columns) {
          console.error(`      – column  "${col}"`);
        }
      }
    }

    console.error(
      "\n  Fix: write a migration with the appropriate DROP TABLE / DROP COLUMN\n" +
        "       statements and commit it alongside the schema change.\n",
    );

    process.exit(1);
  });
}
