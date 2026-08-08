/**
 * Tests for the schema drift detector.
 *
 * Covers three scenarios:
 *   1. Clean repository — detector reports no drift (exit 0).
 *   2. Schema-only change without a migration — detector reports drift (exit 1).
 *   3. Generator failure (invalid schema) — detector reports error (exit 1).
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { checkSchemaDrift } from "./check-schema-drift.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const realDbRoot = resolve(__dirname, "..");

// Collect temp dirs for cleanup
const tempDirs: string[] = [];
function makeTempDbRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "drift-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ── Scenario 1: clean ────────────────────────────────────────────────────────

describe("clean repository", () => {
  it("returns ok:true when schema exactly matches migrations", async () => {
    const result = await checkSchemaDrift(realDbRoot);
    expect(result.ok).toBe(true);
  });
});

// ── Scenario 2: drift (schema changed, no migration) ────────────────────────

describe("schema-only change without migration", () => {
  it("returns ok:false with reason 'drift' and lists pending SQL", async () => {
    // Build a temp db root that is identical to the real one …
    const tempRoot = makeTempDbRoot();
    cpSync(join(realDbRoot, "migrations"), join(tempRoot, "migrations"), {
      recursive: true,
    });
    cpSync(join(realDbRoot, "src"), join(tempRoot, "src"), {
      recursive: true,
    });
    // Symlink node_modules so drizzle-kit can resolve imports (drizzle-orm, etc.)
    // from the schema files that now live in the temp dir.
    symlinkSync(join(realDbRoot, "node_modules"), join(tempRoot, "node_modules"));

    // … then add an unreleased column to seo-leads.ts.
    const schemaFile = join(tempRoot, "src/schema/seo-leads.ts");
    const original = readFileSync(schemaFile, "utf8");
    const modified = original.replace(
      "createdAt: timestamp(",
      'driftTestColumn: text("drift_test_column").default(""),\n  createdAt: timestamp(',
    );
    expect(modified).not.toBe(original); // guard: replacement must have occurred
    writeFileSync(schemaFile, modified);

    const result = await checkSchemaDrift(tempRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("drift");
      if (result.reason === "drift") {
        // At least one pending SQL statement should reference the new column.
        const sql = result.pendingSQL.join("\n");
        expect(sql.toLowerCase()).toContain("drift_test_column");
      }
    }
  }, 60_000 /* drizzle-kit generate can take a few seconds */);
});

// ── Scenario 3: generator failure (invalid schema file) ──────────────────────

describe("generator failure", () => {
  it("returns ok:false with reason 'generator_error' when schema cannot be parsed", async () => {
    const tempRoot = makeTempDbRoot();
    cpSync(join(realDbRoot, "migrations"), join(tempRoot, "migrations"), {
      recursive: true,
    });
    // Write a schema index that has a hard TypeScript/syntax error.
    // drizzle-kit will fail to parse it and exit non-zero.
    const srcDir = join(tempRoot, "src/schema");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "index.ts"),
      "this is not valid TypeScript !!! @@@ import { pgTable } from 'DOES_NOT_EXIST';",
    );

    const result = await checkSchemaDrift(tempRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("generator_error");
    }
  }, 60_000);
});

// ── CLI integration tests (spawn the script as a child process) ───────────────
//
// These tests verify that the CLI *entry point* (process.exit calls) behaves
// correctly, so that a future refactor of the CLI block cannot silently swallow
// errors and always exit 0.

/** Resolve the tsx binary from the real db root's node_modules. */
const tsxBin = join(realDbRoot, "node_modules/.bin/tsx");
/** Absolute path to the CLI source file. */
const cliSrc = join(realDbRoot, "src/check-schema-drift.ts");

function spawnCli(dbRoot: string): { exitCode: number | null } {
  const result = spawnSync(
    tsxBin,
    [cliSrc, `--db-root=${dbRoot}`],
    { encoding: "utf8", timeout: 90_000 },
  );
  return { exitCode: result.status };
}

describe("CLI exit codes", () => {
  it("exits 0 when schema is clean", () => {
    const { exitCode } = spawnCli(realDbRoot);
    expect(exitCode).toBe(0);
  }, 90_000);

  it("exits 1 when drift is present", () => {
    // Build a temp db root identical to real one but with an extra column.
    const tempRoot = makeTempDbRoot();
    cpSync(join(realDbRoot, "migrations"), join(tempRoot, "migrations"), {
      recursive: true,
    });
    cpSync(join(realDbRoot, "src"), join(tempRoot, "src"), { recursive: true });
    symlinkSync(
      join(realDbRoot, "node_modules"),
      join(tempRoot, "node_modules"),
    );

    const schemaFile = join(tempRoot, "src/schema/seo-leads.ts");
    const original = readFileSync(schemaFile, "utf8");
    const modified = original.replace(
      "createdAt: timestamp(",
      'cliDriftColumn: text("cli_drift_column").default(""),\n  createdAt: timestamp(',
    );
    expect(modified).not.toBe(original);
    writeFileSync(schemaFile, modified);

    const { exitCode } = spawnCli(tempRoot);
    expect(exitCode).toBe(1);
  }, 90_000);

  it("exits 1 when drizzle-kit fails (generator_error)", () => {
    // Build a temp root where drizzle-kit cannot be found (no node_modules).
    // checkSchemaDrift resolves dkBin relative to dbRoot; when the binary is
    // missing, execFileSync throws ENOENT, the function returns generator_error,
    // and the CLI must exit 1.  This mirrors the unit test for Scenario 3.
    const tempRoot = makeTempDbRoot();
    cpSync(join(realDbRoot, "migrations"), join(tempRoot, "migrations"), {
      recursive: true,
    });
    const srcDir = join(tempRoot, "src/schema");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "index.ts"),
      "this is not valid TypeScript !!! @@@ import { pgTable } from 'DOES_NOT_EXIST';",
    );
    // Intentionally NO node_modules symlink — drizzle-kit binary won't be
    // found, guaranteeing a generator_error result and therefore exit 1.
    // (tsx itself is resolved from the caller's PATH, not from tempRoot.)

    const { exitCode } = spawnCli(tempRoot);
    expect(exitCode).toBe(1);
  }, 90_000);
});
